use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::model::ProjectInfo;
use crate::services;
use crate::services::preview;
use crate::state::AppState;

/// 弹文件夹选择器并打开所选项目；用户取消时返回 None。
/// 路径由对话框直达 Rust，前端全程不经手。
#[tauri::command]
pub async fn select_project(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ProjectInfo>, AppError> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::InvalidProject(e.to_string()))?;
    let ctx = services::project::open_project(&path)?;
    let info = ctx.info();
    // 切换项目前先请求停止旧项目的预览（只发取消信号，不等真正停下——
    // 新项目的预览状态从 Stopped 开始，旧一轮的后台任务会靠 generation 自行收尾）
    preview::stop(&app).await?;
    *state.project.write().expect("project lock poisoned") = Some(ctx);
    Ok(Some(info))
}

#[tauri::command]
pub async fn get_project(state: State<'_, AppState>) -> Result<Option<ProjectInfo>, AppError> {
    Ok(state
        .project
        .read()
        .expect("project lock poisoned")
        .as_ref()
        .map(|ctx| ctx.info()))
}
