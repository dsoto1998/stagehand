use std::sync::Arc;
use tauri::{Emitter, State};
use parking_lot::Mutex;
use serde::Serialize;
use cpal::traits::{DeviceTrait, HostTrait};
use crate::audio::{AudioEngine, LoadResult, PrefetchEntry, decode_to_samples, compute_peaks};
use crate::vst_host::{VstHost, VstPluginInfo, VstChainEntry};
use crate::live_input::{LiveInputEngine, LiveInputConfig, LiveInputStatus, InputDeviceInfo, enumerate_input_devices};
use crate::click_track::{ClickJobQueue, JobStatus};

pub struct EngineState(pub Mutex<AudioEngine>);

pub struct LiveInputState(pub Arc<Mutex<LiveInputEngine>>);

pub struct ClickTrackState(pub ClickJobQueue);

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
    cents: f64,
    speed: f64,
    volume: f32,
    loop_enabled: bool,
    loop_start: f64,
    loop_end: f64,
) -> Result<(), String> {
    log::info!("[stagehand] audio_play: offset={offset_secs:.2}s semitones={semitones} speed={speed} volume={volume}");
    let mut waited_ms = 0u32;
    loop {
        let result = {
            let engine = state.0.lock();
            engine.set_loop(loop_enabled, loop_start, loop_end);
            engine.play_with_params(offset_secs, semitones, cents, speed, volume)
        }; // engine lock released before any sleep
        match result {
            Ok(()) => {
                log::info!("[stagehand] audio_play: started");
                return Ok(());
            }
            Err(ref e) if e == "decode_pending" => {
                if waited_ms >= 8000 {
                    log::warn!("[stagehand] audio_play: decode timeout after {waited_ms}ms");
                    return Err("Audio decode timeout (format may not be supported)".into());
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                waited_ms += 100;
            }
            Err(e) => {
                log::warn!("[stagehand] audio_play failed: {e}");
                return Err(e);
            }
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
    cents: f64,
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
            engine.seek(offset_secs, semitones, cents, speed, volume)
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
    cents: f64,
    speed: f64,
    volume: f32,
    loop_enabled: bool,
    loop_start: f64,
    loop_end: f64,
) -> Result<(), String> {
    let engine = state.0.lock();
    engine.set_loop(loop_enabled, loop_start, loop_end);
    engine.set_semitones(semitones, cents, speed, volume)
}

#[tauri::command]
pub async fn audio_set_speed(
    state: State<'_, EngineState>,
    speed: f64,
    semitones: i32,
    cents: f64,
    volume: f32,
    loop_enabled: bool,
    loop_start: f64,
    loop_end: f64,
) -> Result<(), String> {
    let engine = state.0.lock();
    engine.set_loop(loop_enabled, loop_start, loop_end);
    engine.set_speed(speed, semitones, cents, volume)
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

#[tauri::command]
pub async fn open_vst_dialog() -> Result<Option<String>, String> {
    let common_vst3 = std::path::PathBuf::from("C:\\Program Files\\Common Files\\VST3");
    let mut dlg = rfd::AsyncFileDialog::new()
        .set_title("Load VST3 Plugin")
        .add_filter("VST3 Plugin", &["vst3"]);
    if common_vst3.exists() {
        dlg = dlg.set_directory(common_vst3);
    }
    Ok(dlg.pick_file().await.map(|f| f.path().to_string_lossy().into_owned()))
}

// ─── VST3 commands ───────────────────────────────────────────────────────────
//
// Chain model: AudioEngine holds Arc<Mutex<Vec<VstHost>>>.
// vst_load appends (index=None) or replaces (index=Some(i)).
// All per-plugin commands take an index into the chain.

#[tauri::command]
pub async fn vst_scan(path: String) -> Result<Vec<VstPluginInfo>, String> {
    Ok(VstHost::scan(&path))
}

#[tauri::command]
pub async fn vst_get_chain(state: State<'_, EngineState>) -> Result<Vec<VstChainEntry>, String> {
    let chain = state.0.lock().vst_chain.clone();
    let guard = chain.lock();
    let entries = guard.iter().enumerate().map(|(i, h)| VstChainEntry {
        index: i,
        name: h.name().to_string(),
        path: h.path().to_string(),
        bypassed: h.bypassed,
        gui_open: h.is_gui_open(),
        latency_samples: h.latency_samples,
    }).collect();
    Ok(entries)
}

#[tauri::command]
pub async fn vst_load(
    app: tauri::AppHandle,
    state: State<'_, EngineState>,
    path: String,
    sample_rate: Option<f64>,
    index: Option<usize>,
) -> Result<usize, String> {
    let sr = sample_rate.unwrap_or(44100.0);
    let (chain, parked) = { let g = state.0.lock(); (g.vst_chain.clone(), g.vst_parked.clone()) };

    // Revive a parked instance for this path if one exists (keeps the plugin's
    // graphics engine bound to a live worker thread — required for Plugin Alliance
    // plugins like Lindell 80 that deadlock on a fresh reload). Otherwise load anew.
    let revived = {
        let mut p = parked.lock();
        p.iter().position(|h| h.path() == path).map(|pos| p.remove(pos))
    };
    let host = match revived {
        Some(mut h) => {
            h.set_bypass(false);
            // Pool may hold a host configured at a different SR than the current
            // stream — reconfigure before it re-enters the chain, or all its
            // time-based DSP runs at the wrong rate.
            h.ensure_sample_rate(sr)?;
            h
        }
        None => {
            let path2 = path.clone();
            tokio::task::spawn_blocking(move || VstHost::spawn_and_load(&path2, sr))
                .await
                .map_err(|e| e.to_string())??
        }
    };
    let latency = host.latency_samples;

    // Replacing an existing slot parks the old host (never drop a host mid-session —
    // its engine may be a process-global singleton). Capture any displaced host first.
    let mut displaced: Option<VstHost> = None;
    let actual_index = {
        let mut guard = chain.lock();
        match index {
            None => { guard.push(host); guard.len() - 1 }
            Some(i) if i < guard.len() => { displaced = Some(std::mem::replace(&mut guard[i], host)); i }
            Some(_) => { guard.push(host); guard.len() - 1 }
        }
    };
    if let Some(d) = displaced {
        // Close its editor before parking — otherwise the window stays open and
        // interactive for a plugin that's no longer in the chain.
        if let Some(rx) = d.request_close_gui() {
            tokio::task::spawn_blocking(move || { let _ = rx.recv(); }).await.ok();
        }
        parked.lock().push(d);
    }

    let latency_ms = (latency as f64 / sr) * 1000.0;
    let _ = app.emit("vst_latency", serde_json::json!({
        "index": actual_index,
        "latency_samples": latency,
        "latency_ms": latency_ms,
    }));
    Ok(actual_index)
}

/// Remove plugin at chain index. JS must call vst_close_gui first if GUI is open.
#[tauri::command]
pub async fn vst_unload(
    state: State<'_, EngineState>,
    index: usize,
) -> Result<(), String> {
    let (chain, parked) = { let g = state.0.lock(); (g.vst_chain.clone(), g.vst_parked.clone()) };
    // Remove under the lock; close its GUI and PARK it (keep worker + DLL alive) so a
    // later reload of the same path reuses it instead of deadlocking on a fresh load.
    let removed = {
        let mut guard = chain.lock();
        if index >= guard.len() {
            return Err(format!("No plugin at index {index}"));
        }
        guard.remove(index)
    };
    if let Some(rx) = removed.request_close_gui() {
        tokio::task::spawn_blocking(move || { let _ = rx.recv(); }).await.ok();
    }
    parked.lock().push(removed);
    Ok(())
}

/// Move plugin from one position to another (drag-to-reorder).
#[tauri::command]
pub async fn vst_move(
    state: State<'_, EngineState>,
    from: usize,
    to: usize,
) -> Result<(), String> {
    let chain = state.0.lock().vst_chain.clone();
    let mut guard = chain.lock();
    if from >= guard.len() || to >= guard.len() {
        return Err("Plugin index out of range".into());
    }
    if from != to {
        let plugin = guard.remove(from);
        guard.insert(to, plugin);
    }
    Ok(())
}

#[tauri::command]
pub async fn vst_process_test(
    state: State<'_, EngineState>,
    index: Option<usize>,
) -> Result<(), String> {
    let chain = state.0.lock().vst_chain.clone();
    let mut guard = chain.lock();
    if let Some(i) = index {
        guard.get_mut(i).ok_or(format!("No plugin at index {i}"))?.process_test()
    } else {
        for host in guard.iter_mut() { host.process_test()?; }
        Ok(())
    }
}

#[tauri::command]
pub async fn vst_get_latency(
    state: State<'_, EngineState>,
    index: usize,
) -> Result<u32, String> {
    let chain = state.0.lock().vst_chain.clone();
    let guard = chain.lock();
    Ok(guard.get(index).ok_or(format!("No plugin at index {index}"))?.get_latency())
}

#[tauri::command]
pub async fn vst_bypass(
    state: State<'_, EngineState>,
    index: usize,
    bypassed: bool,
) -> Result<(), String> {
    let chain = state.0.lock().vst_chain.clone();
    let mut guard = chain.lock();
    guard.get_mut(index).ok_or(format!("No plugin at index {index}"))?.set_bypass(bypassed);
    Ok(())
}

#[tauri::command]
pub async fn vst_global_bypass(
    state: State<'_, EngineState>,
    bypassed: bool,
) -> Result<(), String> {
    let chain = state.0.lock().vst_chain.clone();
    for host in chain.lock().iter_mut() { host.set_bypass(bypassed); }
    Ok(())
}

/// Open the plugin editor on its persistent UI worker thread (the thread that
/// loaded it). Sends OpenGui to the worker, then waits for the attach result
/// WITHOUT holding the chain lock (so the audio thread is never blocked).
#[tauri::command]
pub async fn vst_open_gui(
    state: State<'_, EngineState>,
    index: usize,
) -> Result<(), String> {
    let chain = state.0.lock().vst_chain.clone();
    // Brief lock: ask the worker to open; get a reply receiver.
    let rx = {
        let guard = chain.lock();
        let host = guard.get(index).ok_or(format!("No plugin at index {index}"))?;
        host.request_open_gui()?
    };
    // Wait for the worker's attach result off the lock.
    tokio::task::spawn_blocking(move || {
        rx.recv().map_err(|_| "UI worker exited unexpectedly".to_string()).and_then(|r| r)
    }).await.map_err(|e| e.to_string())?
}

/// Ask the plugin's UI worker to close its editor window; wait for teardown.
#[tauri::command]
pub async fn vst_close_gui(
    state: State<'_, EngineState>,
    index: usize,
) -> Result<(), String> {
    let chain = state.0.lock().vst_chain.clone();
    let rx = {
        let guard = chain.lock();
        guard.get(index).and_then(|h| h.request_close_gui())
    };
    if let Some(rx) = rx {
        tokio::task::spawn_blocking(move || { let _ = rx.recv(); })
            .await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close all open plugin GUIs (e.g. before unloading the whole chain).
#[tauri::command]
pub async fn vst_close_all_guis(
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let chain = state.0.lock().vst_chain.clone();
    // Collect close receivers under a brief lock, then wait off the lock.
    let receivers: Vec<_> = {
        let guard = chain.lock();
        guard.iter().filter_map(|h| h.request_close_gui()).collect()
    };
    tokio::task::spawn_blocking(move || {
        for rx in receivers { let _ = rx.recv(); }
    }).await.map_err(|e| e.to_string())
}

/// Unload all plugins in the chain at once. JS must close all GUIs first.
#[tauri::command]
pub async fn vst_unload_all(state: State<'_, EngineState>) -> Result<(), String> {
    let (chain, parked) = { let g = state.0.lock(); (g.vst_chain.clone(), g.vst_parked.clone()) };
    // Drain under the lock; close GUIs and PARK the hosts (keep workers + DLLs alive).
    let drained: Vec<VstHost> = { let mut guard = chain.lock(); guard.drain(..).collect() };
    let receivers: Vec<_> = drained.iter().filter_map(|h| h.request_close_gui()).collect();
    tokio::task::spawn_blocking(move || { for rx in receivers { let _ = rx.recv(); } })
        .await.map_err(|e| e.to_string())?;
    parked.lock().extend(drained);
    Ok(())
}

// ─── Live input commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn live_input_get_input_devices() -> Result<Vec<InputDeviceInfo>, String> {
    // spawn_blocking: ASIO COM init is not safe on tokio async threads.
    tokio::task::spawn_blocking(enumerate_input_devices)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn live_input_start(
    state: State<'_, LiveInputState>,
    config: LiveInputConfig,
) -> Result<(), String> {
    // spawn_blocking: find_device + stream creation call into ASIO COM, which
    // requires an STA thread. Tokio pool threads are MTA and will fail to find
    // ASIO devices.
    let engine = Arc::clone(&state.0);
    tokio::task::spawn_blocking(move || engine.lock().start(config))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn live_input_stop(state: State<'_, LiveInputState>) -> Result<(), String> {
    // spawn_blocking: dropping ASIO streams calls COM cleanup; same STA requirement.
    let engine = Arc::clone(&state.0);
    tokio::task::spawn_blocking(move || engine.lock().stop())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn live_input_set_input_gain(
    state: State<'_, LiveInputState>,
    gain: f32,
) -> Result<(), String> {
    state.0.lock().set_input_gain(gain);
    Ok(())
}

#[tauri::command]
pub async fn live_input_set_output_gain(
    state: State<'_, LiveInputState>,
    gain: f32,
) -> Result<(), String> {
    state.0.lock().set_output_gain(gain);
    Ok(())
}

#[tauri::command]
pub async fn live_input_set_mute(
    state: State<'_, LiveInputState>,
    muted: bool,
) -> Result<(), String> {
    state.0.lock().set_mute(muted);
    Ok(())
}

#[tauri::command]
pub async fn live_input_status(
    state: State<'_, LiveInputState>,
) -> Result<LiveInputStatus, String> {
    Ok(state.0.lock().status())
}

// ─── Click track ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn clicktrack_enqueue(
    state: State<'_, ClickTrackState>,
    track_id: String,
    path: String,
) -> Result<(), String> {
    state.0.enqueue(track_id, path)
}

#[tauri::command]
pub async fn clicktrack_status(
    state: State<'_, ClickTrackState>,
) -> Result<Vec<JobStatus>, String> {
    Ok(state.0.status())
}

#[tauri::command]
pub async fn clicktrack_cancel(
    state: State<'_, ClickTrackState>,
    track_id: String,
) -> Result<(), String> {
    state.0.cancel(track_id);
    Ok(())
}

/// Read the on-disk beat-grid descriptor for a track (written by the sidecar).
#[tauri::command]
pub async fn clicktrack_get(
    app: tauri::AppHandle,
    track_id: String,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("clicktracks")
        .join(format!("{track_id}.json"));
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
