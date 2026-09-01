mod accounts;
mod acp;
mod bridges;
mod config;
mod feishu_ws;
mod git;
mod image_gen;
mod install;
mod media;
mod pty;
mod runtime;
mod sessions;
mod ssh;
mod text_decode;
mod workspace;

use accounts::{
    clear_login, commit_account, create_account, discover_skills, drop_uncommitted_home,
    ensure_skill_dir, fetch_quota, load_state, save_accounts, skill_dirs, start_login,
    AccountRecord, AccountState, LoginSlot, SkillDirs, SkillRecord,
};
use acp::{AcpClient, AcpHub, AcpStatus, PromptAttachment, SessionInfo, SessionOptions};
use bridges::{BridgeHub, BridgeMedia, BridgesConfig, BridgesStatus, BridgePairing};
use config::{
    parse_deeplink, write_config, ModelCatalog, ModelListRequest, RelayImport, RelayQuota, RelayUsage,
};
use install::{install_official, InstallEventSink};
use pty::{pty_close, pty_detect, pty_open, pty_resize, pty_write};
use runtime::{grok_home, runtime_status, RuntimeStatus};
use sessions::{LocalSessionHistory, LocalSessionSummary};
use ssh::{SshConfigHost, SshProbe, SshTarget};
use git::{GitCommit, GitFileDiff, GitReview, GitStatus, GithubIdentity, SnapshotFile};
use image_gen::GeneratedImage;
use workspace::{GrepHit, LocalPathInfo, ProjectRules, WorkspaceEntry, WorkspaceFile, WorkspaceImage};
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

struct AppState {
    pending_import: Mutex<Option<RelayImport>>,
    acp: Arc<AcpHub>,
    bridges: Arc<BridgeHub>,
    login: LoginSlot,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            pending_import: Mutex::new(None),
            acp: Arc::new(AcpHub::default()),
            bridges: Arc::new(BridgeHub::default()),
            login: Arc::new(Mutex::new(None)),
        }
    }
}

async fn run_blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| format!("后台任务失败：{err}"))?
}

#[tauri::command]
async fn get_runtime_status() -> RuntimeStatus {
    tauri::async_runtime::spawn_blocking(runtime_status)
        .await
        .unwrap_or_else(|_| runtime_status())
}

#[tauri::command]
async fn import_relay(payload: RelayImport) -> Result<config::ImportResult, String> {
    run_blocking(move || {
        let import = payload.normalized()?;
        write_config(&grok_home(), &import).map_err(|err| format!("写入 config.toml 失败：{err}"))
    })
    .await
}

#[tauri::command]
fn parse_import_url(url: String) -> Result<RelayImport, String> {
    parse_deeplink(&url)
}

#[tauri::command]
fn take_pending_import(state: State<AppState>) -> Option<RelayImport> {
    state
        .pending_import
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
}

#[tauri::command]
fn get_acp_status(state: State<AppState>) -> AcpStatus {
    state.acp.status()
}

#[tauri::command]
async fn ensure_session(
    app: AppHandle,
    state: State<'_, AppState>,
    options: SessionOptions,
) -> Result<SessionInfo, String> {
    let hub = Arc::clone(&state.acp);
    run_blocking(move || {
        let conversation_id = options.conversation_id.clone();
        let client = hub.client(conversation_id.as_deref())?;
        AcpClient::connect_resilient(&client, &app, options)
    })
    .await
}

#[tauri::command]
async fn send_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    attachments: Option<Vec<PromptAttachment>>,
    conversation_id: Option<String>,
) -> Result<(), String> {
    let hub = Arc::clone(&state.acp);
    run_blocking(move || {
        let client = hub.client(conversation_id.as_deref())?;
        AcpClient::send_prompt(&client, &app, text, attachments.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn get_relay_quota() -> RelayQuota {
    tauri::async_runtime::spawn_blocking(|| config::fetch_relay_quota(&grok_home()))
        .await
        .unwrap_or_else(|_| config::fetch_relay_quota(&grok_home()))
}

#[tauri::command]
async fn get_relay_usage() -> RelayUsage {
    tauri::async_runtime::spawn_blocking(|| config::fetch_relay_usage(&grok_home()))
        .await
        .unwrap_or_else(|_| config::fetch_relay_usage(&grok_home()))
}

#[tauri::command]
async fn list_local_sessions() -> Vec<LocalSessionSummary> {
    tauri::async_runtime::spawn_blocking(sessions::list_local_sessions)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn list_ssh_hosts() -> Vec<SshTarget> {
    ssh::load_hosts()
}

#[tauri::command]
async fn list_ssh_config_hosts() -> Vec<SshConfigHost> {
    ssh::load_ssh_config_hosts()
}

#[tauri::command]
async fn save_ssh_hosts(hosts: Vec<SshTarget>) -> Result<(), String> {
    let normalized = hosts
        .into_iter()
        .map(SshTarget::normalized)
        .collect::<Result<Vec<_>, _>>()?;
    ssh::persist_hosts(&normalized)
}

#[tauri::command]
async fn probe_ssh_host(target: SshTarget) -> Result<SshProbe, String> {
    let target = target.normalized()?;
    run_blocking(move || ssh::probe(&target)).await
}

#[tauri::command]
async fn list_ssh_dir(target: SshTarget, path: Option<String>) -> Result<Vec<WorkspaceEntry>, String> {
    let target = target.normalized()?;
    run_blocking(move || ssh::list_remote_dir(&target, path.as_deref())).await
}

#[tauri::command]
async fn pick_ssh_identity() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("选择 SSH 私钥")
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_workspace_folder(current: Option<String>) -> Option<String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("选择工作目录");
    if let Some(path) = current.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        dialog = dialog.set_directory(path);
    }
    dialog
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned())
}

#[tauri::command]
async fn list_workspace(
    root: String,
    path: Option<String>,
    ssh: Option<SshTarget>,
) -> Result<Vec<WorkspaceEntry>, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::list_remote_workspace(&target, path.as_deref())
        } else {
            workspace::list_workspace(&root, path.as_deref())
        }
    })
    .await
}

#[tauri::command]
async fn read_workspace_file(
    root: String,
    path: String,
    ssh: Option<SshTarget>,
) -> Result<WorkspaceFile, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::read_remote_file(&target, &path)
        } else {
            workspace::read_workspace_file(&root, &path)
        }
    })
    .await
}

#[tauri::command]
async fn read_workspace_image(
    root: String,
    path: String,
    ssh: Option<SshTarget>,
) -> Result<WorkspaceImage, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::read_remote_image(&target, &path)
        } else {
            workspace::read_workspace_image(&root, &path)
        }
    })
    .await
}

#[tauri::command]
async fn write_workspace_file(
    root: String,
    path: String,
    content: String,
    ssh: Option<SshTarget>,
) -> Result<(), String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::write_remote_file(&target, &path, &content)
        } else {
            workspace::write_workspace_file(&root, &path, &content)
        }
    })
    .await
}

#[tauri::command]
async fn search_workspace(
    root: String,
    query: String,
    limit: Option<u32>,
    ssh: Option<SshTarget>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let cap = limit.unwrap_or(80) as usize;
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::search_remote_workspace(&target, &query, cap)
        } else {
            workspace::search_workspace(&root, &query, cap)
        }
    })
    .await
}

#[tauri::command]
async fn grep_workspace(
    root: String,
    query: String,
    limit: Option<u32>,
    ssh: Option<SshTarget>,
) -> Result<Vec<GrepHit>, String> {
    let cap = limit.unwrap_or(50) as usize;
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::grep_remote_workspace(&target, &query, cap)
        } else {
            workspace::grep_workspace(&root, &query, cap)
        }
    })
    .await
}

#[tauri::command]
async fn read_project_rules(root: String, ssh: Option<SshTarget>) -> Result<Option<ProjectRules>, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_read_rules(&target)
        } else {
            workspace::read_project_rules(&root)
        }
    })
    .await
}
#[tauri::command]
async fn write_project_rules(root: String, content: String, ssh: Option<SshTarget>) -> Result<ProjectRules, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_write_rules(&target, &content)
        } else {
            workspace::write_project_rules(&root, &content)
        }
    })
    .await
}

#[tauri::command]
async fn git_status(root: String, ssh: Option<SshTarget>) -> Result<GitStatus, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_status(&target)
        } else {
            git::status(&root)
        }
    })
    .await
}

#[tauri::command]
async fn git_commit(
    root: String,
    message: String,
    ssh: Option<SshTarget>,
    all: Option<bool>,
) -> Result<String, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_commit(&target, &message, all)
        } else {
            git::commit(&root, &message, all)
        }
    })
    .await
}

#[tauri::command]
async fn git_init(root: String, ssh: Option<SshTarget>) -> Result<String, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_init(&target)
        } else {
            git::init(&root)
        }
    })
    .await
}

#[tauri::command]
async fn git_set_remote(
    root: String,
    url: String,
    name: Option<String>,
    ssh: Option<SshTarget>,
) -> Result<String, String> {
    let remote_name = name.unwrap_or_else(|| "origin".into());
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_set_remote(&target, &remote_name, &url)
        } else {
            git::set_remote(&root, &remote_name, &url)
        }
    })
    .await
}

#[tauri::command]
async fn git_stage(root: String, paths: Vec<String>, ssh: Option<SshTarget>) -> Result<String, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_stage(&target, &paths)
        } else {
            git::stage(&root, &paths)
        }
    })
    .await
}

#[tauri::command]
async fn git_unstage(root: String, paths: Vec<String>, ssh: Option<SshTarget>) -> Result<String, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_unstage(&target, &paths)
        } else {
            git::unstage(&root, &paths)
        }
    })
    .await
}

#[tauri::command]
async fn git_push(root: String, ssh: Option<SshTarget>) -> Result<String, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_push(&target)
        } else {
            git::push(&root)
        }
    })
    .await
}

#[tauri::command]
async fn git_pull(root: String, ssh: Option<SshTarget>) -> Result<String, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_pull(&target)
        } else {
            git::pull(&root)
        }
    })
    .await
}

#[tauri::command]
async fn git_fetch(root: String, ssh: Option<SshTarget>) -> Result<String, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_fetch(&target)
        } else {
            git::fetch(&root)
        }
    })
    .await
}

#[tauri::command]
async fn git_discard(root: String, paths: Vec<String>, ssh: Option<SshTarget>) -> Result<String, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_discard(&target, &paths)
        } else {
            git::discard(&root, &paths)
        }
    })
    .await
}

#[tauri::command]
async fn git_log(root: String, limit: Option<u32>, ssh: Option<SshTarget>) -> Result<Vec<GitCommit>, String> {
    let cap = limit.unwrap_or(40);
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_log(&target, cap)
        } else {
            git::log(&root, cap)
        }
    })
    .await
}

#[tauri::command]
async fn git_file_diff(
    root: String,
    path: String,
    staged: Option<bool>,
    ssh: Option<SshTarget>,
) -> Result<GitFileDiff, String> {
    let staged = staged.unwrap_or(false);
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_file_diff(&target, &path, staged)
        } else {
            git::file_diff(&root, &path, staged)
        }
    })
    .await
}

#[tauri::command]
async fn git_github_accounts() -> Result<Vec<GithubIdentity>, String> {
    run_blocking(|| Ok(git::github_identities())).await
}

#[tauri::command]
async fn git_review(root: String, ssh: Option<SshTarget>) -> Result<GitReview, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_git_review(&target)
        } else {
            git::review(&root)
        }
    })
    .await
}

#[tauri::command]
async fn capture_checkpoint(root: String, ssh: Option<SshTarget>) -> Result<Vec<SnapshotFile>, String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_capture_snapshot(&target)
        } else {
            git::capture_snapshot(&root)
        }
    })
    .await
}

#[tauri::command]
async fn restore_checkpoint(
    root: String,
    files: Vec<SnapshotFile>,
    ssh: Option<SshTarget>,
) -> Result<(), String> {
    run_blocking(move || {
        if let Some(target) = ssh {
            let target = target.normalized()?;
            ssh::remote_restore_snapshot(&target, &files)
        } else {
            git::restore_snapshot(&root, &files)
        }
    })
    .await
}

#[tauri::command]
async fn load_session_history(
    session_id: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<LocalSessionHistory, String> {
    run_blocking(move || {
        sessions::load_session_history(
            &session_id,
            limit.unwrap_or(48) as usize,
            skip.unwrap_or(0) as usize,
        )
    })
    .await
}

#[tauri::command]
async fn list_relay_models(payload: Option<ModelListRequest>) -> Result<ModelCatalog, String> {
    run_blocking(move || config::fetch_model_catalog(&grok_home(), payload.as_ref())).await
}

#[tauri::command]
async fn set_active_model(model: String, context_window: Option<u64>) -> Result<(), String> {
    run_blocking(move || config::set_active_model(&grok_home(), &model, context_window)).await
}

#[tauri::command]
async fn generate_image(prompt: String) -> Result<GeneratedImage, String> {
    run_blocking(move || image_gen::generate_image(prompt)).await
}

#[tauri::command]
async fn read_clipboard_image() -> Result<Option<PromptAttachment>, String> {
    run_blocking(media::read_clipboard_image).await
}

#[tauri::command]
async fn read_image_file(path: String) -> Result<PromptAttachment, String> {
    run_blocking(move || media::read_image_file(path)).await
}

#[tauri::command]
async fn save_image_as(
    path: Option<String>,
    data: Option<String>,
    name: Option<String>,
) -> Result<Option<String>, String> {
    let suggested = name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("grok-image.png")
        .to_string();
    let file = rfd::AsyncFileDialog::new()
        .set_title("保存图片")
        .set_file_name(&suggested)
        .save_file()
        .await;
    let Some(file) = file else {
        return Ok(None);
    };
    let dest = file.path().to_path_buf();
    let saved = dest.to_string_lossy().into_owned();
    run_blocking(move || media::save_image_as(path, data, &dest)).await?;
    Ok(Some(saved))
}

#[tauri::command]
async fn cancel_turn(
    state: State<'_, AppState>,
    conversation_id: Option<String>,
) -> Result<(), String> {
    let hub = Arc::clone(&state.acp);
    run_blocking(move || {
        let client = hub.client(conversation_id.as_deref())?;
        let guard = client.lock().map_err(|_| "无法锁定 ACP 会话".to_string())?;
        guard.cancel()
    })
    .await
}

#[tauri::command]
async fn set_permission_mode(
    state: State<'_, AppState>,
    mode: String,
    conversation_id: Option<String>,
) -> Result<(), String> {
    let hub = Arc::clone(&state.acp);
    run_blocking(move || hub.set_permission_mode(&mode, conversation_id.as_deref())).await
}

#[tauri::command]
async fn stop_session(
    state: State<'_, AppState>,
    conversation_id: Option<String>,
) -> Result<(), String> {
    let hub = Arc::clone(&state.acp);
    run_blocking(move || {
        if conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
        {
            hub.stop_one(conversation_id.as_deref())
        } else {
            hub.stop_all();
            Ok(())
        }
    })
    .await
}

#[tauri::command]
async fn answer_interaction(
    state: State<'_, AppState>,
    request_id: String,
    result: Value,
    conversation_id: Option<String>,
) -> Result<(), String> {
    let hub = Arc::clone(&state.acp);
    run_blocking(move || {
        let client = hub.client(conversation_id.as_deref())?;
        let guard = client.lock().map_err(|_| "无法锁定 ACP 会话".to_string())?;
        guard.answer_interaction(request_id, result)
    })
    .await
}

#[tauri::command]
async fn call_extension(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
    conversation_id: Option<String>,
) -> Result<Value, String> {
    let hub = Arc::clone(&state.acp);
    run_blocking(move || {
        let client = hub.client(conversation_id.as_deref())?;
        AcpClient::call_extension(&client, method, params.unwrap_or_else(|| serde_json::json!({})))
    })
    .await
}

#[tauri::command]
async fn list_accounts() -> AccountState {
    tauri::async_runtime::spawn_blocking(load_state)
        .await
        .unwrap_or_else(|_| load_state())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAccountsPayload {
    accounts: Vec<AccountRecord>,
    routing_mode: Option<String>,
    preferred_account_id: Option<String>,
}

#[tauri::command]
async fn save_account_state(payload: SaveAccountsPayload) -> Result<AccountState, String> {
    run_blocking(move || {
        save_accounts(
            payload.accounts,
            payload.routing_mode,
            payload.preferred_account_id,
        )
    })
    .await
}

#[tauri::command]
async fn add_account(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<AccountRecord, String> {
    let login = Arc::clone(&state.login);
    run_blocking(move || {
        let account = create_account(name)?;
        start_login(app, &login, account.clone(), true)?;
        Ok(account)
    })
    .await
}

#[tauri::command]
async fn login_account(
    app: AppHandle,
    state: State<'_, AppState>,
    account: AccountRecord,
) -> Result<(), String> {
    let login = Arc::clone(&state.login);
    run_blocking(move || start_login(app, &login, account, false)).await
}

#[tauri::command]
fn cancel_login(state: State<AppState>) {
    clear_login(&state.login);
}

#[tauri::command]
async fn discard_account_home(home_path: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || drop_uncommitted_home(&home_path)).await;
}

#[tauri::command]
async fn confirm_account(account: AccountRecord) -> Result<AccountState, String> {
    run_blocking(move || commit_account(account)).await
}

#[tauri::command]
async fn refresh_account_quota(account: AccountRecord) -> AccountRecord {
    let fallback = account.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut account = account;
        account.quota = Some(fetch_quota(&account));
        account.logged_in = std::path::Path::new(&account.home_path)
            .join("auth.json")
            .is_file();
        account
    })
    .await
    .unwrap_or(fallback)
}

#[tauri::command]
async fn list_skills(cwd: Option<String>) -> Vec<SkillRecord> {
    tauri::async_runtime::spawn_blocking(move || discover_skills(cwd))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn list_skill_dirs(cwd: Option<String>) -> SkillDirs {
    skill_dirs(cwd)
}

#[tauri::command]
fn open_skills_dir(app: AppHandle, kind: String, cwd: Option<String>) -> Result<String, String> {
    let dir = ensure_skill_dir(&kind, cwd)?;
    let path = dir.display().to_string();
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|err| err.to_string())?;
    Ok(path)
}

#[tauri::command]
fn inspect_local_path(path: String) -> Result<LocalPathInfo, String> {
    workspace::inspect_local_path(&path)
}

#[tauri::command]
fn reveal_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(path.trim());
    if !target.exists() {
        return Err("路径不存在".into());
    }
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn bridges_load(state: State<AppState>) -> BridgesConfig {
    state.bridges.snapshot()
}

#[tauri::command]
fn bridges_status(state: State<AppState>) -> BridgesStatus {
    state.bridges.status()
}

#[tauri::command]
fn bridges_apply(app: AppHandle, state: State<AppState>, config: BridgesConfig) -> Result<BridgesStatus, String> {
    state.bridges.apply(app, config)
}

#[tauri::command]
fn bridges_send(
    state: State<AppState>,
    text: String,
    title: Option<String>,
    kind: Option<String>,
    target: Option<String>,
    media: Option<Vec<BridgeMedia>>,
) -> Result<String, String> {
    state.bridges.send(
        kind,
        &text,
        title.as_deref().unwrap_or(""),
        media.as_deref().unwrap_or(&[]),
        target.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
fn bridges_test(state: State<AppState>, kind: String) -> Result<String, String> {
    state.bridges.test(&kind)
}

#[tauri::command]
fn bridges_probe(state: State<AppState>, kind: String) -> Result<String, String> {
    state.bridges.probe(&kind)
}

#[tauri::command]
fn bridges_pairing_decide(
    app: AppHandle,
    state: State<AppState>,
    kind: String,
    sender: String,
    accept: bool,
) -> Result<Vec<BridgePairing>, String> {
    state.bridges.decide_pairing(app, &kind, &sender, accept)
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        focus_window(&window);
    }
}

fn focus_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
async fn install_runtime(app: AppHandle) -> Result<String, String> {
    run_blocking(move || {
        let cancel = Arc::new(AtomicBool::new(false));
        let app_for_log = app.clone();
        install_official(
            InstallEventSink {
                on_line: Box::new(move |line| {
                    let _ = app_for_log.emit("install-log", line);
                }),
            },
            cancel,
        )
    })
    .await
}

fn emit_deeplink(app: &AppHandle, urls: Vec<String>) {
    for url in urls {
        match parse_deeplink(&url) {
            Ok(payload) => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut slot) = state.pending_import.lock() {
                        *slot = Some(payload.clone());
                    }
                }
                let _ = app.emit("relay-import", payload);
            }
            Err(err) => {
                let _ = app.emit("relay-import-error", err);
            }
        }
    }
    focus_main_window(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let urls = argv
                .into_iter()
                .filter(|arg| arg.starts_with("grokdesk://"))
                .collect::<Vec<_>>();
            if !urls.is_empty() {
                emit_deeplink(&app, urls);
            } else {
                focus_main_window(&app);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState::default())
        .manage(Arc::new(pty::PtyHub::new()))
        .setup(|app| {
            #[cfg(desktop)]
            {
                let _ = app.deep_link().register("grokdesk");
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                emit_deeplink(&handle, event.urls().iter().map(|u| u.to_string()).collect());
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                emit_deeplink(
                    app.handle(),
                    urls.into_iter().map(|u| u.to_string()).collect(),
                );
            }
            if let Some(state) = app.try_state::<AppState>() {
                let config = state.bridges.snapshot();
                if config.enabled {
                    let _ = state.bridges.apply(app.handle().clone(), config);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            import_relay,
            get_relay_quota,
            get_relay_usage,
            list_relay_models,
            set_active_model,
            generate_image,
            read_clipboard_image,
            read_image_file,
            save_image_as,
            parse_import_url,
            take_pending_import,
            install_runtime,
            get_acp_status,
            ensure_session,
            send_prompt,
            cancel_turn,
            set_permission_mode,
            stop_session,
            answer_interaction,
            call_extension,
            list_local_sessions,
            load_session_history,
            pick_workspace_folder,
            list_ssh_hosts,
            list_ssh_config_hosts,
            save_ssh_hosts,
            probe_ssh_host,
            list_ssh_dir,
            pick_ssh_identity,
            list_workspace,
            read_workspace_file,
            read_workspace_image,
            write_workspace_file,
            search_workspace,
            grep_workspace,
            read_project_rules,
            write_project_rules,
            git_status,
            git_commit,
            git_init,
            git_set_remote,
            git_stage,
            git_unstage,
            git_push,
            git_pull,
            git_fetch,
            git_discard,
            git_log,
            git_file_diff,
            git_review,
            git_github_accounts,
            capture_checkpoint,
            restore_checkpoint,
            list_accounts,
            save_account_state,
            add_account,
            login_account,
            cancel_login,
            discard_account_home,
            confirm_account,
            refresh_account_quota,
            list_skills,
            list_skill_dirs,
            open_skills_dir,
            inspect_local_path,
            reveal_in_folder,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_detect,
            bridges_load,
            bridges_status,
            bridges_apply,
            bridges_send,
            bridges_test,
            bridges_probe,
            bridges_pairing_decide
        ])
        .run(tauri::generate_context!())
        .expect("error while running GrokDesk");
}
