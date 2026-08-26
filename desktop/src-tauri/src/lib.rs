mod accounts;
mod acp;
mod config;
mod install;
mod media;
mod runtime;
mod sessions;
mod ssh;
mod workspace;

use accounts::{
    clear_login, commit_account, create_account, discover_skills, drop_uncommitted_home,
    fetch_quota, load_state, save_accounts, start_login, AccountRecord, AccountState, LoginSlot,
    SkillRecord,
};
use acp::{AcpClient, AcpStatus, PromptAttachment, SessionInfo, SessionOptions};
use config::{
    parse_deeplink, write_config, ModelCatalog, ModelListRequest, RelayImport, RelayQuota,
};
use install::{install_official, InstallEventSink};
use runtime::{grok_home, runtime_status, RuntimeStatus};
use sessions::{LocalSessionHistory, LocalSessionSummary};
use ssh::{SshConfigHost, SshProbe, SshTarget};
use workspace::{WorkspaceEntry, WorkspaceFile};
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

struct AppState {
    pending_import: Mutex<Option<RelayImport>>,
    acp: Arc<Mutex<AcpClient>>,
    login: LoginSlot,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            pending_import: Mutex::new(None),
            acp: Arc::new(Mutex::new(AcpClient::default())),
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
    state.acp.lock().map(|client| client.status()).unwrap_or(AcpStatus {
        connected: false,
        session_id: None,
        model: None,
        cwd: None,
    })
}

#[tauri::command]
async fn ensure_session(
    app: AppHandle,
    state: State<'_, AppState>,
    options: SessionOptions,
) -> Result<SessionInfo, String> {
    let acp = Arc::clone(&state.acp);
    run_blocking(move || AcpClient::connect(&acp, &app, options)).await
}

#[tauri::command]
async fn send_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    attachments: Option<Vec<PromptAttachment>>,
) -> Result<(), String> {
    let acp = Arc::clone(&state.acp);
    run_blocking(move || {
        let client = acp.lock().map_err(|_| "无法锁定 ACP 会话".to_string())?;
        client.send_prompt(&app, text, attachments.unwrap_or_default())
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
async fn read_clipboard_image() -> Result<Option<PromptAttachment>, String> {
    run_blocking(media::read_clipboard_image).await
}

#[tauri::command]
async fn read_image_file(path: String) -> Result<PromptAttachment, String> {
    run_blocking(move || media::read_image_file(path)).await
}

#[tauri::command]
async fn cancel_turn(state: State<'_, AppState>) -> Result<(), String> {
    let acp = Arc::clone(&state.acp);
    run_blocking(move || {
        let client = acp.lock().map_err(|_| "无法锁定 ACP 会话".to_string())?;
        client.cancel()
    })
    .await
}

#[tauri::command]
async fn set_permission_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let acp = Arc::clone(&state.acp);
    run_blocking(move || {
        let client = acp.lock().map_err(|_| "无法锁定 ACP 会话".to_string())?;
        client.set_permission_mode(&mode)
    })
    .await
}

#[tauri::command]
async fn stop_session(state: State<'_, AppState>) -> Result<(), String> {
    let acp = Arc::clone(&state.acp);
    run_blocking(move || {
        let mut client = acp.lock().map_err(|_| "无法锁定 ACP 会话".to_string())?;
        client.stop();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn answer_interaction(
    state: State<'_, AppState>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    let acp = Arc::clone(&state.acp);
    run_blocking(move || {
        let client = acp.lock().map_err(|_| "无法锁定 ACP 会话".to_string())?;
        client.answer_interaction(request_id, result)
    })
    .await
}

#[tauri::command]
async fn call_extension(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let acp = Arc::clone(&state.acp);
    run_blocking(move || {
        AcpClient::call_extension(&acp, method, params.unwrap_or_else(|| serde_json::json!({})))
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            import_relay,
            get_relay_quota,
            list_relay_models,
            set_active_model,
            read_clipboard_image,
            read_image_file,
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
            list_accounts,
            save_account_state,
            add_account,
            login_account,
            cancel_login,
            discard_account_home,
            confirm_account,
            refresh_account_quota,
            list_skills
        ])
        .run(tauri::generate_context!())
        .expect("error while running GrokDesk");
}
