use std::sync::atomic::AtomicU64;
use std::sync::{Mutex, RwLock};

use crate::model::ProjectContext;
use crate::services::assets::PendingAssetManager;
use crate::services::preview::PreviewManager;

/// 按用途分锁，不用一把大锁
#[derive(Default)]
pub struct AppState {
    /// project root 只存在这里；前端只见 PostId，从不传绝对路径
    pub project: RwLock<Option<ProjectContext>>,
    /// 每次选择新项目递增；延迟图片任务必须携带打开时的 generation。
    pub project_generation: AtomicU64,
    /// 串行化文章/资产的短时落盘操作，并与项目切换互斥。
    pub content_lock: Mutex<()>,
    /// save_image 已创建、但尚未随文章保存确认的文件。
    pub pending_assets: Mutex<PendingAssetManager>,
    /// 覆盖整个 stage→commit→push 序列，防止并发发布
    pub git_lock: Mutex<()>,
    /// tokio::sync::Mutex：只在持锁期间做状态读写，从不跨越 HTTP 探测/子进程等待
    pub preview: tokio::sync::Mutex<PreviewManager>,
}
