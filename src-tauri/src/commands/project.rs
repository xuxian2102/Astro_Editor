use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::model::{ProjectConfig, ProjectInfo};
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
    // 切换项目前等旧项目的整个预览进程组退出，避免两个项目短暂共享端口/窗口。
    preview::stop_and_wait(&app).await?;
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let old_root = state
        .project
        .read()
        .expect("project lock poisoned")
        .as_ref()
        .map(|project| project.root.clone());
    if let Some(old_root) = old_root {
        state
            .pending_assets
            .lock()
            .expect("pending assets lock poisoned")
            .discard_project(&old_root)?;
    }
    *state.project.write().expect("project lock poisoned") = Some(ctx);
    let generation = state.project_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let info = state
        .project
        .read()
        .expect("project lock poisoned")
        .as_ref()
        .expect("project was just set")
        .info(generation);
    Ok(Some(info))
}

#[tauri::command]
pub async fn get_project(state: State<'_, AppState>) -> Result<Option<ProjectInfo>, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let generation = state.project_generation.load(Ordering::Acquire);
    Ok(state
        .project
        .read()
        .expect("project lock poisoned")
        .as_ref()
        .map(|ctx| ctx.info(generation)))
}

/// 结构化更新项目配置。第一版不允许通过设置面板迁移内容目录或切换资产布局；
/// 这两项会牵涉文章/图片移动，必须由未来单独的迁移命令处理。
#[tauri::command]
pub async fn update_project_config(
    app: AppHandle,
    state: State<'_, AppState>,
    project_generation: u64,
    config: ProjectConfig,
) -> Result<ProjectInfo, AppError> {
    let info = {
        let _content_guard = state.content_lock.lock().expect("content lock poisoned");
        let current = super::current_project_at(&state, project_generation)?;
        if config.content_dir != current.config.content_dir {
            return Err(AppError::Config(
                "contentDir 暂不支持在设置中修改；目录迁移需要单独执行".into(),
            ));
        }
        if config.assets != current.config.assets {
            return Err(AppError::Config(
                "assets 暂不支持在设置中修改；资产迁移需要单独执行".into(),
            ));
        }

        let updated = services::project::write_project_config(&current.root, config)?;
        let generation = state.project_generation.load(Ordering::Acquire);
        let info = updated.info(generation);
        *state.project.write().expect("project lock poisoned") = Some(updated);
        info
    };

    // 新配置可能改变命令、端口或路由。写盘成功后取消旧预览；停止流程异步收尾，
    // 不持有 content_lock，也不把清理失败伪装成配置保存失败。
    if let Err(error) = preview::stop(&app).await {
        log::warn!("项目配置已保存，但停止旧预览失败：{error}");
    }
    Ok(info)
}
