use tauri::{AppHandle, State};

use super::current_project;
use crate::error::AppError;
use crate::model::PreviewStatus;
use crate::services::preview;
use crate::state::AppState;

#[tauri::command]
pub async fn ensure_preview_server(
    app: AppHandle,
    state: State<'_, AppState>,
    post_id: Option<String>,
) -> Result<PreviewStatus, AppError> {
    let ctx = current_project(&state)?;
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
