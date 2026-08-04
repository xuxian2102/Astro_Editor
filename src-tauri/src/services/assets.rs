use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::model::ProjectContext;
use crate::path_guard::resolve_post_path;
use crate::services::posts::revision_of;
use crate::services::preview::resolve_slug;

/// 只取 basename，拒绝空/`.`/`..`——天然防路径穿越，不需要额外正则
fn sanitize_filename(name: &str) -> Option<String> {
    let base = Path::new(name).file_name()?.to_str()?;
    if base.is_empty() || base == "." || base == ".." {
        return None;
    }
    Some(base.to_string())
}

/// `dir/desired` 已存在时在扩展名前插 `-1`/`-2`/... 直到找到未占用的名字
fn unique_filename(dir: &Path, desired: &str) -> String {
    if !dir.join(desired).exists() {
        return desired.to_string();
    }
    let path = Path::new(desired);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(desired);
    let ext = path.extension().and_then(|s| s.to_str());
    for i in 1u32.. {
        let candidate = match ext {
            Some(ext) => format!("{stem}-{i}.{ext}"),
            None => format!("{stem}-{i}"),
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!("dir 里不可能有无限多个同名候选文件")
}

/// 剪贴板粘贴没有文件名，只能从字节内容猜扩展名；不引入图片处理库，只做磁数嗅探
fn sniff_image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn asset_dir_for_post(content_root: &Path, post_id: &str) -> PathBuf {
    content_root.join(resolve_slug(post_id))
}

/// 保存一张图片到文章的同名资产子目录，返回可以直接写进 Markdown 的相对路径（`"{stem}/{filename}"`）。
pub fn save_image(
    ctx: &ProjectContext,
    post_id: &str,
    suggested_name: Option<&str>,
    bytes: &[u8],
) -> Result<String, AppError> {
    let post_path = resolve_post_path(&ctx.content_root, &ctx.config.extensions, post_id)?;
    if !post_path.is_file() {
        return Err(AppError::NotFound(post_id.to_owned()));
    }

    let stem = resolve_slug(post_id);
    let asset_dir = asset_dir_for_post(&ctx.content_root, post_id);
    std::fs::create_dir_all(&asset_dir)?;
    // 双重校验：跟 path_guard 一贯的风格一致，即便 stem 来自已校验过的 post_id 也再核对一次
    let canon = asset_dir.canonicalize()?;
    if !canon.starts_with(&ctx.content_root) {
        return Err(AppError::InvalidPostId(post_id.to_owned()));
    }

    let final_name = match suggested_name.and_then(sanitize_filename) {
        // 有真实文件名（拖拽）：不同内容撞同名是正常情况，交给 unique_filename 加后缀
        Some(name) => unique_filename(&asset_dir, &name),
        // 没有文件名（剪贴板粘贴）：内容寻址命名，同样的字节天然映射到同一个文件名，
        // 已存在就直接复用（不重复占地方），不能走 unique_filename 那套"名字冲突就加后缀"的逻辑
        None => {
            let ext = sniff_image_extension(bytes).unwrap_or("png");
            format!("{}.{ext}", &revision_of(bytes)[..8])
        }
    };
    if !asset_dir.join(&final_name).exists() {
        std::fs::write(asset_dir.join(&final_name), bytes)?;
    }

    Ok(format!("{stem}/{final_name}"))
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

    const PNG_MAGIC: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    #[test]
    fn sanitize_filename_strips_to_basename_and_rejects_empty() {
        assert_eq!(sanitize_filename("cover.png"), Some("cover.png".into()));
        // 只取 basename——"../evil.png" 被归约成安全的 "evil.png"，不是拒绝整个请求；
        // 反正只会拼到 asset_dir 下面当直接子文件，取到什么 basename 都逃不出 asset_dir
        assert_eq!(sanitize_filename("../evil.png"), Some("evil.png".into()));
        assert_eq!(sanitize_filename("a/b.png"), Some("b.png".into()));
        assert_eq!(sanitize_filename(""), None);
        assert_eq!(sanitize_filename("."), None);
        assert_eq!(sanitize_filename(".."), None);
    }

    #[test]
    fn unique_filename_increments_on_conflict() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unique_filename(dir.path(), "a.png"), "a.png");

        std::fs::write(dir.path().join("a.png"), "x").unwrap();
        assert_eq!(unique_filename(dir.path(), "a.png"), "a-1.png");

        std::fs::write(dir.path().join("a-1.png"), "x").unwrap();
        assert_eq!(unique_filename(dir.path(), "a.png"), "a-2.png");
    }

    #[test]
    fn sniff_image_extension_detects_known_formats() {
        assert_eq!(sniff_image_extension(PNG_MAGIC), Some("png"));
        assert_eq!(sniff_image_extension(&[0xFF, 0xD8, 0xFF, 0x00]), Some("jpg"));
        assert_eq!(sniff_image_extension(b"GIF89a..."), Some("gif"));
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(sniff_image_extension(&webp), Some("webp"));
        assert_eq!(sniff_image_extension(b"not an image"), None);
    }

    fn make_post(ctx: &ProjectContext, id: &str) {
        std::fs::write(ctx.content_root.join(id), "---\ntitle: x\n---\nbody").unwrap();
    }

    #[test]
    fn save_image_with_suggested_name_lands_in_stem_dir() {
        let (_dir, ctx) = ctx();
        make_post(&ctx, "hello.md");

        let rel = save_image(&ctx, "hello.md", Some("cover.png"), PNG_MAGIC).unwrap();
        assert_eq!(rel, "hello/cover.png");
        assert!(ctx.content_root.join("hello/cover.png").is_file());
    }

    #[test]
    fn save_image_without_name_uses_content_hash_and_dedupes_identical_bytes() {
        let (_dir, ctx) = ctx();
        make_post(&ctx, "hello.md");

        let rel1 = save_image(&ctx, "hello.md", None, PNG_MAGIC).unwrap();
        assert!(rel1.starts_with("hello/"));
        assert!(rel1.ends_with(".png"));

        // 同样的字节再存一次应该落到同一个文件名（内容寻址），不会重复占地方
        let rel2 = save_image(&ctx, "hello.md", None, PNG_MAGIC).unwrap();
        assert_eq!(rel1, rel2);
    }

    #[test]
    fn save_image_suggested_name_conflict_gets_suffixed() {
        let (_dir, ctx) = ctx();
        make_post(&ctx, "hello.md");

        let rel1 = save_image(&ctx, "hello.md", Some("cover.png"), PNG_MAGIC).unwrap();
        let rel2 = save_image(&ctx, "hello.md", Some("cover.png"), b"different bytes").unwrap();
        assert_eq!(rel1, "hello/cover.png");
        assert_eq!(rel2, "hello/cover-1.png");
        // 两个文件都真实存在，第一个没被覆盖
        assert_eq!(
            std::fs::read(ctx.content_root.join("hello/cover.png")).unwrap(),
            PNG_MAGIC
        );
    }

    #[test]
    fn save_image_rejects_missing_or_invalid_post_id() {
        let (_dir, ctx) = ctx();
        assert!(matches!(
            save_image(&ctx, "does-not-exist.md", None, PNG_MAGIC),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            save_image(&ctx, "../escape.md", None, PNG_MAGIC),
            Err(AppError::InvalidPostId(_))
        ));
    }
}
