use std::collections::HashMap;

use tauri::State;

use super::current_project_at;
use crate::error::AppError;
use crate::model::{PostDocument, PostSummary};
use crate::services::posts;
use crate::state::AppState;

#[tauri::command]
pub async fn list_posts(
    state: State<'_, AppState>,
    project_generation: u64,
) -> Result<Vec<PostSummary>, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    posts::list_posts(&ctx)
}

#[tauri::command]
pub async fn read_post(
    state: State<'_, AppState>,
    project_generation: u64,
    id: String,
) -> Result<PostDocument, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    posts::read_post(&ctx, &id)
}

#[tauri::command]
pub async fn write_post(
    state: State<'_, AppState>,
    project_generation: u64,
    id: String,
    raw_frontmatter: Option<String>,
    body: String,
    expected_revision: String,
) -> Result<String, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    let revision = posts::write_post(
        &ctx,
        &id,
        raw_frontmatter.as_deref(),
        &body,
        &expected_revision,
    )?;
    // 保存成功后：正文已引用的图片解除待提交标记，撤销后未引用的图片立即清理。
    if let Err(error) = state
        .pending_assets
        .lock()
        .expect("pending assets lock poisoned")
        .discard_post(&ctx.root, &id)
    {
        log::warn!("文章已保存，但清理未引用图片失败：{error}");
    }
    Ok(revision)
}

#[tauri::command]
pub async fn create_post(
    state: State<'_, AppState>,
    project_generation: u64,
    id: String,
    raw_frontmatter: Option<String>,
    body: String,
) -> Result<PostDocument, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    posts::create_post(&ctx, &id, raw_frontmatter.as_deref(), &body)
}

#[tauri::command]
pub async fn rename_post(
    state: State<'_, AppState>,
    project_generation: u64,
    old_id: String,
    new_id: String,
    expected_revision: String,
) -> Result<PostDocument, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    posts::validate_rename(&ctx, &old_id, &new_id, &expected_revision)?;
    let mut pending = state
        .pending_assets
        .lock()
        .expect("pending assets lock poisoned");
    // 命令边界也保证安全：即便绕过前端 dirty guard，未保存图片也不会被带进重命名。
    pending.discard_post(&ctx.root, &old_id)?;
    let document = posts::rename_post(&ctx, &old_id, &new_id, &expected_revision)?;
    pending.forget_post(&ctx.root, &old_id);
    Ok(document)
}

#[tauri::command]
pub async fn delete_post(
    state: State<'_, AppState>,
    project_generation: u64,
    id: String,
    expected_revision: String,
) -> Result<(), AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    if posts::read_post(&ctx, &id)?.revision != expected_revision {
        return Err(AppError::ExternalModificationConflict);
    }
    posts::delete_post(&ctx, &id, &expected_revision)?;
    state
        .pending_assets
        .lock()
        .expect("pending assets lock poisoned")
        .forget_post(&ctx.root, &id);
    Ok(())
}

#[tauri::command]
pub async fn list_tags(
    state: State<'_, AppState>,
    project_generation: u64,
) -> Result<HashMap<String, Vec<String>>, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    posts::list_tags(&ctx)
}
