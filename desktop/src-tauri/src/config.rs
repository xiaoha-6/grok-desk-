use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_MODEL: &str = "grok-4.5";
pub const DEFAULT_PROVIDER: &str = "小哈AI";

const MANAGED_MODELS: &[(&str, &str, u64)] = &[
    ("grok-4.6", "Grok 4.6", 500_000),
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
                canonical_model_id(trimmed)
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

pub const NO_CREDENTIALS_CODE: &str = "GROKDESK_NO_CREDENTIALS";

pub fn credentials_ready(home: &Path) -> bool {
    if home.join("auth.json").is_file() {
        return true;
    }
    config_has_api_key(&home.join("config.toml"))
}

pub fn config_has_api_key(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("api_key") else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        if !toml_unquote(rest.trim()).is_empty() {
            return true;
        }
    }
    false
}

fn toml_unquote(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        toml_unescape(&trimmed[1..trimmed.len() - 1])
    } else if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed
            .split('#')
            .next()
            .unwrap_or(trimmed)
            .trim()
            .to_string()
    }
}

fn toml_unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(ch);
        }
    }
    out
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
    let _ = write_relay_sidecar(grok_home, import);
    Ok(ImportResult {
        config_path: config_path.display().to_string(),
        backup_path: backup_path.map(|path| path.display().to_string()),
        model: import.model.clone(),
        endpoint: import.endpoint.clone(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySidecar {
    pub endpoint: String,
    pub name: String,
    pub model: String,
}

#[derive(Debug, Clone)]
pub struct RelayProfile {
    pub endpoint: String,
    pub api_key: String,
    pub name: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayQuota {
    pub configured: bool,
    pub name: String,
    pub endpoint: String,
    pub remaining: Option<f64>,
    pub used: Option<f64>,
    pub total: Option<f64>,
    pub unit: Option<String>,
    pub plan_name: Option<String>,
    pub error: Option<String>,
}

impl RelayQuota {
    fn empty() -> Self {
        Self {
            configured: false,
            name: DEFAULT_PROVIDER.to_string(),
            endpoint: String::new(),
            remaining: None,
            used: None,
            total: None,
            unit: None,
            plan_name: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub models: Vec<CatalogModel>,
    pub source: String,
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListRequest {
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
}

fn sidecar_path(grok_home: &Path) -> PathBuf {
    grok_home.join("grokdesk-relay.json")
}

fn write_relay_sidecar(grok_home: &Path, import: &RelayImport) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(&RelaySidecar {
        endpoint: import.endpoint.clone(),
        name: import.name.clone(),
        model: import.model.clone(),
    })
    .map_err(io::Error::other)?;
    atomic_write(&sidecar_path(grok_home), &body)
}

fn read_relay_sidecar(grok_home: &Path) -> Option<RelaySidecar> {
    let bytes = fs::read(sidecar_path(grok_home)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn first_toml_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix(key) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let value = toml_unquote(rest.trim());
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

pub fn read_relay_profile(grok_home: &Path) -> Option<RelayProfile> {
    let text = fs::read_to_string(grok_home.join("config.toml")).ok()?;
    let api_key = first_toml_value(&text, "api_key")?;
    let sidecar = read_relay_sidecar(grok_home);
    let endpoint = sidecar
        .as_ref()
        .map(|item| item.endpoint.clone())
        .filter(|value| !value.is_empty())
        .or_else(|| first_toml_value(&text, "models_base_url"))
        .or_else(|| first_toml_value(&text, "xai_api_base_url"))?;
    Some(RelayProfile {
        endpoint: with_v1(&endpoint),
        api_key,
        name: sidecar
            .as_ref()
            .map(|item| item.name.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_PROVIDER.to_string()),
        model: sidecar
            .as_ref()
            .map(|item| item.model.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| first_toml_value(&text, "default"))
            .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
    })
}

fn is_official_endpoint(endpoint: &str) -> bool {
    let lower = endpoint.to_ascii_lowercase();
    lower.contains("api.x.ai") || lower.contains("://x.ai/")
}

pub fn is_relay_configured(grok_home: &Path) -> bool {
    read_relay_profile(grok_home)
        .map(|profile| !is_official_endpoint(&profile.endpoint))
        .unwrap_or(false)
}

pub fn canonical_model_id(id: &str) -> String {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["grok/", "xai/", "x-ai/", "x-ai:"] {
        if lower.starts_with(prefix) {
            let rest = trimmed[prefix.len()..].trim();
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    trimmed.to_string()
}

pub fn resolve_agent_home(requested: Option<&str>) -> Result<PathBuf, String> {
    let default = crate::runtime::grok_home();
    if is_relay_configured(&default) {
        return prepare_relay_runtime_home(&default);
    }
    Ok(requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default))
}

pub fn prepare_relay_runtime_home(grok_home: &Path) -> Result<PathBuf, String> {
    let home = grok_home.join("grokdesk-relay");
    fs::create_dir_all(&home).map_err(|err| format!("无法准备中转站运行目录：{err}"))?;
    for name in [
        "bin",
        "skills",
        "plugins",
        "hooks",
        "agents",
        "commands",
        "marketplaces",
        "sessions",
    ] {
        let source = grok_home.join(name);
        let target = home.join(name);
        if source.exists() && !target.exists() {
            link_or_copy(&source, &target);
        }
    }
    for name in [
        "config.toml",
        "managed_config.toml",
        "grokdesk-relay.json",
        "models_cache.json",
    ] {
        let source = grok_home.join(name);
        let target = home.join(name);
        if source.exists() {
            let _ = fs::copy(&source, &target);
        }
    }
    let auth = home.join("auth.json");
    if auth.exists() {
        let _ = fs::remove_file(&auth);
    }
    Ok(home)
}

fn link_or_copy(source: &Path, target: &Path) {
    if source.is_dir() {
        #[cfg(unix)]
        {
            let _ = std::os::unix::fs::symlink(source, target);
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(source, target).is_err() {
                let _ = copy_dir(source, target);
            }
        }
        return;
    }
    #[cfg(unix)]
    {
        if std::os::unix::fs::symlink(source, target).is_err() {
            let _ = fs::copy(source, target);
        }
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(source, target).is_err() {
            let _ = fs::copy(source, target);
        }
    }
}

#[cfg(windows)]
fn copy_dir(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let to = target.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            let _ = fs::copy(entry.path(), to);
        }
    }
    Ok(())
}

pub fn fetch_relay_quota(grok_home: &Path) -> RelayQuota {
    let Some(profile) = read_relay_profile(grok_home) else {
        return RelayQuota::empty();
    };
    if is_official_endpoint(&profile.endpoint) {
        return RelayQuota::empty();
    }
    match fetch_relay_quota_inner(&profile) {
        Ok(mut quota) => {
            quota.configured = true;
            quota.name = profile.name;
            quota.endpoint = profile.endpoint;
            quota
        }
        Err(error) => RelayQuota {
            configured: true,
            name: profile.name,
            endpoint: profile.endpoint,
            remaining: None,
            used: None,
            total: None,
            unit: None,
            plan_name: None,
            error: Some(error),
        },
    }
}

fn fetch_relay_quota_inner(profile: &RelayProfile) -> Result<RelayQuota, String> {
    let base = profile.endpoint.trim_end_matches('/');
    let candidates = [
        format!("{base}/user/balance"),
        format!("{base}/dashboard/billing/credit_grants"),
    ];
    let mut last_error = "无法查询中转站额度".to_string();
    for url in candidates {
        match http_json_get(&url, &profile.api_key) {
            Ok(value) => return Ok(parse_relay_quota(&value)),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

pub fn fetch_model_catalog(
    grok_home: &Path,
    request: Option<&ModelListRequest>,
) -> Result<ModelCatalog, String> {
    let profile = read_relay_profile(grok_home);
    let endpoint = request
        .and_then(|item| item.endpoint.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(with_v1)
        .or_else(|| profile.as_ref().map(|item| item.endpoint.clone()));
    let api_key = request
        .and_then(|item| item.api_key.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| profile.as_ref().map(|item| item.api_key.clone()));

    let mut last_error = "还没有可查询的中转站或 Grok 模型列表".to_string();
    if let (Some(endpoint), Some(api_key)) = (endpoint.as_deref(), api_key.as_deref()) {
        if !is_official_endpoint(endpoint) {
            match fetch_relay_models(endpoint, api_key) {
                Ok(models) if !models.is_empty() => {
                    return Ok(ModelCatalog {
                        models,
                        source: "relay".into(),
                        endpoint: Some(endpoint.to_string()),
                    });
                }
                Ok(_) => last_error = "中转站没有返回可用模型".into(),
                Err(error) => last_error = error,
            }
        }
    }

    match list_cli_models() {
        Ok(models) if !models.is_empty() => Ok(ModelCatalog {
            models,
            source: "cli".into(),
            endpoint,
        }),
        Ok(_) => Err(last_error),
        Err(error) => Err(if last_error.contains("还没有可查询") {
            error
        } else {
            last_error
        }),
    }
}

fn fetch_relay_models(endpoint: &str, api_key: &str) -> Result<Vec<CatalogModel>, String> {
    let base = endpoint.trim_end_matches('/');
    let value = http_json_get_timeout(&format!("{base}/models"), api_key, "15")?;
    let models = parse_model_catalog(&value);
    if models.is_empty() {
        return Err("中转站没有返回可用模型".into());
    }
    Ok(models)
}

fn parse_model_catalog(value: &serde_json::Value) -> Vec<CatalogModel> {
    let mut models = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let items = value
        .get("data")
        .and_then(|item| item.as_array())
        .or_else(|| value.get("models").and_then(|item| item.as_array()))
        .or_else(|| value.as_array());
    if let Some(items) = items {
        for item in items {
            if let Some(model) = catalog_model_from_value(item) {
                if seen.insert(model.id.clone()) {
                    models.push(model);
                }
            }
        }
    }
    models.sort_by(|left, right| {
        model_rank(&left.id)
            .cmp(&model_rank(&right.id))
            .then_with(|| left.id.to_ascii_lowercase().cmp(&right.id.to_ascii_lowercase()))
    });
    models
}

fn catalog_model_from_value(value: &serde_json::Value) -> Option<CatalogModel> {
    if let Some(id) = value.as_str().map(str::trim).filter(|item| !item.is_empty()) {
        let id = canonical_model_id(id);
        return Some(CatalogModel {
            id: id.clone(),
            name: id,
            context_window: None,
        });
    }
    let raw_id = json_string(
        value,
        &["id", "model", "model_id", "modelId", "name"],
    )?;
    if raw_id.is_empty() {
        return None;
    }
    let id = canonical_model_id(&raw_id);
    let name = json_string(value, &["display_name", "displayName", "name", "label"])
        .filter(|item| !item.is_empty() && item != &raw_id)
        .unwrap_or_else(|| id.clone());
    let context_window = json_number(
        value,
        &["context_window", "contextWindow", "context_window_tokens", "max_context"],
    )
    .and_then(|item| {
        if item.is_finite() && item > 0.0 {
            Some(item.round() as u64)
        } else {
            None
        }
    });
    Some(CatalogModel {
        id,
        name,
        context_window,
    })
}

fn model_rank(id: &str) -> u8 {
    let lower = id.to_ascii_lowercase();
    if lower.starts_with("grok-4.6") {
        0
    } else if lower.starts_with("grok-4.5") {
        1
    } else if lower.contains("grok") {
        2
    } else {
        3
    }
}

fn list_cli_models() -> Result<Vec<CatalogModel>, String> {
    let binary = crate::runtime::resolve_binary().ok_or_else(|| "还没有检测到 Grok Build".to_string())?;
    let mut command = std::process::Command::new(&binary);
    command
        .arg("models")
        .env("GROK_HOME", crate::runtime::grok_home())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_window(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法读取 Grok 模型列表：{err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "读取 Grok 模型列表失败：{}",
            stderr.trim().chars().take(180).collect::<String>()
        ));
    }
    let mut models = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let trimmed = line.trim();
        let id = if let Some(rest) = trimmed.strip_prefix("* ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("- ") {
            rest
        } else {
            continue;
        };
        let id = id.split_whitespace().next().unwrap_or("").trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        models.push(CatalogModel {
            id: id.to_string(),
            name: id.to_string(),
            context_window: None,
        });
    }
    models.sort_by(|left, right| {
        model_rank(&left.id)
            .cmp(&model_rank(&right.id))
            .then_with(|| left.id.to_ascii_lowercase().cmp(&right.id.to_ascii_lowercase()))
    });
    Ok(models)
}

pub fn set_active_model(
    grok_home: &Path,
    model: &str,
    context_window: Option<u64>,
) -> Result<(), String> {
    let model = canonical_model_id(model.trim());
    if model.is_empty() {
        return Err("缺少模型".into());
    }
    let path = grok_home.join("config.toml");
    if !path.is_file() {
        return Ok(());
    }
    let mut text = fs::read_to_string(&path).map_err(|err| format!("读取配置失败：{err}"))?;
    text = set_models_default(&text, &model);
    let escaped = toml_escape(&model);
    let has_block = text.contains(&format!("[model.\"{escaped}\"]"))
        || text.contains(&format!("[model.{model}]"));
    if !has_block {
        if let Some(profile) = read_relay_profile(grok_home) {
            if !is_official_endpoint(&profile.endpoint) {
                let window = context_window.unwrap_or_else(|| {
                    if model.to_ascii_lowercase().contains("grok") {
                        500_000
                    } else {
                        200_000
                    }
                });
                if !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push('\n');
                text.push_str(&render_model_block(
                    &model,
                    &model,
                    &profile.name,
                    &profile.api_key,
                    window,
                ));
            }
        }
    }
    atomic_write(&path, text.as_bytes()).map_err(|err| format!("写入配置失败：{err}"))?;
    if let Some(sidecar) = read_relay_sidecar(grok_home) {
        let _ = write_relay_sidecar(
            grok_home,
            &RelayImport {
                endpoint: sidecar.endpoint,
                api_key: String::new(),
                model: model.to_string(),
                name: sidecar.name,
            },
        );
    }
    Ok(())
}

fn set_models_default(text: &str, model: &str) -> String {
    let replacement = format!("default = \"{}\"", toml_escape(model));
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut in_models = false;
    let mut replaced = false;
    let mut models_index = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_models = trimmed == "[models]";
            if in_models {
                models_index = Some(index);
            }
        }
        if in_models
            && trimmed.starts_with("default")
            && !trimmed.starts_with("default_reasoning")
            && trimmed.split_once('=').is_some()
        {
            lines[index] = replacement.clone();
            replaced = true;
            break;
        }
    }
    if !replaced {
        if let Some(index) = models_index {
            lines.insert(index + 1, replacement);
        } else {
            lines.push(String::new());
            lines.push("[models]".into());
            lines.push(replacement);
        }
    }
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn parse_relay_quota(value: &serde_json::Value) -> RelayQuota {
    let root = value
        .get("data")
        .filter(|item| item.is_object())
        .unwrap_or(value);
    let remaining = json_number(
        root,
        &[
            "remaining",
            "balance",
            "total_available",
            "totalAvailable",
            "quota_remaining",
            "quotaRemaining",
        ],
    );
    let used = json_number(
        root,
        &["used", "total_used", "totalUsed", "quota_used", "quotaUsed"],
    );
    let total = json_number(
        root,
        &[
            "total",
            "total_granted",
            "totalGranted",
            "quota",
            "limit",
            "hard_limit_usd",
        ],
    );
    let unit = json_string(root, &["unit", "currency"]).or(Some("USD".into()));
    let plan_name = json_string(root, &["planName", "plan_name", "plan", "name"]);
    RelayQuota {
        configured: true,
        name: DEFAULT_PROVIDER.to_string(),
        endpoint: String::new(),
        remaining,
        used,
        total,
        unit,
        plan_name,
        error: None,
    }
}

fn json_number(value: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(found) = value.get(*key).and_then(value_as_f64) {
            return Some(found);
        }
    }
    None
}

fn json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|item| item.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn value_as_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|item| item as f64))
        .or_else(|| value.as_u64().map(|item| item as f64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<f64>().ok())
        })
}

fn hide_window(command: &mut std::process::Command) {
    let _ = command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn http_json_get(url: &str, api_key: &str) -> Result<serde_json::Value, String> {
    http_json_get_timeout(url, api_key, "8")
}

fn http_json_get_timeout(url: &str, api_key: &str, timeout_secs: &str) -> Result<serde_json::Value, String> {
    let mut command = std::process::Command::new("curl");
    command
        .arg("-sS")
        .arg("-f")
        .arg("-m")
        .arg(timeout_secs)
        .arg("-H")
        .arg(format!("Authorization: Bearer {api_key}"))
        .arg("-H")
        .arg("Accept: application/json")
        .arg(url)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_window(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法连接中转站：{err}"))?;
    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        return Err(format!("中转站接口 HTTP {code}"));
    }
    serde_json::from_slice(&output.stdout).map_err(|err| format!("中转站响应无法解析：{err}"))
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
        assert!(credentials_ready(&dir));
        let profile = read_relay_profile(&dir).expect("relay profile");
        assert_eq!(profile.api_key, "sk-new");
        assert!(profile.endpoint.contains("example.com"));
        assert_eq!(profile.name, "Demo");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_balance_payload() {
        let quota = parse_relay_quota(&serde_json::json!({
            "balance": 12.34,
            "remaining": 12.34,
            "used": 1.1,
            "unit": "USD",
            "planName": "API Key 额度"
        }));
        assert_eq!(quota.remaining, Some(12.34));
        assert_eq!(quota.unit.as_deref(), Some("USD"));
        assert_eq!(quota.plan_name.as_deref(), Some("API Key 额度"));
        let unlimited = parse_relay_quota(&serde_json::json!({ "remaining": -1, "balance": -1 }));
        assert_eq!(unlimited.remaining, Some(-1.0));
    }

    #[test]
    fn official_xai_endpoints_are_skipped() {
        assert!(is_official_endpoint("https://api.x.ai/v1"));
        assert!(!is_official_endpoint("https://api.xiaohaweb.com/v1"));
    }

    #[test]
    fn parses_openai_and_grok_model_lists() {
        let openai = parse_model_catalog(&serde_json::json!({
            "object": "list",
            "data": [
                { "id": "gpt-4.1", "object": "model" },
                { "id": "grok-4.5", "display_name": "Grok 4.5", "context_window": 500000 },
                { "id": "grok/grok-4.6" }
            ]
        }));
        assert_eq!(canonical_model_id("grok/grok-4.6"), "grok-4.6");
        assert_eq!(openai[0].id, "grok-4.6");
        assert_eq!(openai[1].id, "grok-4.5");
        assert_eq!(openai[1].name, "Grok 4.5");
        assert_eq!(openai[1].context_window, Some(500_000));
        assert_eq!(openai[2].id, "gpt-4.1");

        let patched = set_models_default(
            "[models]\ndefault = \"grok-4.5\"\ndefault_reasoning_effort = \"xhigh\"\n",
            "grok-4.6",
        );
        assert!(patched.contains("default = \"grok-4.6\""));
        assert!(patched.contains("default_reasoning_effort = \"xhigh\""));
    }

    #[test]
    fn render_includes_grok_46() {
        let cfg = render_config(
            &RelayImport {
                endpoint: "https://api.xiaohaweb.com/v1".into(),
                api_key: "sk-test".into(),
                model: "grok-4.6".into(),
                name: "小哈AI".into(),
            }
            .normalized()
            .unwrap(),
        );
        assert!(cfg.contains("[model.\"grok-4.6\"]"));
        assert!(cfg.contains("default = \"grok-4.6\""));
    }

    #[test]
    fn detects_inline_api_key_and_ignores_empty() {
        let dir = std::env::temp_dir().join(format!("grokdesk-cred-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.toml"), "name = \"x\"\napi_key = \"\"\n").unwrap();
        assert!(!credentials_ready(&dir));
        fs::write(
            dir.join("config.toml"),
            "# api_key = \"ignored\"\napi_key = \"sk-live\"\n",
        )
        .unwrap();
        assert!(config_has_api_key(&dir.join("config.toml")));
        fs::write(dir.join("config.toml"), "name = \"x\"\n").unwrap();
        fs::write(dir.join("auth.json"), "{}\n").unwrap();
        assert!(credentials_ready(&dir));
        let _ = fs::remove_dir_all(&dir);
    }
}
