mod acp;
mod config;
mod install;
mod runtime;

use acp::{AcpClient, AcpStatus, SessionInfo};
use config::{parse_deeplink, write_config, RelayImport};
use install::{install_official, InstallEventSink};
use runtime::{grok_home, runtime_status, RuntimeStatus};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

struct AppState {
    pending_import: Mutex<Option<RelayImport>>,
    acp: Mutex<AcpClient>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            pending_import: Mutex::new(None),
            acp: Mutex::new(AcpClient::default()),
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
    model: Option<String>,
    cwd: Option<String>,
    existing_session_id: Option<String>,
) -> Result<SessionInfo, String> {
    let mut client = state
        .acp
        .lock()
        .map_err(|_| "无法锁定 ACP 会话".to_string())?;
    client.ensure_session(&app, model, cwd, existing_session_id)
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
            stop_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running GrokDesk");
}
