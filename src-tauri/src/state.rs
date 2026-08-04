use std::sync::RwLock;

use crate::model::ProjectContext;

/// 按用途分锁（阶段 3/4 会加 preview、git_lock），不用一把大锁
#[derive(Default)]
pub struct AppState {
    /// project root 只存在这里；前端只见 PostId，从不传绝对路径
    pub project: RwLock<Option<ProjectContext>>,
}
