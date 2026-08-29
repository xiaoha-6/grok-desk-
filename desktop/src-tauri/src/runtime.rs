use serde::Serialize;
use std::env;
use std::fs;
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

fn user_home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Expand `~` / `$HOME` so Finder-launched builds do not spawn with a literal tilde cwd.
pub fn expand_user_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    let home = user_home();
    if trimmed == "~" || trimmed == "$HOME" {
        return home;
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home.join(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("~\\") {
        return home.join(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("$HOME/") {
        return home.join(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("$HOME\\") {
        return home.join(rest);
    }
    PathBuf::from(trimmed)
}

fn common_tool_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    dirs.push(grok_home().join("bin"));
    let home = user_home();
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/opt/git/bin"));
        dirs.push(home.join("homebrew").join("bin"));
    }
    if cfg!(windows) {
        if let Ok(pf) = env::var("ProgramFiles") {
            dirs.push(PathBuf::from(&pf).join("Git").join("cmd"));
            dirs.push(PathBuf::from(&pf).join("Git").join("bin"));
        }
        if let Ok(pf86) = env::var("ProgramFiles(x86)") {
            dirs.push(PathBuf::from(pf86).join("Git").join("cmd"));
        }
        dirs.push(PathBuf::from(r"C:\Program Files\Git\cmd"));
        dirs.push(PathBuf::from(r"C:\Program Files\Git\bin"));
        dirs.push(
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("Git")
                .join("cmd"),
        );
    }
    dirs
}

/// PATH for Agent / git: GUI apps launched from a DMG or Start Menu inherit a
/// stripped PATH, so grok cannot see Homebrew or Git for Windows.
pub fn augmented_path(existing: Option<String>) -> String {
    let sep = path_separator();
    let mut parts = Vec::new();
    for dir in common_tool_dirs() {
        if dir.is_dir() {
            let text = dir.display().to_string();
            if !parts.iter().any(|item: &String| item == &text) {
                parts.push(text);
            }
        }
    }
    if let Some(existing) = existing {
        for directory in existing.split(sep) {
            if directory.is_empty() {
                continue;
            }
            if !parts.iter().any(|item| item == directory) {
                parts.push(directory.to_string());
            }
        }
    }
    parts.join(&sep.to_string())
}

pub fn resolve_git_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    for dir in common_tool_dirs() {
        let candidate = dir.join(name);
        if is_runnable(&candidate) {
            return Some(candidate);
        }
    }
    if let Ok(path) = env::var("PATH") {
        for directory in path.split(path_separator()) {
            if directory.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(directory).join(name);
            if is_runnable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn downloaded_binaries(home: &Path) -> Vec<PathBuf> {
    let dir = home.join("downloads");
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let looks_like_cli = name == binary_name()
            || name.starts_with("grok-macos")
            || name.starts_with("grok-windows")
            || name.starts_with("grok-linux")
            || name.starts_with("grok-1.");
        if looks_like_cli && is_runnable(&path) {
            found.push(path);
        }
    }
    found.sort_by_key(|path| {
        std::cmp::Reverse(
            path.metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    });
    found
}

fn relink_bin(home: &Path, target: &Path) {
    let bin_dir = home.join("bin");
    let _ = fs::create_dir_all(&bin_dir);
    let link = bin_dir.join(binary_name());
    if is_runnable(&link) {
        return;
    }
    #[cfg(unix)]
    {
        let _ = fs::remove_file(&link);
        let rel = if target.starts_with(home.join("downloads")) {
            target
                .file_name()
                .map(|name| PathBuf::from("..").join("downloads").join(name))
        } else {
            None
        };
        let dest = rel.unwrap_or_else(|| target.to_path_buf());
        let _ = std::os::unix::fs::symlink(dest, &link);
    }
    #[cfg(windows)]
    {
        if !link.is_file() {
            let _ = fs::copy(target, &link);
        }
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
    let home = grok_home();
    let mut candidates = vec![home.join("bin").join(binary_name())];
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/opt/homebrew/bin/grok"));
        candidates.push(PathBuf::from("/usr/local/bin/grok"));
    }
    if cfg!(windows) {
        candidates.push(home.join("bin").join("grok"));
    }
    for dir in common_tool_dirs() {
        candidates.push(dir.join(binary_name()));
    }
    if let Ok(path) = env::var("PATH") {
        for directory in path.split(path_separator()) {
            if directory.is_empty() {
                continue;
            }
            candidates.push(PathBuf::from(directory).join(binary_name()));
        }
    }
    if let Some(path) = candidates.into_iter().find(|path| is_runnable(path)) {
        return Some(path);
    }

    // Official installer leaves ~/.grok/bin/grok → ../downloads/grok-macos-*.
    // After a CLI self-update the symlink can dangle; recover the newest download.
    let downloads = downloaded_binaries(&home);
    if let Some(target) = downloads.first() {
        relink_bin(&home, target);
        let linked = home.join("bin").join(binary_name());
        if is_runnable(&linked) {
            return Some(linked);
        }
        return Some(target.clone());
    }
    None
}

pub fn resolve_spawn_binary() -> Result<PathBuf, String> {
    let binary = resolve_binary().ok_or_else(|| {
        "还没有检测到 Grok Build。请打开设置安装官方 CLI，或确认 ~/.grok/bin/grok 存在。"
            .to_string()
    })?;
    match fs::canonicalize(&binary) {
        Ok(resolved) if is_runnable(&resolved) => Ok(resolved),
        Ok(_) | Err(_) if is_runnable(&binary) => Ok(binary),
        _ => Err(format!(
            "Grok Build 指向的文件不存在：{}。请打开设置重新安装官方 CLI。",
            binary.display()
        )),
    }
}

/// Always return a directory that exists. A missing project folder used to make
/// `Command::spawn` fail with "No such file or directory (os error 2)", which
/// the UI showed as Grok Agent/runtime disappearing even though the CLI was fine.
pub fn resolve_spawn_cwd(cwd: &str) -> Result<PathBuf, String> {
    let home = user_home();
    let trimmed = cwd.trim();
    let path = if trimmed.is_empty() {
        home.clone()
    } else {
        expand_user_path(trimmed)
    };
    if path.is_dir() {
        return Ok(path);
    }
    if !home.is_dir() {
        fs::create_dir_all(&home).map_err(|err| format!("无法创建主目录：{err}"))?;
    }
    Ok(home)
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

    #[test]
    fn expand_user_path_resolves_tilde() {
        let home = user_home();
        assert_eq!(expand_user_path("~"), home);
        assert_eq!(expand_user_path("~/Downloads"), home.join("Downloads"));
        assert_eq!(expand_user_path("/tmp/project"), PathBuf::from("/tmp/project"));
    }

    #[test]
    fn resolve_spawn_cwd_falls_back_when_folder_missing() {
        let missing = user_home().join("grokdesk-missing-cwd-test-folder-does-not-exist");
        let resolved = resolve_spawn_cwd(&missing.display().to_string()).expect("home fallback");
        assert_eq!(resolved, user_home());
    }

    #[test]
    fn resolve_spawn_cwd_falls_back_to_home() {
        let home = resolve_spawn_cwd("").expect("home cwd");
        assert!(home.is_dir());
    }
}
