use crate::config::{read_relay_profile, IMAGE_GEN_MODEL};
use crate::runtime::{grok_home, hide_console};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub path: String,
    pub mime_type: String,
    pub name: String,
}

pub fn generate_image(prompt: String) -> Result<GeneratedImage, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("请输入要生成的图片描述".into());
    }
    let prompt = if prompt.chars().count() > 3500 {
        prompt.chars().take(3500).collect::<String>()
    } else {
        prompt.to_string()
    };
    let home = grok_home();
    let profile = read_relay_profile(&home).ok_or_else(|| {
        "还没有配置图片生成。请先在设置里导入中转站，并确认已开通 grok-imagine-image。".to_string()
    })?;
    let url = format!(
        "{}/images/generations",
        profile.endpoint.trim_end_matches('/')
    );
    let body = json!({
        "model": IMAGE_GEN_MODEL,
        "prompt": prompt,
        "n": 1,
        "response_format": "b64_json",
    })
    .to_string();
    let value = http_json_post(&url, &profile.api_key, &body, "180")?;
    let (bytes, mime) = extract_image_bytes(&value)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|item| item.as_millis())
        .unwrap_or(0);
    let ext = if mime == "image/jpeg" { "jpg" } else { "png" };
    let name = format!("imagine-{stamp}.{ext}");
    let dir = home.join("imagine");
    fs::create_dir_all(&dir).map_err(|err| format!("无法保存图片：{err}"))?;
    let path = dir.join(&name);
    fs::write(&path, bytes).map_err(|err| format!("无法保存图片：{err}"))?;
    Ok(GeneratedImage {
        path: path.display().to_string(),
        mime_type: mime.to_string(),
        name,
    })
}

fn extract_image_bytes(value: &Value) -> Result<(Vec<u8>, &'static str), String> {
    if let Some(err) = value.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("图片生成失败");
        return Err(message.to_string());
    }
    let item = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .or_else(|| value.get("images").and_then(Value::as_array).and_then(|items| items.first()))
        .unwrap_or(value);
    if let Some(encoded) = item
        .get("b64_json")
        .or_else(|| item.get("b64Json"))
        .or_else(|| item.get("base64"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let payload = encoded
            .split(',')
            .last()
            .unwrap_or(encoded)
            .trim();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
            .map_err(|err| format!("图片数据无法解码：{err}"))?;
        let mime = sniff_mime(&bytes);
        return Ok((bytes, mime));
    }
    if let Some(url) = item
        .get("url")
        .or_else(|| item.get("image_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && (value.starts_with("http://") || value.starts_with("https://") || value.starts_with("data:")))
    {
        if let Some(rest) = url.strip_prefix("data:") {
            if let Some((_, encoded)) = rest.split_once(',') {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded.trim())
                    .map_err(|err| format!("图片数据无法解码：{err}"))?;
                let mime = sniff_mime(&bytes);
                return Ok((bytes, mime));
            }
        }
        if url.starts_with("http://") || url.starts_with("https://") {
            let bytes = http_download(url)?;
            let mime = sniff_mime(&bytes);
            return Ok((bytes, mime));
        }
    }
    Err("中转站没有返回图片数据。请确认 grok-imagine-image 已开通。".into())
}

fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/png"
    }
}

fn http_json_post(url: &str, api_key: &str, body: &str, timeout_secs: &str) -> Result<Value, String> {
    let dir = grok_home().join("imagine");
    fs::create_dir_all(&dir).map_err(|err| format!("无法准备出图目录：{err}"))?;
    let out_path = unique_temp(&dir, "imagine-resp");
    let mut command = Command::new("curl");
    command
        .arg("-sS")
        .arg("-m")
        .arg(timeout_secs)
        .arg("-X")
        .arg("POST")
        .arg("-H")
        .arg(format!("Authorization: Bearer {api_key}"))
        .arg("-H")
        .arg("Content-Type: application/json")
        .arg("-H")
        .arg("Accept: application/json")
        .arg("--data-binary")
        .arg(body)
        .arg("-o")
        .arg(&out_path)
        .arg("-w")
        .arg("%{http_code}")
        .arg(url)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法连接中转站：{err}"))?;
    let status_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let http_code: i32 = status_text.parse().unwrap_or(0);
    let raw = fs::read(&out_path).unwrap_or_default();
    let _ = fs::remove_file(&out_path);
    if !output.status.success() && raw.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("无法连接图片服务：{}", err.trim()));
    }
    let value: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    if http_code >= 400 || value.get("error").is_some() {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("图片生成失败");
        return Err(format!("HTTP {http_code}: {message}"));
    }
    if value.is_null() {
        return Err("图片服务没有返回有效数据".into());
    }
    Ok(value)
}

fn http_download(url: &str) -> Result<Vec<u8>, String> {
    let dir = grok_home().join("imagine");
    fs::create_dir_all(&dir).map_err(|err| format!("无法准备出图目录：{err}"))?;
    let out_path = unique_temp(&dir, "imagine-dl");
    let mut command = Command::new("curl");
    command
        .arg("-sS")
        .arg("-L")
        .arg("-m")
        .arg("60")
        .arg("-o")
        .arg(&out_path)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法下载图片：{err}"))?;
    let bytes = fs::read(&out_path).unwrap_or_default();
    let _ = fs::remove_file(&out_path);
    if !output.status.success() || bytes.is_empty() {
        return Err("图片地址无法下载".into());
    }
    Ok(bytes)
}

fn unique_temp(dir: &std::path::Path, prefix: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|item| item.as_nanos())
        .unwrap_or(0);
    dir.join(format!("{prefix}-{stamp}.tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_b64_jpeg() {
        let jpeg = [0xFFu8, 0xD8, 0xFF, 0xE0, 0, 1, 2, 3];
        let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg);
        let value = json!({ "data": [{ "b64_json": encoded }] });
        let (bytes, mime) = extract_image_bytes(&value).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn surfaces_api_error() {
        let value = json!({ "error": { "message": "context_too_large: 请求内容过大" } });
        let err = extract_image_bytes(&value).unwrap_err();
        assert!(err.contains("context_too_large"));
    }
}
