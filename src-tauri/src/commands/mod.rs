pub mod git;
pub mod posts;
pub mod preview;
pub mod project;

use crate::error::AppError;
use crate::model::ProjectContext;
use crate::state::AppState;

/// 在锁内只做 clone，之后的 IO 都不持有锁
pub(crate) fn current_project(state: &AppState) -> Result<ProjectContext, AppError> {
    state
        .project
        .read()
        .expect("project lock poisoned")
        .clone()
        .ok_or(AppError::NoProject)
}
