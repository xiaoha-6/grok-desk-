use crate::config::{
    canonical_model_id, credentials_ready, ensure_image_gen_routing, resolve_agent_home,
    IMAGE_EDIT_MODEL, IMAGE_GEN_MODEL, NO_CREDENTIALS_CODE,
};
use crate::runtime::{grok_home, resolve_spawn_binary, resolve_spawn_cwd};
use crate::ssh::SshTarget;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const CLIENT_VERSION: &str = "0.6.29";
const INIT_TIMEOUT: Duration = Duration::from_secs(60);
const SESSION_TIMEOUT: Duration = Duration::from_secs(90);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 30);
const RECONNECT_MAX_ATTEMPTS: u32 = 12;
const CONNECT_RETRY_MAX_ATTEMPTS: u32 = 8;
pub const DEFAULT_CONTEXT_WINDOW: u64 = 500_000;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOptions {
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub existing_session_id: Option<String>,
    pub grok_home: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_effort: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub auto_compact_threshold_percent: Option<u8>,
    pub enable_memory: Option<bool>,
    pub enable_web_search: Option<bool>,
    pub enable_subagents: Option<bool>,
    pub ssh: Option<SshTarget>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub model: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAttachment {
    pub mime_type: Option<String>,
    pub data: Option<String>,
    pub name: Option<String>,
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

struct DiagnosticBuffer {
    lines: Mutex<Vec<String>>,
}

impl DiagnosticBuffer {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            lines: Mutex::new(Vec::new()),
        })
    }

    fn push(&self, line: String) {
        if let Ok(mut lines) = self.lines.lock() {
            if lines.len() >= 16 {
                lines.remove(0);
            }
            lines.push(line);
        }
    }

    fn last_relevant(&self) -> Option<String> {
        let lines = self.lines.lock().ok()?;
        lines.iter().rev().find(|line| {
            let upper = line.to_ascii_uppercase();
            upper.contains("ERROR")
                || upper.contains("502")
                || upper.contains("503")
                || upper.contains("402")
                || upper.contains("403")
                || upper.contains("QUOTA")
                || upper.contains("CREDIT")
                || upper.contains("WEEKLY")
                || upper.contains("LIMIT")
                || line.contains("额度")
                || upper.contains("BAD GATEWAY")
                || upper.contains("UNAVAILABLE")
                || upper.contains("INTERNAL")
        }).cloned()
    }

    fn last(&self) -> Option<String> {
        let lines = self.lines.lock().ok()?;
        lines.last().cloned()
    }
}

struct AgentProcess {
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: Arc<AtomicU64>,
    pending: Arc<PendingMap>,
    permission_mode: Arc<Mutex<String>>,
    pending_interactions: Arc<Mutex<HashMap<String, Value>>>,
    diagnostics: Arc<DiagnosticBuffer>,
    home: PathBuf,
}

impl AgentProcess {
    fn interrupt(&self, message: &str) {
        self.pending.fail_all(message);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }

    fn initialize(&self) -> Result<(), String> {
        let client_type = if cfg!(target_os = "windows") {
            "grokdesk-windows"
        } else if cfg!(target_os = "macos") {
            "grokdesk-macos"
        } else {
            "grokdesk-linux"
        };
        let result = self.request(
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
        authenticate_if_needed(&self.stdin, &self.next_id, &self.pending, &result, &self.home)
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        rpc_request(&self.stdin, &self.next_id, &self.pending, method, params, timeout)
            .map_err(|err| decorate_rpc_error(method, err, &self.diagnostics))
    }

    fn open_session(
        &self,
        cwd: &str,
        existing_session_id: Option<&str>,
        options: &SessionOptions,
    ) -> Result<String, String> {
        let method = if existing_session_id.is_some() {
            "session/load"
        } else {
            "session/new"
        };
        let mut params = session_params(cwd, options);
        if let Some(session_id) = existing_session_id {
            params["sessionId"] = json!(session_id);
        }

        match self.request(method, params, SESSION_TIMEOUT) {
            Ok(value) => session_id_from(&value, existing_session_id),
            Err(error) if existing_session_id.is_some() => {
                let created = self.request("session/new", session_params(cwd, options), SESSION_TIMEOUT)?;
                session_id_from(&created, None).map_err(|_| error)
            }
            Err(error) => Err(error),
        }
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        self.pending.fail_all("Grok Agent 已退出");
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct AcpClient {
    agent: Option<Arc<AgentProcess>>,
    session: Option<SessionInfo>,
    spawn_fingerprint: Option<String>,
    connect_options: Option<SessionOptions>,
    generation: u64,
    cancel_epoch: u64,
    conversation_id: String,
}

impl Default for AcpClient {
    fn default() -> Self {
        Self {
            agent: None,
            session: None,
            spawn_fingerprint: None,
            connect_options: None,
            generation: 0,
            cancel_epoch: 0,
            conversation_id: String::new(),
        }
    }
}

#[derive(Default)]
pub struct AcpHub {
    inner: Mutex<HashMap<String, Arc<Mutex<AcpClient>>>>,
}

impl AcpHub {
    fn key(conversation_id: Option<&str>) -> String {
        conversation_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("_default")
            .to_string()
    }

    pub fn client(&self, conversation_id: Option<&str>) -> Result<Arc<Mutex<AcpClient>>, String> {
        let key = Self::key(conversation_id);
        let mut map = self
            .inner
            .lock()
            .map_err(|_| "无法锁定 ACP 会话池".to_string())?;
        Ok(map
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(AcpClient::default())))
            .clone())
    }

    pub fn status(&self) -> AcpStatus {
        let Ok(map) = self.inner.lock() else {
            return AcpStatus {
                connected: false,
                session_id: None,
                model: None,
                cwd: None,
            };
        };
        for client in map.values() {
            if let Ok(guard) = client.lock() {
                let status = guard.status();
                if status.connected {
                    return status;
                }
            }
        }
        AcpStatus {
            connected: false,
            session_id: None,
            model: None,
            cwd: None,
        }
    }

    pub fn stop_one(&self, conversation_id: Option<&str>) -> Result<(), String> {
        let client = self.client(conversation_id)?;
        let mut guard = client
            .lock()
            .map_err(|_| "无法锁定 ACP 会话".to_string())?;
        guard.stop();
        Ok(())
    }

    pub fn stop_all(&self) {
        if let Ok(map) = self.inner.lock() {
            for client in map.values() {
                if let Ok(mut guard) = client.lock() {
                    guard.stop();
                }
            }
        }
    }

    pub fn set_permission_mode(&self, mode: &str, conversation_id: Option<&str>) -> Result<(), String> {
        if conversation_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
        {
            let client = self.client(conversation_id)?;
            let guard = client
                .lock()
                .map_err(|_| "无法锁定 ACP 会话".to_string())?;
            return guard.set_permission_mode(mode);
        }
        let map = self
            .inner
            .lock()
            .map_err(|_| "无法锁定 ACP 会话池".to_string())?;
        for client in map.values() {
            if let Ok(guard) = client.lock() {
                let _ = guard.set_permission_mode(mode);
            }
        }
        Ok(())
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
        self.generation = self.generation.wrapping_add(1);
        self.cancel_epoch = self.cancel_epoch.wrapping_add(1);
        if let Some(agent) = self.agent.take() {
            agent.interrupt("连接已取消");
        }
        self.session = None;
        self.spawn_fingerprint = None;
        self.connect_options = None;
    }

    fn recycle_for_reconnect(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(agent) = self.agent.take() {
            agent.interrupt("上游断开，正在重连");
        }
        self.session = None;
        self.spawn_fingerprint = None;
    }

    pub fn answer_interaction(&self, request_id: String, result: Value) -> Result<(), String> {
        let agent = self
            .agent
            .as_ref()
            .ok_or_else(|| "Agent 尚未连接".to_string())?;
        let rpc_id = agent
            .pending_interactions
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&request_id))
            .unwrap_or(Value::String(request_id));
        write_message(
            &agent.stdin,
            json!({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": result
            }),
        )
    }

    pub fn call_extension(
        shared: &Arc<Mutex<Self>>,
        method: String,
        mut params: Value,
    ) -> Result<Value, String> {
        let (stdin, next_id, pending, params) = {
            let this = lock_client(shared)?;
            let agent = this
                .agent
                .as_ref()
                .ok_or_else(|| "Agent 尚未连接".to_string())?;
            if params.get("sessionId").and_then(Value::as_str).is_none() {
                if let Some(session) = &this.session {
                    if let Some(object) = params.as_object_mut() {
                        object.insert("sessionId".into(), json!(session.session_id));
                    }
                }
            }
            (
                Arc::clone(&agent.stdin),
                Arc::clone(&agent.next_id),
                Arc::clone(&agent.pending),
                params,
            )
        };
        rpc_request(
            &stdin,
            &next_id,
            &pending,
            &method,
            params,
            Duration::from_secs(30),
        )
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

    pub fn set_permission_mode(&self, mode: &str) -> Result<(), String> {
        let agent = self
            .agent
            .as_ref()
            .ok_or_else(|| "Agent 尚未连接".to_string())?;
        let next = mode.trim();
        if next.is_empty() {
            return Err("权限模式不能为空".into());
        }
        let mut current = agent
            .permission_mode
            .lock()
            .map_err(|_| "无法锁定权限模式".to_string())?;
        *current = next.to_string();
        Ok(())
    }

    pub fn connect(
        shared: &Arc<Mutex<Self>>,
        app: &AppHandle,
        options: SessionOptions,
    ) -> Result<SessionInfo, String> {
        require_credentials(&options)?;
        let conversation_id = options
            .conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_default()
            .to_string();
        let model = canonical_model_id(
            options
                .model
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("grok-4.5"),
        );
        let ssh = options
            .ssh
            .clone()
            .or_else(|| recover_ssh_from_cwd(options.cwd.as_deref()))
            .map(SshTarget::normalized)
            .transpose()?;
        let cwd = if let Some(ssh) = &ssh {
            ssh.remote_path.clone()
        } else {
            resolve_cwd(options.cwd.clone())?
        };
        let fingerprint = spawn_fingerprint(&options, &model, ssh.as_ref());
        let existing_session_id = options
            .existing_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let (agent, need_init, generation) = {
            let mut this = lock_client(shared)?;
            if let Some(current) = &this.session {
                if this.agent.is_some()
                    && this.spawn_fingerprint.as_deref() == Some(&fingerprint)
                    && current.model == model
                    && current.cwd == cwd
                    && existing_session_id.as_ref() == Some(&current.session_id)
                {
                    if let Some(agent) = &this.agent {
                        if let Ok(mut mode) = agent.permission_mode.lock() {
                            *mode = options
                                .permission_mode
                                .clone()
                                .unwrap_or_else(|| "default".to_string());
                        }
                    }
                    let current = current.clone();
                    let mut saved = options.clone();
                    saved.existing_session_id = Some(current.session_id.clone());
                    saved.conversation_id = Some(conversation_id.clone()).filter(|value| !value.is_empty());
                    this.connect_options = Some(saved);
                    this.conversation_id = conversation_id;
                    return Ok(current);
                }
            }

            let restart_agent =
                this.agent.is_none() || this.spawn_fingerprint.as_deref() != Some(&fingerprint);
            if restart_agent {
                this.stop();
                this.spawn_agent(app, &options, &model, &cwd, ssh.as_ref())?;
                this.spawn_fingerprint = Some(fingerprint);
            } else if let Some(agent) = &this.agent {
                if let Ok(mut mode) = agent.permission_mode.lock() {
                    *mode = options
                        .permission_mode
                        .clone()
                        .unwrap_or_else(|| "default".to_string());
                }
            }

            let agent = this
                .agent
                .as_ref()
                .cloned()
                .ok_or_else(|| "Agent 尚未连接".to_string())?;
            (agent, restart_agent, this.generation)
        };

        let connect_result = (|| {
            if need_init {
                agent.initialize()?;
            }
            agent.open_session(&cwd, existing_session_id.as_deref(), &options)
        })();

        match connect_result {
            Ok(session_id) => {
                let mut this = lock_client(shared)?;
                if this.generation != generation
                    || !this
                        .agent
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &agent))
                {
                    return Err("连接已取消".into());
                }
                let info = SessionInfo {
                    session_id,
                    model,
                    cwd,
                };
                this.session = Some(info.clone());
                this.conversation_id = conversation_id;
                let mut saved = options.clone();
                saved.existing_session_id = Some(info.session_id.clone());
                saved.conversation_id = Some(this.conversation_id.clone()).filter(|value| !value.is_empty());
                this.connect_options = Some(saved);
                Ok(info)
            }
            Err(error) => {
                if let Ok(mut this) = shared.lock() {
                    if this
                        .agent
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &agent))
                    {
                        this.recycle_for_reconnect();
                    }
                }
                Err(error)
            }
        }
    }

    pub fn connect_resilient(
        shared: &Arc<Mutex<Self>>,
        app: &AppHandle,
        options: SessionOptions,
    ) -> Result<SessionInfo, String> {
        let epoch = lock_client(shared)?.cancel_epoch;
        let mut last = "连接失败".to_string();
        for attempt in 1..=CONNECT_RETRY_MAX_ATTEMPTS {
            if cancel_epoch_changed(shared, epoch) {
                return Err("连接已取消".into());
            }
            match Self::connect(shared, app, options.clone()) {
                Ok(info) => return Ok(info),
                Err(error) if is_user_cancel_error(&error) => return Err(error),
                Err(error) if !is_retryable_rpc_error(&error) || attempt == CONNECT_RETRY_MAX_ATTEMPTS => {
                    return Err(error);
                }
                Err(error) => {
                    last = error;
                    emit_reconnect(app, options.conversation_id.as_deref().unwrap_or(""), attempt, CONNECT_RETRY_MAX_ATTEMPTS, &last);
                    if sleep_interruptible(reconnect_backoff(attempt), shared, epoch) {
                        return Err("连接已取消".into());
                    }
                }
            }
        }
        Err(last)
    }

    pub fn send_prompt(
        shared: &Arc<Mutex<Self>>,
        app: &AppHandle,
        text: String,
        attachments: Vec<PromptAttachment>,
    ) -> Result<(), String> {
        let prompt = build_prompt_parts(&text, &attachments)?;
        let (conversation_id, epoch) = {
            let this = lock_client(shared)?;
            if this.agent.is_none() {
                return Err("Agent 尚未连接".into());
            }
            if this.session.is_none() {
                return Err("ACP Session 尚未就绪".into());
            }
            (this.conversation_id.clone(), this.cancel_epoch)
        };
        let shared = Arc::clone(shared);
        let app = app.clone();
        thread::spawn(move || {
            send_prompt_with_reconnect(shared, app, prompt, conversation_id, epoch);
        });
        Ok(())
    }

    fn spawn_agent(
        &mut self,
        app: &AppHandle,
        options: &SessionOptions,
        model: &str,
        cwd: &str,
        ssh: Option<&SshTarget>,
    ) -> Result<(), String> {
        let home = resolve_agent_home(options.grok_home.as_deref())?;
        let _ = ensure_image_gen_routing(&crate::runtime::grok_home());
        let _ = ensure_image_gen_routing(&home);
        let mut extra_env: Vec<(String, String)> = vec![
            (
                "GROK_MEMORY".into(),
                if options.enable_memory.unwrap_or(false) {
                    "1".into()
                } else {
                    "0".into()
                },
            ),
            (
                "GROK_DEBUG_CONTEXT_WINDOW".into(),
                options
                    .context_window_tokens
                    .unwrap_or(DEFAULT_CONTEXT_WINDOW)
                    .to_string(),
            ),
            (
                "GROK_AUTO_COMPACT_THRESHOLD_PERCENT".into(),
                options
                    .auto_compact_threshold_percent
                    .unwrap_or(85)
                    .clamp(50, 99)
                    .to_string(),
            ),
        ];
        if options.enable_web_search == Some(false) {
            extra_env.push(("GROK_WEB_FETCH".into(), "0".into()));
        }
        let relay_profile = crate::config::read_relay_profile(&grok_home());
        extra_env.push(("GROK_IMAGE_GEN".into(), "1".into()));
        extra_env.push(("GROK_IMAGE_GEN_MODEL_OVERRIDE".into(), IMAGE_GEN_MODEL.into()));
        extra_env.push(("GROK_IMAGE_EDIT_MODEL_OVERRIDE".into(), IMAGE_EDIT_MODEL.into()));
        if crate::config::is_relay_configured(&grok_home()) {
            if let Some(profile) = &relay_profile {
                extra_env.push(("GROK_CLI_CHAT_PROXY_BASE_URL".into(), profile.endpoint.clone()));
                extra_env.push(("XAI_API_KEY".into(), profile.api_key.clone()));
                extra_env.push(("GROK_CODE_XAI_API_KEY".into(), profile.api_key.clone()));
            }
        }

        let mut child = if let Some(ssh) = ssh {
            // Let spawn_remote_agent expand $HOME on the remote shell.
            let env_refs: Vec<(&str, String)> = extra_env.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
            crate::ssh::spawn_remote_agent(ssh, model, None, &env_refs)?
        } else {
            let binary = resolve_spawn_binary()?;
            let workdir = resolve_spawn_cwd(cwd)?;
            let mut command = Command::new(&binary);
            command.arg("agent");
            if !model.is_empty() {
                command.arg("--model").arg(model);
            }
            command
                .arg("stdio")
                .current_dir(&workdir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env("GROK_HOME", &home);
            for (key, value) in &extra_env {
                command.env(key, value);
            }
            command.env(
                "PATH",
                crate::runtime::augmented_path(std::env::var("PATH").ok()),
            );
            crate::runtime::hide_console(&mut command);
            command.spawn().map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    format!(
                        "找不到 Grok 可执行文件：{}。设置里若显示已安装，通常是官方 CLI 刚更新、软链暂时断开。请点「重新检测」，或等几秒再发。",
                        binary.display()
                    )
                } else {
                    format!(
                        "无法启动 Grok Agent：{err}（程序：{}，目录：{}）",
                        binary.display(),
                        workdir.display()
                    )
                }
            })?
        };
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
        let diagnostics = DiagnosticBuffer::new();
        let permission_mode = Arc::new(Mutex::new(
            options
                .permission_mode
                .clone()
                .unwrap_or_else(|| "default".to_string()),
        ));
        let pending_interactions = Arc::new(Mutex::new(HashMap::new()));
        let conversation_id = options
            .conversation_id
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        self.conversation_id = conversation_id.clone();
        spawn_stdout_reader(
            app.clone(),
            Arc::clone(&stdin),
            Arc::clone(&pending),
            Arc::clone(&diagnostics),
            Arc::clone(&permission_mode),
            Arc::clone(&pending_interactions),
            stdout,
            conversation_id.clone(),
        );
        spawn_stderr_reader(app.clone(), stderr, Arc::clone(&diagnostics));

        self.agent = Some(Arc::new(AgentProcess {
            child: Mutex::new(child),
            stdin,
            next_id,
            pending,
            permission_mode,
            pending_interactions,
            diagnostics,
            home,
        }));
        Ok(())
    }
}

fn lock_client(shared: &Arc<Mutex<AcpClient>>) -> Result<std::sync::MutexGuard<'_, AcpClient>, String> {
    shared
        .lock()
        .map_err(|_| "无法锁定 ACP 会话".to_string())
}

fn recover_ssh_from_cwd(cwd: Option<&str>) -> Option<SshTarget> {
    let trimmed = cwd?.trim();
    let rest = trimmed.strip_prefix("ssh://").or_else(|| trimmed.strip_prefix("SSH://"))?;
    let (user_host, path) = rest.split_once('/')?;
    let (user, host_port) = user_host.split_once('@')?;
    let (host, port_text) = match host_port.rsplit_once(':') {
        Some((host, port)) => (host, port),
        None => (host_port, "22"),
    };
    let port = port_text.parse::<u16>().unwrap_or(22);
    let remote_path = if path.is_empty() {
        "/".to_string()
    } else {
        format!("/{path}")
    };
    Some(SshTarget {
        host: host.to_string(),
        port,
        user: user.to_string(),
        remote_path,
        identity_file: None,
        auth: "key".into(),
        password: None,
        alias: None,
    })
}

fn require_credentials(options: &SessionOptions) -> Result<(), String> {
    let home = resolve_agent_home(options.grok_home.as_deref())?;
    if credentials_ready(&home) || credentials_ready(&grok_home()) {
        return Ok(());
    }
    Err(format!(
        "{NO_CREDENTIALS_CODE}: 还没有可用的登录或 API Key。请先在设置里导入中转站配置，或登录官方 Grok 账号。"
    ))
}

fn spawn_fingerprint(options: &SessionOptions, model: &str, ssh: Option<&SshTarget>) -> String {
    let home = resolve_agent_home(options.grok_home.as_deref())
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let remote = ssh.map(|item| item.workspace_id()).unwrap_or_default();
    format!(
        "{model}|{home}|{remote}|{}|{}|{}|{}",
        options
            .context_window_tokens
            .unwrap_or(DEFAULT_CONTEXT_WINDOW),
        options.auto_compact_threshold_percent.unwrap_or(85),
        options.enable_memory.unwrap_or(false),
        options.enable_web_search.unwrap_or(true)
    )
}

fn session_params(cwd: &str, options: &SessionOptions) -> Value {
    let mode = options
        .permission_mode
        .as_deref()
        .unwrap_or("default");
    let mut meta = json!({
        "yoloMode": mode == "bypassPermissions",
        "autoMode": mode == "auto"
    });
    if mode == "plan" {
        meta["agentProfile"] = if options.enable_subagents.unwrap_or(true) {
            json!("grok-build-plan")
        } else {
            json!("grok-build-plan-no-subagents")
        };
    }
    if let Some(effort) = options
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        meta["reasoningEffort"] = json!(effort);
    }
    meta["imageGenModel"] = json!(IMAGE_GEN_MODEL);
    json!({
        "cwd": cwd,
        "mcpServers": [],
        "_meta": meta
    })
}

fn resolve_cwd(cwd: Option<String>) -> Result<String, String> {
    let raw = cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    resolve_spawn_cwd(raw).map(|path| path.display().to_string())
}

fn with_conversation(mut payload: Value, conversation_id: &str) -> Value {
    if !conversation_id.is_empty() {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("conversationId".into(), json!(conversation_id));
        }
    }
    payload
}

fn spawn_stdout_reader(
    app: AppHandle,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<PendingMap>,
    diagnostics: Arc<DiagnosticBuffer>,
    permission_mode: Arc<Mutex<String>>,
    pending_interactions: Arc<Mutex<HashMap<String, Value>>>,
    stdout: impl std::io::Read + Send + 'static,
    conversation_id: String,
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
            dispatch_message(
                &app,
                &stdin,
                &pending,
                &diagnostics,
                &permission_mode,
                &pending_interactions,
                json,
                &conversation_id,
            );
        }
        pending.fail_all("Grok Agent 已退出");
        let _ = app.emit(
            "acp-exit",
            with_conversation(json!({ "ok": false }), &conversation_id),
        );
    });
}

fn spawn_stderr_reader(
    app: AppHandle,
    stderr: impl std::io::Read + Send + 'static,
    diagnostics: Arc<DiagnosticBuffer>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(plain) = user_facing_diagnostic(&line) {
                diagnostics.push(plain.clone());
                let _ = app.emit("acp-diagnostic", plain);
            }
        }
    });
}

fn dispatch_message(
    app: &AppHandle,
    stdin: &Arc<Mutex<ChildStdin>>,
    pending: &PendingMap,
    diagnostics: &DiagnosticBuffer,
    permission_mode: &Mutex<String>,
    pending_interactions: &Mutex<HashMap<String, Value>>,
    json: Value,
    conversation_id: &str,
) {
    let id = json.get("id").cloned();
    let method = json.get("method").and_then(Value::as_str).map(str::to_string);
    if let Some(id) = &id {
        if method.is_none() {
            let key = stringify_id(id);
            if let Some(tx) = pending.take(&key) {
                if let Some(error) = json.get("error") {
                    let last = diagnostics.last_relevant();
                    let message = format_rpc_error(error, last.as_deref());
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
            } else {
                method = method.trim_start_matches('_').to_string();
            }
        } else {
            method = method.trim_start_matches('_').to_string();
        }
    }

    if let Some(id) = id {
        let is_ask = is_ask_method(&method) || is_ask_payload(&params);
        if method == "session/request_permission"
            || is_ask
            || method == "x.ai/exit_plan_mode"
        {
            let mode = permission_mode
                .lock()
                .ok()
                .map(|value| value.clone())
                .unwrap_or_else(|| "default".to_string());
            if method == "session/request_permission" && is_generated_image_probe_params(&params)
            {
                let result = if let Some(option_id) = pick_reject_option(&params) {
                    json!({
                        "outcome": {
                            "outcome": "selected",
                            "optionId": option_id
                        }
                    })
                } else {
                    json!({ "outcome": { "outcome": "cancelled" } })
                };
                let _ = write_message(
                    stdin,
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": result
                    }),
                );
                let _ = app.emit(
                    "acp-update",
                    with_conversation(
                        json!({
                            "method": "session/request_permission",
                            "params": params,
                            "autoDenied": true,
                            "reason": "generated_image_probe"
                        }),
                        conversation_id,
                    ),
                );
                return;
            }
            if method == "session/request_permission"
                && should_auto_allow(&mode, &params)
            {
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
                        with_conversation(
                            json!({
                                "method": "session/request_permission",
                                "params": params,
                                "autoAllowed": true
                            }),
                            conversation_id,
                        ),
                    );
                    return;
                }
            }
            let request_id = stringify_id(&id);
            if let Ok(mut map) = pending_interactions.lock() {
                map.insert(request_id.clone(), id.clone());
            }
            let emit_method = if is_ask && method == "session/request_permission" {
                "x.ai/ask_user_question"
            } else {
                method.as_str()
            };
            let emit_params = if is_ask {
                lift_ask_params(params.clone())
            } else {
                params.clone()
            };
            let _ = app.emit(
                "acp-interaction",
                with_conversation(
                    json!({
                        "method": emit_method,
                        "requestId": request_id,
                        "params": emit_params
                    }),
                    conversation_id,
                ),
            );
            return;
        }
    }

    let _ = app.emit(
        "acp-update",
        with_conversation(
            json!({
                "method": method,
                "params": params
            }),
            conversation_id,
        ),
    );
}

fn authenticate_if_needed(
    stdin: &Arc<Mutex<ChildStdin>>,
    next_id: &Arc<AtomicU64>,
    pending: &Arc<PendingMap>,
    result: &Value,
    home: &Path,
) -> Result<(), String> {
    if crate::config::config_has_api_key(&home.join("config.toml"))
        || crate::config::config_has_api_key(&grok_home().join("config.toml"))
    {
        return Ok(());
    }
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

fn looks_like_official_quota(text: &str) -> bool {
    let upper = text.to_ascii_uppercase();
    upper.contains("WEEKLY LIMIT")
        || upper.contains("RUN OUT OF CREDITS")
        || upper.contains("FREE USAGE LIMIT")
        || upper.contains("STATUS 402")
        || text.contains("额度不足")
        || text.contains("周限额")
}

fn decorate_rpc_error(method: &str, err: String, diagnostics: &DiagnosticBuffer) -> String {
    let extra = diagnostics
        .last_relevant()
        .or_else(|| diagnostics.last());
    let mut out = err;
    if let Some(extra) = extra {
        if !out.contains(&extra) {
            out = format!("{out}\n{extra}");
        }
    }
    if looks_like_official_quota(&out) {
        format!(
            "{out}\n这是官方 Grok 周额度或登录限制，不是中转站余额。请确认已写入中转站配置后，开一个新对话再试。"
        )
    } else if out.contains("超时") {
        format!("{out}\nGrok Agent 在 {method} 阶段没有返回。若本机配了中转站，这通常是还在连官方 grok.com。请开新对话重试。")
    } else {
        out
    }
}

fn build_prompt_parts(text: &str, attachments: &[PromptAttachment]) -> Result<Vec<Value>, String> {
    let trimmed = text.trim();
    let mut prompt: Vec<Value> = Vec::new();
    if !trimmed.is_empty() {
        prompt.push(json!({ "type": "text", "text": trimmed }));
    }
    for attachment in attachments {
        let data = attachment.data.clone().unwrap_or_default();
        if data.is_empty() {
            continue;
        }
        if data.len() > 35_000_000 {
            return Err("图片太大，请控制在 25MB 以内".into());
        }
        prompt.push(json!({
            "type": "image",
            "data": data,
            "mimeType": attachment.mime_type.clone().unwrap_or_else(|| "image/png".into()),
            "name": attachment.name.clone().unwrap_or_default()
        }));
    }
    if prompt.is_empty() {
        return Err("请输入要发送的内容，或粘贴一张图片".into());
    }
    Ok(prompt)
}

fn is_user_cancel_error(err: &str) -> bool {
    let text = err.trim();
    if text.is_empty() {
        return false;
    }
    text.contains("连接已取消")
        || text.contains("連線已取消")
        || text.to_ascii_lowercase().contains("cancelled by user")
        || text.contains("session/cancel")
        || text.to_ascii_lowercase().contains("canceled by the user")
}

fn is_fatal_rpc_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    looks_like_official_quota(err)
        || is_user_cancel_error(err)
        || lower.contains("context_too_large")
        || lower.contains("context too large")
        || lower.contains("maximum context")
        || lower.contains("context length")
        || lower.contains("too many tokens")
        || lower.contains("prompt is too long")
        || err.contains("请求内容过大")
        || err.contains("长度超限")
        || err.contains("超过最大")
        || err.contains("上下文爆")
        || err.contains("上下文") && (err.contains("过大") || err.contains("太长") || err.contains("超限"))
        || err.contains("图片太大")
        || lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("invalid api key")
        || err.contains(NO_CREDENTIALS_CODE)
        || err.contains("请输入要发送的内容")
}

fn is_retryable_rpc_error(err: &str) -> bool {
    if is_fatal_rpc_error(err) {
        return false;
    }
    let lower = err.to_ascii_lowercase();
    lower.contains("超时")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || err.contains("已退出")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("bad gateway")
        || lower.contains("unavailable")
        || lower.contains("overloaded")
        || lower.contains("temporarily")
        || lower.contains("broken pipe")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("eof")
        || err.contains("写入 Grok Agent 失败")
        || err.contains("无法写入 Grok Agent")
        || err.contains("尚未连接")
        || err.contains("尚未就绪")
        || err.contains("上游")
        || lower.contains("internal error")
}

fn reconnect_backoff(attempt: u32) -> Duration {
    let secs = match attempt {
        0 | 1 => 1,
        2 => 2,
        3 => 4,
        4 => 6,
        5 => 8,
        6 => 10,
        7 => 12,
        _ => 15,
    };
    Duration::from_secs(secs)
}

fn cancel_epoch_changed(shared: &Arc<Mutex<AcpClient>>, epoch: u64) -> bool {
    lock_client(shared)
        .map(|this| this.cancel_epoch != epoch)
        .unwrap_or(true)
}

fn sleep_interruptible(total: Duration, shared: &Arc<Mutex<AcpClient>>, epoch: u64) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if cancel_epoch_changed(shared, epoch) {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    cancel_epoch_changed(shared, epoch)
}

fn emit_reconnect(app: &AppHandle, conversation_id: &str, attempt: u32, max_attempts: u32, error: &str) {
    let _ = app.emit(
        "acp-reconnect",
        with_conversation(
            json!({
                "attempt": attempt,
                "maxAttempts": max_attempts,
                "error": error
            }),
            conversation_id,
        ),
    );
}

fn emit_turn_done(app: &AppHandle, conversation_id: &str, ok: bool, error: Option<&str>) {
    let payload = match error {
        Some(error) => json!({ "ok": ok, "error": error }),
        None => json!({ "ok": ok }),
    };
    let _ = app.emit("acp-turn-done", with_conversation(payload, conversation_id));
}

fn send_one_prompt(shared: &Arc<Mutex<AcpClient>>, prompt: &[Value], epoch: u64) -> Result<Value, String> {
    let (stdin, next_id, pending, session_id) = {
        let this = lock_client(shared)?;
        if this.cancel_epoch != epoch {
            return Err("连接已取消".into());
        }
        let agent = this
            .agent
            .as_ref()
            .ok_or_else(|| "Agent 尚未连接".to_string())?;
        let session_id = this
            .session
            .as_ref()
            .map(|session| session.session_id.clone())
            .ok_or_else(|| "ACP Session 尚未就绪".to_string())?;
        (
            Arc::clone(&agent.stdin),
            Arc::clone(&agent.next_id),
            Arc::clone(&agent.pending),
            session_id,
        )
    };
    rpc_request(
        &stdin,
        &next_id,
        &pending,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": prompt
        }),
        PROMPT_TIMEOUT,
    )
}

fn send_prompt_with_reconnect(
    shared: Arc<Mutex<AcpClient>>,
    app: AppHandle,
    prompt: Vec<Value>,
    conversation_id: String,
    epoch: u64,
) {
    let mut last = "ACP 请求失败".to_string();
    for attempt in 1..=RECONNECT_MAX_ATTEMPTS {
        if cancel_epoch_changed(&shared, epoch) {
            emit_turn_done(&app, &conversation_id, false, Some("连接已取消"));
            return;
        }
        match send_one_prompt(&shared, &prompt, epoch) {
            Ok(_) => {
                emit_turn_done(&app, &conversation_id, true, None);
                return;
            }
            Err(error) if is_user_cancel_error(&error) || cancel_epoch_changed(&shared, epoch) => {
                emit_turn_done(&app, &conversation_id, false, Some(&error));
                return;
            }
            Err(error) if !is_retryable_rpc_error(&error) || attempt == RECONNECT_MAX_ATTEMPTS => {
                emit_turn_done(&app, &conversation_id, false, Some(&error));
                return;
            }
            Err(error) => {
                last = error;
                emit_reconnect(&app, &conversation_id, attempt, RECONNECT_MAX_ATTEMPTS, &last);
                if sleep_interruptible(reconnect_backoff(attempt), &shared, epoch) {
                    emit_turn_done(&app, &conversation_id, false, Some("连接已取消"));
                    return;
                }
                let options = match lock_client(&shared) {
                    Ok(mut this) => {
                        this.recycle_for_reconnect();
                        this.connect_options.clone()
                    }
                    Err(error) => {
                        emit_turn_done(&app, &conversation_id, false, Some(&error));
                        return;
                    }
                };
                let Some(options) = options else {
                    emit_turn_done(&app, &conversation_id, false, Some(&last));
                    return;
                };
                if let Err(error) = AcpClient::connect(&shared, &app, options) {
                    last = error;
                    if is_user_cancel_error(&last) || !is_retryable_rpc_error(&last) {
                        emit_turn_done(&app, &conversation_id, false, Some(&last));
                        return;
                    }
                }
            }
        }
    }
    emit_turn_done(&app, &conversation_id, false, Some(&last));
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

pub fn pick_reject_option(params: &Value) -> Option<String> {
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
        "reject_once",
        "reject",
        "deny_once",
        "deny",
        "cancel",
        "skip",
    ];
    for priority in priorities {
        if let Some((id, _)) = parsed
            .iter()
            .find(|(id, extra)| searchable(id, extra).contains(priority))
        {
            return Some(id.clone());
        }
    }
    None
}

fn tool_call_from_params(params: &Value) -> Option<&Value> {
    params.get("toolCall").or_else(|| params.get("tool_call"))
}

fn permission_haystack(params: &Value) -> String {
    let mut text = String::new();
    if let Some(tool) = tool_call_from_params(params) {
        for key in ["title", "kind", "command"] {
            if let Some(value) = tool.get(key).and_then(Value::as_str) {
                text.push_str(value);
                text.push('\n');
            }
        }
        for key in ["rawInput", "raw_input", "input", "content"] {
            if let Some(value) = tool.get(key) {
                text.push_str(&value.to_string());
                text.push('\n');
            }
        }
    }
    text
}

pub fn is_generated_image_probe(text: &str) -> bool {
    let lower = text.to_ascii_lowercase().replace('\\', "/");
    if lower.trim().is_empty() {
        return false;
    }
    let has_ext = [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif",
    ]
    .iter()
    .any(|ext| lower.contains(ext));
    if !has_ext {
        return false;
    }
    let touches_images = lower.contains("/images/")
        || lower.contains(" images/")
        || lower.contains("\"images/")
        || lower.contains("'images/")
        || lower.contains("=images/");
    if !touches_images {
        return false;
    }
    if lower.contains("grokdesk-relay")
        || lower.contains("/.grok/")
        || lower.contains("sessions/")
    {
        return true;
    }
    if lower.contains("b64encode")
        || lower.contains("base64")
        || lower.contains("pathlib")
        || lower.contains("python")
        || lower.contains("data:image")
    {
        return true;
    }
    lower.split("images/").any(|chunk| {
        chunk
            .chars()
            .next()
            .map(|ch| ch.is_ascii_digit())
            .unwrap_or(false)
    })
}

fn is_generated_image_probe_params(params: &Value) -> bool {
    is_generated_image_probe(&permission_haystack(params))
}

#[allow(dead_code)]
pub fn session_update_from(params: &Value) -> Option<Value> {
    if let Some(update) = params.get("update").cloned() {
        return Some(update);
    }
    if params.get("sessionUpdate").is_some() || params.get("session_update").is_some() {
        return Some(params.clone());
    }
    None
}

fn is_image_gen_label(label: &str) -> bool {
    let h = label.trim().to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    h == "imagine"
        || h.starts_with("imagine ")
        || h.contains("image_gen")
        || h.contains("imagegen")
        || h.contains("generate image")
        || h.contains("生成图片")
        || h.contains("生成圖片")
        || h.contains("文生图")
        || h.contains("文生圖")
        || h.contains("grok-imagine")
}

fn is_image_gen_tool_params(params: &Value) -> bool {
    let Some(tool) = tool_call_from_params(params) else {
        return false;
    };
    let kind = tool.get("kind").and_then(Value::as_str).unwrap_or("");
    let title = tool.get("title").and_then(Value::as_str).unwrap_or("");
    let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
    is_image_gen_label(kind) || is_image_gen_label(title) || is_image_gen_label(name)
}

fn should_auto_allow(permission_mode: &str, params: &Value) -> bool {
    // Ask 本身是只读交互工具：权限必须先放行，工具才会通过
    // `x.ai/ask_user_question` 把选择题发给桌面。卡住权限的话，
    // 界面只会看到 JSON，模型也会自己猜答案。
    if is_ask_payload(params) {
        return true;
    }
    // ImageGen 即使在 bypass 也不自动放行：模型常把“检查插件”误当成出图，
    // 桌面按用户原话决定允许或拒绝，避免一提问就打 grok-imagine-image。
    if is_image_gen_tool_params(params) {
        return false;
    }
    match permission_mode {
        "bypassPermissions" | "auto" => true,
        "acceptEdits" => {
            let kind = params
                .get("toolCall")
                .or_else(|| params.get("tool_call"))
                .and_then(|tool| tool.get("kind").or_else(|| tool.get("title")))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            kind.contains("edit") || kind.contains("write")
        }
        _ => false,
    }
}

fn is_ask_method(method: &str) -> bool {
    method.contains("ask_user_question")
}

fn is_ask_payload(params: &Value) -> bool {
    if params
        .get("questions")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
    {
        return true;
    }
    let Some(tool) = tool_call_from_params(params) else {
        return false;
    };
    let title = tool
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if title.contains("ask:") || title == "ask" || title.starts_with("ask ") {
        return true;
    }
    for key in ["rawInput", "raw_input", "input"] {
        if let Some(value) = tool.get(key) {
            if value
                .get("questions")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            {
                return true;
            }
            if let Some(text) = value.as_str() {
                if text.contains("\"questions\"") {
                    return true;
                }
            }
        }
    }
    false
}

fn lift_ask_params(mut params: Value) -> Value {
    if params.get("questions").is_some() {
        return params;
    }
    let input = tool_call_from_params(&params).and_then(|tool| {
        tool.get("rawInput")
            .or_else(|| tool.get("raw_input"))
            .or_else(|| tool.get("input"))
            .cloned()
    });
    let Some(input) = input else {
        return params;
    };
    let parsed = if let Some(text) = input.as_str() {
        serde_json::from_str::<Value>(text).unwrap_or(input)
    } else {
        input
    };
    if let Some(questions) = parsed.get("questions").cloned() {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("questions".into(), questions);
            if let Some(mode) = parsed.get("mode").cloned() {
                obj.entry("mode").or_insert(mode);
            }
        }
    }
    params
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

fn compact_json_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) if text.trim().is_empty() => None,
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        other => {
            let text = other.to_string();
            if text == "null" || text == "{}" || text == "[]" {
                None
            } else {
                Some(text)
            }
        }
    }
}

fn looks_generic(message: &str) -> bool {
    let lower = message.trim().to_ascii_lowercase();
    lower == "internal error"
        || lower == "internal_error"
        || lower == "error"
        || lower == "acp 请求失败"
}

fn explain_upstream(message: String) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("502")
        || lower.contains("bad gateway")
        || lower.contains("temporarily unavailable")
        || lower.contains("upstream service")
    {
        format!(
            "{message}\n上游模型服务暂时不可用。这通常是中转站或 xAI 上游波动，不是本机 Grok Build 没装好。请稍后重试。"
        )
    } else if lower.contains("missing field `created_at`")
        || lower.contains("missing field \"created_at\"")
        || lower.contains("missing field created_at")
    {
        format!(
            "{message}\n中转站返回的 Responses 缺 created_at，Grok CLI 无法反序列化。这是上游兼容字段，不是本机没装好。请稍后重试。"
        )
    } else if lower.contains("503") {
        format!("{message}\n上游暂时过载（503）。请稍后重试。")
    } else if lower.contains("context_too_large")
        || message.contains("请求内容过大")
        || lower.contains("context too large")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
        || message.contains("上下文爆")
    {
        format!(
            "{message}\n这次对话或附件太长，当前渠道处理不了。出图请直接说「生成一张…」；写代码请开新对话或把问题说短一点。"
        )
    } else {
        message
    }
}

fn format_rpc_error(error: &Value, last_diag: Option<&str>) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("ACP 请求失败")
        .trim();
    let data = error.get("data").and_then(compact_json_text);
    let mut parts: Vec<String> = Vec::new();
    if !message.is_empty() {
        parts.push(message.to_string());
    }
    if let Some(data) = data {
        if !parts.iter().any(|part| part.contains(&data) || data.contains(part)) {
            parts.push(data);
        }
    }
    if let Some(diag) = last_diag.map(str::trim).filter(|value| !value.is_empty()) {
        let already = parts.iter().any(|part| part.contains(diag));
        let useful = looks_generic(message)
            || diag.contains("502")
            || diag.contains("503")
            || diag.to_ascii_lowercase().contains("bad gateway")
            || diag.to_ascii_lowercase().contains("unavailable");
        if !already && useful {
            parts.push(diag.to_string());
        }
    }
    let joined = if parts.is_empty() {
        "ACP 请求失败".to_string()
    } else {
        parts.join(" — ")
    };
    explain_upstream(joined)
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
        || (plain.contains("git_cli")
            && (plain.contains("program not found") || plain.contains("NotFound")))
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
    fn reads_snake_case_session_update() {
        let params = json!({ "session_update": "tool_call", "title": "Edit" });
        let update = session_update_from(&params).unwrap();
        assert_eq!(
            update.get("session_update").and_then(Value::as_str),
            Some("tool_call")
        );
    }

    #[test]
    fn auto_allows_edits_only_in_accept_edits_mode() {
        let edit = json!({ "toolCall": { "kind": "edit", "title": "Edit file" } });
        let shell = json!({ "toolCall": { "kind": "execute", "title": "Run" } });
        assert!(should_auto_allow("acceptEdits", &edit));
        assert!(!should_auto_allow("acceptEdits", &shell));
        assert!(should_auto_allow("bypassPermissions", &shell));
        assert!(!should_auto_allow("default", &edit));
        let ask = json!({
            "toolCall": {
                "title": "Ask: 你想还原哪一部分混淆代码?",
                "rawInput": {
                    "questions": [{ "question": "which?", "options": [{ "label": "app.js" }] }]
                }
            }
        });
        assert!(should_auto_allow("bypassPermissions", &ask));
        assert!(should_auto_allow("default", &ask));
        assert!(is_ask_payload(&ask));
        let imagine = json!({
            "toolCall": {
                "kind": "other",
                "title": "Generate Image",
                "rawInput": { "prompt": "a cat" }
            }
        });
        assert!(is_image_gen_tool_params(&imagine));
        assert!(!should_auto_allow("bypassPermissions", &imagine));
        assert!(!should_auto_allow("auto", &imagine));
        let read_image = json!({
            "toolCall": {
                "kind": "read",
                "title": "Read file",
                "rawInput": { "path": "html/images/icon.png" }
            }
        });
        assert!(!is_image_gen_tool_params(&read_image));
        assert!(should_auto_allow("bypassPermissions", &read_image));
        let reimagine = json!({
            "toolCall": {
                "kind": "edit",
                "title": "Edit reimagine.lua"
            }
        });
        assert!(!is_image_gen_tool_params(&reimagine));
        assert!(should_auto_allow("bypassPermissions", &reimagine));
        let imagine_named = json!({
            "toolCall": { "kind": "other", "title": "Imagine" }
        });
        assert!(is_image_gen_tool_params(&imagine_named));
        assert!(!should_auto_allow("bypassPermissions", &imagine_named));
    }

    #[test]
    fn rejects_generated_image_probe() {
        let params = json!({
            "toolCall": {
                "kind": "execute",
                "title": "python3",
                "rawInput": {
                    "command": "python3 -c \"import base64,pathlib; print(base64.b64encode(pathlib.Path('images/1.jpg').read_bytes()))\""
                }
            },
            "options": [
                { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "reject", "name": "Reject", "kind": "reject" }
            ]
        });
        assert!(is_generated_image_probe_params(&params));
        assert_eq!(pick_reject_option(&params).as_deref(), Some("reject"));
        assert!(!is_generated_image_probe("ls src && cargo test"));
    }

    #[test]
    fn strips_ansi_diagnostics() {
        assert_eq!(
            user_facing_diagnostic("\u{001b}[31mboom\u{001b}[0m").as_deref(),
            Some("boom")
        );
        assert!(user_facing_diagnostic("2026-08-24 WARN leftover").is_none());
    }

    #[test]
    fn explains_missing_created_at() {
        let formatted = format_rpc_error(
            &json!({
                "code": -32603,
                "message": "Internal error",
                "data": "serialization error: missing field `created_at`"
            }),
            None,
        );
        assert!(formatted.contains("created_at"));
        assert!(formatted.contains("中转站"));
    }

    #[test]
    fn hides_git_cli_not_found_noise() {
        assert!(user_facing_diagnostic(
            "2026-08-29T13:12:19Z ERROR git_cli: Command::output() FAILED (spawn error) error=program not found error_kind=NotFound cwd=C:\\Users\\31147"
        )
        .is_none());
    }

    #[test]
    fn formats_internal_error_with_upstream_status() {
        let error = json!({
            "code": -32603,
            "message": "Internal error",
            "data": "responses API error status=502 Bad Gateway"
        });
        let formatted = format_rpc_error(
            &error,
            Some("responses API error status=502 Bad Gateway model_id=grok-4.6"),
        );
        assert!(formatted.contains("502"));
        assert!(formatted.contains("上游"));
    }

    #[test]
    fn fail_all_unblocks_pending_rpc() {
        let pending = PendingMap::new();
        let (tx, rx) = mpsc::channel();
        pending.insert("1".into(), tx);
        pending.fail_all("连接已取消");
        assert_eq!(rx.recv().unwrap(), Err("连接已取消".into()));
    }

    #[test]
    fn retries_transient_upstream_errors() {
        assert!(is_retryable_rpc_error("ACP 请求超时：session/prompt"));
        assert!(is_retryable_rpc_error("Grok Agent 已退出"));
        assert!(is_retryable_rpc_error("responses API error status=502 Bad Gateway"));
        assert!(is_retryable_rpc_error("上游模型服务暂时不可用"));
        assert!(is_retryable_rpc_error("写入 Grok Agent 失败：Broken pipe"));
        assert!(!is_retryable_rpc_error("连接已取消"));
        assert!(!is_retryable_rpc_error("图片太大，请控制在 25MB 以内"));
        assert!(!is_retryable_rpc_error("status 402 weekly limit"));
        assert!(!is_retryable_rpc_error("maximum context length exceeded"));
        assert!(!is_retryable_rpc_error("上下文爆了"));
    }
}
