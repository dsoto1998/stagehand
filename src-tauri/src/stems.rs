//! Guitar-removal stem jobs (run on the shared analysis worker — see
//! `click_track.rs`).
//!
//! Per job:
//!   1. decode the source with the SAME decoder playback uses
//!      (`crate::audio::decode_to_samples`) and write it to a float WAV — so the
//!      stem comes back sample-aligned with what `AudioEngine` will play;
//!   2. run the `stem_separate` sidecar (Demucs htdemucs_6s) on it, on the GPU
//!      when the GPU pack is installed (`crate::gpu_pack`), else CPU;
//!   3. leave `<APPDATA>/stems/<trackId>.guitar.flac` and emit `stems_done`.
//!
//! Only the guitar stem is stored. Playback mixes `original - (1 - g) * guitar`
//! (`AudioEngine::set_stem` / `set_stem_gain`), so g=1 is the untouched
//! recording and g=0 has the guitar removed.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::decode_to_samples;
use crate::click_track::{mark_done, set_state, sidecar_command, Job, JobKind, JobState, Statuses};

const KIND: JobKind = JobKind::Stems;

pub fn stems_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("stems"))
}

pub fn guitar_stem_path(app: &AppHandle, track_id: &str) -> Result<PathBuf, String> {
    Ok(stems_dir(app)?.join(format!("{track_id}.guitar.flac")))
}

pub(crate) fn process_stems_job(app: &AppHandle, statuses: &Statuses, job: &Job) -> Result<(), String> {
    set_state(app, statuses, KIND, &job.track_id, JobState::Decoding, None);

    let bytes = std::fs::read(&job.src_path).map_err(|e| format!("read source: {e}"))?;
    let (samples, channels, sample_rate) = decode_to_samples(bytes)?;
    if !(1..=2).contains(&channels) {
        return Err(format!("only mono/stereo tracks are supported ({channels} channels)"));
    }

    let tmp_wav = std::env::temp_dir().join(format!("stagehand_stems_{}.wav", job.track_id));
    write_wav_f32(&tmp_wav, &samples, channels, sample_rate).map_err(|e| format!("write wav: {e}"))?;
    drop(samples);

    let out = guitar_stem_path(app, &job.track_id)?;
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;

    set_state(app, statuses, KIND, &job.track_id, JobState::Separating, None);
    let gpu = crate::gpu_pack::active_torch_dir(app);
    let mut result = run_separator(app, &job.track_id, &tmp_wav, &out, gpu.as_deref());
    if let (Err(e), Some(_)) = (&result, &gpu) {
        // A broken GPU pack (driver too old, corrupt extract, OOM) must not make
        // guitar removal unusable — fall back to the bundled CPU torch.
        log::warn!("[stagehand] stems {} GPU run failed ({e}) — retrying on CPU", job.track_id);
        result = run_separator(app, &job.track_id, &tmp_wav, &out, None);
    }
    let _ = std::fs::remove_file(&tmp_wav);
    let done = result?;

    mark_done(statuses, KIND, &job.track_id);
    let _ = app.emit(
        "stems_done",
        json!({
            "track_id": job.track_id,
            "stage": "done",
            "path": out.to_string_lossy(),
            "device": done.get("device").and_then(|v| v.as_str()).unwrap_or("cpu"),
            "seconds": done.get("seconds").and_then(|v| v.as_f64()),
        }),
    );
    Ok(())
}

/// Run `stem_separate`, forwarding its JSON progress lines as `stems_progress`.
/// Returns the final `{"stage":"done",...}` record.
fn run_separator(
    app: &AppHandle,
    track_id: &str,
    input_wav: &Path,
    output: &Path,
    torch_dir: Option<&Path>,
) -> Result<serde_json::Value, String> {
    use std::process::Stdio;

    let mut cmd = sidecar_command(app, "stem_separate", "STAGEHAND_STEM_SEPARATE")?;
    cmd.arg("--input").arg(input_wav).arg("--output").arg(output);
    if let Some(dir) = torch_dir {
        cmd.arg("--torch-dir").arg(dir);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    log::info!("[stagehand] stems {} sidecar: {:?} gpu={}", track_id, cmd.get_program(), torch_dir.is_some());
    let mut child = cmd.spawn().map_err(|e| format!("spawn stem_separate: {e}"))?;

    // Drain stderr on its own thread — torch can be chatty, and a full stderr
    // pipe would block the child while we sit reading stdout.
    let mut stderr = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });

    let mut done: Option<serde_json::Value> = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v.get("stage").and_then(|s| s.as_str()) {
                Some("done") => done = Some(v),
                Some(stage) => {
                    let _ = app.emit(
                        "stems_progress",
                        json!({
                            "track_id": track_id,
                            "stage": if stage == "loading" { "separating" } else { stage },
                            "progress": v.get("progress"),
                            "device": v.get("device"),
                        }),
                    );
                }
                None => {}
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let err = err_thread.join().unwrap_or_default();
    log::info!("[stagehand] stems {} sidecar exited: {}", track_id, status);
    if !status.success() {
        let msg = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("separation failed").trim();
        return Err(msg.to_string());
    }
    if !output.exists() {
        return Err("separator produced no output".into());
    }
    Ok(done.unwrap_or_else(|| json!({})))
}

/// 32-bit float WAV (WAVE_FORMAT_IEEE_FLOAT), interleaved. Float — not i16 —
/// because the app later subtracts the returned stem from the original; a
/// quantised input would leave quantisation noise in the difference.
fn write_wav_f32(path: &Path, samples: &[f32], channels: u16, sample_rate: u32) -> std::io::Result<()> {
    let data_len = (samples.len() * 4) as u32;
    let block_align = channels * 4;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&3u16.to_le_bytes())?; // IEEE float
    f.write_all(&channels.to_le_bytes())?;
    f.write_all(&sample_rate.to_le_bytes())?;
    f.write_all(&(sample_rate * block_align as u32).to_le_bytes())?;
    f.write_all(&block_align.to_le_bytes())?;
    f.write_all(&32u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for &s in samples {
        f.write_all(&s.to_le_bytes())?;
    }
    f.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f32_wav_round_trips_through_decoder() {
        let path = std::env::temp_dir().join("stagehand_stems_test.wav");
        let src: Vec<f32> = (0..2000).map(|i| ((i as f32) * 0.01).sin() * 0.5).collect();
        write_wav_f32(&path, &src, 2, 44100).unwrap();
        let (got, ch, sr) = decode_to_samples(std::fs::read(&path).unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!((ch, sr), (2, 44100));
        assert_eq!(got.len(), src.len());
        assert!(got.iter().zip(&src).all(|(a, b)| (a - b).abs() < 1e-6));
    }
}
