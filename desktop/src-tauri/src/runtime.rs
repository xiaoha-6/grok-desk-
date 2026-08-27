use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// GUI apps on Windows allocate a visible console for every console subprocess
/// unless CREATE_NO_WINDOW is set. Keep helper tools (git, gh, curl, grok) silent.
pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = command;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub grok_home: String,
    pub config_path: String,
    pub config_exists: bool,
    pub home_dir: String,
    pub os: String,
    pub installer_url: String,
    pub credentials_ready: bool,
}

pub fn current_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub fn official_installer_url() -> &'static str {
    if cfg!(target_os = "windows") {
        "https://x.ai/cli/install.ps1"
    } else {
        "https://x.ai/cli/install.sh"
    }
}

pub fn grok_home() -> PathBuf {
    if let Ok(home) = env::var("GROK_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok")
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "grok.exe"
    } else {
        "grok"
    }
}

fn path_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

fn is_runnable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        true
    }
}

fn probe_version(path: &Path) -> Option<String> {
    let mut command = Command::new(path);
    command.arg("--version");
    hide_console(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or(text.trim()).trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

pub fn resolve_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    let home = grok_home();
    candidates.push(home.join("bin").join(binary_name()));

    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/opt/homebrew/bin/grok"));
        candidates.push(PathBuf::from("/usr/local/bin/grok"));
    }

    if let Ok(path) = env::var("PATH") {
        for directory in path.split(path_separator()) {
            if directory.is_empty() {
                continue;
            }
            candidates.push(PathBuf::from(directory).join(binary_name()));
        }
    }

    candidates.into_iter().find(|path| is_runnable(path))
}

pub fn runtime_status() -> RuntimeStatus {
    let home = grok_home();
    let config_path = home.join("config.toml");
    let binary = resolve_binary();
    let version = binary.as_ref().and_then(|path| probe_version(path));
    RuntimeStatus {
        installed: binary.is_some(),
        path: binary.as_ref().map(|path| path.display().to_string()),
        version,
        grok_home: home.display().to_string(),
        config_path: config_path.display().to_string(),
        config_exists: config_path.is_file(),
        home_dir: dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .display()
            .to_string(),
        os: current_os().to_string(),
        installer_url: official_installer_url().to_string(),
        credentials_ready: crate::config::credentials_ready(&home),
    }
}

#[allow(dead_code)]
pub fn launch_grok() -> Result<(), String> {
    let binary = resolve_binary().ok_or_else(|| "还没有检测到 Grok Build".to_string())?;
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"",
            binary.display()
        );
        let status = Command::new("osascript")
            .args(["-e", &script])
            .status()
            .map_err(|err| format!("无法打开 Terminal：{err}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("打开 Terminal 失败".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;
        let home = grok_home();
        Command::new(&binary)
            .current_dir(&home)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("无法启动 Grok：{err}"))?;
        return Ok(());
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let status = Command::new("x-terminal-emulator")
            .arg("-e")
            .arg(&binary)
            .status();
        if status.map(|s| s.success()).unwrap_or(false) {
            return Ok(());
        }
        Command::new(&binary)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("无法启动 Grok：{err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_home_uses_env_override() {
        env::set_var("GROK_HOME", "/tmp/custom-grok-home");
        assert_eq!(grok_home(), PathBuf::from("/tmp/custom-grok-home"));
        env::remove_var("GROK_HOME");
    }
}
