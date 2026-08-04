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
pub struct ProjectConfig {
    pub version: u32,
    #[serde(default = "default_content_dir")]
    pub content_dir: String,
    #[serde(default = "default_extensions")]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub frontmatter: FrontmatterConfig,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            content_dir: default_content_dir(),
            extensions: default_extensions(),
            frontmatter: FrontmatterConfig::default(),
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
    pub config: ProjectConfig,
}

impl ProjectContext {
    pub fn info(&self) -> ProjectInfo {
        ProjectInfo {
            root: self.root.display().to_string(),
            config: self.config.clone(),
        }
    }
}
