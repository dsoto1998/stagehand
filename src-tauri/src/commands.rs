use tauri::State;
use parking_lot::Mutex;
use serde::Serialize;
use cpal::traits::{DeviceTrait, HostTrait};
use crate::audio::{AudioEngine, LoadResult, PrefetchEntry, decode_to_samples, compute_peaks};

pub struct EngineState(pub Mutex<AudioEngine>);

// ─── Load ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn audio_load_file(
    state: State<'_, EngineState>,
    path: String,
    track_id: Option<String>,
    cached_peaks: Option<Vec<f32>>,
    cached_duration: Option<f64>,
    cached_sample_rate: Option<u32>,
) -> Result<LoadResult, String> {
    let t0 = std::time::Instant::now();

    // Check prefetch cache before reading the file
    if let Some(ref tid) = track_id {
        let prefetch_arc = state.0.lock().prefetch.clone();
        let mut cache = prefetch_arc.lock();
        let hit = cache.as_ref().map_or(false, |e| e.track_id == *tid);
        if hit {
            let entry = cache.take().unwrap();
            drop(cache);
            let result = state.0.lock().apply_prefetch_entry(entry);
            log::info!("[stagehand] audio_load_file: prefetch HIT for {} ({:.0}ms)", tid, t0.elapsed().as_millis());
            return Ok(result);
        } else {
            log::info!("[stagehand] audio_load_file: prefetch MISS for {} — decoding from file", tid);
        }
    }

    if path.is_empty() {
        return Err("prefetch_miss".into()); // no file and no cache hit
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Read audio file failed: {e}"))?;
    let _ = std::fs::remove_file(&path);
    let result = match (cached_peaks, cached_duration, cached_sample_rate) {
        (Some(peaks), Some(duration), Some(sample_rate)) => {
            state.0.lock().load_cached(bytes, peaks, duration, sample_rate)
        }
        _ => state.0.lock().load(bytes),
    };
    log::info!("[stagehand] audio_load_file: decoded in {:.0}ms", t0.elapsed().as_millis());
    result
}

/// Returns true if the prefetch cache holds a decoded entry for this track_id.
#[tauri::command]
pub async fn audio_check_prefetch(
    state: State<'_, EngineState>,
    track_id: String,
) -> Result<bool, String> {
    let prefetch_arc = state.0.lock().prefetch.clone();
    let hit = prefetch_arc.lock().as_ref().map_or(false, |e| e.track_id == track_id);
    Ok(hit)
}

/// Decode a track in the background so it's ready when the user hits next/prev.
/// Returns immediately — decode runs on an OS thread so the async runtime stays free.
#[tauri::command]
pub async fn audio_prefetch(
    state: State<'_, EngineState>,
    path: String,
    track_id: String,
    cached_peaks: Option<Vec<f32>>,
    cached_duration: Option<f64>,
) -> Result<(), String> {
    // Grab prefetch Arc now (brief lock) — OS thread uses it directly
    let prefetch_arc = state.0.lock().prefetch.clone();

    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => { log::warn!("[stagehand] audio_prefetch: read failed: {e}"); return; }
        };
        let _ = std::fs::remove_file(&path);
        log::info!("[stagehand] audio_prefetch: start decode for {}", track_id);

        let raw_bytes = bytes.clone();
        let (samples, channels, sample_rate) = match decode_to_samples(bytes) {
            Ok(r) => r,
            Err(e) => { log::warn!("[stagehand] audio_prefetch: decode failed: {e}"); return; }
        };
        let total_frames = samples.len() / channels as usize;
        let duration = cached_duration.unwrap_or(total_frames as f64 / sample_rate as f64);
        let peaks = match cached_peaks {
            Some(p) => p,
            None => compute_peaks(&samples, channels as usize, 600),
        };
        *prefetch_arc.lock() = Some(PrefetchEntry::new(
            track_id.clone(), raw_bytes, samples, channels, sample_rate, peaks, duration,
        ));
        log::info!("[stagehand] audio_prefetch: {} ready in {:.0}ms", track_id, t0.elapsed().as_millis());
    });

    Ok(()) // returns immediately — decode continues on OS thread
}

#[tauri::command]
pub async fn audio_load(
    state: State<'_, EngineState>,
    audio_bytes: Vec<u8>,
    _track_id: String,
) -> Result<LoadResult, String> {
    state.0.lock().load(audio_bytes)
}

// ─── Playback ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn audio_play(
    state: State<'_, EngineState>,
    offset_secs: f64,
    semitones: i32,
    speed: f64,
    volume: f32,
    loop_enabled: bool,
    loop_start: f64,
    loop_end: f64,
) -> Result<(), String> {
    let engine = state.0.lock();
    engine.set_loop(loop_enabled, loop_start, loop_end);
    engine.play_with_params(offset_secs, semitones, speed, volume)
}

#[tauri::command]
pub async fn audio_pause(
    state: State<'_, EngineState>,
) -> Result<f64, String> {
    Ok(state.0.lock().pause())
}

#[tauri::command]
pub async fn audio_resume(
    state: State<'_, EngineState>,
) -> Result<(), String> {
    state.0.lock().resume();
    Ok(())
}

#[tauri::command]
pub async fn audio_stop(
    state: State<'_, EngineState>,
) -> Result<(), String> {
    state.0.lock().stop();
    Ok(())
}

#[tauri::command]
pub async fn audio_set_volume(
    state: State<'_, EngineState>,
    volume: f32,
) -> Result<(), String> {
    state.0.lock().set_volume(volume);
    Ok(())
}

// ─── Seek / pitch / speed ────────────────────────────────────────────────────

#[tauri::command]
pub async fn audio_seek(
    state: State<'_, EngineState>,
    offset_secs: f64,
    semitones: i32,
    speed: f64,
    volume: f32,
    loop_enabled: bool,
    loop_start: f64,
    loop_end: f64,
) -> Result<(), String> {
    let engine = state.0.lock();
    engine.set_loop(loop_enabled, loop_start, loop_end);
    engine.seek(offset_secs, semitones, speed, volume)
}

#[tauri::command]
pub async fn audio_set_semitones(
    state: State<'_, EngineState>,
    semitones: i32,
    speed: f64,
    volume: f32,
    loop_enabled: bool,
    loop_start: f64,
    loop_end: f64,
) -> Result<(), String> {
    let engine = state.0.lock();
    engine.set_loop(loop_enabled, loop_start, loop_end);
    engine.set_semitones(semitones, speed, volume)
}

#[tauri::command]
pub async fn audio_set_speed(
    state: State<'_, EngineState>,
    speed: f64,
    semitones: i32,
    volume: f32,
    loop_enabled: bool,
    loop_start: f64,
    loop_end: f64,
) -> Result<(), String> {
    let engine = state.0.lock();
    engine.set_loop(loop_enabled, loop_start, loop_end);
    engine.set_speed(speed, semitones, volume)
}

#[tauri::command]
pub async fn audio_set_loop(
    state: State<'_, EngineState>,
    enabled: bool,
    loop_start: f64,
    loop_end: f64,
) -> Result<(), String> {
    state.0.lock().set_loop(enabled, loop_start, loop_end);
    Ok(())
}

// ─── Device picker ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_asio: bool,
    pub is_default: bool,
}

#[tauri::command]
pub async fn audio_get_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let mut devices = Vec::new();

    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    if !default_name.is_empty() {
        devices.push(AudioDevice {
            name: default_name.clone(),
            is_asio: false,
            is_default: true,
        });
    }

    if let Ok(all) = host.output_devices() {
        for d in all {
            if let Ok(name) = d.name() {
                if name != default_name {
                    devices.push(AudioDevice { name, is_asio: false, is_default: false });
                }
            }
        }
    }

    Ok(devices)
}

#[tauri::command]
pub async fn audio_set_device(
    state: State<'_, EngineState>,
    device_name: String,
) -> Result<(), String> {
    state.0.lock().set_output_device(&device_name)
}
