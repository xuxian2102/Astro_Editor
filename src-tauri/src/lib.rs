mod commands;
mod error;
mod model;
mod path_guard;
mod services;
mod state;

use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use state::AppState;

const LOG_FILE_NAME: &str = "blog-editor";
const LOG_MAX_FILE_SIZE_BYTES: u128 = 1024 * 1024;
const LOG_ARCHIVE_COUNT: usize = 2;

#[cfg(feature = "e2e")]
const E2E_CSP_MONITOR_SCRIPT: &str = r#"
window.__blogEditorE2eCspViolations = [];
document.addEventListener("securitypolicyviolation", (event) => {
  window.__blogEditorE2eCspViolations.push({
    blockedUri: event.blockedURI,
    directive: event.effectiveDirective,
  });
});
"#;

#[cfg(feature = "e2e")]
fn e2e_csp_monitor<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("e2e-csp-monitor")
        .js_init_script(E2E_CSP_MONITOR_SCRIPT)
        .build()
}

#[cfg(not(feature = "e2e"))]
fn initial_app_state() -> AppState {
    AppState::default()
}

#[cfg(feature = "e2e")]
fn initial_app_state() -> AppState {
    let mut state = AppState::default();
    if let Some(root) = std::env::var_os("BLOG_EDITOR_E2E_PROJECT") {
        let project = services::project::open_project(std::path::Path::new(&root))
            .expect("BLOG_EDITOR_E2E_PROJECT must point to a valid test project");
        *state.project.get_mut().expect("project lock poisoned") = Some(project);
        *state.project_generation.get_mut() = 1;
    }
    state
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_target = if cfg!(debug_assertions) {
        TargetKind::Stdout
    } else {
        TargetKind::LogDir {
            file_name: Some(LOG_FILE_NAME.into()),
        }
    };
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .clear_targets()
                .target(Target::new(log_target))
                .max_file_size(LOG_MAX_FILE_SIZE_BYTES)
                .rotation_strategy(RotationStrategy::KeepSome(LOG_ARCHIVE_COUNT))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(feature = "e2e")]
    let builder = builder
        // document-start 脚本先于 HTML 解析，能记录 WebDriver 连接前的启动期 CSP 违规。
        .plugin(e2e_csp_monitor())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .manage(initial_app_state())
        .setup(|_| {
            log::info!("Blog Editor {} 已启动", env!("CARGO_PKG_VERSION"));
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
                log::info!("应用退出清理开始");
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
                log::info!("应用退出清理完成");
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn trusted_main_window_can_finish_the_close_request_handshake() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json"))
                .expect("main capability must be valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("main capability permissions must be an array");

        assert!(permissions
            .iter()
            .any(|permission| { permission.as_str() == Some("core:window:allow-destroy") }));
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
    }

    #[test]
    fn release_version_is_consistent_across_manifests() {
        let tauri_config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json"))
                .expect("tauri config must be valid JSON");
        let package: serde_json::Value = serde_json::from_str(include_str!("../../package.json"))
            .expect("package manifest must be valid JSON");

        assert_eq!(tauri_config["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
    }
}
