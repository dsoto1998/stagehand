pub mod audio;
pub mod click_track;
pub mod commands;
pub mod live_input;
pub mod vst_host;

use commands::{EngineState, LiveInputState, ClickTrackState};
use click_track::ClickJobQueue;
use audio::AudioEngine;
use live_input::LiveInputEngine;
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let name = match shortcut.key {
                            Code::MediaPlayPause     => Some("media-play-pause"),
                            Code::MediaTrackNext     => Some("media-next-track"),
                            Code::MediaTrackPrevious => Some("media-prev-track"),
                            Code::MediaStop          => Some("media-stop"),
                            _ => None,
                        };
                        if let Some(n) = name {
                            let _ = app.emit(n, ());
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Ensure library + click-track directories exist for filesystem-backed storage
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(data_dir.join("library"));
                let _ = std::fs::create_dir_all(data_dir.join("clicktracks"));
            }
            let engine = AudioEngine::new(app.handle().clone())
                .expect("Failed to init audio engine");
            let vst_chain = engine.vst_chain.clone();
            app.manage(EngineState(Mutex::new(engine)));
            app.manage(LiveInputState(Arc::new(Mutex::new(LiveInputEngine::new(vst_chain)))));
            app.manage(ClickTrackState(ClickJobQueue::new(app.handle().clone())));

            for code in [
                Code::MediaPlayPause,
                Code::MediaTrackNext,
                Code::MediaTrackPrevious,
                Code::MediaStop,
            ] {
                if let Err(e) = app.global_shortcut().register(Shortcut::new(None, code)) {
                    log::warn!("Failed to register global shortcut {code:?}: {e}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library_get_dir,
            commands::library_scan,
            commands::audio_load,
            commands::audio_play,
            commands::audio_pause,
            commands::audio_resume,
            commands::audio_stop,
            commands::audio_seek,
            commands::audio_set_volume,
            commands::audio_set_semitones,
            commands::audio_set_speed,
            commands::audio_set_loop,
            commands::audio_get_devices,
            commands::audio_set_device,
            commands::audio_load_file,
            commands::audio_prefetch,
            commands::audio_check_prefetch,
            commands::open_url,
            commands::library_check_paths,
            commands::open_audio_files_dialog,
            commands::open_vst_dialog,
            commands::vst_scan,
            commands::vst_get_chain,
            commands::vst_load,
            commands::vst_unload,
            commands::vst_unload_all,
            commands::vst_move,
            commands::vst_process_test,
            commands::vst_get_latency,
            commands::vst_bypass,
            commands::vst_global_bypass,
            commands::vst_open_gui,
            commands::vst_close_gui,
            commands::vst_close_all_guis,
            commands::live_input_get_input_devices,
            commands::live_input_start,
            commands::live_input_stop,
            commands::live_input_set_input_gain,
            commands::live_input_set_output_gain,
            commands::live_input_set_mute,
            commands::live_input_status,
            commands::clicktrack_enqueue,
            commands::clicktrack_status,
            commands::clicktrack_cancel,
            commands::clicktrack_get,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
