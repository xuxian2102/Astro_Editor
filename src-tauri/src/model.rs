use crate::error::ErrorPayload;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSummary {
    pub id: String,
    pub relative_path: String,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostDocument {
    pub id: String,
    pub relative_path: String,
    /// frontmatter 原始 YAML 文本（不含 `---` 分隔线）；None 表示文件没有 frontmatter 块
    pub raw_frontmatter: Option<String>,
    pub body: String,
    /// 整个文件字节的 SHA-256，保存时回传用于检测外部修改
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDocument {
    pub post_id: String,
    pub raw_frontmatter: Option<String>,
    pub body: String,
    pub base_revision: String,
    pub saved_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    /// 可以直接写入 Markdown 图片目标的、相对文章文件的路径。
    pub markdown_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub version: u32,
    #[serde(default = "default_content_dir")]
    pub content_dir: String,
    #[serde(default = "default_extensions")]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub frontmatter: FrontmatterConfig,
    #[serde(default)]
    pub preview: PreviewConfig,
    #[serde(default)]
    pub assets: AssetsConfig,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            content_dir: default_content_dir(),
            extensions: default_extensions(),
            frontmatter: FrontmatterConfig::default(),
            preview: PreviewConfig::default(),
            assets: AssetsConfig::default(),
        }
    }
}

fn default_content_dir() -> String {
    "src/content/blog".into()
}

fn default_extensions() -> Vec<String> {
    vec![".md".into()]
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FrontmatterConfig {
    #[serde(default)]
    pub fields: Vec<FieldSpec>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsConfig {
    #[serde(default)]
    pub mode: AssetMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetMode {
    /// 图片放在文章同目录下、与文章 stem 同名的子目录中。
    #[default]
    Colocated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConfig {
    #[serde(default = "default_preview_command")]
    pub command: String,
    #[serde(default = "default_preview_args")]
    pub args: Vec<String>,
    #[serde(default = "default_preview_host")]
    pub host: String,
    #[serde(default = "default_preview_port")]
    pub port: u16,
    #[serde(default)]
    pub route_template: Option<String>,
}

impl Default for PreviewConfig {
    fn default() -> Self {
        Self {
            command: default_preview_command(),
            args: default_preview_args(),
            host: default_preview_host(),
            port: default_preview_port(),
            route_template: None,
        }
    }
}

fn default_preview_command() -> String {
    "node_modules/.bin/astro".into()
}

fn default_preview_args() -> Vec<String> {
    vec!["dev".into()]
}

fn default_preview_host() -> String {
    "127.0.0.1".into()
}

fn default_preview_port() -> u16 {
    4321
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
}

/// 只存在 Rust 侧的项目上下文；root/content_root 均已 canonicalize
#[derive(Debug, Clone)]
pub struct ProjectContext {
    pub root: PathBuf,
    pub content_root: PathBuf,
    pub config: ProjectConfig,
}

/// 给前端展示用的项目信息（root 仅用于显示，前端永远不回传路径）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root: String,
    pub generation: u64,
    pub config: ProjectConfig,
}

impl ProjectContext {
    pub fn info(&self, generation: u64) -> ProjectInfo {
        ProjectInfo {
            root: self.root.display().to_string(),
            generation,
            config: self.config.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Unmerged,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// 相对 project root 的路径
    pub path: String,
    /// 仅重命名时存在
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    /// 变更是否已在 git 索引里（相对 HEAD）
    pub staged: bool,
    /// 是否落在 content_dir 内——只有这些会被 publish 暂存
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub staged: bool,
    pub staged_files: Vec<String>,
    pub committed: bool,
    pub commit_hash: Option<String>,
    pub pushed: bool,
    /// "stage" | "commit" | "push"，None 表示全部成功（或未尝试推送）
    pub error_stage: Option<String>,
    pub error: Option<ErrorPayload>,
}

/// 预览服务生命周期状态机：Stopped → Starting → Ready → Stopping → Stopped。
/// generation 用于让后台任务能核对自己发起的这一轮启动是否还是"当前"这一轮，
/// 防止过期的后台任务在新一轮开始后才姗姗来迟地覆盖状态。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PreviewStatus {
    #[default]
    Stopped,
    Starting {
        generation: u64,
        started_at_ms: u64,
    },
    Ready {
        generation: u64,
        url: String,
        pid: u32,
    },
    Stopping {
        generation: u64,
    },
    Failed {
        generation: u64,
        error: ErrorPayload,
        log_tail: String,
    },
}

#[cfg(test)]
mod tests {
    use super::PreviewStatus;
    use super::PublishResult;
    use crate::error::{AppError, ErrorPayload};

    #[test]
    fn preview_status_uses_the_typescript_field_names() {
        let starting = serde_json::to_value(PreviewStatus::Starting {
            generation: 2,
            started_at_ms: 123,
        })
        .unwrap();
        assert_eq!(starting["phase"], "starting");
        assert_eq!(starting["startedAtMs"], 123);
        assert!(starting.get("started_at_ms").is_none());

        let failed = serde_json::to_value(PreviewStatus::Failed {
            generation: 2,
            error: AppError::Preview("boom".into()).payload(),
            log_tail: "details".into(),
        })
        .unwrap();
        assert_eq!(failed["logTail"], "details");
        assert_eq!(failed["error"]["code"], "preview");
        assert!(failed.get("log_tail").is_none());
    }

    #[test]
    fn publish_result_uses_structured_error_payload() {
        let result = serde_json::to_value(PublishResult {
            staged: false,
            staged_files: vec![],
            committed: false,
            commit_hash: None,
            pushed: false,
            error_stage: Some("stage".into()),
            error: Some(ErrorPayload::git_nothing_to_commit("没有可提交的改动")),
        })
        .unwrap();

        assert_eq!(result["errorStage"], "stage");
        assert_eq!(result["error"]["code"], "git_nothing_to_commit");
        assert!(result.get("message").is_none());
    }
}
