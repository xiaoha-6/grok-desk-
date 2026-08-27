use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::ssh::{pty_ssh_command, SshTarget};

const READ_BUF: usize = 8192;

pub struct PtyHub {
    sessions: Mutex<HashMap<String, PtySession>>,
}

struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShell {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub preferred: bool,
}

#[derive(Clone, Serialize)]
struct PtyChunk {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
    code: Option<i32>,
}

impl PtyHub {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn take(&self, id: &str) -> Option<PtySession> {
        self.sessions.lock().ok()?.remove(id)
    }
}

fn find_bin(names: &[&str]) -> Option<String> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    #[cfg(windows)]
    {
        if let Some(system) = std::env::var_os("SystemRoot") {
            dirs.push(PathBuf::from(system).join("System32"));
        }
        dirs.push(PathBuf::from(r"C:\Windows\System32"));
    }
    #[cfg(not(windows))]
    {
        dirs.extend(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(PathBuf::from));
    }
    let exts: &[&str] = {
        #[cfg(windows)]
        {
            &["", ".exe", ".cmd", ".bat"]
        }
        #[cfg(not(windows))]
        {
            &[""]
        }
    };
    for dir in dirs {
        for name in names {
            for ext in exts {
                let candidate = if ext.is_empty() {
                    dir.join(name)
                } else if name.ends_with(ext) {
                    dir.join(name)
                } else {
                    dir.join(format!("{name}{ext}"))
                };
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

fn detect_shell_list() -> Vec<DetectedShell> {
    let mut out = Vec::new();
    let mut push = |id: &str, name: &str, names: &[&str], args: Vec<String>| {
        if out.iter().any(|item: &DetectedShell| item.id == id) {
            return;
        }
        if let Some(executable) = find_bin(names) {
            out.push(DetectedShell {
                id: id.into(),
                name: name.into(),
                executable,
                args,
                preferred: false,
            });
        }
    };

    let mut preferred_id = String::new();
    #[cfg(windows)]
    {
        push("pwsh", "PowerShell 7", &["pwsh"], vec!["-NoLogo".into()]);
        push("powershell", "Windows PowerShell", &["powershell"], vec!["-NoLogo".into()]);
        push("cmd", "Command Prompt", &["cmd"], Vec::new());
        push("bash", "Git Bash", &["bash"], vec!["-l".into()]);
        if out.iter().any(|item| item.id == "pwsh") {
            preferred_id = "pwsh".into();
        } else if out.iter().any(|item| item.id == "powershell") {
            preferred_id = "powershell".into();
        } else if out.iter().any(|item| item.id == "cmd") {
            preferred_id = "cmd".into();
        }
    }
    #[cfg(not(windows))]
    {
        push("zsh", "zsh", &["zsh"], vec!["-l".into()]);
        push("bash", "bash", &["bash"], vec!["-l".into()]);
        push("fish", "fish", &["fish"], vec!["-l".into()]);
        push("sh", "sh", &["sh"], Vec::new());
        push("pwsh", "PowerShell", &["pwsh"], vec!["-NoLogo".into()]);
        if let Ok(shell) = std::env::var("SHELL") {
            let path = Path::new(&shell);
            if path.is_file() {
                let id = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("shell")
                    .to_string();
                preferred_id = id.clone();
                if let Some(existing) = out.iter_mut().find(|item| item.executable == shell || item.id == id) {
                    existing.executable = shell;
                    existing.args = vec!["-l".into()];
                } else {
                    out.insert(
                        0,
                        DetectedShell {
                            id,
                            name: path
                                .file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or("shell")
                                .to_string(),
                            executable: shell,
                            args: vec!["-l".into()],
                            preferred: false,
                        },
                    );
                }
            }
        }
    }

    if let Some(item) = out.iter_mut().find(|item| item.id == preferred_id) {
        item.preferred = true;
    } else if let Some(first) = out.first_mut() {
        first.preferred = true;
    }
    out
}

fn resolve_shell(id: Option<&str>) -> Result<(String, Vec<String>), String> {
    let shells = detect_shell_list();
    if shells.is_empty() {
        return Err("no local shell found".into());
    }
    if let Some(want) = id.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(found) = shells.iter().find(|item| item.id.eq_ignore_ascii_case(want)) {
            return Ok((found.executable.clone(), found.args.clone()));
        }
    }
    let preferred = shells
        .iter()
        .find(|item| item.preferred)
        .unwrap_or(&shells[0]);
    Ok((preferred.executable.clone(), preferred.args.clone()))
}

fn build_command(cwd: Option<&str>, shell: Option<&str>) -> Result<CommandBuilder, String> {
    let (executable, args) = resolve_shell(shell)?;
    let mut cmd = CommandBuilder::new(executable);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(dir) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        if Path::new(dir).is_dir() {
            cmd.cwd(dir);
        }
    }
    Ok(cmd)
}

fn build_argv_command(cwd: Option<&str>, argv: &[String]) -> Result<CommandBuilder, String> {
    let program = argv.first().map(|item| item.trim()).filter(|item| !item.is_empty());
    let Some(program) = program else {
        return Err("运行命令为空".into());
    };
    let mut cmd = CommandBuilder::new(program);
    for arg in argv.iter().skip(1) {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(dir) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        if Path::new(dir).is_dir() {
            cmd.cwd(dir);
        }
    }
    Ok(cmd)
}

fn spawn_reader(app: AppHandle, id: String, mut reader: Box<dyn Read + Send>) {
    std::thread::Builder::new()
        .name(format!("pty-read-{id}"))
        .spawn(move || {
            let mut buf = [0_u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let payload = PtyChunk {
                            id: id.clone(),
                            data: BASE64.encode(&buf[..n]),
                        };
                        if app.emit("pty-output", payload).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit("pty-exit", PtyExit { id, code: None });
        })
        .ok();
}

#[tauri::command]
pub fn pty_detect() -> Vec<DetectedShell> {
    detect_shell_list()
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    hub: State<Arc<PtyHub>>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    ssh: Option<SshTarget>,
    argv: Option<Vec<String>>,
) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("terminal id is empty".into());
    }
    if let Some(old) = hub.take(&id) {
        if let Ok(mut child) = old.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let system = native_pty_system();
    let pair = system
        .openpty(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("open pty: {err}"))?;
    let command = if let Some(target) = ssh {
        pty_ssh_command(&target.normalized()?, argv.as_deref())?
    } else if let Some(args) = argv.as_ref().filter(|items| !items.is_empty()) {
        build_argv_command(cwd.as_deref(), args)?
    } else {
        build_command(cwd.as_deref(), shell.as_deref())?
    };
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("spawn shell: {err}"))?;
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("pty reader: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("pty writer: {err}"))?;
    let session = PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    };
    hub.sessions
        .lock()
        .map_err(|err| err.to_string())?
        .insert(id.clone(), session);
    spawn_reader(app, id, reader);
    Ok(())
}

#[tauri::command]
pub fn pty_write(hub: State<Arc<PtyHub>>, id: String, data: String) -> Result<(), String> {
    let sessions = hub.sessions.lock().map_err(|err| err.to_string())?;
    let session = sessions.get(&id).ok_or_else(|| "terminal is closed".to_string())?;
    let mut writer = session.writer.lock().map_err(|err| err.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("pty write: {err}"))?;
    writer.flush().ok();
    Ok(())
}

#[tauri::command]
pub fn pty_resize(hub: State<Arc<PtyHub>>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = hub.sessions.lock().map_err(|err| err.to_string())?;
    let session = sessions.get(&id).ok_or_else(|| "terminal is closed".to_string())?;
    let master = session.master.lock().map_err(|err| err.to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("pty resize: {err}"))
}

#[tauri::command]
pub fn pty_close(hub: State<Arc<PtyHub>>, id: String) -> Result<(), String> {
    if let Some(session) = hub.take(&id) {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}
