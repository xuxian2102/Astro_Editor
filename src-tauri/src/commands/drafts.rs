use tauri::{AppHandle, Manager, State};

use super::current_project_at;
use crate::error::AppError;
use crate::model::DraftDocument;
use crate::services::drafts;
use crate::state::AppState;

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Io(format!("无法定位应用数据目录：{error}")))
}

#[tauri::command]
pub async fn write_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    project_generation: u64,
    post_id: String,
    raw_frontmatter: Option<String>,
    body: String,
    base_revision: String,
) -> Result<(), AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    let app_data_dir = app_data_dir(&app)?;
    drafts::write(
        &app_data_dir,
        &ctx,
        &post_id,
        raw_frontmatter,
        body,
        base_revision,
    )
}

#[tauri::command]
pub async fn read_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    project_generation: u64,
    post_id: String,
) -> Result<Option<DraftDocument>, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    drafts::read(&app_data_dir(&app)?, &ctx, &post_id)
}

#[tauri::command]
pub async fn delete_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    project_generation: u64,
    post_id: String,
) -> Result<(), AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    drafts::delete(&app_data_dir(&app)?, &ctx, &post_id)
}
