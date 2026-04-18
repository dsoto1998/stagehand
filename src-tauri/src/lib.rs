pub mod audio;
pub mod commands;

use commands::EngineState;
use audio::AudioEngine;
use parking_lot::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let engine = AudioEngine::new(app.handle().clone())
                .expect("Failed to init audio engine");
            app.manage(EngineState(Mutex::new(engine)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
