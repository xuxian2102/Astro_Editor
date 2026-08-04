use tauri::{AppHandle, State};

use super::current_project_at;
use crate::error::AppError;
use crate::model::PreviewStatus;
use crate::services::preview;
use crate::state::AppState;

#[tauri::command]
pub async fn ensure_preview_server(
    app: AppHandle,
    state: State<'_, AppState>,
    project_generation: u64,
    post_id: Option<String>,
) -> Result<PreviewStatus, AppError> {
    let ctx = {
        let _content_guard = state.content_lock.lock().expect("content lock poisoned");
        current_project_at(&state, project_generation)?
    };
    preview::ensure(app, ctx, post_id).await
}

#[tauri::command]
pub async fn stop_preview_server(app: AppHandle) -> Result<PreviewStatus, AppError> {
    preview::stop(&app).await
}

#[tauri::command]
pub async fn get_preview_status(app: AppHandle) -> Result<PreviewStatus, AppError> {
    Ok(preview::current_status(&app).await)
}
