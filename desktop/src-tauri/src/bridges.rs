use crate::runtime::grok_home;
use aes::Aes256;
use base64::Engine;
use cbc::Decryptor;
use cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

type Aes256CbcDec = Decryptor<Aes256>;

const WEBHOOK_PORT: u16 = 18791;
const UA: &str = "GrokDesk-Bridge/0.6.71";
const KNOWN_KINDS: &[&str] = &[
    "telegram", "discord", "slack", "whatsapp", "feishu", "qq", "wechat", "wecom", "dingtalk",
    "line", "zalo", "googlechat", "msteams", "mattermost", "matrix", "sms", "synology", "signal",
    "imessage", "irc", "nostr", "nextcloud", "twitch", "tlon", "yuanbao", "buzz",
];

type ErrorMap = Arc<Mutex<HashMap<String, String>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeChannel {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_dm_policy")]
    pub dm_policy: String,
    #[serde(default)]
    pub allow_from: String,
    #[serde(default = "default_group_policy")]
    pub group_policy: String,
    #[serde(default = "default_true")]
    pub require_mention: bool,
    #[serde(default = "default_true")]
    pub mirror_outbound: bool,
    #[serde(default = "default_true")]
    pub accept_inbound: bool,
    #[serde(default)]
    pub default_target: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub app_secret: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default = "default_connection")]
    pub connection_mode: String,
    #[serde(default)]
    pub verification_token: String,
    #[serde(default)]
    pub encrypt_key: String,
    #[serde(default)]
    pub webhook_url: String,
}

fn default_dm_policy() -> String {
    "pairing".into()
}
fn default_group_policy() -> String {
    "allowlist".into()
}
fn default_true() -> bool {
    true
}
fn default_connection() -> String {
    "websocket".into()
}

impl Default for BridgeChannel {
    fn default() -> Self {
        Self {
            enabled: false,
            dm_policy: default_dm_policy(),
            allow_from: String::new(),
            group_policy: default_group_policy(),
            require_mention: true,
            mirror_outbound: true,
            accept_inbound: true,
            default_target: String::new(),
            token: String::new(),
            app_id: String::new(),
            app_secret: String::new(),
            domain: String::new(),
            connection_mode: default_connection(),
            verification_token: String::new(),
            encrypt_key: String::new(),
            webhook_url: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgesConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub channels: HashMap<String, BridgeChannel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeChannelStatus {
    pub id: String,
    pub enabled: bool,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgesStatus {
    pub enabled: bool,
    pub running: bool,
    pub webhook: String,
    pub channels: Vec<BridgeChannelStatus>,
    pub pairings: Vec<BridgePairing>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInbound {
    pub kind: String,
    pub sender: String,
    pub target: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgePairing {
    pub kind: String,
    pub sender: String,
    pub target: String,
    pub code: String,
    pub preview: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgeMedia {
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub data: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone)]
struct InboundCtx {
    app: AppHandle,
    config: Arc<Mutex<BridgesConfig>>,
    pairings: Arc<Mutex<Vec<BridgePairing>>>,
    errors: ErrorMap,
}

pub struct BridgeHub {
    config: Arc<Mutex<BridgesConfig>>,
    errors: ErrorMap,
    pairings: Arc<Mutex<Vec<BridgePairing>>>,
    running: AtomicBool,
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for BridgeHub {
    fn default() -> Self {
        Self {
            config: Arc::new(Mutex::new(load_config())),
            errors: Arc::new(Mutex::new(HashMap::new())),
            pairings: Arc::new(Mutex::new(load_pairings())),
            running: AtomicBool::new(false),
            stop: Mutex::new(None),
        }
    }
}

fn config_path() -> std::path::PathBuf {
    grok_home().join("bridges.json")
}

pub fn load_config() -> BridgesConfig {
    let path = config_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return BridgesConfig::default();
    };
    let value: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    migrate_config(value)
}

fn migrate_config(value: Value) -> BridgesConfig {
    let mut cfg: BridgesConfig = serde_json::from_value(value.clone()).unwrap_or_default();
    if let Some(enabled) = value.get("enabled").and_then(Value::as_bool) {
        cfg.enabled = enabled;
    }
    for id in ["discord", "feishu", "qq", "wechat"] {
        if cfg.channels.contains_key(id) {
            continue;
        }
        let Some(raw) = value.get(id) else { continue };
        if let Ok(ch) = serde_json::from_value::<BridgeChannel>(raw.clone()) {
            if ch.enabled
                || !ch.token.trim().is_empty()
                || !ch.webhook_url.trim().is_empty()
                || !ch.app_id.trim().is_empty()
            {
                cfg.channels.insert(id.to_string(), ch);
            }
        }
    }
    for ch in cfg.channels.values_mut() {
        if ch.dm_policy == "allowlist" && ch.allow_from.trim().is_empty() {
            ch.dm_policy = "pairing".into();
        }
    }
    cfg
}

pub fn save_config(config: &BridgesConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("无法创建配置目录：{err}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|err| format!("序列化失败：{err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("写入 bridges.json 失败：{err}"))
}

fn pairings_path() -> std::path::PathBuf {
    grok_home().join("bridge-pairings.json")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|item| item.as_secs())
        .unwrap_or(0)
}

fn load_pairings() -> Vec<BridgePairing> {
    let Ok(text) = std::fs::read_to_string(pairings_path()) else {
        return Vec::new();
    };
    let mut rows: Vec<BridgePairing> = serde_json::from_str(&text).unwrap_or_default();
    let cutoff = now_secs().saturating_sub(86_400);
    rows.retain(|item| item.created_at >= cutoff);
    rows
}

fn save_pairings(rows: &[BridgePairing]) {
    if let Some(parent) = pairings_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(rows) {
        let _ = std::fs::write(pairings_path(), text);
    }
}

fn record_error(errors: &ErrorMap, id: &str, err: impl ToString) {
    if let Ok(mut slot) = errors.lock() {
        slot.insert(id.to_string(), err.to_string());
    }
}

fn clear_error(errors: &ErrorMap, id: &str) {
    if let Ok(mut slot) = errors.lock() {
        slot.remove(id);
    }
}

fn channel_of(config: &BridgesConfig, id: &str) -> BridgeChannel {
    config.channels.get(id).cloned().unwrap_or_default()
}

impl BridgeHub {
    pub fn snapshot(&self) -> BridgesConfig {
        self.config.lock().map(|item| item.clone()).unwrap_or_default()
    }

    pub fn status(&self) -> BridgesStatus {
        let config = self.snapshot();
        let errors = self.errors.lock().ok().map(|item| item.clone()).unwrap_or_default();
        let running = self.running.load(Ordering::SeqCst);
        let mut seen = std::collections::HashSet::new();
        let mut channels = Vec::new();
        let push = |channels: &mut Vec<BridgeChannelStatus>, id: &str, ch: &BridgeChannel| {
            let err = errors.get(id).cloned();
            channels.push(BridgeChannelStatus {
                id: id.into(),
                enabled: ch.enabled,
                running: running && config.enabled && ch.enabled && err.is_none(),
                error: err,
            });
        };
        for id in KNOWN_KINDS {
            seen.insert((*id).to_string());
            push(&mut channels, id, &channel_of(&config, id));
        }
        let mut extra: Vec<String> = config
            .channels
            .keys()
            .filter(|id| !seen.contains(*id))
            .cloned()
            .collect();
        extra.sort();
        for id in extra {
            push(&mut channels, &id, &channel_of(&config, &id));
        }
        BridgesStatus {
            enabled: config.enabled,
            running,
            webhook: format!("http://127.0.0.1:{WEBHOOK_PORT}/bridge/{{channel}}"),
            channels,
            pairings: self.list_pairings(),
        }
    }

    pub fn list_pairings(&self) -> Vec<BridgePairing> {
        let cutoff = now_secs().saturating_sub(86_400);
        self.pairings
            .lock()
            .ok()
            .map(|mut rows| {
                rows.retain(|item| item.created_at >= cutoff);
                rows.clone()
            })
            .unwrap_or_default()
    }

    pub fn save(&self, config: BridgesConfig) -> Result<BridgesConfig, String> {
        save_config(&config)?;
        if let Ok(mut slot) = self.config.lock() {
            *slot = config.clone();
        }
        Ok(config)
    }

    pub fn apply(&self, app: AppHandle, config: BridgesConfig) -> Result<BridgesStatus, String> {
        self.stop();
        self.save(config.clone())?;
        if let Ok(mut slot) = self.errors.lock() {
            slot.clear();
        }
        if !config.enabled {
            return Ok(self.status());
        }
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut slot) = self.stop.lock() {
            *slot = Some(flag.clone());
        }
        self.running.store(true, Ordering::SeqCst);
        let ctx = InboundCtx {
            app: app.clone(),
            config: self.config.clone(),
            pairings: self.pairings.clone(),
            errors: self.errors.clone(),
        };
        let inbound_any = config
            .channels
            .values()
            .any(|ch| ch.enabled && ch.accept_inbound);
        if inbound_any {
            let ctx2 = ctx.clone();
            let stop = flag.clone();
            thread::spawn(move || webhook_loop(ctx2, stop));
        }
        spawn_pollers(&ctx, &config, &flag);
        spawn_feishu_ws(&ctx, &config, &flag);
        Ok(self.status())
    }

    pub fn stop(&self) {
        if let Ok(mut slot) = self.stop.lock() {
            if let Some(flag) = slot.take() {
                flag.store(true, Ordering::SeqCst);
            }
        }
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn send(
        &self,
        kind: Option<String>,
        text: &str,
        title: &str,
        media: &[BridgeMedia],
        target: &str,
    ) -> Result<String, String> {
        let config = self.snapshot();
        if !config.enabled {
            return Err("桥接未启用".into());
        }
        let body = format_outbound(title, text);
        let want = kind.unwrap_or_default();
        let mut ok = Vec::new();
        let mut bad = Vec::new();
        let mut ids: Vec<String> = if want.is_empty() {
            let mut all: Vec<String> = config.channels.keys().cloned().collect();
            for id in KNOWN_KINDS {
                if !all.iter().any(|item| item == *id) {
                    all.push((*id).to_string());
                }
            }
            all.sort();
            all
        } else {
            vec![want.clone()]
        };
        ids.sort();
        ids.dedup();
        for id in ids {
            let ch = channel_of(&config, &id);
            if !ch.enabled || !ch.mirror_outbound {
                continue;
            }
            if !want.is_empty() && want != id {
                continue;
            }
            match send_channel(&id, &with_target(&ch, target), &body, media) {
                Ok(()) => {
                    clear_error(&self.errors, &id);
                    ok.push(id);
                }
                Err(err) => {
                    record_error(&self.errors, &id, &err);
                    bad.push(format!("{id}: {err}"));
                }
            }
        }
        if ok.is_empty() {
            if bad.is_empty() {
                return Err("没有已启用且打开「同步桌面对话」的渠道".into());
            }
            return Err(bad.join(" · "));
        }
        if bad.is_empty() {
            Ok(ok.join(" · "))
        } else {
            Ok(format!("{} · {}", ok.join(" · "), bad.join(" · ")))
        }
    }

    pub fn test(&self, kind: &str) -> Result<String, String> {
        self.send(
            Some(kind.to_string()),
            "这是 GrokDesk 桥接测试消息。",
            "GrokDesk",
            &[],
            "",
        )
    }

    pub fn probe(&self, kind: &str) -> Result<String, String> {
        let ch = channel_of(&self.snapshot(), kind);
        if !ch.enabled && ch.token.trim().is_empty() && webhook_if_any(&ch.webhook_url).is_none() && ch.app_id.trim().is_empty()
        {
            return Err("先填凭证或 Webhook".into());
        }
        match kind {
            "telegram" if !ch.token.trim().is_empty() => {
                get_json(&format!("https://api.telegram.org/bot{}/getMe", ch.token.trim()), None)
                    .map(|_| "Telegram Bot 有效".into())
            }
            "discord" if !ch.token.trim().is_empty() => {
                get_json("https://discord.com/api/v10/users/@me", Some(&format!("Bot {}", ch.token.trim())))
                    .map(|_| "Discord Bot 有效".into())
            }
            "slack" if !ch.token.trim().is_empty() => {
                get_json("https://slack.com/api/auth.test", Some(&format!("Bearer {}", ch.token.trim())))
                    .map(|_| "Slack Token 有效".into())
            }
            "feishu" if !ch.app_id.trim().is_empty() => feishu_token(&ch).map(|_| "飞书 App 凭证有效".into()),
            _ => {
                let url = webhook_if_any(&ch.webhook_url).ok_or_else(|| "没有可检测的 Token 或 Webhook".to_string())?;
                match ureq::get(&url).set("User-Agent", UA).timeout(Duration::from_secs(5)).call() {
                    Ok(res) => Ok(format!("Webhook HTTP {}", res.status())),
                    Err(ureq::Error::Status(code, _)) => Ok(format!("Webhook HTTP {code}")),
                    Err(err) => Err(err.to_string()),
                }
            }
        }
    }

    pub fn decide_pairing(&self, app: AppHandle, kind: &str, sender: &str, accept: bool) -> Result<Vec<BridgePairing>, String> {
        let found = {
            let mut rows = self.pairings.lock().map_err(|err| err.to_string())?;
            let idx = rows.iter().position(|item| item.kind == kind && item.sender == sender);
            idx.map(|i| rows.remove(i))
        };
        let Some(row) = found else {
            return Err("没有这条配对请求".into());
        };
        save_pairings(&self.list_pairings());
        if accept {
            add_allow(&self.config, kind, sender)?;
            emit_inbound(&app, kind, sender, &row.target, &row.preview);
        }
        let _ = app.emit("bridge-pairing", self.list_pairings());
        Ok(self.list_pairings())
    }
}

fn spawn_pollers(ctx: &InboundCtx, config: &BridgesConfig, stop: &Arc<AtomicBool>) {
    let telegram = channel_of(config, "telegram");
    if telegram.enabled && telegram.accept_inbound && !telegram.token.trim().is_empty() {
        let ctx = ctx.clone();
        let stop = stop.clone();
        thread::spawn(move || telegram_poll_loop(ctx, telegram, stop));
    }
    let discord = channel_of(config, "discord");
    if discord.enabled && discord.accept_inbound && !discord.token.trim().is_empty() && !discord.default_target.trim().is_empty()
    {
        let ctx = ctx.clone();
        let stop = stop.clone();
        thread::spawn(move || discord_poll_loop(ctx, discord, stop));
    }
    let slack = channel_of(config, "slack");
    if slack.enabled && slack.accept_inbound && !slack.token.trim().is_empty() && !slack.default_target.trim().is_empty() {
        let ctx = ctx.clone();
        let stop = stop.clone();
        thread::spawn(move || slack_poll_loop(ctx, slack, stop));
    }
}

fn spawn_feishu_ws(ctx: &InboundCtx, config: &BridgesConfig, stop: &Arc<AtomicBool>) {
    let feishu = channel_of(config, "feishu");
    if !feishu.enabled || !feishu.accept_inbound {
        return;
    }
    if feishu.connection_mode == "webhook" {
        return;
    }
    if feishu.app_id.trim().is_empty() || feishu.app_secret.trim().is_empty() {
        return;
    }
    let ctx = ctx.clone();
    let stop = stop.clone();
    thread::spawn(move || feishu_ws_loop(ctx, feishu, stop));
}

fn feishu_ws_loop(ctx: InboundCtx, ch: BridgeChannel, stop: Arc<AtomicBool>) {
    let base = feishu_host(&ch.domain);
    while !stop.load(Ordering::SeqCst) {
        match crate::feishu_ws::fetch_endpoint(base, ch.app_id.trim(), ch.app_secret.trim()) {
            Ok(endpoint) => {
                clear_error(&ctx.errors, "feishu");
                let result = crate::feishu_ws::run_connection(&endpoint, |value| {
                    let body = value.to_string();
                    let (sender, target, text) = parse_inbound("feishu", &body, &value);
                    route_inbound(&ctx, "feishu", &sender, &target, &text, &value);
                });
                if let Err(err) = result {
                    record_error(&ctx.errors, "feishu", err);
                }
            }
            Err(err) => record_error(&ctx.errors, "feishu", err),
        }
        sleep_while(&stop, Duration::from_secs(5));
    }
}

fn with_target(ch: &BridgeChannel, target: &str) -> BridgeChannel {
    let mut next = ch.clone();
    if !target.trim().is_empty() {
        next.default_target = target.trim().to_string();
    }
    next
}

fn add_allow(config: &Arc<Mutex<BridgesConfig>>, kind: &str, sender: &str) -> Result<(), String> {
    let sender = sender.trim();
    if sender.is_empty() {
        return Err("发送者是空的".into());
    }
    let mut cfg = config.lock().map_err(|err| err.to_string())?;
    let ch = cfg.channels.entry(kind.to_string()).or_default();
    if !allowlist_match(&ch.allow_from, sender) {
        if ch.allow_from.trim().is_empty() {
            ch.allow_from = sender.to_string();
        } else {
            ch.allow_from = format!("{}, {}", ch.allow_from.trim(), sender);
        }
    }
    save_config(&cfg)
}

fn format_outbound(title: &str, text: &str) -> String {
    let title = title.trim();
    let text = text.trim();
    if title.is_empty() {
        return text.to_string();
    }
    format!("【{title}】\n{text}")
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}

fn parse_list(raw: &str) -> Vec<String> {
    raw.split(|ch: char| ch == ',' || ch == '\n' || ch == ' ')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn allowlist_match(allow_from: &str, sender: &str) -> bool {
    let list = parse_list(allow_from);
    if list.iter().any(|item| item == "*") {
        return true;
    }
    let sender = sender.trim();
    if list.is_empty() || sender.is_empty() {
        return false;
    }
    list.iter().any(|item| item == sender)
}

fn inbound_allowed(ch: &BridgeChannel, sender: &str, is_group: bool, target: &str) -> bool {
    let policy = if is_group {
        ch.group_policy.as_str()
    } else {
        ch.dm_policy.as_str()
    };
    match policy {
        "disabled" => false,
        "open" => true,
        _ => {
            if is_group {
                let configured = ch.default_target.trim();
                if !configured.is_empty() && (configured == target.trim() || configured == sender.trim()) {
                    return true;
                }
                allowlist_match(&ch.allow_from, sender) || allowlist_match(&ch.allow_from, target)
            } else {
                allowlist_match(&ch.allow_from, sender)
            }
        }
    }
}

fn looks_mentioned(kind: &str, text: &str, value: &Value) -> bool {
    let text = text.trim();
    if text.starts_with('/') || text.contains("<@") {
        return true;
    }
    if kind == "telegram" {
        if let Some(rows) = value.pointer("/message/entities").and_then(Value::as_array) {
            return rows.iter().any(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("mention" | "text_mention")
                )
            });
        }
    }
    if kind == "discord" {
        return value
            .get("mentions")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
    }
    if kind == "slack" && text.contains("<@") {
        return true;
    }
    if value.get("mention").is_some() {
        return true;
    }
    text.split_whitespace().any(|word| word.starts_with('@') && !word.contains('.'))
}

fn looks_group(kind: &str, target: &str, value: &Value) -> bool {
    match kind {
        "telegram" => matches!(
            value
                .pointer("/message/chat/type")
                .or_else(|| value.pointer("/chat/type"))
                .and_then(Value::as_str),
            Some("group" | "supergroup" | "channel")
        ),
        "discord" => {
            let channel_type = value
                .get("channel_type")
                .or_else(|| value.pointer("/channel/type"))
                .and_then(Value::as_u64);
            if let Some(kind) = channel_type {
                return kind != 1;
            }
            value.get("guild_id").is_some()
        }
        "slack" => {
            let channel = if target.is_empty() {
                value.get("channel").and_then(Value::as_str).unwrap_or("")
            } else {
                target
            };
            !channel.starts_with('D')
        }
        "feishu" => value
            .pointer("/event/message/chat_type")
            .and_then(Value::as_str)
            == Some("group"),
        _ => {
            target.starts_with("group:")
                || target.starts_with('-')
                || target.starts_with('!')
                || target.starts_with('#')
        }
    }
}

fn emit_inbound(app: &AppHandle, kind: &str, sender: &str, target: &str, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let _ = app.emit(
        "bridge-inbound",
        BridgeInbound {
            kind: kind.into(),
            sender: sender.into(),
            target: target.into(),
            text: text.into(),
        },
    );
}

fn live_channel(ctx: &InboundCtx, kind: &str) -> BridgeChannel {
    ctx.config
        .lock()
        .ok()
        .map(|cfg| channel_of(&cfg, kind))
        .unwrap_or_default()
}

fn route_inbound(ctx: &InboundCtx, kind: &str, sender: &str, target: &str, text: &str, value: &Value) {
    let ch = live_channel(ctx, kind);
    if !ch.enabled || !ch.accept_inbound {
        return;
    }
    let group = looks_group(kind, target, value);
    if group {
        if !inbound_allowed(&ch, sender, true, target) {
            return;
        }
        if ch.require_mention && !looks_mentioned(kind, text, value) {
            let configured = ch.default_target.trim();
            if configured.is_empty() || (configured != target.trim() && configured != sender.trim()) {
                return;
            }
        }
        emit_inbound(&ctx.app, kind, sender, target, text);
        return;
    }
    match ch.dm_policy.as_str() {
        "disabled" => {}
        "open" => emit_inbound(&ctx.app, kind, sender, target, text),
        "pairing" => {
            if allowlist_match(&ch.allow_from, sender) {
                emit_inbound(&ctx.app, kind, sender, target, text);
            } else {
                handle_pairing(ctx, &ch, kind, sender, target, text);
            }
        }
        _ => {
            if allowlist_match(&ch.allow_from, sender) {
                emit_inbound(&ctx.app, kind, sender, target, text);
            }
        }
    }
}

fn pairing_code(kind: &str, sender: &str) -> String {
    let t = now_secs();
    let mut n = t as u32 ^ 0x811c_9dc5;
    for b in kind.bytes().chain(sender.bytes()) {
        n = n.wrapping_mul(16_777_619) ^ (b as u32);
    }
    format!("{:06}", n % 1_000_000)
}

fn text_has_code(text: &str, code: &str) -> bool {
    let code = code.trim();
    if code.is_empty() {
        return false;
    }
    if text.trim() == code {
        return true;
    }
    text.split(|ch: char| !ch.is_ascii_digit())
        .any(|item| item == code)
}

fn emit_pairings(ctx: &InboundCtx) {
    let rows = ctx
        .pairings
        .lock()
        .ok()
        .map(|item| item.clone())
        .unwrap_or_default();
    save_pairings(&rows);
    let _ = ctx.app.emit("bridge-pairing", rows);
}

fn handle_pairing(ctx: &InboundCtx, ch: &BridgeChannel, kind: &str, sender: &str, target: &str, text: &str) {
    let existing = ctx.pairings.lock().ok().and_then(|rows| {
        rows.iter()
            .find(|item| item.kind == kind && item.sender == sender)
            .cloned()
    });
    if let Some(row) = existing {
        if text_has_code(text, &row.code) {
            if let Ok(mut rows) = ctx.pairings.lock() {
                rows.retain(|item| !(item.kind == kind && item.sender == sender));
            }
            let _ = add_allow(&ctx.config, kind, sender);
            emit_pairings(ctx);
            let preview = if text_has_code(text, &row.code) && text.trim() == row.code {
                row.preview
            } else if row.preview.trim().is_empty() {
                text.to_string()
            } else {
                row.preview
            };
            emit_inbound(&ctx.app, kind, sender, target, &preview);
        }
        return;
    }
    let code = pairing_code(kind, sender);
    let row = BridgePairing {
        kind: kind.to_string(),
        sender: sender.to_string(),
        target: target.to_string(),
        code: code.clone(),
        preview: text.to_string(),
        created_at: now_secs(),
    };
    if let Ok(mut rows) = ctx.pairings.lock() {
        rows.push(row);
    }
    emit_pairings(ctx);
    let mut reply = ch.clone();
    if !target.trim().is_empty() {
        reply.default_target = target.to_string();
    }
    let msg = format!("GrokDesk 配对码 / pairing code: {code}。把这串数字发回来，或在设置 → 聊天桥接里批准。");
    if let Err(err) = send_channel(kind, &reply, &msg, &[]) {
        record_error(&ctx.errors, kind, err);
    }
}

fn feishu_decrypt(encrypt: &str, key: &str) -> Result<Value, String> {
    let digest = Sha256::digest(key.as_bytes());
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encrypt.trim())
        .map_err(|err| format!("飞书密文不是 Base64：{err}"))?;
    if raw.len() < 32 {
        return Err("飞书加密事件太短".into());
    }
    let (iv, data) = raw.split_at(16);
    let dec = Aes256CbcDec::new(digest.as_slice().into(), iv.into());
    let mut buf = data.to_vec();
    let plain = dec
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|err| format!("飞书解密失败：{err}"))?;
    let text = std::str::from_utf8(plain).map_err(|err| err.to_string())?.trim();
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Ok(value);
    }
    if text.len() > 16 {
        if let Ok(value) = serde_json::from_str::<Value>(text[16..].trim()) {
            return Ok(value);
        }
    }
    Err("飞书解密后不是 JSON".into())
}

fn send_channel(kind: &str, ch: &BridgeChannel, text: &str, media: &[BridgeMedia]) -> Result<(), String> {
    match kind {
        "telegram" => send_telegram(ch, text, media),
        "discord" => send_discord(ch, text, media),
        "slack" => send_slack(ch, &with_media_text(text, media)),
        "whatsapp" => send_whatsapp(ch, &with_media_text(text, media)),
        "feishu" => send_feishu(ch, &with_media_text(text, media)),
        "qq" => send_qq(ch, &with_media_text(text, media)),
        "wechat" | "wecom" | "dingtalk" => send_wecom_like(ch, &with_media_text(text, media)),
        "line" => send_line(ch, &with_media_text(text, media)),
        "zalo" => send_zalo(ch, &with_media_text(text, media)),
        "googlechat" | "msteams" | "mattermost" | "synology" | "nextcloud" | "yuanbao" => {
            send_text_webhook(ch, &with_media_text(text, media))
        }
        "matrix" => send_matrix(ch, &with_media_text(text, media)),
        "sms" => send_twilio(ch, text),
        "signal" | "imessage" | "irc" | "nostr" | "twitch" | "tlon" | "buzz" => {
            send_generic_webhook(ch, &with_media_text(text, media))
        }
        _ => send_generic_webhook(ch, &with_media_text(text, media)),
    }
}

fn with_media_text(text: &str, media: &[BridgeMedia]) -> String {
    let mut out = text.to_string();
    for item in media {
        let uri = item.uri.trim();
        if (uri.starts_with("http://") || uri.starts_with("https://")) && !out.contains(uri) {
            out.push('\n');
            out.push_str(uri);
        }
    }
    out
}

fn first_http_image(media: &[BridgeMedia]) -> Option<String> {
    media.iter().find_map(|item| {
        let uri = item.uri.trim();
        if uri.starts_with("http://") || uri.starts_with("https://") {
            Some(uri.to_string())
        } else {
            None
        }
    })
}

fn first_image_bytes(media: &[BridgeMedia]) -> Option<(String, String, Vec<u8>)> {
    for item in media {
        let raw = item.data.trim();
        if raw.is_empty() {
            continue;
        }
        let payload = raw.split(',').last().unwrap_or(raw);
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) {
            if bytes.is_empty() {
                continue;
            }
            let mime = if item.mime_type.trim().is_empty() {
                "image/png"
            } else {
                item.mime_type.trim()
            };
            let name = if item.name.trim().is_empty() {
                "image.png"
            } else {
                item.name.trim()
            };
            return Some((name.to_string(), mime.to_string(), bytes));
        }
    }
    None
}

fn send_telegram(ch: &BridgeChannel, text: &str, media: &[BridgeMedia]) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(&url, None, json!({ "text": clip(&with_media_text(text, media), 4000), "chat_id": ch.default_target }));
    }
    let token = ch.token.trim();
    let chat = ch.default_target.trim();
    if token.is_empty() || chat.is_empty() {
        return Err("缺少 Bot Token 或 chat_id".into());
    }
    if let Some(photo) = first_http_image(media) {
        return post_json(
            &format!("https://api.telegram.org/bot{token}/sendPhoto"),
            None,
            json!({ "chat_id": chat, "photo": photo, "caption": clip(text, 1024) }),
        );
    }
    if let Some((name, mime, bytes)) = first_image_bytes(media) {
        return post_multipart(
            &format!("https://api.telegram.org/bot{token}/sendPhoto"),
            None,
            &[("chat_id", chat), ("caption", &clip(text, 1024))],
            Some(("photo", &name, &mime, &bytes)),
        )
        .map(|_| ());
    }
    post_json(
        &format!("https://api.telegram.org/bot{token}/sendMessage"),
        None,
        json!({ "chat_id": chat, "text": clip(text, 4000) }),
    )
}

fn send_discord(ch: &BridgeChannel, text: &str, media: &[BridgeMedia]) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        let mut body = json!({ "content": clip(text, 1900) });
        if let Some(image) = first_http_image(media) {
            body["embeds"] = json!([{ "image": { "url": image } }]);
        } else {
            body["content"] = json!(clip(&with_media_text(text, media), 1900));
        }
        return post_json(&url, None, body);
    }
    let token = ch.token.trim();
    let channel = ch.default_target.trim();
    if token.is_empty() || channel.is_empty() {
        return Err("缺少 Bot Token 或频道 ID".into());
    }
    let endpoint = format!("https://discord.com/api/v10/channels/{channel}/messages");
    let auth = format!("Bot {token}");
    if let Some(image) = first_http_image(media) {
        return post_json(
            &endpoint,
            Some(&auth),
            json!({ "content": clip(text, 1900), "embeds": [{ "image": { "url": image } }] }),
        );
    }
    if let Some((name, mime, bytes)) = first_image_bytes(media) {
        let payload = json!({ "content": clip(text, 1900) }).to_string();
        return post_multipart(
            &endpoint,
            Some(&auth),
            &[("payload_json", &payload)],
            Some(("files[0]", &name, &mime, &bytes)),
        )
        .map(|_| ());
    }
    post_json(&endpoint, Some(&auth), json!({ "content": clip(text, 1900) }))
}

fn send_slack(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(&url, None, json!({ "text": clip(text, 4000) }));
    }
    let token = ch.token.trim();
    let channel = ch.default_target.trim();
    if token.is_empty() || channel.is_empty() {
        return Err("缺少 Bot Token 或频道 ID".into());
    }
    post_json(
        "https://slack.com/api/chat.postMessage",
        Some(&format!("Bearer {token}")),
        json!({ "channel": channel, "text": clip(text, 4000) }),
    )
}

fn send_whatsapp(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(&url, None, json!({ "text": clip(text, 4000) }));
    }
    let token = ch.token.trim();
    let phone_id = ch.app_id.trim();
    let to = ch.default_target.trim().replace([' ', '+'], "");
    if token.is_empty() || phone_id.is_empty() || to.is_empty() {
        return Err("缺少 Access Token、Phone Number ID 或对方号码".into());
    }
    post_json(
        &format!("https://graph.facebook.com/v21.0/{phone_id}/messages"),
        Some(&format!("Bearer {token}")),
        json!({
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": { "body": clip(text, 4000) },
        }),
    )
}

fn feishu_host(domain: &str) -> &'static str {
    if domain == "lark" {
        "https://open.larksuite.com"
    } else {
        "https://open.feishu.cn"
    }
}

fn feishu_token(ch: &BridgeChannel) -> Result<String, String> {
    let app_id = ch.app_id.trim();
    let secret = ch.app_secret.trim();
    if app_id.is_empty() || secret.is_empty() {
        return Err("缺少 App ID / App Secret".into());
    }
    let url = format!(
        "{}/open-apis/auth/v3/tenant_access_token/internal",
        feishu_host(&ch.domain)
    );
    let rec = post_json_value(&url, None, json!({ "app_id": app_id, "app_secret": secret }))?;
    rec.get("tenant_access_token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| rec.get("msg").and_then(Value::as_str).unwrap_or("飞书鉴权失败").to_string())
}

fn send_feishu(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(
            &url,
            None,
            json!({ "msg_type": "text", "content": { "text": clip(text, 4000) } }),
        );
    }
    let token = feishu_token(ch)?;
    let receive_id = ch.default_target.trim();
    if receive_id.is_empty() {
        return Err("缺少默认会话 ID（chat_id / open_id）".into());
    }
    let receive_id_type = if receive_id.starts_with("ou_") {
        "open_id"
    } else {
        "chat_id"
    };
    post_json(
        &format!(
            "{}/open-apis/im/v1/messages?receive_id_type={receive_id_type}",
            feishu_host(&ch.domain)
        ),
        Some(&format!("Bearer {token}")),
        json!({
            "receive_id": receive_id,
            "msg_type": "text",
            "content": serde_json::to_string(&json!({ "text": clip(text, 4000) })).unwrap_or_default(),
        }),
    )
}

fn qq_token(ch: &BridgeChannel) -> Result<String, String> {
    let app_id = ch.app_id.trim();
    let secret = ch.app_secret.trim();
    if app_id.is_empty() || secret.is_empty() {
        return Err("缺少 App ID / App Secret".into());
    }
    let rec = post_json_value(
        "https://bots.qq.com/app/getAppAccessToken",
        None,
        json!({ "appId": app_id, "clientSecret": secret }),
    )?;
    rec.get("access_token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "QQ 鉴权失败".into())
}

fn send_qq(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(&url, None, json!({ "message": clip(text, 4000) }));
    }
    let token = qq_token(ch)?;
    let target = ch.default_target.trim();
    if target.is_empty() {
        return Err("缺少默认目标（user:openid 或 group:openid）".into());
    }
    let (kind, id) = if let Some(rest) = target.strip_prefix("user:") {
        ("users", rest)
    } else if let Some(rest) = target.strip_prefix("group:") {
        ("groups", rest)
    } else {
        ("groups", target)
    };
    post_json(
        &format!("https://api.sgroup.qq.com/v2/{kind}/{id}/messages"),
        Some(&format!("QQBot {token}")),
        json!({ "content": clip(text, 4000), "msg_type": 0 }),
    )
}

fn send_wecom_like(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    let url = webhook_if_any(&ch.webhook_url).ok_or_else(|| "缺少企业微信 / 钉钉 Webhook".to_string())?;
    post_json(
        &url,
        None,
        json!({ "msgtype": "text", "text": { "content": clip(text, 4000) } }),
    )
}

fn send_line(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(&url, None, json!({ "text": clip(text, 5000) }));
    }
    let token = ch.token.trim();
    let to = ch.default_target.trim();
    if token.is_empty() || to.is_empty() {
        return Err("缺少 Channel Access Token 或用户/群 ID".into());
    }
    post_json(
        "https://api.line.me/v2/bot/message/push",
        Some(&format!("Bearer {token}")),
        json!({ "to": to, "messages": [{ "type": "text", "text": clip(text, 5000) }] }),
    )
}

fn send_zalo(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(&url, None, json!({ "text": clip(text, 2000) }));
    }
    let token = ch.token.trim();
    let user = ch.default_target.trim();
    if token.is_empty() || user.is_empty() {
        return Err("缺少 OA Access Token 或 user_id".into());
    }
    post_json(
        &format!("https://openapi.zalo.me/v3.0/oa/message/cs?access_token={token}"),
        None,
        json!({
            "recipient": { "user_id": user },
            "message": { "text": clip(text, 2000) },
        }),
    )
}

fn send_text_webhook(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    let url = webhook_if_any(&ch.webhook_url).ok_or_else(|| "缺少 Webhook".to_string())?;
    post_json(&url, None, json!({ "text": clip(text, 4000) }))
}

fn send_generic_webhook(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    let url = webhook_if_any(&ch.webhook_url).ok_or_else(|| "缺少 Webhook / HTTP 桥地址".to_string())?;
    post_json(
        &url,
        token_auth(ch).as_deref(),
        json!({
            "text": clip(text, 4000),
            "message": clip(text, 4000),
            "content": clip(text, 4000),
            "target": ch.default_target,
        }),
    )
}

fn token_auth(ch: &BridgeChannel) -> Option<String> {
    let token = ch.token.trim();
    if token.is_empty() {
        None
    } else if token.to_ascii_lowercase().starts_with("bearer ") || token.to_ascii_lowercase().starts_with("bot ") {
        Some(token.to_string())
    } else {
        Some(format!("Bearer {token}"))
    }
}

fn send_matrix(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(&url, None, json!({ "text": clip(text, 4000) }));
    }
    let token = ch.token.trim();
    let room = ch.default_target.trim();
    if token.is_empty() || room.is_empty() {
        return Err("缺少 Access Token 或 Room ID".into());
    }
    let host = homeserver(&ch.domain);
    let txn = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|item| item.as_millis())
        .unwrap_or(1);
    let url = format!(
        "{}/_matrix/client/v3/rooms/{}/send/m.room.message/{txn}",
        host,
        enc(room)
    );
    put_json(
        &url,
        Some(&format!("Bearer {token}")),
        json!({ "msgtype": "m.text", "body": clip(text, 4000) }),
    )
}

fn send_twilio(ch: &BridgeChannel, text: &str) -> Result<(), String> {
    if let Some(url) = webhook_if_any(&ch.webhook_url) {
        return post_json(&url, None, json!({ "text": clip(text, 1600) }));
    }
    let sid = ch.app_id.trim();
    let token = ch.token.trim();
    let from = ch.app_secret.trim();
    let to = ch.default_target.trim();
    if sid.is_empty() || token.is_empty() || from.is_empty() || to.is_empty() {
        return Err("缺少 Account SID / Auth Token / 发送号码 / 接收号码".into());
    }
    let auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{sid}:{token}"))
    );
    let body = format!(
        "From={}&To={}&Body={}",
        enc(from),
        enc(to),
        enc(&clip(text, 1600))
    );
    let response = ureq::post(&format!(
        "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
    ))
    .set("Authorization", &auth)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .set("User-Agent", UA)
    .send_string(&body)
    .map_err(|err| err.to_string())?;
    read_ureq(response).map(|_| ())
}

fn homeserver(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        return "https://matrix.org".into();
    }
    if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.into()
    } else {
        format!("https://{raw}")
    }
}

fn enc(raw: &str) -> String {
    let mut out = String::new();
    for b in raw.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn webhook_if_any(raw: &str) -> Option<String> {
    let url = raw.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
}

fn post_json(url: &str, auth: Option<&str>, body: Value) -> Result<(), String> {
    post_json_value(url, auth, body).map(|_| ())
}

fn put_json(url: &str, auth: Option<&str>, body: Value) -> Result<(), String> {
    let mut req = ureq::put(url)
        .set("Content-Type", "application/json")
        .set("User-Agent", UA);
    if let Some(auth) = auth {
        req = req.set("Authorization", auth);
    }
    let response = req.send_string(&body.to_string()).map_err(|err| err.to_string())?;
    read_ureq(response).map(|_| ())
}

fn post_json_value(url: &str, auth: Option<&str>, body: Value) -> Result<Value, String> {
    let mut req = ureq::post(url)
        .set("Content-Type", "application/json")
        .set("User-Agent", UA);
    if let Some(auth) = auth {
        req = req.set("Authorization", auth);
    }
    let response = req.send_string(&body.to_string()).map_err(|err| err.to_string())?;
    read_ureq(response)
}

fn post_multipart(
    url: &str,
    auth: Option<&str>,
    fields: &[(&str, &str)],
    file: Option<(&str, &str, &str, &[u8])>,
) -> Result<Value, String> {
    let boundary = format!(
        "----GD{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|item| item.as_nanos())
            .unwrap_or(1)
    );
    let mut body = Vec::new();
    for (key, value) in fields {
        let _ = write!(
            body,
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n"
        );
    }
    if let Some((name, filename, mime, data)) = file {
        let _ = write!(
            body,
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        );
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    let _ = write!(body, "--{boundary}--\r\n");
    let mut req = ureq::post(url)
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .set("User-Agent", UA);
    if let Some(auth) = auth {
        req = req.set("Authorization", auth);
    }
    let response = req.send_bytes(&body).map_err(|err| err.to_string())?;
    read_ureq(response)
}

fn read_ureq(response: ureq::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response.into_string().unwrap_or_default();
    if status >= 400 {
        return Err(clip(&format!("{status}: {text}"), 240));
    }
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }));
    if value.get("ok") == Some(&Value::Bool(false)) {
        let err = value
            .get("description")
            .or_else(|| value.get("error"))
            .cloned()
            .unwrap_or(value.clone());
        return Err(clip(&err.to_string(), 240));
    }
    if let Some(code) = value.get("code").and_then(Value::as_i64) {
        if code != 0 {
            let msg = value
                .get("msg")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("请求失败");
            return Err(format!("{code}: {msg}"));
        }
    }
    Ok(value)
}

fn webhook_loop(ctx: InboundCtx, stop: Arc<AtomicBool>) {
    let listener = match TcpListener::bind(("127.0.0.1", WEBHOOK_PORT)) {
        Ok(item) => item,
        Err(err) => {
            if let Ok(cfg) = ctx.config.lock() {
                for (id, ch) in &cfg.channels {
                    if ch.enabled && ch.accept_inbound {
                        record_error(&ctx.errors, id, format!("入站端口绑定失败：{err}"));
                    }
                }
            }
            return;
        }
    };
    let _ = listener.set_nonblocking(true);
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = handle_webhook(&ctx, stream);
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(120));
            }
            Err(_) => thread::sleep(Duration::from_millis(240)),
        }
    }
}

fn write_http(stream: &mut TcpStream, status: &str, body: &str, content_type: &str) {
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

fn handle_webhook(ctx: &InboundCtx, mut stream: TcpStream) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|err| err.to_string())?;
    let (first, headers, body) = read_http_request(&mut stream)?;
    let kind = path_kind(&first).unwrap_or_default();
    if kind.is_empty() {
        write_http(&mut stream, "404 Not Found", "", "text/plain");
        return Ok(());
    }
    let ch = live_channel(ctx, &kind);
    if first.starts_with("GET") && kind == "whatsapp" {
        if let Some(challenge) = query_param(&first, "hub.challenge") {
            let verify = query_param(&first, "hub.verify_token").unwrap_or_default();
            let expected = [
                ch.verification_token.trim(),
                ch.token.trim(),
                ch.app_secret.trim(),
            ];
            if expected.iter().any(|item| !item.is_empty() && *item == verify) {
                write_http(&mut stream, "200 OK", &challenge, "text/plain");
                return Ok(());
            }
        }
        write_http(&mut stream, "403 Forbidden", "", "text/plain");
        return Ok(());
    }
    let mut value = serde_json::from_str::<Value>(&body).unwrap_or(json!({}));
    if kind == "feishu" {
        if let Some(enc) = value.get("encrypt").and_then(Value::as_str).map(str::to_string) {
            if ch.encrypt_key.trim().is_empty() {
                record_error(&ctx.errors, "feishu", "事件已加密，请填写 Encrypt Key");
                write_http(&mut stream, "200 OK", "OK", "text/plain");
                return Ok(());
            }
            match feishu_decrypt(&enc, &ch.encrypt_key) {
                Ok(decrypted) => value = decrypted,
                Err(err) => {
                    record_error(&ctx.errors, "feishu", &err);
                    write_http(&mut stream, "200 OK", "OK", "text/plain");
                    return Ok(());
                }
            }
        }
        if let Some(challenge) = value.get("challenge").and_then(Value::as_str) {
            write_http(
                &mut stream,
                "200 OK",
                &format!("{{\"challenge\":\"{challenge}\"}}"),
                "application/json",
            );
            return Ok(());
        }
        if !ch.verification_token.trim().is_empty() {
            let got = value
                .get("token")
                .and_then(Value::as_str)
                .or_else(|| headers.get("x-lark-verification").map(String::as_str))
                .unwrap_or("");
            if got != ch.verification_token.trim() {
                write_http(&mut stream, "401 Unauthorized", "", "text/plain");
                return Ok(());
            }
        }
    }
    write_http(&mut stream, "200 OK", "OK", "text/plain");
    let body = value.to_string();
    let (sender, target, text) = parse_inbound(&kind, &body, &value);
    route_inbound(ctx, &kind, &sender, &target, &text, &value);
    Ok(())
}

fn query_param(first_line: &str, key: &str) -> Option<String> {
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            return Some(urlencoding_decode(value));
        }
    }
    None
}

fn urlencoding_decode(raw: &str) -> String {
    let mut out = String::new();
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(v as char);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { ' ' } else { bytes[i] as char });
        i += 1;
    }
    out
}

fn path_kind(first_line: &str) -> Option<String> {
    let path = first_line.split_whitespace().nth(1)?;
    let path = path.split('?').next().unwrap_or(path);
    let rest = path.strip_prefix("/bridge/")?;
    let id = rest.trim_matches('/').split('/').next().unwrap_or("").to_ascii_lowercase();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn read_http_request(stream: &mut TcpStream) -> Result<(String, HashMap<String, String>, String), String> {
    let mut data = Vec::new();
    let mut tmp = [0u8; 2048];
    loop {
        let n = stream.read(&mut tmp).map_err(|err| err.to_string())?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_header_end(&data) {
            let head = String::from_utf8_lossy(&data[..pos]).into_owned();
            let headers = parse_headers(&head);
            let declared = headers
                .get("content-length")
                .and_then(|item| item.parse::<usize>().ok())
                .unwrap_or(0)
                .min(1_048_576);
            let mut body = data.get(pos + 4..).unwrap_or(&[]).to_vec();
            while body.len() < declared {
                let n = stream.read(&mut tmp).map_err(|err| err.to_string())?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&tmp[..n]);
            }
            if declared > 0 {
                body.truncate(declared);
            }
            let first = head.lines().next().unwrap_or("").to_string();
            return Ok((first, headers, String::from_utf8_lossy(&body).into_owned()));
        }
        if data.len() > 65_536 {
            return Err("请求头过大".into());
        }
    }
    Err("不完整的 HTTP 请求".into())
}

fn find_header_end(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|item| item == b"\r\n\r\n")
}

fn parse_headers(head: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in head.lines().skip(1) {
        if let Some((key, value)) = line.split_once(':') {
            out.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    out
}

fn parse_inbound(kind: &str, body: &str, value: &Value) -> (String, String, String) {
    match kind {
        "telegram" => {
            let msg = value.get("message").cloned().unwrap_or_else(|| value.clone());
            return (
                pick_string(&msg, &["from"]).if_empty(pick_path(&msg, "/from/id")),
                pick_path(&msg, "/chat/id"),
                pick_string(&msg, &["text", "caption"]),
            );
        }
        "slack" => {
            let event = value.get("event").cloned().unwrap_or_else(|| value.clone());
            return (
                pick_string(&event, &["user", "sender"]),
                pick_string(&event, &["channel", "channel_id"]),
                pick_string(&event, &["text"]),
            );
        }
        "whatsapp" => {
            let msg = value
                .pointer("/entry/0/changes/0/value/messages/0")
                .cloned()
                .unwrap_or_else(|| value.clone());
            return (
                pick_string(&msg, &["from"]),
                pick_string(&msg, &["from"]),
                msg.pointer("/text/body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            );
        }
        "line" => {
            let event = value
                .pointer("/events/0")
                .cloned()
                .unwrap_or_else(|| value.clone());
            return (
                pick_path(&event, "/source/userId"),
                pick_path(&event, "/source/groupId").if_empty(pick_path(&event, "/source/userId")),
                pick_path(&event, "/message/text"),
            );
        }
        "feishu" => {
            let event = value.get("event").cloned().unwrap_or_else(|| value.clone());
            let message = event.get("message").cloned().unwrap_or_else(|| event.clone());
            let sender = event
                .pointer("/sender/sender_id/open_id")
                .or_else(|| event.pointer("/sender/sender_id/user_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let target = message.get("chat_id").and_then(Value::as_str).unwrap_or("").to_string();
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            let text = serde_json::from_str::<Value>(content)
                .ok()
                .and_then(|item| item.get("text").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| pick_text(value));
            return (sender, target, text);
        }
        _ => {}
    }
    if value.is_object() {
        return (
            pick_string(value, &["sender", "user_id", "openid", "author", "from"]),
            pick_string(value, &["target", "chat_id", "channel_id", "group", "room"]),
            pick_text(value),
        );
    }
    if let Some(text) = xml_tag(body, "Content") {
        return (
            xml_tag(body, "FromUserName").unwrap_or_default(),
            xml_tag(body, "ToUserName").unwrap_or_default(),
            text,
        );
    }
    (String::new(), String::new(), body.trim().to_string())
}

trait IfEmpty {
    fn if_empty(self, other: String) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, other: String) -> String {
        if self.trim().is_empty() {
            other
        } else {
            self
        }
    }
}

fn pick_path(value: &Value, pointer: &str) -> String {
    match value.pointer(pointer) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(num)) => num.to_string(),
        _ => String::new(),
    }
}

fn pick_text(value: &Value) -> String {
    for key in ["text", "content", "message", "msg", "body"] {
        match value.get(key) {
            Some(Value::String(text)) if !text.trim().is_empty() => return text.clone(),
            Some(Value::Number(num)) => return num.to_string(),
            Some(Value::Object(map)) => {
                if let Some(Value::String(text)) = map.get("text").or_else(|| map.get("content")).or_else(|| map.get("body"))
                {
                    if !text.trim().is_empty() {
                        return text.clone();
                    }
                }
            }
            _ => {}
        }
    }
    String::new()
}

fn pick_string(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        match value.get(*key) {
            Some(Value::String(text)) if !text.trim().is_empty() => return text.clone(),
            Some(Value::Number(num)) => return num.to_string(),
            Some(Value::Object(map)) => {
                if let Some(Value::String(text)) = map
                    .get("id")
                    .or_else(|| map.get("username"))
                    .or_else(|| map.get("user_id"))
                {
                    return text.clone();
                }
                if let Some(Value::Number(num)) = map.get("id") {
                    return num.to_string();
                }
            }
            _ => {}
        }
    }
    String::new()
}

fn xml_tag(body: &str, tag: &str) -> Option<String> {
    let start = format!("<{tag}>");
    let end = format!("</{tag}>");
    let from = body.find(&start)? + start.len();
    let to = body[from..].find(&end)? + from;
    Some(
        body[from..to]
            .replace("<![CDATA[", "")
            .replace("]]>", "")
            .trim()
            .to_string(),
    )
}

fn telegram_poll_loop(ctx: InboundCtx, ch: BridgeChannel, stop: Arc<AtomicBool>) {
    let token = ch.token.trim().to_string();
    let mut offset: i64 = 0;
    while !stop.load(Ordering::SeqCst) {
        let url = format!("https://api.telegram.org/bot{token}/getUpdates?timeout=20&offset={offset}");
        match get_json(&url, None) {
            Ok(value) => {
                clear_error(&ctx.errors, "telegram");
                if let Some(rows) = value.get("result").and_then(Value::as_array) {
                    for item in rows {
                        if let Some(id) = item.get("update_id").and_then(Value::as_i64) {
                            offset = id + 1;
                        }
                        let (sender, target, text) = parse_inbound("telegram", "", item);
                        route_inbound(&ctx, "telegram", &sender, &target, &text, item);
                    }
                }
            }
            Err(err) => {
                record_error(&ctx.errors, "telegram", err);
                sleep_while(&stop, Duration::from_secs(4));
            }
        }
    }
}

fn discord_poll_loop(ctx: InboundCtx, ch: BridgeChannel, stop: Arc<AtomicBool>) {
    let token = ch.token.trim().to_string();
    let channel = ch.default_target.trim().to_string();
    if token.is_empty() || channel.is_empty() {
        return;
    }
    let mut after = String::new();
    let mut primed = false;
    while !stop.load(Ordering::SeqCst) {
        let url = if after.is_empty() {
            format!("https://discord.com/api/v10/channels/{channel}/messages?limit=5")
        } else {
            format!("https://discord.com/api/v10/channels/{channel}/messages?after={after}&limit=20")
        };
        match get_json(&url, Some(&format!("Bot {token}"))) {
            Ok(value) => {
                clear_error(&ctx.errors, "discord");
                if let Some(rows) = value.as_array() {
                    if !primed {
                        after = rows
                            .first()
                            .and_then(|item| item.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        primed = true;
                    } else {
                        for item in rows.iter().rev() {
                            if item.get("author").and_then(|a| a.get("bot")).and_then(Value::as_bool) == Some(true) {
                                continue;
                            }
                            let sender = item
                                .pointer("/author/id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let text = item.get("content").and_then(Value::as_str).unwrap_or("").trim().to_string();
                            route_inbound(&ctx, "discord", &sender, &channel, &text, item);
                            if let Some(id) = item.get("id").and_then(Value::as_str) {
                                after = id.to_string();
                            }
                        }
                    }
                }
            }
            Err(err) => record_error(&ctx.errors, "discord", err),
        }
        sleep_while(&stop, Duration::from_secs(6));
    }
}

fn slack_poll_loop(ctx: InboundCtx, ch: BridgeChannel, stop: Arc<AtomicBool>) {
    let token = ch.token.trim().to_string();
    let channel = ch.default_target.trim().to_string();
    if token.is_empty() || channel.is_empty() {
        return;
    }
    let mut oldest = String::new();
    let mut primed = false;
    while !stop.load(Ordering::SeqCst) {
        let url = if oldest.is_empty() {
            format!("https://slack.com/api/conversations.history?channel={channel}&limit=5")
        } else {
            format!("https://slack.com/api/conversations.history?channel={channel}&oldest={oldest}&limit=20")
        };
        match get_json(&url, Some(&format!("Bearer {token}"))) {
            Ok(value) => {
                clear_error(&ctx.errors, "slack");
                if let Some(rows) = value.get("messages").and_then(Value::as_array) {
                    if !primed {
                        oldest = rows
                            .first()
                            .and_then(|item| item.get("ts"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        primed = true;
                    } else {
                        for item in rows.iter().rev() {
                            if item.get("bot_id").is_some() || item.get("subtype").is_some() {
                                continue;
                            }
                            let sender = item.get("user").and_then(Value::as_str).unwrap_or("").to_string();
                            let text = item.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                            let ts = item.get("ts").and_then(Value::as_str).unwrap_or("");
                            route_inbound(&ctx, "slack", &sender, &channel, &text, item);
                            if !ts.is_empty() {
                                oldest = ts.to_string();
                            }
                        }
                    }
                }
            }
            Err(err) => record_error(&ctx.errors, "slack", err),
        }
        sleep_while(&stop, Duration::from_secs(6));
    }
}

fn sleep_while(stop: &AtomicBool, total: Duration) {
    let started = Instant::now();
    while started.elapsed() < total && !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(200));
    }
}

fn get_json(url: &str, auth: Option<&str>) -> Result<Value, String> {
    let mut req = ureq::get(url).set("User-Agent", UA);
    if let Some(auth) = auth {
        req = req.set("Authorization", auth);
    }
    let response = req.call().map_err(|err| err.to_string())?;
    read_ureq(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_empty_denies() {
        let ch = BridgeChannel {
            dm_policy: "allowlist".into(),
            allow_from: String::new(),
            ..Default::default()
        };
        assert!(!inbound_allowed(&ch, "u1", false, ""));
    }

    #[test]
    fn open_allows() {
        let ch = BridgeChannel {
            dm_policy: "open".into(),
            ..Default::default()
        };
        assert!(inbound_allowed(&ch, "u1", false, ""));
    }

    #[test]
    fn star_allows() {
        let ch = BridgeChannel {
            dm_policy: "allowlist".into(),
            allow_from: "*".into(),
            ..Default::default()
        };
        assert!(inbound_allowed(&ch, "u1", false, ""));
    }

    #[test]
    fn disabled_denies() {
        let ch = BridgeChannel {
            dm_policy: "disabled".into(),
            allow_from: "*".into(),
            ..Default::default()
        };
        assert!(!inbound_allowed(&ch, "u1", false, ""));
    }

    #[test]
    fn configured_group_is_allowed() {
        let ch = BridgeChannel {
            group_policy: "allowlist".into(),
            default_target: "C123".into(),
            ..Default::default()
        };
        assert!(inbound_allowed(&ch, "u1", true, "C123"));
        assert!(!inbound_allowed(&ch, "u1", true, "C999"));
    }

    #[test]
    fn path_kind_reads_channel() {
        assert_eq!(
            path_kind("POST /bridge/telegram HTTP/1.1").as_deref(),
            Some("telegram")
        );
        assert_eq!(path_kind("POST /bridge HTTP/1.1"), None);
        assert_eq!(path_kind("POST /bridge/Feishu/event HTTP/1.1").as_deref(), Some("feishu"));
    }

    #[test]
    fn migrate_legacy_top_level() {
        let value = json!({
            "enabled": true,
            "discord": { "enabled": true, "token": "t", "defaultTarget": "c" }
        });
        let cfg = migrate_config(value);
        assert!(cfg.enabled);
        assert_eq!(cfg.channels.get("discord").map(|c| c.token.as_str()), Some("t"));
    }

    #[test]
    fn pairing_code_is_accepted() {
        assert!(text_has_code("123456", "123456"));
        assert!(text_has_code("配对码 123456 谢谢", "123456"));
        assert!(!text_has_code("hello", "123456"));
        assert!(!text_has_code("电话 1234567890", "123456"));
    }

    #[test]
    fn mention_ignores_email() {
        assert!(!looks_mentioned("generic", "mail me at a@b.com please", &json!({})));
        assert!(looks_mentioned("generic", "hey @bot hi", &json!({})));
    }

    #[test]
    fn discord_dm_is_not_group() {
        assert!(!looks_group("discord", "dm1", &json!({"channel_type": 1, "content": "hi"})));
        assert!(looks_group("discord", "c1", &json!({"guild_id": "1", "content": "hi"})));
        assert!(!looks_group("discord", "dm1", &json!({"type": 0, "content": "hi"})));
    }

    #[test]
    fn whatsapp_challenge_query() {
        let line = "GET /bridge/whatsapp?hub.mode=subscribe&hub.challenge=abc%201&hub.verify_token=tok HTTP/1.1";
        assert_eq!(path_kind(line).as_deref(), Some("whatsapp"));
        assert_eq!(query_param(line, "hub.challenge").as_deref(), Some("abc 1"));
        assert_eq!(query_param(line, "hub.verify_token").as_deref(), Some("tok"));
    }

    #[test]
    fn feishu_decrypt_roundtrip() {
        use cbc::Encryptor;
        use cipher::BlockEncryptMut;
        type Enc = Encryptor<Aes256>;
        let key = "test-encrypt-key";
        let digest = Sha256::digest(key.as_bytes());
        let iv = [3u8; 16];
        let plain = br#"{"challenge":"abc","schema":"2.0"}"#;
        let mut buf = vec![0u8; plain.len() + 16];
        buf[..plain.len()].copy_from_slice(plain);
        let encrypted = Enc::new(digest.as_slice().into(), (&iv).into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len())
            .expect("encrypt")
            .to_vec();
        let mut packed = iv.to_vec();
        packed.extend_from_slice(&encrypted);
        let encoded = base64::engine::general_purpose::STANDARD.encode(packed);
        let value = feishu_decrypt(&encoded, key).expect("decrypt");
        assert_eq!(value.get("challenge").and_then(Value::as_str), Some("abc"));
    }
}
