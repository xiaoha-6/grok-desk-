use crate::runtime::{grok_home, resolve_binary};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub weekly_used_percent: Option<f64>,
    pub weekly_remaining_percent: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub monthly_used: Option<f64>,
    pub monthly_remaining: Option<f64>,
    pub period_end: Option<String>,
    pub checked_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    pub name: String,
    pub home_path: String,
    pub enabled: bool,
    pub created_at: u64,
    pub quota: Option<QuotaSnapshot>,
    #[serde(default)]
    pub logged_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountStateFile {
    accounts: Vec<AccountRecord>,
    routing_mode: Option<String>,
    preferred_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub accounts: Vec<AccountRecord>,
    pub routing_mode: String,
    pub preferred_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub description: String,
    pub short_description: Option<String>,
    pub path: String,
    pub scope: String,
    pub enabled: bool,
    pub user_invocable: bool,
    pub when_to_use: Option<String>,
    pub argument_hint: Option<String>,
    pub author: Option<String>,
    pub compatibility: Option<String>,
    pub content: String,
}

pub struct LoginJob {
    cancel: Arc<AtomicBool>,
}

impl LoginJob {
    pub fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub type LoginSlot = Arc<Mutex<Option<LoginJob>>>;

pub fn desk_root() -> PathBuf {
    dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("GrokDesk")
}

fn state_path() -> PathBuf {
    desk_root().join("accounts.json")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn new_id() -> String {
    format!(
        "{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}",
        (now_secs() ^ 0x9e37_79b9) as u32,
        (std::process::id() & 0xffff) as u16,
        (now_secs() as u16) & 0x0fff,
        (std::process::id() >> 8) & 0x0fff,
        now_secs() as u64 % 1_000_000_000_000
    )
}

fn auth_path(home: &str) -> PathBuf {
    PathBuf::from(home).join("auth.json")
}

fn is_logged_in(home: &str) -> bool {
    auth_path(home).is_file()
}

fn load_file() -> AccountStateFile {
    let path = state_path();
    let Ok(bytes) = fs::read(&path) else {
        return AccountStateFile::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_file(state: &AccountStateFile) -> Result<(), String> {
    fs::create_dir_all(desk_root()).map_err(|err| format!("无法创建账号目录：{err}"))?;
    let path = state_path();
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(state).map_err(|err| format!("序列化账号失败：{err}"))?;
    fs::write(&tmp, bytes).map_err(|err| format!("写入账号失败：{err}"))?;
    fs::rename(tmp, path).map_err(|err| format!("保存账号失败：{err}"))
}

fn refresh_login_flags(mut accounts: Vec<AccountRecord>) -> Vec<AccountRecord> {
    for account in &mut accounts {
        account.logged_in = is_logged_in(&account.home_path);
    }
    accounts
}

fn with_default_account(mut state: AccountStateFile) -> AccountStateFile {
    let default_home = grok_home();
    let default_path = default_home.display().to_string();
    let has_default = state.accounts.iter().any(|account| {
        PathBuf::from(&account.home_path) == default_home
    });
    if !has_default {
        state.accounts.insert(
            0,
            AccountRecord {
                id: "local".to_string(),
                name: "本机 Grok CLI".to_string(),
                home_path: default_path,
                enabled: true,
                created_at: now_secs(),
                quota: None,
                logged_in: false,
            },
        );
    }
    state.accounts = refresh_login_flags(state.accounts);
    state
}

pub fn load_state() -> AccountState {
    let state = with_default_account(load_file());
    AccountState {
        accounts: state.accounts,
        routing_mode: state
            .routing_mode
            .unwrap_or_else(|| "quota".to_string()),
        preferred_account_id: state.preferred_account_id,
    }
}

pub fn save_accounts(
    accounts: Vec<AccountRecord>,
    routing_mode: Option<String>,
    preferred_account_id: Option<String>,
) -> Result<AccountState, String> {
    let mut state = with_default_account(load_file());
    state.accounts = refresh_login_flags(accounts);
    if let Some(mode) = routing_mode {
        state.routing_mode = Some(mode);
    }
    state.preferred_account_id = preferred_account_id;
    save_file(&state)?;
    Ok(load_state())
}

pub fn prepare_home(home: &Path) -> Result<(), String> {
    fs::create_dir_all(home).map_err(|err| format!("无法创建账号目录：{err}"))?;
    let default_home = grok_home();
    let shared = [
        "sessions",
        "bin",
        "skills",
        "plugins",
        "hooks",
        "agents",
        "commands",
        "marketplaces",
        "config.toml",
        "managed_config.toml",
    ];
    for name in shared {
        let source = default_home.join(name);
        let target = home.join(name);
        if !source.exists() || target.exists() {
            continue;
        }
        link_or_copy(&source, &target);
    }
    Ok(())
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
fn copy_dir(source: &Path, target: &Path) -> std::io::Result<()> {
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

pub fn create_account(name: String) -> Result<AccountRecord, String> {
    let id = new_id();
    let home = desk_root().join("accounts").join(&id);
    prepare_home(&home)?;
    Ok(AccountRecord {
        id,
        name: if name.trim().is_empty() {
            "Grok 账号".to_string()
        } else {
            name.trim().to_string()
        },
        home_path: home.display().to_string(),
        enabled: true,
        created_at: now_secs(),
        quota: None,
        logged_in: false,
    })
}

pub fn commit_account(account: AccountRecord) -> Result<AccountState, String> {
    let mut state = with_default_account(load_file());
    if !state.accounts.iter().any(|item| item.id == account.id) {
        state.accounts.push(account);
    }
    state.accounts = refresh_login_flags(state.accounts);
    save_file(&state)?;
    Ok(load_state())
}

pub fn drop_uncommitted_home(home: &str) {
    let path = PathBuf::from(home);
    if path.starts_with(desk_root().join("accounts")) {
        let _ = fs::remove_dir_all(path);
    }
}

pub fn start_login(
    app: AppHandle,
    slot: &LoginSlot,
    account: AccountRecord,
    commit: bool,
) -> Result<(), String> {
    let mut guard = slot.lock().map_err(|_| "无法启动登录".to_string())?;
    if guard.is_some() {
        return Err("已有登录正在进行".into());
    }
    let job = LoginJob::new();
    let cancel = Arc::clone(&job.cancel);
    *guard = Some(job);
    drop(guard);
    let slot = Arc::clone(slot);

    thread::spawn(move || {
        let result = run_login(&app, &account, &cancel);
        let logged_in = is_logged_in(&account.home_path);
        if commit {
            if result.is_ok() && logged_in {
                let _ = commit_account(account.clone());
            } else {
                drop_uncommitted_home(&account.home_path);
            }
        }
        if let Ok(mut guard) = slot.lock() {
            *guard = None;
        }
        let _ = app.emit(
            "account-login-done",
            serde_json::json!({
                "id": account.id,
                "ok": result.is_ok() && logged_in,
                "loggedIn": logged_in,
                "error": result.err(),
                "commit": commit
            }),
        );
    });
    Ok(())
}

pub fn clear_login(slot: &LoginSlot) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(job) = guard.take() {
            job.cancel.store(true, Ordering::SeqCst);
        }
    }
}

fn run_login(
    app: &AppHandle,
    account: &AccountRecord,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let binary = resolve_binary().ok_or_else(|| "还没有检测到 Grok Build".to_string())?;
    let _ = app.emit(
        "account-login-log",
        format!("正在启动 {} 的浏览器登录…", account.name),
    );
    prepare_home(Path::new(&account.home_path))?;
    let mut command = Command::new(&binary);
    command
        .arg("login")
        .arg("--oauth")
        .current_dir(dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .env("GROK_HOME", &account.home_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let bin_dir = binary.parent().unwrap_or(Path::new("."));
    let path_sep = if cfg!(windows) { ';' } else { ':' };
    let mut path_value = bin_dir.display().to_string();
    if let Ok(existing) = std::env::var("PATH") {
        path_value.push(path_sep);
        path_value.push_str(&existing);
    }
    command.env("PATH", path_value);
    crate::runtime::hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("无法启动 grok login：{err}"))?;
    if let Some(stdout) = child.stdout.take() {
        pipe_lines(app, stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_lines(app, stderr);
    }
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("登录已取消".into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!("Grok CLI 退出码 {}", status.code().unwrap_or(-1)))
            }
            Ok(None) => thread::sleep(std::time::Duration::from_millis(200)),
            Err(err) => return Err(format!("等待登录失败：{err}")),
        }
    }
}

fn pipe_lines<R: std::io::Read + Send + 'static>(app: &AppHandle, reader: R) {
    let app = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                let _ = app.emit("account-login-log", trimmed);
            }
        }
    });
}

pub fn fetch_quota(account: &AccountRecord) -> QuotaSnapshot {
    match fetch_quota_inner(account) {
        Ok(snapshot) => snapshot,
        Err(error) => QuotaSnapshot {
            weekly_used_percent: None,
            weekly_remaining_percent: None,
            monthly_limit: None,
            monthly_used: None,
            monthly_remaining: None,
            period_end: None,
            checked_at: Some(now_secs()),
            error: Some(error),
        },
    }
}

fn fetch_quota_inner(account: &AccountRecord) -> Result<QuotaSnapshot, String> {
    let token = read_token(&auth_path(&account.home_path))?;
    let weekly = billing_request(&token, Some("format=credits"))?;
    let monthly = billing_request(&token, None)?;
    let weekly_used = find_number(&weekly, &["creditUsagePercent"]);
    let limit = find_number(&monthly, &["monthlyLimit", "monthly_limit"]);
    let used = find_number(&monthly, &["used", "monthlyUsed", "monthly_used"]);
    let remaining = find_number(
        &monthly,
        &["remaining", "monthlyRemaining", "monthly_remaining"],
    )
    .or_else(|| match (limit, used) {
        (Some(limit), Some(used)) => Some((limit - used).max(0.0)),
        _ => None,
    });
    let period_end = find_string(&weekly, &["end", "billingPeriodEnd", "billing_period_end"])
        .or_else(|| find_string(&monthly, &["billingPeriodEnd", "billing_period_end"]));
    Ok(QuotaSnapshot {
        weekly_used_percent: weekly_used,
        weekly_remaining_percent: weekly_used.map(|value| (100.0 - value).max(0.0)),
        monthly_limit: limit,
        monthly_used: used,
        monthly_remaining: remaining,
        period_end,
        checked_at: Some(now_secs()),
        error: None,
    })
}

fn read_token(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|_| "尚未登录，auth.json 不存在".to_string())?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|err| format!("无法解析 auth.json：{err}"))?;
    find_string(&value, &["key", "access_token", "accessToken"])
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "auth.json 中没有可用登录令牌".to_string())
}

fn billing_request(token: &str, query: Option<&str>) -> Result<Value, String> {
    let mut url = "https://cli-chat-proxy.grok.com/v1/billing".to_string();
    if let Some(query) = query {
        url.push('?');
        url.push_str(query);
    }
    let mut command = Command::new("curl");
    command
        .arg("-sS")
        .arg("-f")
        .arg("-H")
        .arg(format!("Authorization: Bearer {token}"))
        .arg("-H")
        .arg("Accept: application/json")
        .arg("-H")
        .arg("x-grok-client-version: 0.2.101")
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::runtime::hide_console(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法请求额度接口：{err}"))?;
    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        return Err(format!(
            "额度接口 HTTP {code}，可先重新登录或发起一次对话刷新令牌"
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|err| format!("额度响应无法解析：{err}"))
}

fn find_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(Value::String(text)) = map.get(*key) {
                    if !text.is_empty() {
                        return Some(text.clone());
                    }
                }
            }
            for child in map.values() {
                if let Some(found) = find_string(child, keys) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(|item| find_string(item, keys)),
        _ => None,
    }
}

fn find_number(value: &Value, keys: &[&str]) -> Option<f64> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(found) = map.get(*key) {
                    if let Some(number) = found.as_f64() {
                        return Some(number);
                    }
                    if let Some(text) = found.as_str() {
                        if let Ok(number) = text.parse::<f64>() {
                            return Some(number);
                        }
                    }
                }
            }
            for child in map.values() {
                if let Some(found) = find_number(child, keys) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(|item| find_number(item, keys)),
        _ => None,
    }
}

pub fn discover_skills(cwd: Option<String>) -> Vec<SkillRecord> {
    let mut roots: Vec<(PathBuf, &str)> = Vec::new();
    let home = grok_home();
    roots.push((home.join("skills"), "user"));
    roots.push((home.join("server-skills"), "server"));
    if let Some(cwd) = cwd {
        let mut cursor = PathBuf::from(cwd);
        let mut first = true;
        loop {
            roots.push((
                cursor.join(".grok").join("skills"),
                if first { "local" } else { "repo" },
            ));
            first = false;
            if !cursor.pop() {
                break;
            }
        }
    }

    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (root, scope) in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            let file = dir.join("SKILL.md");
            if !file.is_file() {
                continue;
            }
            let Ok(content) = fs::read_to_string(&file) else {
                continue;
            };
            let fields = frontmatter(&content);
            let fallback = dir
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("skill")
                .to_string();
            let name = fields
                .get("name")
                .cloned()
                .filter(|value| !value.is_empty())
                .unwrap_or(fallback);
            if !seen.insert(name.clone()) {
                continue;
            }
            let description = fields
                .get("description")
                .cloned()
                .or_else(|| first_paragraph(&content))
                .unwrap_or_else(|| "Grok Skill".to_string());
            result.push(SkillRecord {
                id: format!("{scope}:{name}:{}", file.display()),
                display_name: fields.get("display_name").cloned(),
                name,
                description,
                short_description: fields.get("short_description").cloned(),
                path: file.display().to_string(),
                scope: scope.to_string(),
                enabled: true,
                user_invocable: fields
                    .get("user_invocable")
                    .map(|value| value.to_ascii_lowercase() != "false")
                    .unwrap_or(true),
                when_to_use: fields.get("when_to_use").cloned(),
                argument_hint: fields.get("argument_hint").cloned(),
                author: fields.get("author").cloned(),
                compatibility: fields.get("compatibility").cloned(),
                content,
            });
        }
    }
    result.sort_by(|a, b| {
        title(a)
            .to_ascii_lowercase()
            .cmp(&title(b).to_ascii_lowercase())
    });
    result
}

fn title(skill: &SkillRecord) -> &str {
    skill
        .display_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(&skill.name)
}

fn frontmatter(content: &str) -> std::collections::HashMap<String, String> {
    let mut values = std::collections::HashMap::new();
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return values;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let mut value = value.trim().to_string();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value.remove(0);
            value.pop();
        }
        if !key.trim().is_empty() && !value.is_empty() {
            values.insert(key.trim().to_string(), value);
        }
    }
    values
}

fn first_paragraph(content: &str) -> Option<String> {
    let mut in_frontmatter = content.lines().next().map(str::trim) == Some("---");
    for (index, line) in content.lines().enumerate() {
        let value = line.trim();
        if in_frontmatter {
            if index > 0 && value == "---" {
                in_frontmatter = false;
            }
            continue;
        }
        if !value.is_empty() && !value.starts_with('#') {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_nested_billing_fields() {
        let weekly = json!({"usage": {"creditUsagePercent": 12.5, "end": "2026-09-01"}});
        assert_eq!(find_number(&weekly, &["creditUsagePercent"]), Some(12.5));
        assert_eq!(
            find_string(&weekly, &["end", "billingPeriodEnd"]).as_deref(),
            Some("2026-09-01")
        );
    }

    #[test]
    fn parses_skill_frontmatter() {
        let fields = frontmatter("---\nname: demo\ndescription: Hello\n---\n# Title\nbody");
        assert_eq!(fields.get("name").map(String::as_str), Some("demo"));
        assert_eq!(first_paragraph("---\nname: demo\n---\n\nUseful skill.").as_deref(), Some("Useful skill."));
    }
}
