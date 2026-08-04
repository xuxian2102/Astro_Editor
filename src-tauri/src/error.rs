use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("当前没有打开的项目")]
    NoProject,
    #[error("项目已经切换，请在当前文章中重试此操作")]
    StaleProjectSession,
    #[error("项目目录无效：{0}")]
    InvalidProject(String),
    #[error("配置文件错误：{0}")]
    Config(String),
    #[error("非法的文章标识：{0}")]
    InvalidPostId(String),
    #[error("文章不存在：{0}")]
    NotFound(String),
    #[error("目标已存在：{0}")]
    AlreadyExists(String),
    #[error("文件在外部被修改，保存已中止")]
    ExternalModificationConflict,
    #[error("IO 错误：{0}")]
    Io(String),
    #[error("剪贴板错误：{0}")]
    Clipboard(String),
    #[error("Git 错误：{0}")]
    Git(String),
    #[error("预览错误：{0}")]
    Preview(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NoProject => "no_project",
            AppError::StaleProjectSession => "stale_project_session",
            AppError::InvalidProject(_) => "invalid_project",
            AppError::Config(_) => "config",
            AppError::InvalidPostId(_) => "invalid_post_id",
            AppError::NotFound(_) => "not_found",
            AppError::AlreadyExists(_) => "already_exists",
            AppError::ExternalModificationConflict => "external_modification_conflict",
            AppError::Io(_) => "io",
            AppError::Clipboard(_) => "clipboard",
            AppError::Git(_) => "git",
            AppError::Preview(_) => "preview",
        }
    }
}

// 前端拿到 { code, message }，靠 code 区分冲突等需要特殊 UI 的错误
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}
