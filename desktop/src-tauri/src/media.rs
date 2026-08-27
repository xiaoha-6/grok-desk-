use crate::acp::PromptAttachment;
use arboard::Clipboard;
use base64::Engine;
use png::{BitDepth, ColorType, Encoder};
use std::fs;
use std::path::Path;

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

fn mime_from_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("bmp") => Some("image/bmp"),
        Some("tif") | Some("tiff") => Some("image/tiff"),
        Some("heic") | Some("heif") => Some("image/heic"),
        _ => None,
    }
}

fn attachment(bytes: &[u8], mime: &str, name: &str) -> Result<PromptAttachment, String> {
    if bytes.is_empty() {
        return Err("图片是空的".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片太大，请控制在 25MB 以内".into());
    }
    Ok(PromptAttachment {
        mime_type: Some(mime.to_string()),
        data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        name: Some(name.to_string()),
    })
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("剪贴板图片无效".into());
    }
    let expected = width as usize * height as usize * 4;
    if rgba.len() < expected {
        return Err("剪贴板图片数据不完整".into());
    }
    let mut buf = Vec::new();
    {
        let mut encoder = Encoder::new(&mut buf, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|err| format!("无法编码图片：{err}"))?;
        writer
            .write_image_data(&rgba[..expected])
            .map_err(|err| format!("无法编码图片：{err}"))?;
        writer
            .finish()
            .map_err(|err| format!("无法编码图片：{err}"))?;
    }
    Ok(buf)
}

pub fn read_clipboard_image() -> Result<Option<PromptAttachment>, String> {
    let mut clipboard = Clipboard::new().map_err(|err| format!("无法读取剪贴板：{err}"))?;
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(_) => return Ok(None),
    };
    let png = encode_png(image.width as u32, image.height as u32, &image.bytes)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|item| item.as_millis())
        .unwrap_or(0);
    Ok(Some(attachment(
        &png,
        "image/png",
        &format!("paste-{stamp}.png"),
    )?))
}

pub fn read_image_file(path: String) -> Result<PromptAttachment, String> {
    let path = Path::new(&path);
    let mime = mime_from_path(path).ok_or_else(|| "只支持图片文件".to_string())?;
    let bytes = fs::read(path).map_err(|err| format!("无法读取图片：{err}"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image")
        .to_string();
    attachment(&bytes, mime, &name)
}

pub fn save_image_as(
    source_path: Option<String>,
    data: Option<String>,
    dest: &Path,
) -> Result<(), String> {
    if let Some(path) = source_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        fs::copy(path, dest).map_err(|err| format!("无法保存图片：{err}"))?;
        return Ok(());
    }
    let encoded = data.unwrap_or_default();
    let payload = encoded
        .split(',')
        .last()
        .unwrap_or(encoded.trim())
        .trim();
    if payload.is_empty() {
        return Err("没有可保存的图片".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|err| format!("无法解码图片：{err}"))?;
    fs::write(dest, bytes).map_err(|err| format!("无法保存图片：{err}"))?;
    Ok(())
}
