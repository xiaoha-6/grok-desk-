use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_MODEL: &str = "grok-4.5";
pub const DEFAULT_PROVIDER: &str = "小哈AI";

const MANAGED_MODELS: &[(&str, &str, u64)] = &[
    ("grok-4.5", "Grok 4.5", 500_000),
    ("grok-build-0.1", "Grok Build", 256_000),
    ("grok-4.20-multi-agent-0309", "Grok 4.20 Multi Agent", 1_000_000),
    ("grok-4.3", "Grok 4.3", 1_000_000),
    ("grok-composer-2.5-fast", "Grok Composer 2.5 Fast", 500_000),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayImport {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub config_path: String,
    pub backup_path: Option<String>,
    pub model: String,
    pub endpoint: String,
}

impl RelayImport {
    pub fn normalized(self) -> Result<Self, String> {
        let endpoint = with_v1(&self.endpoint);
        if endpoint.is_empty() {
            return Err("缺少 API 地址".into());
        }
        if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
            return Err("API 地址必须以 http:// 或 https:// 开头".into());
        }
        let api_key = self.api_key.trim().to_string();
        if api_key.is_empty() {
            return Err("缺少 API Key".into());
        }
        let model = {
            let trimmed = self.model.trim();
            if trimmed.is_empty() {
                DEFAULT_MODEL.to_string()
            } else {
                trimmed.to_string()
            }
        };
        let name = {
            let trimmed = self.name.trim();
            if trimmed.is_empty() {
                DEFAULT_PROVIDER.to_string()
            } else {
                trimmed.to_string()
            }
        };
        Ok(Self {
            endpoint,
            api_key,
            model,
            name,
        })
    }
}

pub fn with_v1(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.to_ascii_lowercase().ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

pub fn toml_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

pub fn parse_deeplink(raw: &str) -> Result<RelayImport, String> {
    let url = url::Url::parse(raw).map_err(|err| format!("无法解析导入链接：{err}"))?;
    if url.scheme() != "grokdesk" {
        return Err("不是 grokdesk:// 导入链接".into());
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path().trim_matches('/');
    let is_import = (host.eq_ignore_ascii_case("v1") && path.eq_ignore_ascii_case("import"))
        || path.eq_ignore_ascii_case("v1/import")
        || raw.to_ascii_lowercase().contains("://v1/import");
    if !is_import {
        return Err("导入链接格式应为 grokdesk://v1/import?...".into());
    }

    let mut endpoint = String::new();
    let mut api_key = String::new();
    let mut model = DEFAULT_MODEL.to_string();
    let mut name = DEFAULT_PROVIDER.to_string();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "endpoint" | "baseUrl" | "base_url" | "homepage" => {
                if endpoint.is_empty() || key == "endpoint" {
                    endpoint = value.into_owned();
                }
            }
            "apiKey" | "api_key" | "key" => api_key = value.into_owned(),
            "model" => {
                let owned = value.into_owned();
                if !owned.trim().is_empty() {
                    model = owned;
                }
            }
            "name" | "provider" | "providerName" => {
                let owned = value.into_owned();
                if !owned.trim().is_empty() {
                    name = owned;
                }
            }
            _ => {}
        }
    }
    RelayImport {
        endpoint,
        api_key,
        model,
        name,
    }
    .normalized()
}

pub fn render_config(import: &RelayImport) -> String {
    let endpoint = toml_escape(&import.endpoint);
    let api_key = toml_escape(&import.api_key);
    let models_list_url = format!("{}/models", import.endpoint);
    let models_list_url = toml_escape(&models_list_url);
    let provider = toml_escape(&import.name);
    let default_model = toml_escape(&import.model);
    let mut body = String::new();
    body.push_str("# Managed by GrokDesk — 小哈中转站 API-key 接入。\n");
    body.push_str("# 原文件会在写入前备份为 config.toml.bak-grokdesk-*.\n");
    body.push_str("# 文本模型使用 Responses（POST /v1/responses）。\n");
    body.push_str("# 保存后可运行: grok inspect\n\n");
    body.push_str("[endpoints]\n");
    body.push_str(&format!("models_base_url = \"{endpoint}\"\n"));
    body.push_str(&format!("models_list_url = \"{models_list_url}\"\n"));
    body.push_str(&format!("xai_api_base_url = \"{endpoint}\"\n"));
    body.push_str(&format!("cli_chat_proxy_base_url = \"{endpoint}\"\n\n"));
    body.push_str("[auth]\n");
    body.push_str("preferred_method = \"api_key\"\n\n");

    let mut written = std::collections::BTreeSet::new();
    for (id, display, window) in MANAGED_MODELS {
        body.push_str(&render_model_block(
            id,
            display,
            &provider,
            &api_key,
            *window,
        ));
        written.insert(*id);
    }
    if !written.contains(import.model.as_str()) {
        body.push_str(&render_model_block(
            &import.model,
            &import.model,
            &provider,
            &api_key,
            500_000,
        ));
    }

    body.push_str("[models]\n");
    body.push_str(&format!("default = \"{default_model}\"\n"));
    body.push_str("web_search = \"grok-4.5\"\n");
    body.push_str("image_description = \"grok-4.5\"\n\n");
    body.push_str("[session]\n");
    body.push_str("auto_compact_threshold_percent = 80\n\n");
    body.push_str("[features]\n");
    body.push_str("image_gen = true\n");
    body.push_str("video_gen = true\n");
    body.push_str("image_gen_model_override = \"grok-imagine-image-quality\"\n");
    body.push_str("image_edit_model_override = \"grok-imagine-edit\"\n");
    body
}

fn render_model_block(id: &str, display: &str, provider: &str, api_key: &str, window: u64) -> String {
    let id_esc = toml_escape(id);
    let display_esc = toml_escape(display);
    format!(
        "[model.\"{id_esc}\"]\n\
model = \"{id_esc}\"\n\
name = \"{display_esc}\"\n\
description = \"{provider} · Responses\"\n\
api_key = \"{api_key}\"\n\
api_backend = \"responses\"\n\
context_window = {window}\n\
supports_backend_search = true\n\n"
    )
}

pub fn write_config(grok_home: &Path, import: &RelayImport) -> io::Result<ImportResult> {
    fs::create_dir_all(grok_home)?;
    let config_path = grok_home.join("config.toml");
    let backup_path = backup_if_exists(&config_path)?;
    let rendered = render_config(import);
    atomic_write(&config_path, rendered.as_bytes())?;
    restrict_owner_only(&config_path);
    Ok(ImportResult {
        config_path: config_path.display().to_string(),
        backup_path: backup_path.map(|path| path.display().to_string()),
        model: import.model.clone(),
        endpoint: import.endpoint.clone(),
    })
}

fn backup_if_exists(path: &Path) -> io::Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("config.toml.bak-grokdesk-{ts}"));
    fs::copy(path, &backup)?;
    Ok(Some(backup))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("toml.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

fn restrict_owner_only(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_v1_does_not_double() {
        assert_eq!(with_v1("https://api.xiaohaweb.com/v1"), "https://api.xiaohaweb.com/v1");
        assert_eq!(with_v1("https://api.xiaohaweb.com/v1/"), "https://api.xiaohaweb.com/v1");
        assert_eq!(with_v1("https://api.xiaohaweb.com"), "https://api.xiaohaweb.com/v1");
    }

    #[test]
    fn parse_import_deeplink() {
        let url = "grokdesk://v1/import?endpoint=https%3A%2F%2Fapi.xiaohaweb.com%2Fv1&apiKey=sk-test&model=grok-4.5&name=%E5%B0%8F%E5%93%88AI";
        let parsed = parse_deeplink(url).expect("parse");
        assert_eq!(parsed.endpoint, "https://api.xiaohaweb.com/v1");
        assert_eq!(parsed.api_key, "sk-test");
        assert_eq!(parsed.model, "grok-4.5");
        assert_eq!(parsed.name, "小哈AI");
    }

    #[test]
    fn render_contains_responses_and_inline_key() {
        let cfg = render_config(
            &RelayImport {
                endpoint: "https://api.xiaohaweb.com/v1".into(),
                api_key: r#"sk-"quoted""#.into(),
                model: "grok-4.5".into(),
                name: "小哈AI".into(),
            }
            .normalized()
            .unwrap(),
        );
        assert!(cfg.contains("api_backend = \"responses\""));
        assert!(cfg.contains("models_base_url = \"https://api.xiaohaweb.com/v1\""));
        assert!(cfg.contains("api_key = \"sk-\\\"quoted\\\"\""));
        assert!(cfg.contains("default = \"grok-4.5\""));
        assert!(cfg.contains("[model.\"grok-build-0.1\"]"));
    }

    #[test]
    fn writes_backup_then_config() {
        let dir = std::env::temp_dir().join(format!("grokdesk-cfg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.toml"), "old = true\n").unwrap();
        let result = write_config(
            &dir,
            &RelayImport {
                endpoint: "https://example.com/v1".into(),
                api_key: "sk-new".into(),
                model: "grok-4.5".into(),
                name: "Demo".into(),
            },
        )
        .unwrap();
        assert!(result.backup_path.is_some());
        let written = fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(written.contains("sk-new"));
        let _ = fs::remove_dir_all(&dir);
    }
}
