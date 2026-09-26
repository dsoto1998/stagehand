//! Background analysis job queue (click tracks + guitar-removal stems).
//!
//! `Create Click Track` / `Remove Guitar` (renderer) → `clicktrack_enqueue` /
//! `stems_enqueue` → ONE background worker thread (jobs run strictly one at a
//! time — both kinds are heavy torch workloads), which per job:
//!   - click track: decodes the source to a mono WAV, runs the frozen
//!     `beat_detect` sidecar, leaves `<APPDATA>/clicktracks/<trackId>.json`;
//!   - stems: see `crate::stems::process_stems_job`.
//!
//! and emits `<kind>_progress` / `<kind>_done` / `<kind>_error` events, where
//! `<kind>` is `clicktrack` or `stems`.
//!
//! Progress is pushed to the frontend via Tauri events — mirrors the
//! `peaks_ready` / `vst_latency` pattern used elsewhere. Nothing here blocks the
//! audio threads.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::decode_to_samples;

/// Which analysis a job runs. Also the event-name prefix (`clicktrack_done`, ...).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    ClickTrack,
    Stems,
}

impl JobKind {
    pub(crate) fn event_prefix(self) -> &'static str {
        match self {
            JobKind::ClickTrack => "clicktrack",
            JobKind::Stems => "stems",
        }
    }
}

/// Public job state, surfaced to the Processing Queue panel.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Decoding,
    Analyzing,
    Separating,
    Done,
    Error,
}

impl JobState {
    fn as_stage(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Decoding => "decoding",
            JobState::Analyzing => "analyzing",
            JobState::Separating => "separating",
            JobState::Done => "done",
            JobState::Error => "error",
        }
    }

    fn in_flight(self) -> bool {
        matches!(self, JobState::Queued | JobState::Decoding | JobState::Analyzing | JobState::Separating)
    }
}

#[derive(Clone, Serialize)]
pub struct JobStatus {
    pub kind: JobKind,
    pub track_id: String,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub(crate) struct Job {
    pub kind: JobKind,
    pub track_id: String,
    pub src_path: String,
}

enum WorkerMsg {
    Run(Job),
    Cancel(JobKind, String),
}

pub(crate) type Statuses = Arc<Mutex<VecDeque<JobStatus>>>;

pub struct ClickJobQueue {
    tx: Sender<WorkerMsg>,
    /// Snapshot of every job seen this session (newest last), for `clicktrack_status`.
    statuses: Statuses,
}

impl ClickJobQueue {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<WorkerMsg>();
        let statuses: Statuses = Arc::new(Mutex::new(VecDeque::new()));
        let worker_statuses = statuses.clone();
        std::thread::Builder::new()
            .name("analysis-worker".into())
            .spawn(move || worker_main(app, rx, worker_statuses))
            .expect("spawn clicktrack worker");
        Self { tx, statuses }
    }

    pub fn enqueue(&self, kind: JobKind, track_id: String, src_path: String) -> Result<(), String> {
        let p = kind.event_prefix();
        {
            let mut s = self.statuses.lock().unwrap();
            if let Some(existing) = s.iter_mut().find(|j| j.kind == kind && j.track_id == track_id) {
                if existing.state.in_flight() {
                    log::info!("[stagehand] {p} {} already in flight ({}) — ignoring re-enqueue", track_id, existing.state.as_stage());
                    return Ok(()); // already in flight — no-op
                }
                existing.state = JobState::Queued;
                existing.message = None;
            } else {
                s.push_back(JobStatus { kind, track_id: track_id.clone(), state: JobState::Queued, message: None });
            }
        }
        log::info!("[stagehand] {p} {} enqueued ({})", track_id, src_path);
        self.tx
            .send(WorkerMsg::Run(Job { kind, track_id, src_path }))
            .map_err(|e| e.to_string())
    }

    pub fn cancel(&self, kind: JobKind, track_id: String) {
        let _ = self.tx.send(WorkerMsg::Cancel(kind, track_id));
    }

    pub fn status(&self) -> Vec<JobStatus> {
        self.statuses.lock().unwrap().iter().cloned().collect()
    }
}

pub(crate) fn set_state(
    app: &AppHandle,
    statuses: &Statuses,
    kind: JobKind,
    track_id: &str,
    state: JobState,
    message: Option<String>,
) {
    {
        let mut s = statuses.lock().unwrap();
        if let Some(j) = s.iter_mut().find(|j| j.kind == kind && j.track_id == track_id) {
            j.state = state;
            j.message = message.clone();
        }
    }
    let suffix = match state {
        JobState::Done => "done",
        JobState::Error => "error",
        _ => "progress",
    };
    let _ = app.emit(
        &format!("{}_{}", kind.event_prefix(), suffix),
        json!({ "track_id": track_id, "stage": state.as_stage(), "message": message }),
    );
}

/// Mark a job Done in the status list WITHOUT emitting — the job emits its own
/// `<kind>_done` with a richer payload.
pub(crate) fn mark_done(statuses: &Statuses, kind: JobKind, track_id: &str) {
    let mut s = statuses.lock().unwrap();
    if let Some(j) = s.iter_mut().find(|j| j.kind == kind && j.track_id == track_id) {
        j.state = JobState::Done;
        j.message = None;
    }
}

fn worker_main(
    app: AppHandle,
    rx: Receiver<WorkerMsg>,
    statuses: Statuses,
) {
    let mut cancelled: Vec<(JobKind, String)> = Vec::new();
    while let Ok(msg) = rx.recv() {
        let job = match msg {
            WorkerMsg::Cancel(kind, id) => {
                set_state(&app, &statuses, kind, &id, JobState::Error, Some("cancelled".into()));
                cancelled.push((kind, id));
                continue;
            }
            WorkerMsg::Run(job) => job,
        };
        if let Some(pos) = cancelled.iter().position(|(k, id)| *k == job.kind && id == &job.track_id) {
            cancelled.remove(pos);
            continue;
        }
        let p = job.kind.event_prefix();
        log::info!("[stagehand] {p} {} dequeued, starting", job.track_id);
        let result = match job.kind {
            JobKind::ClickTrack => process_job(&app, &statuses, &job),
            JobKind::Stems => crate::stems::process_stems_job(&app, &statuses, &job),
        };
        match result {
            Ok(()) => log::info!("[stagehand] {p} {} done", job.track_id),
            Err(e) => {
                log::warn!("[stagehand] {p} {} failed: {}", job.track_id, e);
                set_state(&app, &statuses, job.kind, &job.track_id, JobState::Error, Some(e));
            }
        }
    }
}

fn process_job(
    app: &AppHandle,
    statuses: &Statuses,
    job: &Job,
) -> Result<(), String> {
    let kind = JobKind::ClickTrack;
    set_state(app, statuses, kind, &job.track_id, JobState::Decoding, None);

    let bytes = std::fs::read(&job.src_path).map_err(|e| format!("read source: {e}"))?;
    let (samples, channels, sample_rate) = decode_to_samples(bytes)?;
    let mono = downmix_mono(&samples, channels as usize);

    let tmp_wav = std::env::temp_dir().join(format!("stagehand_click_{}.wav", job.track_id));
    write_wav_mono_i16(&tmp_wav, &mono, sample_rate).map_err(|e| format!("write wav: {e}"))?;

    let out_dir = clicktracks_dir(app)?;
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out_json = out_dir.join(format!("{}.json", job.track_id));

    set_state(app, statuses, kind, &job.track_id, JobState::Analyzing, None);
    let run = run_sidecar(app, &job.track_id, &tmp_wav, &out_json);
    let _ = std::fs::remove_file(&tmp_wav);
    let descriptor = run?;

    let numerator = descriptor.get("numerator").and_then(|v| v.as_u64()).unwrap_or(4);
    let tempo_bpm = descriptor.get("tempoBpm").and_then(|v| v.as_f64()).unwrap_or(0.0);

    mark_done(statuses, kind, &job.track_id);
    let _ = app.emit(
        "clicktrack_done",
        json!({
            "track_id": job.track_id,
            "stage": "done",
            "numerator": numerator,
            "tempo_bpm": tempo_bpm,
            "path": out_json.to_string_lossy(),
        }),
    );
    Ok(())
}

fn clicktracks_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("clicktracks"))
}

/// Average all interleaved channels into a single mono track.
fn downmix_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let sum: f32 = interleaved[base..base + channels].iter().sum();
        out.push(sum / channels as f32);
    }
    out
}

/// Minimal 16-bit PCM mono WAV writer (no external crate).
fn write_wav_mono_i16(path: &PathBuf, samples: &[f32], sample_rate: u32) -> std::io::Result<()> {
    let data_len = (samples.len() * 2) as u32;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?; // PCM fmt chunk size
    f.write_all(&1u16.to_le_bytes())?; // audio format = PCM
    f.write_all(&1u16.to_le_bytes())?; // channels = 1
    f.write_all(&sample_rate.to_le_bytes())?;
    f.write_all(&(sample_rate * 2).to_le_bytes())?; // byte rate
    f.write_all(&2u16.to_le_bytes())?; // block align
    f.write_all(&16u16.to_le_bytes())?; // bits per sample
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        f.write_all(&v.to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
}

/// Locate a program in the frozen sidecar bundle (`beat_detect` or
/// `stem_separate` — both live in the same `beat_detect/` folder and share its
/// `_internal/`). Order:
///   1. `env_var` (dev override; may be an .exe, or `python:<interpreter>` to
///      run the unfrozen `sidecar/<program>.py`).
///   2. bundled resource dir: `<resources>/beat_detect/<program>.exe`.
///   3. dev fallback: `<CARGO_MANIFEST_DIR>/binaries/beat_detect/<program>.exe`.
pub(crate) fn sidecar_command(
    app: &AppHandle,
    program: &str,
    env_var: &str,
) -> Result<std::process::Command, String> {
    if let Ok(spec) = std::env::var(env_var) {
        // "python:<path to interpreter>" — runs the unfrozen sidecar/<program>.py
        // via that interpreter (e.g. the sidecar/.venv Python). Otherwise `spec`
        // is taken as a path to a built <program>(.exe).
        if let Some(py) = spec.strip_prefix("python:") {
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("sidecar")
                .join(format!("{program}.py"));
            let mut c = std::process::Command::new(py);
            c.arg(script);
            return Ok(c);
        }
        return Ok(std::process::Command::new(spec));
    }

    let exe_name = if cfg!(windows) { format!("{program}.exe") } else { program.to_string() };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        // depending on how Tauri flattens bundle.resources globs
        candidates.push(res.join("beat_detect").join(&exe_name));
        candidates.push(res.join("beat_detect").join("binaries").join("beat_detect").join(&exe_name));
        candidates.push(res.join("binaries").join("beat_detect").join(&exe_name));
    }
    // dev fallback
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("beat_detect")
            .join(&exe_name),
    );

    for p in candidates {
        if p.exists() {
            return Ok(std::process::Command::new(p));
        }
    }

    Err(format!("{program} sidecar not found (set {env_var} for dev)"))
}

/// Spawn the sidecar, forward its stdout progress lines, and return the parsed
/// output descriptor on success.
fn run_sidecar(
    app: &AppHandle,
    track_id: &str,
    input_wav: &PathBuf,
    output_json: &PathBuf,
) -> Result<serde_json::Value, String> {
    use std::process::Stdio;

    let mut cmd = sidecar_command(app, "beat_detect", "STAGEHAND_BEAT_DETECT")?;
    log::info!("[stagehand] clicktrack {} sidecar: {:?}", track_id, cmd.get_program());
    cmd.arg("--input")
        .arg(input_wav)
        .arg("--output")
        .arg(output_json)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn sidecar: {e}"))?;
    log::info!("[stagehand] clicktrack {} sidecar pid={:?}", track_id, child.id());

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            log::info!("[stagehand] clicktrack {} stdout: {}", track_id, line);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(stage) = v.get("stage").and_then(|s| s.as_str()) {
                    if stage != "done" {
                        let _ = app.emit(
                            "clicktrack_progress",
                            json!({ "track_id": track_id, "stage": stage }),
                        );
                    }
                }
            }
        }
    }

    log::info!("[stagehand] clicktrack {} waiting on sidecar exit", track_id);
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    log::info!("[stagehand] clicktrack {} sidecar exited: {}", track_id, out.status);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.lines().last().unwrap_or("analysis failed").trim().to_string();
        return Err(if msg.is_empty() { "analysis failed".into() } else { msg });
    }

    let text = std::fs::read_to_string(output_json).map_err(|e| format!("read descriptor: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse descriptor: {e}"))
}
