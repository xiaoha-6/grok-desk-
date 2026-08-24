mod config;
mod install;
mod runtime;

use config::{parse_deeplink, write_config, RelayImport};
use install::{install_official, InstallEventSink};
use runtime::{grok_home, launch_grok, runtime_status, RuntimeStatus};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

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
fn open_grok() -> Result<(), String> {
    launch_grok()
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
                let _ = app.emit("relay-import", payload);
            }
            Err(err) => {
                let _ = app.emit("relay-import-error", err);
            }
        }
    }
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
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
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
            open_grok,
            install_runtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running GrokDesk");
}
