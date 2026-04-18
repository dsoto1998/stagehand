use tauri::State;
use parking_lot::Mutex;
use serde::Serialize;
use cpal::traits::{DeviceTrait, HostTrait};
use crate::audio::{AudioEngine, LoadResult};

pub struct EngineState(pub Mutex<AudioEngine>);

// ─── Load ────────────────────────────────────────────────────────────────────

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
    _offset_secs: f64,
    _semitones: i32,
    _speed: f64,
    volume: f32,
    _loop_enabled: bool,
    _loop_start: f64,
    _loop_end: f64,
) -> Result<(), String> {
    // Phase 2a: offset/semitones/speed/loop stubbed — plain playback from start
    state.0.lock().play(volume)
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

// ─── Stubs (Phase 2b: RubberbandSource + seek) ───────────────────────────────

#[tauri::command]
pub async fn audio_seek(
    _state: State<'_, EngineState>,
    _offset_secs: f64,
    _semitones: i32,
    _speed: f64,
    _volume: f32,
    _loop_enabled: bool,
    _loop_start: f64,
    _loop_end: f64,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn audio_set_semitones(
    _state: State<'_, EngineState>,
    _semitones: i32,
    _speed: f64,
    _volume: f32,
    _loop_enabled: bool,
    _loop_start: f64,
    _loop_end: f64,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn audio_set_speed(
    _state: State<'_, EngineState>,
    _speed: f64,
    _semitones: i32,
    _volume: f32,
    _loop_enabled: bool,
    _loop_start: f64,
    _loop_end: f64,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn audio_set_loop(
    _state: State<'_, EngineState>,
    _enabled: bool,
    _loop_start: f64,
    _loop_end: f64,
) -> Result<(), String> {
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
    _state: State<'_, EngineState>,
    _device_name: String,
) -> Result<(), String> {
    // TODO Phase 2b: tear down OutputStream, rebuild targeting named device
    Ok(())
}
