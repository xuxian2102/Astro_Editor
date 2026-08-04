use tauri::State;

use super::current_project;
use crate::error::AppError;
use crate::model::{GitStatus, PublishResult};
use crate::services::git;
use crate::state::AppState;

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<GitStatus, AppError> {
    let ctx = current_project(&state)?;
    git::status(&ctx)
}

#[tauri::command]
pub async fn git_publish(
    state: State<'_, AppState>,
    message: String,
    push: bool,
) -> Result<PublishResult, AppError> {
    let ctx = current_project(&state)?;
    // 覆盖整个 stage→commit→push 序列，防止并发发布
    let _guard = state.git_lock.lock().expect("git lock poisoned");
    git::publish(&ctx, &message, push)
}
