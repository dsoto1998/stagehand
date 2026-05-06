pub mod audio;
pub mod commands;

use commands::EngineState;
use audio::AudioEngine;
use parking_lot::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Ensure library directory exists for filesystem-backed audio storage
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(data_dir.join("library"));
            }
            let engine = AudioEngine::new(app.handle().clone())
                .expect("Failed to init audio engine");
            app.manage(EngineState(Mutex::new(engine)));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
