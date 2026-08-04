use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use arboard::{Clipboard, ImageData};

use crate::error::AppError;

/// 防止恶意/异常 clipboard provider 让应用一次性分配无上限内存。
const MAX_CLIPBOARD_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_CLIPBOARD_RGBA_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CLIPBOARD_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_COUNT: usize = 20;

#[derive(Debug)]
pub struct ClipboardImage {
    pub suggested_name: Option<String>,
    pub bytes: Vec<u8>,
}

/// 从系统剪贴板读取图片。顺序很重要：
/// 1. 文件管理器复制的图片保留原文件名和编码；
/// 2. Wayland 按 compositor 实际提供的 image/* MIME 取原始字节；
/// 3. Wayland 最后让 arboard 解码位图，再编码成 PNG。
pub fn read_images() -> Result<Vec<ClipboardImage>, AppError> {
    let mut diagnostics = Vec::new();
    let mut clipboard = match Clipboard::new() {
        Ok(clipboard) => Some(clipboard),
        Err(error) => {
            diagnostics.push(format!("初始化 arboard 失败：{error}"));
            None
        }
    };

    if let Some(clipboard) = clipboard.as_mut() {
        match clipboard.get().file_list() {
            Ok(paths) => {
                let images = read_image_files(paths)?;
                if !images.is_empty() {
                    return Ok(images);
                }
            }
            Err(error) => diagnostics.push(format!("读取文件列表失败：{error}")),
        }
    }

    #[cfg(target_os = "linux")]
    match read_wayland_image() {
        Ok(Some(image)) => return Ok(vec![image]),
        Ok(None) => {}
        Err(error) => diagnostics.push(error.to_string()),
    }

    if let Some(clipboard) = clipboard.as_mut() {
        match clipboard.get_image() {
            Ok(image) => return Ok(vec![rgba_to_png(image)?]),
            Err(error) => diagnostics.push(format!("读取位图失败：{error}")),
        }
    }

    if !diagnostics.is_empty() {
        log::debug!("没有从剪贴板读取到图片：{}", diagnostics.join("；"));
    }
    Err(AppError::Clipboard(
        "剪贴板中没有可读取的图片，请先复制图片本身或图片文件后再粘贴".into(),
    ))
}

fn read_image_files(paths: Vec<PathBuf>) -> Result<Vec<ClipboardImage>, AppError> {
    let mut images = Vec::new();
    let mut total_bytes = 0u64;
    for path in paths.into_iter().filter(|path| is_image_path(path)) {
        if images.len() >= MAX_CLIPBOARD_IMAGE_COUNT {
            return Err(AppError::Clipboard(format!(
                "一次最多从剪贴板导入 {MAX_CLIPBOARD_IMAGE_COUNT} 张图片"
            )));
        }

        // 在同一个文件句柄上检查 metadata 并限量读取，避免检查路径后文件被替换。
        let mut file = fs::File::open(&path).map_err(|error| {
            AppError::Clipboard(format!("无法读取图片文件 {}：{error}", path.display()))
        })?;
        let metadata = file.metadata().map_err(|error| {
            AppError::Clipboard(format!("无法读取图片信息 {}：{error}", path.display()))
        })?;
        if !metadata.is_file() {
            return Err(AppError::Clipboard(format!(
                "剪贴板图片不是普通文件：{}",
                path.display()
            )));
        }
        if metadata.len() > MAX_CLIPBOARD_FILE_BYTES {
            return Err(AppError::Clipboard(format!(
                "单张图片超过 25 MiB，拒绝导入：{}",
                path.display()
            )));
        }

        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.by_ref()
            .take(MAX_CLIPBOARD_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                AppError::Clipboard(format!("无法读取图片文件 {}：{error}", path.display()))
            })?;
        if bytes.len() as u64 > MAX_CLIPBOARD_FILE_BYTES {
            return Err(AppError::Clipboard(format!(
                "读取期间图片增长到 25 MiB 以上，拒绝导入：{}",
                path.display()
            )));
        }
        if bytes.is_empty() {
            return Err(AppError::Clipboard(format!(
                "图片文件为空：{}",
                path.display()
            )));
        }
        total_bytes = total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| AppError::Clipboard("剪贴板图片总大小溢出".into()))?;
        if total_bytes > MAX_CLIPBOARD_TOTAL_BYTES {
            return Err(AppError::Clipboard(
                "一次导入的图片总大小不能超过 100 MiB".into(),
            ));
        }

        let suggested_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        images.push(ClipboardImage {
            suggested_name,
            bytes,
        });
    }
    Ok(images)
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "avif"
                    | "bmp"
                    | "gif"
                    | "ico"
                    | "jfif"
                    | "jpeg"
                    | "jpg"
                    | "png"
                    | "svg"
                    | "tif"
                    | "tiff"
                    | "webp"
            )
        })
}

fn rgba_to_png(image: ImageData<'static>) -> Result<ClipboardImage, AppError> {
    let expected_len = image
        .width
        .checked_mul(image.height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| AppError::Clipboard("剪贴板图片尺寸溢出".into()))?;
    if image.width == 0 || image.height == 0 || image.bytes.len() != expected_len {
        return Err(AppError::Clipboard(
            "剪贴板图片尺寸与 RGBA 像素数据不匹配".into(),
        ));
    }
    if expected_len as u64 > MAX_CLIPBOARD_RGBA_BYTES {
        return Err(AppError::Clipboard(
            "剪贴板图片解码后超过 256 MiB，拒绝导入".into(),
        ));
    }
    let width =
        u32::try_from(image.width).map_err(|_| AppError::Clipboard("剪贴板图片宽度过大".into()))?;
    let height = u32::try_from(image.height)
        .map_err(|_| AppError::Clipboard("剪贴板图片高度过大".into()))?;

    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| AppError::Clipboard(format!("PNG 编码初始化失败：{error}")))?;
        writer
            .write_image_data(image.bytes.as_ref())
            .map_err(|error| AppError::Clipboard(format!("PNG 编码失败：{error}")))?;
    }
    if bytes.len() as u64 > MAX_CLIPBOARD_FILE_BYTES {
        return Err(AppError::Clipboard(
            "剪贴板图片编码后超过 25 MiB，拒绝导入".into(),
        ));
    }
    Ok(ClipboardImage {
        suggested_name: None,
        bytes,
    })
}

#[cfg(target_os = "linux")]
fn read_wayland_image() -> Result<Option<ClipboardImage>, AppError> {
    use wl_clipboard_rs::paste::{
        get_contents, get_mime_types_ordered, ClipboardType, Error, MimeType, Seat,
    };

    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Ok(None);
    }

    let mime_types = match get_mime_types_ordered(ClipboardType::Regular, Seat::Unspecified) {
        Ok(mime_types) => mime_types,
        Err(Error::NoSeats | Error::ClipboardEmpty | Error::NoMimeType) => return Ok(None),
        Err(error) => {
            return Err(AppError::Clipboard(format!(
                "无法枚举 Wayland 剪贴板格式：{error}"
            )))
        }
    };
    let Some(mime_type) = select_image_mime(&mime_types) else {
        return Ok(None);
    };
    let (pipe, actual_mime) = get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        MimeType::Specific(mime_type),
    )
    .map_err(|error| AppError::Clipboard(format!("无法读取 {mime_type} 图片：{error}")))?;

    let mut bytes = Vec::new();
    pipe.take(MAX_CLIPBOARD_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::Clipboard(format!("读取 {actual_mime} 图片失败：{error}")))?;
    if bytes.len() as u64 > MAX_CLIPBOARD_FILE_BYTES {
        return Err(AppError::Clipboard(
            "剪贴板图片超过 25 MiB，拒绝导入".into(),
        ));
    }
    if bytes.is_empty() {
        return Err(AppError::Clipboard(format!(
            "剪贴板提供了 {actual_mime}，但图片数据为空"
        )));
    }
    if !infer::get(&bytes).is_some_and(|kind| kind.mime_type().starts_with("image/")) {
        return Err(AppError::Clipboard(format!(
            "剪贴板的 {actual_mime} 内容不是可识别的图片格式"
        )));
    }
    Ok(Some(ClipboardImage {
        suggested_name: None,
        bytes,
    }))
}

#[cfg(target_os = "linux")]
fn select_image_mime(mime_types: &[String]) -> Option<&str> {
    mime_types
        .iter()
        .filter_map(|mime| image_mime_priority(mime).map(|priority| (priority, mime.as_str())))
        .min_by_key(|(priority, _)| *priority)
        .map(|(_, mime)| mime)
}

#[cfg(target_os = "linux")]
fn image_mime_priority(mime: &str) -> Option<u8> {
    let base = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    Some(match base.as_str() {
        "image/png" => 0,
        "image/jpeg" | "image/jpg" => 1,
        "image/webp" => 2,
        "image/avif" => 3,
        "image/gif" => 4,
        "image/bmp" | "image/x-ms-bmp" => 5,
        "image/tiff" => 6,
        "image/x-icon" | "image/vnd.microsoft.icon" => 7,
        // SVG 可携带外部引用/脚本，不把未经文件系统选择的任意 SVG 数据直接写入项目。
        "image/svg+xml" => return None,
        _ if base.starts_with("image/") => 100,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    #[test]
    fn image_path_filter_is_case_insensitive() {
        assert!(is_image_path(Path::new("旅行照片.WEBP")));
        assert!(is_image_path(Path::new("icon.svg")));
        assert!(!is_image_path(Path::new("notes.txt")));
    }

    #[test]
    fn rgba_pixels_are_encoded_as_png() {
        let image = ImageData {
            width: 1,
            height: 1,
            bytes: Cow::Owned(vec![255, 0, 0, 255]),
        };
        let encoded = rgba_to_png(image).unwrap();
        assert_eq!(encoded.suggested_name, None);
        assert_eq!(infer::get(&encoded.bytes).unwrap().mime_type(), "image/png");
    }

    #[test]
    fn invalid_rgba_length_is_rejected() {
        let image = ImageData {
            width: 2,
            height: 2,
            bytes: Cow::Owned(vec![0; 4]),
        };
        assert!(matches!(rgba_to_png(image), Err(AppError::Clipboard(_))));
    }

    #[test]
    fn file_list_enforces_image_count_limit() {
        let dir = tempfile::tempdir().unwrap();
        let paths = (0..=MAX_CLIPBOARD_IMAGE_COUNT)
            .map(|index| {
                let path = dir.path().join(format!("image-{index}.png"));
                fs::write(&path, [index as u8]).unwrap();
                path
            })
            .collect();

        let error = read_image_files(paths).unwrap_err();
        assert!(matches!(error, AppError::Clipboard(message) if message.contains("20")));
    }

    #[test]
    fn file_list_rejects_oversized_file_from_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.png");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_CLIPBOARD_FILE_BYTES + 1).unwrap();

        assert!(matches!(
            read_image_files(vec![path]),
            Err(AppError::Clipboard(_))
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn wayland_mime_selection_prefers_portable_raster_format() {
        let types = vec![
            "text/plain;charset=utf-8".into(),
            "image/webp".into(),
            "image/png".into(),
            "image/svg+xml".into(),
        ];
        assert_eq!(select_image_mime(&types), Some("image/png"));
        assert_eq!(select_image_mime(&["image/svg+xml".into()]), None);
    }
}
