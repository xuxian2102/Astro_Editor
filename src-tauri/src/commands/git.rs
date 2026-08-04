use tauri::{AppHandle, Manager};

use super::current_project_at;
use crate::error::AppError;
use crate::model::{GitStatus, PublishResult};
use crate::services::git;
use crate::state::AppState;

#[tauri::command]
pub async fn git_status(app: AppHandle, project_generation: u64) -> Result<GitStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _content_guard = state.content_lock.lock().expect("content lock poisoned");
        let ctx = current_project_at(&state, project_generation)?;
        git::status(&ctx)
    })
    .await
    .map_err(|error| AppError::Git(format!("Git 状态任务异常结束：{error}")))?
}

#[tauri::command]
pub async fn git_publish(
    app: AppHandle,
    project_generation: u64,
    message: String,
    push: bool,
) -> Result<PublishResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // 与项目切换、文章保存和图片落盘串行；否则 stage 可能看见一半完成的内容事务。
        let _content_guard = state.content_lock.lock().expect("content lock poisoned");
        let ctx = current_project_at(&state, project_generation)?;
        if state
            .pending_assets
            .lock()
            .expect("pending assets lock poisoned")
            .has_pending_project(&ctx.root)
        {
            return Err(AppError::Git(
                "仍有尚未随文章保存确认的图片，请先保存文章再发布".into(),
            ));
        }
        // 覆盖整个 stage→commit→push 序列，防止并发发布
        let _guard = state.git_lock.lock().expect("git lock poisoned");
        git::publish(&ctx, &message, push)
    })
    .await
    .map_err(|error| AppError::Git(format!("Git 发布任务异常结束：{error}")))?
}
