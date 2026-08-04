use std::fs;
use std::io::Write as _;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::model::{PostDocument, PostSummary, ProjectContext};
use crate::path_guard::resolve_post_path;

pub fn revision_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// 拆分 frontmatter 与正文。返回的 frontmatter 不含 `---` 分隔线并保留自身换行；
/// None 表示没有 frontmatter 块（含分隔线未闭合的情况——宁可整篇当正文也不丢内容）。
/// 对 LF 文件满足 join_markdown(split_markdown(x)) == x（BOM 会被剥离，见测试）。
pub fn split_markdown(text: &str) -> (Option<&str>, &str) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text
        .strip_prefix("---")
        .and_then(|t| t.strip_prefix("\r\n").or_else(|| t.strip_prefix('\n')))
    else {
        return (None, text);
    };

    let mut idx = 0;
    while idx < rest.len() {
        let line_end = rest[idx..]
            .find('\n')
            .map(|p| idx + p + 1)
            .unwrap_or(rest.len());
        let line = rest[idx..line_end].trim_end_matches(['\n', '\r']);
        if line == "---" {
            return (Some(&rest[..idx]), &rest[line_end..]);
        }
        idx = line_end;
    }
    (None, text)
}

pub fn join_markdown(raw_frontmatter: Option<&str>, body: &str) -> String {
    match raw_frontmatter {
        None => body.to_owned(),
        Some(fm) => {
            let mut s = String::with_capacity(fm.len() + body.len() + 10);
            s.push_str("---\n");
            s.push_str(fm);
            if !fm.is_empty() && !fm.ends_with('\n') {
                s.push('\n');
            }
            s.push_str("---\n");
            s.push_str(body);
            s
        }
    }
}

pub fn list_posts(ctx: &ProjectContext) -> Result<Vec<PostSummary>, AppError> {
    let mut out = Vec::new();
    walk(
        &ctx.content_root,
        &ctx.content_root,
        &ctx.config.extensions,
        &mut out,
    )?;
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn walk(
    root: &Path,
    dir: &Path,
    extensions: &[String],
    out: &mut Vec<PostSummary>,
) -> Result<(), AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        // 符号链接可能指向 content root 之外，路径守卫会拒绝打开，列表里干脆不显示
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            walk(root, &path, extensions, out)?;
        } else if has_allowed_extension(&path, extensions) {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| AppError::Io("路径前缀异常".into()))?;
            let id = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let modified_ms = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            out.push(PostSummary {
                relative_path: id.clone(),
                id,
                modified_ms,
            });
        }
    }
    Ok(())
}

fn has_allowed_extension(path: &Path, extensions: &[String]) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    extensions
        .iter()
        .any(|allowed| allowed.strip_prefix('.').unwrap_or(allowed) == ext)
}

pub fn read_post(ctx: &ProjectContext, id: &str) -> Result<PostDocument, AppError> {
    let path = resolve_post_path(&ctx.content_root, &ctx.config.extensions, id)?;
    let bytes = read_existing(&path, id)?;
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::Io(format!("文件不是 UTF-8 编码：{id}")))?;
    let revision = revision_of(text.as_bytes());
    let (fm, body) = split_markdown(&text);
    Ok(PostDocument {
        id: id.to_owned(),
        relative_path: id.to_owned(),
        raw_frontmatter: fm.map(str::to_owned),
        body: body.to_owned(),
        revision,
    })
}

pub fn write_post(
    ctx: &ProjectContext,
    id: &str,
    raw_frontmatter: Option<&str>,
    body: &str,
    expected_revision: &str,
) -> Result<String, AppError> {
    let path = resolve_post_path(&ctx.content_root, &ctx.config.extensions, id)?;
    let current = read_existing(&path, id)?;
    if revision_of(&current) != expected_revision {
        return Err(AppError::ExternalModificationConflict);
    }
    let content = join_markdown(raw_frontmatter, body);
    atomic_write(&path, content.as_bytes())?;
    Ok(revision_of(content.as_bytes()))
}

pub fn create_post(
    ctx: &ProjectContext,
    id: &str,
    raw_frontmatter: Option<&str>,
    body: &str,
) -> Result<PostDocument, AppError> {
    let path = resolve_post_path(&ctx.content_root, &ctx.config.extensions, id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = join_markdown(raw_frontmatter, body);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => AppError::AlreadyExists(id.to_owned()),
            _ => AppError::Io(e.to_string()),
        })?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    read_post(ctx, id)
}

pub fn rename_post(
    ctx: &ProjectContext,
    old_id: &str,
    new_id: &str,
) -> Result<PostSummary, AppError> {
    let old_path = resolve_post_path(&ctx.content_root, &ctx.config.extensions, old_id)?;
    let new_path = resolve_post_path(&ctx.content_root, &ctx.config.extensions, new_id)?;
    if !old_path.is_file() {
        return Err(AppError::NotFound(old_id.to_owned()));
    }
    if new_path.exists() {
        return Err(AppError::AlreadyExists(new_id.to_owned()));
    }
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&old_path, &new_path)?;
    let modified_ms = fs::metadata(&new_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(PostSummary {
        id: new_id.to_owned(),
        relative_path: new_id.to_owned(),
        modified_ms,
    })
}

fn read_existing(path: &Path, id: &str) -> Result<Vec<u8>, AppError> {
    fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(id.to_owned()),
        _ => AppError::Io(e.to_string()),
    })
}

/// 同目录临时文件 + rename，避免写到一半崩溃产生半截文件
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Io("目标路径没有父目录".into()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProjectConfig;

    fn ctx() -> (tempfile::TempDir, ProjectContext) {
        let dir = tempfile::tempdir().unwrap();
        let content_root = dir.path().canonicalize().unwrap();
        let ctx = ProjectContext {
            root: content_root.clone(),
            content_root,
            config: ProjectConfig::default(),
        };
        (dir, ctx)
    }

    #[test]
    fn split_lf_file() {
        let (fm, body) = split_markdown("---\ntitle: a\n---\n\n# Hi\n");
        assert_eq!(fm, Some("title: a\n"));
        assert_eq!(body, "\n# Hi\n");
    }

    #[test]
    fn split_crlf_file() {
        let (fm, body) = split_markdown("---\r\ntitle: a\r\n---\r\n\r\nhi");
        assert_eq!(fm, Some("title: a\r\n"));
        assert_eq!(body, "\r\nhi");
    }

    #[test]
    fn split_bom_is_stripped() {
        let (fm, body) = split_markdown("\u{feff}---\ntitle: a\n---\nbody");
        assert_eq!(fm, Some("title: a\n"));
        assert_eq!(body, "body");
    }

    #[test]
    fn split_no_frontmatter_and_unterminated() {
        assert_eq!(split_markdown("# 只有正文\n"), (None, "# 只有正文\n"));
        // 未闭合的 frontmatter：整篇当正文，不丢内容
        let text = "---\ntitle: a\n没有闭合";
        assert_eq!(split_markdown(text), (None, text));
        // 正文里的 --- 不受影响
        let (fm, body) = split_markdown("---\ntitle: a\n---\nx\n---\ny\n");
        assert_eq!(fm, Some("title: a\n"));
        assert_eq!(body, "x\n---\ny\n");
    }

    #[test]
    fn split_join_roundtrip_is_lossless_for_lf() {
        for text in [
            "---\ntitle: a # 注释\nweird: 'q'\n---\n\n# Hi\n\n正文\n",
            "---\ntitle: a\n---\n",
            "no frontmatter at all\n",
            "---\n---\nempty fm\n",
        ] {
            let (fm, body) = split_markdown(text);
            assert_eq!(join_markdown(fm, body), text, "roundtrip 失败：{text:?}");
        }
    }

    #[test]
    fn read_write_roundtrip_and_revision() {
        let (_dir, ctx) = ctx();
        let original = "---\n# 置顶注释\ntitle: \"hello\"\ncustom_field: keep-me\n---\n\n正文\n";
        std::fs::write(ctx.content_root.join("a.md"), original).unwrap();

        let doc = read_post(&ctx, "a.md").unwrap();
        assert_eq!(
            doc.raw_frontmatter.as_deref(),
            Some("# 置顶注释\ntitle: \"hello\"\ncustom_field: keep-me\n")
        );

        // 原样写回 → 文件字节不变
        let rev = write_post(
            &ctx,
            "a.md",
            doc.raw_frontmatter.as_deref(),
            &doc.body,
            &doc.revision,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(ctx.content_root.join("a.md")).unwrap(),
            original
        );
        assert_eq!(rev, doc.revision);
    }

    #[test]
    fn write_detects_external_modification() {
        let (_dir, ctx) = ctx();
        std::fs::write(ctx.content_root.join("a.md"), "---\nt: 1\n---\nx").unwrap();
        let doc = read_post(&ctx, "a.md").unwrap();

        // 模拟外部编辑器改了文件
        std::fs::write(ctx.content_root.join("a.md"), "---\nt: 2\n---\ny").unwrap();

        let result = write_post(&ctx, "a.md", None, "覆盖", &doc.revision);
        assert!(matches!(
            result,
            Err(AppError::ExternalModificationConflict)
        ));
        // 冲突时绝不落盘
        assert_eq!(
            std::fs::read_to_string(ctx.content_root.join("a.md")).unwrap(),
            "---\nt: 2\n---\ny"
        );
    }

    #[test]
    fn create_rejects_existing_and_rename_rejects_overwrite() {
        let (_dir, ctx) = ctx();
        create_post(&ctx, "a.md", Some("title: a\n"), "\nbody\n").unwrap();
        assert!(matches!(
            create_post(&ctx, "a.md", None, ""),
            Err(AppError::AlreadyExists(_))
        ));

        create_post(&ctx, "b.md", None, "b").unwrap();
        assert!(matches!(
            rename_post(&ctx, "a.md", "b.md"),
            Err(AppError::AlreadyExists(_))
        ));

        // 正常重命名（含新建子目录）
        let summary = rename_post(&ctx, "a.md", "2026/a-renamed.md").unwrap();
        assert_eq!(summary.id, "2026/a-renamed.md");
        assert!(ctx.content_root.join("2026/a-renamed.md").is_file());
        assert!(!ctx.content_root.join("a.md").exists());
    }

    #[test]
    fn fixture_smoke_readonly() {
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/test-blog");
        let ctx = crate::services::project::open_project(&fixture).unwrap();

        let ids: Vec<String> = list_posts(&ctx)
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert!(ids.contains(&"hello-astro.md".to_string()));
        assert!(ids.contains(&"nested/2026-plans.md".to_string()));

        // 每篇文章拆分/重组都必须无损（含正文代码块里的 --- 行）
        for id in &ids {
            let doc = read_post(&ctx, id).unwrap();
            let raw = std::fs::read_to_string(ctx.content_root.join(id)).unwrap();
            assert_eq!(
                join_markdown(doc.raw_frontmatter.as_deref(), &doc.body),
                raw,
                "{id} 拆分/重组必须无损"
            );
        }

        let tricky = read_post(&ctx, "tricky-frontmatter.md").unwrap();
        let fm = tricky.raw_frontmatter.unwrap();
        assert!(fm.contains("# 这条注释必须在保存后原样保留"));
        assert!(fm.contains("legacy_field"));

        let plain = read_post(&ctx, "no-frontmatter.md").unwrap();
        assert!(plain.raw_frontmatter.is_none());
    }

    #[test]
    fn list_skips_hidden_and_non_matching() {
        let (_dir, ctx) = ctx();
        std::fs::write(ctx.content_root.join("a.md"), "a").unwrap();
        std::fs::create_dir_all(ctx.content_root.join("nested")).unwrap();
        std::fs::write(ctx.content_root.join("nested/b.md"), "b").unwrap();
        std::fs::write(ctx.content_root.join(".hidden.md"), "h").unwrap();
        std::fs::write(ctx.content_root.join("notes.txt"), "t").unwrap();

        let ids: Vec<String> = list_posts(&ctx).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["a.md".to_string(), "nested/b.md".to_string()]);
    }
}
