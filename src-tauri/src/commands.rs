use tauri::State;
use parking_lot::Mutex;
use serde::Serialize;
use cpal::traits::{DeviceTrait, HostTrait};
use crate::audio::{AudioEngine, LoadResult, PrefetchEntry, decode_to_samples, compute_peaks};

pub struct EngineState(pub Mutex<AudioEngine>);

// ─── Library ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LibraryFileEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub ext: String,
    pub size: u64,
}

#[tauri::command]
pub async fn library_get_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(data_dir.join("library").to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn library_scan(app: tauri::AppHandle) -> Result<Vec<LibraryFileEntry>, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let lib_dir = data_dir.join("library");
    if !lib_dir.exists() {
        return Ok(vec![]);
    }
    let supported = ["flac", "wav", "mp3", "ogg", "opus", "aiff", "aif"];
    let mut results = vec![];
    let entries = std::fs::read_dir(&lib_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        if !supported.contains(&ext.as_str()) { continue; }
        let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        results.push(LibraryFileEntry {
            id: stem,
            name,
            path: path.to_string_lossy().into_owned(),
            ext: ext.to_uppercase(),
            size,
        });
    }
    Ok(results)
}

// ─── Load ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn audio_load_file(
    state: State<'_, EngineState>,
    path: String,
    track_id: Option<String>,
    cached_peaks: Option<Vec<f32>>,
    cached_duration: Option<f64>,
    cached_sample_rate: Option<u32>,
    keep_file: Option<bool>,
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
    if !keep_file.unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let result = match (cached_peaks, cached_duration, cached_sample_rate) {
        (Some(peaks), Some(duration), Some(sample_rate)) => {
            state.0.lock().load_cached(bytes, peaks, duration, sample_rate, track_id)
        }
        _ => state.0.lock().load(bytes, track_id),
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
    keep_file: Option<bool>,
) -> Result<(), String> {
    // Grab prefetch Arc now (brief lock) — OS thread uses it directly
    let prefetch_arc = state.0.lock().prefetch.clone();
    let keep = keep_file.unwrap_or(false);

    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => { log::warn!("[stagehand] audio_prefetch: read failed: {e}"); return; }
        };
        if !keep {
            let _ = std::fs::remove_file(&path);
        }
        log::info!("[stagehand] audio_prefetch: start decode for {}", track_id);

        let raw_bytes = bytes.clone();
        let (samples, channels, sample_rate) = match decode_to_samples(bytes) {
            Ok(r) => r,
            Err(e) => { log::warn!("[stagehand] audio_prefetch: decode failed: {e}"); return; }
        };
        if channels == 0 || sample_rate == 0 {
            log::warn!("[stagehand] audio_prefetch: bad codec params (ch={channels}, sr={sample_rate})");
            return;
        }
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
    track_id: String,
) -> Result<LoadResult, String> {
    state.0.lock().load(audio_bytes, Some(track_id))
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
    let mut waited_ms = 0u32;
    loop {
        let result = {
            let engine = state.0.lock();
            engine.set_loop(loop_enabled, loop_start, loop_end);
            engine.play_with_params(offset_secs, semitones, speed, volume)
        }; // engine lock released before any sleep
        match result {
            Ok(()) => return Ok(()),
            Err(ref e) if e == "decode_pending" => {
                if waited_ms >= 8000 {
                    return Err("Audio decode timeout (format may not be supported)".into());
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                waited_ms += 100;
            }
            Err(e) => return Err(e),
        }
    }
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
    let mut waited_ms = 0u32;
    loop {
        let result = {
            let engine = state.0.lock();
            engine.set_loop(loop_enabled, loop_start, loop_end);
            engine.seek(offset_secs, semitones, speed, volume)
        };
        match result {
            Ok(()) => return Ok(()),
            Err(ref e) if e == "decode_pending" => {
                if waited_ms >= 8000 {
                    return Err("Audio decode timeout (format may not be supported)".into());
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                waited_ms += 100;
            }
            Err(e) => return Err(e),
        }
    }
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
    pub latency_hint: String,
}

#[tauri::command]
pub async fn audio_get_devices() -> Result<Vec<AudioDevice>, String> {
    let mut devices = Vec::new();

    // WASAPI devices via default host
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    if !default_name.is_empty() {
        devices.push(AudioDevice {
            name: default_name.clone(),
            is_asio: false,
            is_default: true,
            latency_hint: "~10ms".to_string(),
        });
    }
    if let Ok(all) = host.output_devices() {
        for d in all {
            if let Ok(name) = d.name() {
                if name != default_name {
                    devices.push(AudioDevice {
                        name,
                        is_asio: false,
                        is_default: false,
                        latency_hint: "~10ms".to_string(),
                    });
                }
            }
        }
    }

    // ASIO devices — Windows only, prepended to front of list
    #[cfg(target_os = "windows")]
    if let Ok(asio_host) = cpal::host_from_id(cpal::HostId::Asio) {
        if let Ok(asio_devs) = asio_host.output_devices() {
            let mut asio_list: Vec<AudioDevice> = asio_devs
                .filter_map(|d| {
                    d.name().ok().map(|name| AudioDevice {
                        name,
                        is_asio: true,
                        is_default: false,
                        latency_hint: "~1ms".to_string(),
                    })
                })
                .collect();
            asio_list.append(&mut devices);
            devices = asio_list;
        }
    }

    Ok(devices)
}

#[tauri::command]
pub async fn audio_set_device(
    state: State<'_, EngineState>,
    device_name: String,
    is_asio: bool,
) -> Result<(), String> {
    state.0.lock().set_output_device(&device_name, is_asio)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}

// ─── File dialog / path utilities ────────────────────────────────────────────

#[tauri::command]
pub async fn open_audio_files_dialog() -> Result<Vec<String>, String> {
    let handle = rfd::AsyncFileDialog::new()
        .set_title("Import Audio Files")
        .add_filter("Audio", &["wav", "mp3", "flac", "ogg", "opus", "aiff", "aif"])
        .pick_files()
        .await;
    Ok(handle
        .unwrap_or_default()
        .into_iter()
        .map(|f| f.path().to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
pub async fn library_check_paths(paths: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(paths.iter().map(|p| std::path::Path::new(p).exists()).collect())
}
