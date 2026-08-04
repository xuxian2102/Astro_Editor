use std::path::{Component, Path};

use crate::error::AppError;
use crate::model::{ProjectConfig, ProjectContext, CONFIG_VERSION};

pub const CONFIG_FILE: &str = ".blog-editor.json";

pub fn open_project(root: &Path) -> Result<ProjectContext, AppError> {
    let root = root
        .canonicalize()
        .map_err(|e| AppError::InvalidProject(format!("{}：{e}", root.display())))?;
    if !root.is_dir() {
        return Err(AppError::InvalidProject(format!(
            "不是目录：{}",
            root.display()
        )));
    }

    let config_path = root.join(CONFIG_FILE);
    let raw = std::fs::read_to_string(&config_path).map_err(|_| {
        AppError::Config(format!("项目根目录缺少 {CONFIG_FILE}，请先在博客项目里创建它"))
    })?;
    let config: ProjectConfig = serde_json::from_str(&raw)
        .map_err(|e| AppError::Config(format!("{CONFIG_FILE} 解析失败：{e}")))?;
    if config.version != CONFIG_VERSION {
        return Err(AppError::Config(format!(
            "不支持的配置版本 {}（当前支持 {CONFIG_VERSION}）",
            config.version
        )));
    }

    // contentDir 必须是项目内的相对路径，规则与 PostId 同样严格
    let content_rel = Path::new(&config.content_dir);
    if content_rel.is_absolute()
        || !content_rel
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(AppError::Config(format!(
            "contentDir 非法：{}",
            config.content_dir
        )));
    }
    let content_root = root
        .join(content_rel)
        .canonicalize()
        .map_err(|_| AppError::Config(format!("contentDir 不存在：{}", config.content_dir)))?;
    if !content_root.is_dir() || !content_root.starts_with(&root) {
        return Err(AppError::Config(format!(
            "contentDir 非法：{}",
            config.content_dir
        )));
    }

    Ok(ProjectContext {
        root,
        content_root,
        config,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(config_json: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/content/blog")).unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), config_json).unwrap();
        dir
    }

    #[test]
    fn loads_valid_config_with_defaults() {
        let dir = setup(r#"{ "version": 1 }"#);
        let ctx = open_project(dir.path()).unwrap();
        assert_eq!(ctx.config.content_dir, "src/content/blog");
        assert_eq!(ctx.config.extensions, vec![".md".to_string()]);
        assert!(ctx.content_root.ends_with("src/content/blog"));
    }

    #[test]
    fn parses_frontmatter_fields() {
        let dir = setup(
            r#"{
              "version": 1,
              "frontmatter": { "fields": [
                { "name": "title", "type": "string", "required": true },
                { "name": "draft", "type": "boolean", "default": false }
              ]}
            }"#,
        );
        let ctx = open_project(dir.path()).unwrap();
        assert_eq!(ctx.config.frontmatter.fields.len(), 2);
        assert_eq!(ctx.config.frontmatter.fields[0].field_type, "string");
        assert!(ctx.config.frontmatter.fields[0].required);
    }

    #[test]
    fn rejects_missing_config_wrong_version_and_bad_content_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(open_project(dir.path()), Err(AppError::Config(_))));

        let dir = setup(r#"{ "version": 99 }"#);
        assert!(matches!(open_project(dir.path()), Err(AppError::Config(_))));

        let dir = setup(r#"{ "version": 1, "contentDir": "/etc" }"#);
        assert!(matches!(open_project(dir.path()), Err(AppError::Config(_))));

        let dir = setup(r#"{ "version": 1, "contentDir": "../outside" }"#);
        assert!(matches!(open_project(dir.path()), Err(AppError::Config(_))));

        let dir = setup(r#"{ "version": 1, "contentDir": "does/not/exist" }"#);
        assert!(matches!(open_project(dir.path()), Err(AppError::Config(_))));
    }
}
