mod accounts;
mod acp;
mod config;
mod install;
mod runtime;

use accounts::{
    clear_login, commit_account, create_account, discover_skills, drop_uncommitted_home,
    fetch_quota, load_state, save_accounts, start_login, AccountRecord, AccountState, LoginSlot,
    SkillRecord,
};
use acp::{AcpClient, AcpStatus, SessionInfo, SessionOptions};
use config::{parse_deeplink, write_config, RelayImport};
use install::{install_official, InstallEventSink};
use runtime::{grok_home, runtime_status, RuntimeStatus};
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

struct AppState {
    pending_import: Mutex<Option<RelayImport>>,
    acp: Mutex<AcpClient>,
    login: LoginSlot,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            pending_import: Mutex::new(None),
            acp: Mutex::new(AcpClient::default()),
            login: Arc::new(Mutex::new(None)),
        }
    }
}

#[tauri::command]
fn get_runtime_status() -> RuntimeStatus {
    runtime_status()
}

#[tauri::command]
fn import_relay(payload: RelayImport) -> Result<config::ImportResult, String> {
    let import = payload.normalized()?;
    write_config(&grok_home(), &import).map_err(|err| format!("写入 config.toml 失败：{err}"))
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
    state
        .acp
        .lock()
        .map(|client| client.status())
        .unwrap_or(AcpStatus {
            connected: false,
            session_id: None,
            model: None,
            cwd: None,
        })
}

#[tauri::command]
fn ensure_session(
    app: AppHandle,
    state: State<AppState>,
    options: SessionOptions,
) -> Result<SessionInfo, String> {
    let mut client = state
        .acp
        .lock()
        .map_err(|_| "无法锁定 ACP 会话".to_string())?;
    client.ensure_session(&app, options)
}

#[tauri::command]
fn send_prompt(app: AppHandle, state: State<AppState>, text: String) -> Result<(), String> {
    let client = state
        .acp
        .lock()
        .map_err(|_| "无法锁定 ACP 会话".to_string())?;
    client.send_prompt(&app, text)
}

#[tauri::command]
fn cancel_turn(state: State<AppState>) -> Result<(), String> {
    let client = state
        .acp
        .lock()
        .map_err(|_| "无法锁定 ACP 会话".to_string())?;
    client.cancel()
}

#[tauri::command]
fn stop_session(state: State<AppState>) -> Result<(), String> {
    let mut client = state
        .acp
        .lock()
        .map_err(|_| "无法锁定 ACP 会话".to_string())?;
    client.stop();
    Ok(())
}

#[tauri::command]
fn answer_interaction(
    state: State<AppState>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    let client = state
        .acp
        .lock()
        .map_err(|_| "无法锁定 ACP 会话".to_string())?;
    client.answer_interaction(request_id, result)
}

#[tauri::command]
fn call_extension(
    state: State<AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let client = state
        .acp
        .lock()
        .map_err(|_| "无法锁定 ACP 会话".to_string())?;
    client.call_extension(method, params.unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
fn list_accounts() -> AccountState {
    load_state()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAccountsPayload {
    accounts: Vec<AccountRecord>,
    routing_mode: Option<String>,
    preferred_account_id: Option<String>,
}

#[tauri::command]
fn save_account_state(payload: SaveAccountsPayload) -> Result<AccountState, String> {
    save_accounts(
        payload.accounts,
        payload.routing_mode,
        payload.preferred_account_id,
    )
}

#[tauri::command]
fn add_account(
    app: AppHandle,
    state: State<AppState>,
    name: String,
) -> Result<AccountRecord, String> {
    let account = create_account(name)?;
    start_login(app, &state.login, account.clone(), true)?;
    Ok(account)
}

#[tauri::command]
fn login_account(app: AppHandle, state: State<AppState>, account: AccountRecord) -> Result<(), String> {
    start_login(app, &state.login, account, false)
}

#[tauri::command]
fn cancel_login(state: State<AppState>) {
    clear_login(&state.login);
}

#[tauri::command]
fn discard_account_home(home_path: String) {
    drop_uncommitted_home(&home_path);
}

#[tauri::command]
fn confirm_account(account: AccountRecord) -> Result<AccountState, String> {
    commit_account(account)
}

#[tauri::command]
fn refresh_account_quota(mut account: AccountRecord) -> AccountRecord {
    account.quota = Some(fetch_quota(&account));
    account.logged_in = std::path::Path::new(&account.home_path)
        .join("auth.json")
        .is_file();
    account
}

#[tauri::command]
fn list_skills(cwd: Option<String>) -> Vec<SkillRecord> {
    discover_skills(cwd)
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
fn install_runtime(app: AppHandle) -> Result<String, String> {
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
            parse_import_url,
            take_pending_import,
            install_runtime,
            get_acp_status,
            ensure_session,
            send_prompt,
            cancel_turn,
            stop_session,
            answer_interaction,
            call_extension,
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
