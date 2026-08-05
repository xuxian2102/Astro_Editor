use serde::{Serialize, Serializer};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub params: BTreeMap<String, Value>,
    pub fallback: String,
}

impl ErrorPayload {
    pub fn new(code: impl Into<String>, fallback: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
            fallback: fallback.into(),
        }
    }

    pub fn with_param(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }
}

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

    pub fn payload(&self) -> ErrorPayload {
        let payload = ErrorPayload::new(self.code(), self.to_string());
        match self {
            AppError::NoProject
            | AppError::StaleProjectSession
            | AppError::ExternalModificationConflict => payload,
            AppError::InvalidProject(detail)
            | AppError::Config(detail)
            | AppError::Io(detail)
            | AppError::Clipboard(detail)
            | AppError::Git(detail)
            | AppError::Preview(detail) => payload.with_param("detail", detail.clone()),
            AppError::InvalidPostId(id) | AppError::NotFound(id) => {
                payload.with_param("id", id.clone())
            }
            AppError::AlreadyExists(target) => payload.with_param("target", target.clone()),
        }
    }
}

// 所有 Tauri 命令错误统一为 { code, params, fallback }。前端优先按 code 翻译，
// 新旧版本不认识该 code 时仍可展示 fallback，不能把诊断退化成 [object Object]。
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.payload().serialize(serializer)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_parameterized_error_protocol() {
        let value = serde_json::to_value(AppError::NotFound("nested/post.md".into())).unwrap();
        assert_eq!(
            value,
            json!({
                "code": "not_found",
                "params": { "id": "nested/post.md" },
                "fallback": "文章不存在：nested/post.md"
            })
        );
    }

    #[test]
    fn serializes_errors_without_parameters_as_empty_objects() {
        let value = serde_json::to_value(AppError::NoProject).unwrap();
        assert_eq!(
            value,
            json!({
                "code": "no_project",
                "params": {},
                "fallback": "当前没有打开的项目"
            })
        );
    }

    #[test]
    fn preserves_diagnostic_details_as_parameters_and_fallback() {
        let payload = AppError::Io("permission denied".into()).payload();
        assert_eq!(payload.params["detail"], "permission denied");
        assert_eq!(payload.fallback, "IO 错误：permission denied");
    }
}
