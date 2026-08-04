use tauri::State;

use super::current_project;
use crate::error::AppError;
use crate::services::assets;
use crate::state::AppState;

#[tauri::command]
pub async fn save_image(
    state: State<'_, AppState>,
    post_id: String,
    suggested_name: Option<String>,
    bytes: Vec<u8>,
) -> Result<String, AppError> {
    let ctx = current_project(&state)?;
    assets::save_image(&ctx, &post_id, suggested_name.as_deref(), &bytes)
}
