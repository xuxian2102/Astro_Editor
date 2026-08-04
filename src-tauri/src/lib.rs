mod commands;
mod error;
mod model;
mod path_guard;
mod services;
mod state;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            commands::project::update_project_config,
            commands::posts::list_posts,
            commands::posts::read_post,
            commands::posts::write_post,
            commands::posts::create_post,
            commands::posts::rename_post,
            commands::posts::delete_post,
            commands::posts::list_tags,
            commands::assets::save_image,
            commands::assets::read_image_asset,
            commands::assets::import_clipboard_images,
            commands::assets::discard_pending_images,
            commands::drafts::write_draft,
            commands::drafts::read_draft,
            commands::drafts::delete_draft,
            commands::git::git_status,
            commands::git::git_publish,
            commands::preview::ensure_preview_server,
            commands::preview::stop_preview_server,
            commands::preview::get_preview_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 应用退出时的最后防线，正常路径已经在项目切换/主动停止里处理过
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
                    if let Err(error) = state
                        .pending_assets
                        .lock()
                        .expect("pending assets lock poisoned")
                        .discard_all()
                    {
                        log::warn!("退出时清理待提交图片失败：{error}");
                    }
                    services::preview::best_effort_kill_on_exit(&state);
                }
            }
        });
}
