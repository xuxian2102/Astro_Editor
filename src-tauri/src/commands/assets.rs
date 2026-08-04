use percent_encoding::percent_decode_str;
use tauri::State;

use super::current_project_at;
use crate::error::AppError;
use crate::model::SavedImage;
use crate::services::{assets, clipboard};
use crate::state::AppState;

#[tauri::command]
pub async fn save_image(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<SavedImage, AppError> {
    let post_id = decode_header(&request, "post-id")?
        .ok_or_else(|| AppError::InvalidPostId("缺少 post-id".into()))?;
    let project_generation = decode_header(&request, "project-generation")?
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(AppError::StaleProjectSession)?;
    let suggested_name = decode_header(&request, "suggested-name")?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err(AppError::Io("图片上传必须使用原始二进制 IPC".into())),
    };
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    let outcome = assets::save_image(&ctx, &post_id, suggested_name.as_deref(), bytes)?;
    if let Some(pending) = outcome.pending {
        state
            .pending_assets
            .lock()
            .expect("pending assets lock poisoned")
            .track(pending);
    }
    Ok(outcome.image)
}

fn decode_header(
    request: &tauri::ipc::Request<'_>,
    name: &str,
) -> Result<Option<String>, AppError> {
    let Some(value) = request.headers().get(name) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| AppError::Io(format!("图片上传头 {name} 不是有效文本")))?;
    let decoded = percent_decode_str(value)
        .decode_utf8()
        .map_err(|_| AppError::Io(format!("图片上传头 {name} 不是 UTF-8")))?;
    Ok(Some(decoded.into_owned()))
}

/// 给受信编辑器窗口返回图片原始字节。路径解析和 content_root 边界都在 service 内完成，
/// 使用 IPC 原始响应避免把二进制膨胀成 JSON 数字数组。
#[tauri::command]
pub async fn read_image_asset(
    state: State<'_, AppState>,
    project_generation: u64,
    post_id: String,
    markdown_path: String,
) -> Result<tauri::ipc::Response, AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    let bytes = assets::read_image_asset(&ctx, &post_id, &markdown_path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 原生读取并保存剪贴板图片。读取系统剪贴板可能等待 Wayland/X11 provider 返回数据，
/// 必须放到 blocking worker；保存阶段再进入内容锁，复用统一的路径守卫与 pending 事务。
#[tauri::command]
pub async fn import_clipboard_images(
    state: State<'_, AppState>,
    project_generation: u64,
    post_id: String,
) -> Result<Vec<SavedImage>, AppError> {
    let initial_project_root = {
        let _content_guard = state.content_lock.lock().expect("content lock poisoned");
        let ctx = current_project_at(&state, project_generation)?;
        // 在触碰系统剪贴板前先拒绝非法文章 ID。
        let _ = assets::asset_dir_for_post(&ctx, &post_id)?;
        ctx.root
    };

    let clipboard_images = tauri::async_runtime::spawn_blocking(clipboard::read_images)
        .await
        .map_err(|error| AppError::Clipboard(format!("剪贴板读取任务异常结束：{error}")))??;

    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    if ctx.root != initial_project_root {
        return Err(AppError::Clipboard(
            "读取剪贴板期间项目已切换，请在当前文章中重新粘贴".into(),
        ));
    }

    let mut saved_images = Vec::with_capacity(clipboard_images.len());
    let mut pending_assets = Vec::new();
    for image in clipboard_images {
        let outcome = match assets::save_image(
            &ctx,
            &post_id,
            image.suggested_name.as_deref(),
            &image.bytes,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                // 只回滚本次批量导入已经写入的图片；此前编辑会话的 pending 不受影响。
                let failed_cleanup = assets::rollback_pending_assets(pending_assets);
                let mut manager = state
                    .pending_assets
                    .lock()
                    .expect("pending assets lock poisoned");
                for pending in failed_cleanup {
                    manager.track(pending);
                }
                return Err(error);
            }
        };
        saved_images.push(outcome.image);
        if let Some(pending) = outcome.pending {
            pending_assets.push(pending);
        }
    }

    let mut manager = state
        .pending_assets
        .lock()
        .expect("pending assets lock poisoned");
    for pending in pending_assets {
        manager.track(pending);
    }
    Ok(saved_images)
}

#[tauri::command]
pub async fn discard_pending_images(
    state: State<'_, AppState>,
    project_generation: u64,
    post_id: String,
) -> Result<(), AppError> {
    let _content_guard = state.content_lock.lock().expect("content lock poisoned");
    let ctx = current_project_at(&state, project_generation)?;
    let _ = assets::asset_dir_for_post(&ctx, &post_id)?;
    state
        .pending_assets
        .lock()
        .expect("pending assets lock poisoned")
        .discard_post(&ctx.root, &post_id)?;
    Ok(())
}
