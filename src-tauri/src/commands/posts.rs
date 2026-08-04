use std::collections::HashMap;

use tauri::State;

use super::current_project;
use crate::error::AppError;
use crate::model::{PostDocument, PostSummary};
use crate::services::posts;
use crate::state::AppState;

#[tauri::command]
pub async fn list_posts(state: State<'_, AppState>) -> Result<Vec<PostSummary>, AppError> {
    let ctx = current_project(&state)?;
    posts::list_posts(&ctx)
}

#[tauri::command]
pub async fn read_post(
    state: State<'_, AppState>,
    id: String,
) -> Result<PostDocument, AppError> {
    let ctx = current_project(&state)?;
    posts::read_post(&ctx, &id)
}

#[tauri::command]
pub async fn write_post(
    state: State<'_, AppState>,
    id: String,
    raw_frontmatter: Option<String>,
    body: String,
    expected_revision: String,
) -> Result<String, AppError> {
    let ctx = current_project(&state)?;
    posts::write_post(
        &ctx,
        &id,
        raw_frontmatter.as_deref(),
        &body,
        &expected_revision,
    )
}

#[tauri::command]
pub async fn create_post(
    state: State<'_, AppState>,
    id: String,
    raw_frontmatter: Option<String>,
    body: String,
) -> Result<PostDocument, AppError> {
    let ctx = current_project(&state)?;
    posts::create_post(&ctx, &id, raw_frontmatter.as_deref(), &body)
}

#[tauri::command]
pub async fn rename_post(
    state: State<'_, AppState>,
    old_id: String,
    new_id: String,
) -> Result<PostSummary, AppError> {
    let ctx = current_project(&state)?;
    posts::rename_post(&ctx, &old_id, &new_id)
}

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> Result<HashMap<String, Vec<String>>, AppError> {
    let ctx = current_project(&state)?;
    posts::list_tags(&ctx)
}
