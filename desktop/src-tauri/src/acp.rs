use crate::runtime::{grok_home, resolve_binary};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CLIENT_VERSION: &str = "0.4.1";
const INIT_TIMEOUT: Duration = Duration::from_secs(45);
const SESSION_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub model: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStatus {
    pub connected: bool,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
}

struct PendingMap {
    inner: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
}

impl PendingMap {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
        })
    }

    fn insert(&self, id: String, tx: mpsc::Sender<Result<Value, String>>) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(id, tx);
        }
    }

    fn take(&self, id: &str) -> Option<mpsc::Sender<Result<Value, String>>> {
        self.inner.lock().ok().and_then(|mut map| map.remove(id))
    }

    fn fail_all(&self, message: &str) {
        if let Ok(mut map) = self.inner.lock() {
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(message.to_string()));
            }
        }
    }
}

struct AgentProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: Arc<AtomicU64>,
    pending: Arc<PendingMap>,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        self.pending.fail_all("Grok Agent 已退出");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct AcpClient {
    agent: Option<AgentProcess>,
    session: Option<SessionInfo>,
}

impl Default for AcpClient {
    fn default() -> Self {
        Self {
            agent: None,
            session: None,
        }
    }
}

impl AcpClient {
    pub fn status(&self) -> AcpStatus {
        AcpStatus {
            connected: self.agent.is_some() && self.session.is_some(),
            session_id: self.session.as_ref().map(|s| s.session_id.clone()),
            model: self.session.as_ref().map(|s| s.model.clone()),
            cwd: self.session.as_ref().map(|s| s.cwd.clone()),
        }
    }

    pub fn stop(&mut self) {
        self.agent = None;
        self.session = None;
    }

    pub fn cancel(&self) -> Result<(), String> {
        let agent = self.agent.as_ref().ok_or_else(|| "Agent 尚未连接".to_string())?;
        let session_id = self
            .session
            .as_ref()
            .map(|s| s.session_id.clone())
            .ok_or_else(|| "ACP Session 尚未就绪".to_string())?;
        write_message(
            &agent.stdin,
            json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": session_id, "reason": "user" }
            }),
        )
    }

    pub fn ensure_session(
        &mut self,
        app: &AppHandle,
        model: Option<String>,
        cwd: Option<String>,
        existing_session_id: Option<String>,
    ) -> Result<SessionInfo, String> {
        let model = model
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "grok-4.5".to_string());
        let cwd = resolve_cwd(cwd)?;

        if let Some(current) = &self.session {
            if self.agent.is_some()
                && current.model == model
                && current.cwd == cwd
                && existing_session_id.as_ref() == Some(&current.session_id)
            {
                return Ok(current.clone());
            }
        }

        let restart_agent = self.agent.is_none()
            || self
                .session
                .as_ref()
                .map(|current| current.model != model)
                .unwrap_or(true);
        if restart_agent {
            self.stop();
            self.spawn_agent(app, &model, &cwd)?;
            self.initialize(app)?;
        }

        let session = self.open_session(&cwd, existing_session_id.as_deref())?;
        let info = SessionInfo {
            session_id: session,
            model,
            cwd,
        };
        self.session = Some(info.clone());
        Ok(info)
    }

    pub fn send_prompt(&self, app: &AppHandle, text: String) -> Result<(), String> {
        let agent = self.agent.as_ref().ok_or_else(|| "Agent 尚未连接".to_string())?;
        let session_id = self
            .session
            .as_ref()
            .map(|s| s.session_id.clone())
            .ok_or_else(|| "ACP Session 尚未就绪".to_string())?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("请输入要发送的内容".into());
        }

        let stdin = Arc::clone(&agent.stdin);
        let next_id = Arc::clone(&agent.next_id);
        let pending = Arc::clone(&agent.pending);
        let app = app.clone();
        let prompt = trimmed.to_string();
        thread::spawn(move || {
            let result = rpc_request(
                &stdin,
                &next_id,
                &pending,
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": prompt }]
                }),
                Duration::from_secs(60 * 30),
            );
            match result {
                Ok(_) => {
                    let _ = app.emit("acp-turn-done", json!({ "ok": true }));
                }
                Err(error) => {
                    let _ = app.emit(
                        "acp-turn-done",
                        json!({ "ok": false, "error": error }),
                    );
                }
            }
        });
        Ok(())
    }

    fn spawn_agent(&mut self, app: &AppHandle, model: &str, cwd: &str) -> Result<(), String> {
        let binary = resolve_binary().ok_or_else(|| "还没有检测到 Grok Build".to_string())?;
        let mut command = Command::new(&binary);
        command.arg("agent");
        if !model.is_empty() {
            command.arg("--model").arg(model);
        }
        command
            .arg("stdio")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("GROK_HOME", grok_home())
            .env("GROK_MEMORY", "1");

        let bin_dir = binary
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let path_sep = if cfg!(windows) { ';' } else { ':' };
        let mut path_value = bin_dir.display().to_string();
        if let Ok(existing) = std::env::var("PATH") {
            path_value.push(path_sep);
            path_value.push_str(&existing);
        }
        command.env("PATH", path_value);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|err| format!("无法启动 Grok Agent：{err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Grok Agent 没有 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Grok Agent 没有 stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Grok Agent 没有 stderr".to_string())?;

        let stdin = Arc::new(Mutex::new(stdin));
        let next_id = Arc::new(AtomicU64::new(1));
        let pending = PendingMap::new();
        spawn_stdout_reader(app.clone(), Arc::clone(&stdin), Arc::clone(&pending), stdout);
        spawn_stderr_reader(app.clone(), stderr);

        self.agent = Some(AgentProcess {
            child,
            stdin,
            next_id,
            pending,
        });
        Ok(())
    }

    fn initialize(&self, _app: &AppHandle) -> Result<(), String> {
        let agent = self.agent.as_ref().ok_or_else(|| "Agent 尚未连接".to_string())?;
        let client_type = if cfg!(target_os = "windows") {
            "grokdesk-windows"
        } else if cfg!(target_os = "macos") {
            "grokdesk-macos"
        } else {
            "grokdesk-linux"
        };
        let result = rpc_request(
            &agent.stdin,
            &agent.next_id,
            &agent.pending,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "_meta": {
                        "x.ai/incrementalBashOutput": true,
                        "x.ai/hunkTracker": { "mode": "full" },
                        "x.ai/gitHeadChanged": true
                    }
                },
                "_meta": {
                    "clientType": client_type,
                    "clientVersion": CLIENT_VERSION
                }
            }),
            INIT_TIMEOUT,
        )?;
        authenticate_if_needed(&agent.stdin, &agent.next_id, &agent.pending, &result)
    }

    fn open_session(&self, cwd: &str, existing_session_id: Option<&str>) -> Result<String, String> {
        let agent = self.agent.as_ref().ok_or_else(|| "Agent 尚未连接".to_string())?;
        let method = if existing_session_id.is_some() {
            "session/load"
        } else {
            "session/new"
        };
        let mut params = json!({
            "cwd": cwd,
            "mcpServers": [],
            "_meta": {
                "yoloMode": true,
                "autoMode": true
            }
        });
        if let Some(session_id) = existing_session_id {
            params["sessionId"] = json!(session_id);
        }

        match rpc_request(
            &agent.stdin,
            &agent.next_id,
            &agent.pending,
            method,
            params,
            SESSION_TIMEOUT,
        ) {
            Ok(value) => session_id_from(&value, existing_session_id),
            Err(error) if existing_session_id.is_some() => {
                let created = rpc_request(
                    &agent.stdin,
                    &agent.next_id,
                    &agent.pending,
                    "session/new",
                    json!({
                        "cwd": cwd,
                        "mcpServers": [],
                        "_meta": {
                            "yoloMode": true,
                            "autoMode": true
                        }
                    }),
                    SESSION_TIMEOUT,
                )?;
                session_id_from(&created, None).map_err(|_| error)
            }
            Err(error) => Err(error),
        }
    }
}

fn resolve_cwd(cwd: Option<String>) -> Result<String, String> {
    if let Some(value) = cwd {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    Ok(dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .display()
        .to_string())
}

fn spawn_stdout_reader(
    app: AppHandle,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<PendingMap>,
    stdout: impl std::io::Read + Send + 'static,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(json) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            dispatch_message(&app, &stdin, &pending, json);
        }
        pending.fail_all("Grok Agent 已退出");
        let _ = app.emit("acp-exit", json!({ "ok": false }));
    });
}

fn spawn_stderr_reader(app: AppHandle, stderr: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(plain) = user_facing_diagnostic(&line) {
                let _ = app.emit("acp-diagnostic", plain);
            }
        }
    });
}

fn dispatch_message(
    app: &AppHandle,
    stdin: &Arc<Mutex<ChildStdin>>,
    pending: &PendingMap,
    json: Value,
) {
    let id = json.get("id").cloned();
    let method = json.get("method").and_then(Value::as_str).map(str::to_string);
    if let Some(id) = &id {
        if method.is_none() {
            let key = stringify_id(id);
            if let Some(tx) = pending.take(&key) {
                if let Some(error) = json.get("error") {
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("ACP 请求失败")
                        .to_string();
                    let _ = tx.send(Err(message));
                } else {
                    let result = json.get("result").cloned().unwrap_or(Value::Null);
                    let wrapped = match result {
                        Value::Object(_) => result,
                        other => json!({ "_value": other }),
                    };
                    let _ = tx.send(Ok(wrapped));
                }
            }
            return;
        }
    }

    let mut method = method.unwrap_or_else(|| "unknown".to_string());
    let mut params = json.get("params").cloned().unwrap_or_else(|| json!({}));
    if method.starts_with("_x.ai/") {
        if let Some(inner_method) = params.get("method").and_then(Value::as_str) {
            if let Some(inner_params) = params.get("params").cloned() {
                method = inner_method.to_string();
                params = inner_params;
            }
        }
    }

    if let Some(id) = id {
        if method == "session/request_permission"
            || method == "x.ai/ask_user_question"
            || method == "x.ai/exit_plan_mode"
        {
            if method == "session/request_permission" {
                if let Some(option_id) = pick_permission_option(&params) {
                    let _ = write_message(
                        stdin,
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "outcome": {
                                    "outcome": "selected",
                                    "optionId": option_id
                                }
                            }
                        }),
                    );
                    let _ = app.emit(
                        "acp-update",
                        json!({
                            "method": "session/request_permission",
                            "params": params,
                            "autoAllowed": true
                        }),
                    );
                    return;
                }
            }
            let _ = app.emit(
                "acp-interaction",
                json!({
                    "method": method,
                    "requestId": stringify_id(&id),
                    "params": params
                }),
            );
            // Keep the agent unblocked if the UI does not answer.
            if method == "x.ai/exit_plan_mode" {
                let _ = write_message(
                    stdin,
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "outcome": { "outcome": "approved" } }
                    }),
                );
            }
            return;
        }
    }

    let _ = app.emit(
        "acp-update",
        json!({
            "method": method,
            "params": params
        }),
    );
}

fn authenticate_if_needed(
    stdin: &Arc<Mutex<ChildStdin>>,
    next_id: &Arc<AtomicU64>,
    pending: &Arc<PendingMap>,
    result: &Value,
) -> Result<(), String> {
    let meta = result.get("_meta");
    let default_id = meta
        .and_then(|value| value.get("defaultAuthMethodId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let first_method = result
        .get("authMethods")
        .and_then(Value::as_array)
        .and_then(|methods| methods.first())
        .and_then(|method| method.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(method_id) = default_id.or(first_method) else {
        return Ok(());
    };
    rpc_request(
        stdin,
        next_id,
        pending,
        "authenticate",
        json!({
            "methodId": method_id,
            "_meta": { "headless": true }
        }),
        INIT_TIMEOUT,
    )
    .map(|_| ())
}

fn rpc_request(
    stdin: &Arc<Mutex<ChildStdin>>,
    next_id: &Arc<AtomicU64>,
    pending: &PendingMap,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = next_id.fetch_add(1, Ordering::SeqCst).to_string();
    let (tx, rx) = mpsc::channel();
    pending.insert(id.clone(), tx);
    write_message(
        stdin,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }),
    )?;
    rx.recv_timeout(timeout)
        .map_err(|_| format!("ACP 请求超时：{method}"))?
}

fn write_message(stdin: &Arc<Mutex<ChildStdin>>, value: Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(&value).map_err(|err| format!("序列化 ACP 消息失败：{err}"))?;
    line.push(b'\n');
    let mut stdin = stdin
        .lock()
        .map_err(|_| "无法写入 Grok Agent".to_string())?;
    stdin
        .write_all(&line)
        .and_then(|_| stdin.flush())
        .map_err(|err| format!("写入 Grok Agent 失败：{err}"))
}

fn session_id_from(value: &Value, fallback: Option<&str>) -> Result<String, String> {
    if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    if let Some(id) = fallback {
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    Err("ACP 没有返回 sessionId".into())
}

fn stringify_id(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

pub fn pick_permission_option(params: &Value) -> Option<String> {
    let options = params.get("options").and_then(Value::as_array)?;
    let parsed: Vec<(String, String)> = options
        .iter()
        .filter_map(|option| {
            let id = option
                .get("optionId")
                .or_else(|| option.get("option_id"))
                .or_else(|| option.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)?;
            let kind = option
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = option
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some((id, format!("{kind} {name}")))
        })
        .collect();
    if parsed.is_empty() {
        return None;
    }

    let searchable = |id: &str, extra: &str| {
        format!("{id} {extra}")
            .to_ascii_lowercase()
            .replace('-', "_")
            .replace(' ', "_")
    };
    let priorities = [
        "allow_all_edits_during_this_session",
        "allow_for_session",
        "allow_session",
        "allow_command_always",
        "allow_once",
        "allowonce",
        "yes",
    ];
    for priority in priorities {
        if let Some((id, _)) = parsed
            .iter()
            .find(|(id, extra)| searchable(id, extra).contains(priority))
        {
            return Some(id.clone());
        }
    }
    parsed.into_iter().find_map(|(id, extra)| {
        let text = searchable(&id, &extra);
        if text.contains("allow") && !text.contains("reject") && !text.contains("deny") {
            Some(id)
        } else {
            None
        }
    })
}

#[allow(dead_code)]
pub fn session_update_from(params: &Value) -> Option<Value> {
    if let Some(update) = params.get("update").cloned() {
        return Some(update);
    }
    if params.get("sessionUpdate").is_some() {
        return Some(params.clone());
    }
    None
}

#[allow(dead_code)]
pub fn content_text(update: &Value) -> String {
    if let Some(content) = update.get("content") {
        if let Some(text) = content.get("text").and_then(Value::as_str) {
            return text.to_string();
        }
    }
    update
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn user_facing_diagnostic(line: &str) -> Option<String> {
    let ansi = regex_lite_strip(line);
    let plain = ansi.trim();
    if plain.is_empty() {
        return None;
    }
    if plain.contains("Post-replay flush failed")
        || plain.contains("session not found")
        || plain.contains(" WARN ")
    {
        return None;
    }
    Some(plain.to_string())
}

fn regex_lite_strip(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{001b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_session_allow_option() {
        let params = json!({
            "options": [
                { "optionId": "reject", "name": "Reject", "kind": "reject" },
                { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" }
            ]
        });
        assert_eq!(
            pick_permission_option(&params).as_deref(),
            Some("allow-once")
        );
    }

    #[test]
    fn reads_nested_session_update() {
        let params = json!({
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hello" }
            }
        });
        let update = session_update_from(&params).unwrap();
        assert_eq!(
            update.get("sessionUpdate").and_then(Value::as_str),
            Some("agent_message_chunk")
        );
        assert_eq!(content_text(&update), "hello");
    }

    #[test]
    fn strips_ansi_diagnostics() {
        assert_eq!(
            user_facing_diagnostic("\u{001b}[31mboom\u{001b}[0m").as_deref(),
            Some("boom")
        );
        assert!(user_facing_diagnostic("2026-08-24 WARN leftover").is_none());
    }
}
