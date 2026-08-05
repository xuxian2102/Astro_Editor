use serde::ser::{Error as _, SerializeStruct as _};
use serde::{Serialize, Serializer};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorCode {
    name: &'static str,
    params: &'static [&'static str],
}

impl ErrorCode {
    const fn new(name: &'static str, params: &'static [&'static str]) -> Self {
        Self { name, params }
    }
}

pub mod code {
    use super::ErrorCode;

    pub const NO_PROJECT: ErrorCode = ErrorCode::new("no_project", &[]);
    pub const STALE_PROJECT_SESSION: ErrorCode = ErrorCode::new("stale_project_session", &[]);
    pub const INVALID_PROJECT: ErrorCode = ErrorCode::new("invalid_project", &["detail"]);
    pub const CONFIG: ErrorCode = ErrorCode::new("config", &["detail"]);
    pub const INVALID_POST_ID: ErrorCode = ErrorCode::new("invalid_post_id", &["id"]);
    pub const NOT_FOUND: ErrorCode = ErrorCode::new("not_found", &["id"]);
    pub const ALREADY_EXISTS: ErrorCode = ErrorCode::new("already_exists", &["target"]);
    pub const EXTERNAL_MODIFICATION_CONFLICT: ErrorCode =
        ErrorCode::new("external_modification_conflict", &[]);
    pub const IO: ErrorCode = ErrorCode::new("io", &["detail"]);
    pub const CLIPBOARD: ErrorCode = ErrorCode::new("clipboard", &["detail"]);
    pub const GIT: ErrorCode = ErrorCode::new("git", &["detail"]);
    pub const PREVIEW: ErrorCode = ErrorCode::new("preview", &["detail"]);
    pub const GIT_UNRESOLVED_CONFLICTS: ErrorCode =
        ErrorCode::new("git_unresolved_conflicts", &["paths"]);
    pub const GIT_NOTHING_TO_COMMIT: ErrorCode = ErrorCode::new("git_nothing_to_commit", &[]);
    pub const GIT_STAGE_FAILED: ErrorCode = ErrorCode::new("git_stage_failed", &["detail"]);
    pub const GIT_COMMIT_FAILED: ErrorCode = ErrorCode::new("git_commit_failed", &["detail"]);
    pub const GIT_PUSH_NO_UPSTREAM: ErrorCode = ErrorCode::new("git_push_no_upstream", &[]);
    pub const GIT_PUSH_AUTHENTICATION_FAILED: ErrorCode =
        ErrorCode::new("git_push_authentication_failed", &[]);
    pub const GIT_PUSH_FAILED: ErrorCode = ErrorCode::new("git_push_failed", &[]);
    pub const GIT_PUSH_FAILED_DETAIL: ErrorCode =
        ErrorCode::new("git_push_failed_detail", &["detail"]);
    pub const PREVIEW_PORT_IN_USE: ErrorCode = ErrorCode::new("preview_port_in_use", &["port"]);
    pub const PREVIEW_SPAWN_FAILED: ErrorCode = ErrorCode::new("preview_spawn_failed", &["detail"]);
    pub const PREVIEW_EXITED_EARLY: ErrorCode = ErrorCode::new("preview_exited_early", &["exit"]);
    pub const PREVIEW_STARTUP_TIMEOUT: ErrorCode =
        ErrorCode::new("preview_startup_timeout", &["seconds"]);
    pub const PREVIEW_EXITED_UNEXPECTEDLY: ErrorCode =
        ErrorCode::new("preview_exited_unexpectedly", &["exit"]);

    #[cfg(test)]
    pub const ALL: &[ErrorCode] = &[
        NO_PROJECT,
        STALE_PROJECT_SESSION,
        INVALID_PROJECT,
        CONFIG,
        INVALID_POST_ID,
        NOT_FOUND,
        ALREADY_EXISTS,
        EXTERNAL_MODIFICATION_CONFLICT,
        IO,
        CLIPBOARD,
        GIT,
        PREVIEW,
        GIT_UNRESOLVED_CONFLICTS,
        GIT_NOTHING_TO_COMMIT,
        GIT_STAGE_FAILED,
        GIT_COMMIT_FAILED,
        GIT_PUSH_NO_UPSTREAM,
        GIT_PUSH_AUTHENTICATION_FAILED,
        GIT_PUSH_FAILED,
        GIT_PUSH_FAILED_DETAIL,
        PREVIEW_PORT_IN_USE,
        PREVIEW_SPAWN_FAILED,
        PREVIEW_EXITED_EARLY,
        PREVIEW_STARTUP_TIMEOUT,
        PREVIEW_EXITED_UNEXPECTEDLY,
    ];
}

#[derive(Debug, Clone, PartialEq)]
pub struct ErrorPayload {
    pub code: String,
    pub params: BTreeMap<String, Value>,
    pub fallback: String,
    expected_params: &'static [&'static str],
}

impl ErrorPayload {
    pub fn new(code: ErrorCode, fallback: impl Into<String>) -> Self {
        Self {
            code: code.name.to_owned(),
            params: BTreeMap::new(),
            fallback: fallback.into(),
            expected_params: code.params,
        }
    }

    pub fn with_param(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }
}

impl Serialize for ErrorPayload {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let actual_params = self.params.keys().map(String::as_str).collect::<Vec<_>>();
        let mut expected_params = self.expected_params.to_vec();
        expected_params.sort_unstable();
        if actual_params != expected_params {
            return Err(S::Error::custom(format!(
                "error code {} expects params {:?}, got {:?}",
                self.code, expected_params, actual_params
            )));
        }

        let mut state = serializer.serialize_struct("ErrorPayload", 3)?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("params", &self.params)?;
        state.serialize_field("fallback", &self.fallback)?;
        state.end()
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
    pub fn code(&self) -> ErrorCode {
        match self {
            AppError::NoProject => code::NO_PROJECT,
            AppError::StaleProjectSession => code::STALE_PROJECT_SESSION,
            AppError::InvalidProject(_) => code::INVALID_PROJECT,
            AppError::Config(_) => code::CONFIG,
            AppError::InvalidPostId(_) => code::INVALID_POST_ID,
            AppError::NotFound(_) => code::NOT_FOUND,
            AppError::AlreadyExists(_) => code::ALREADY_EXISTS,
            AppError::ExternalModificationConflict => code::EXTERNAL_MODIFICATION_CONFLICT,
            AppError::Io(_) => code::IO,
            AppError::Clipboard(_) => code::CLIPBOARD,
            AppError::Git(_) => code::GIT,
            AppError::Preview(_) => code::PREVIEW,
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
    use std::collections::BTreeMap;

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

    #[test]
    fn registered_codes_and_parameters_match_shared_manifest() {
        let expected: BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("../../shared/error-codes.json")).unwrap();
        let actual = code::ALL
            .iter()
            .map(|code| {
                (
                    code.name.to_owned(),
                    code.params
                        .iter()
                        .map(|param| (*param).to_owned())
                        .collect(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(actual, expected);
        assert_eq!(actual.len(), code::ALL.len(), "Rust 错误码常量不能重复");
    }

    #[test]
    fn refuses_to_serialize_payload_with_wrong_parameters() {
        let payload = ErrorPayload::new(code::NOT_FOUND, "missing parameter");
        let error = serde_json::to_value(payload).unwrap_err();
        assert!(error.to_string().contains("expects params"));
    }
}
