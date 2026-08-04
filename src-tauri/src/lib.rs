mod commands;
mod error;
mod model;
mod path_guard;
mod services;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project::select_project,
            commands::project::get_project,
            commands::posts::list_posts,
            commands::posts::read_post,
            commands::posts::write_post,
            commands::posts::create_post,
            commands::posts::rename_post,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
