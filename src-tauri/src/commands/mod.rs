pub mod assets;
pub mod drafts;
pub mod git;
pub mod posts;
pub mod preview;
pub mod project;

use crate::error::AppError;
use crate::model::ProjectContext;
use crate::state::AppState;
use std::sync::atomic::Ordering;

/// 在锁内只做 clone，之后的 IO 都不持有锁
pub(crate) fn current_project(state: &AppState) -> Result<ProjectContext, AppError> {
    state
        .project
        .read()
        .expect("project lock poisoned")
        .clone()
        .ok_or(AppError::NoProject)
}

/// 图片任务可能在读取 File/剪贴板期间跨越项目切换；generation 不匹配时必须拒绝。
/// 调用方在检查期间持有 content_lock，使 generation 与 ProjectContext 成为一致快照。
pub(crate) fn current_project_at(
    state: &AppState,
    expected_generation: u64,
) -> Result<ProjectContext, AppError> {
    if state.project_generation.load(Ordering::Acquire) != expected_generation {
        return Err(AppError::StaleProjectSession);
    }
    current_project(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProjectConfig;

    #[test]
    fn project_generation_rejects_late_requests() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let state = AppState::default();
        *state.project.write().unwrap() = Some(ProjectContext {
            root: root.clone(),
            content_root: root,
            config: ProjectConfig::default(),
        });
        state.project_generation.store(7, Ordering::Release);

        assert!(current_project_at(&state, 7).is_ok());
        assert!(matches!(
            current_project_at(&state, 6),
            Err(AppError::StaleProjectSession)
        ));
    }
}
