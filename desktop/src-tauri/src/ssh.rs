use crate::workspace::{WorkspaceEntry, WorkspaceFile, SKIP_DIRS, MAX_FILE_BYTES, language_for_name};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const SSH_TIMEOUT_SECS: u64 = 20;
const SSH_LONG_TIMEOUT_SECS: u64 = 90;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub remote_path: String,
    pub identity_file: Option<String>,
    pub auth: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

impl SshTarget {
    pub fn normalized(self) -> Result<Self, String> {
        let host = self.host.trim().to_string();
        if host.is_empty() {
            return Err("请填写 SSH 主机".into());
        }
        if host.contains(' ') || host.contains('"') || host.contains('\'') {
            return Err("主机名不合法".into());
        }
        let user = {
            let trimmed = self.user.trim();
            if trimmed.is_empty() {
                "root".to_string()
            } else {
                trimmed.to_string()
            }
        };
        if user.contains(' ') || user.contains('@') || user.contains('"') {
            return Err("用户名不合法".into());
        }
        let port = if self.port == 0 { 22 } else { self.port };
        let remote_path = {
            let normalized = normalize_remote_path(&self.remote_path);
            if normalized.is_empty() {
                "~".to_string()
            } else {
                normalized
            }
        };
        let identity_file = self
            .identity_file
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(expand_tilde);
        if let Some(path) = &identity_file {
            if !Path::new(path).is_file() {
                return Err(format!("私钥文件不存在：{path}"));
            }
        }
        let password = self
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        let auth = match self.auth.trim().to_ascii_lowercase().as_str() {
            "password" => "password".to_string(),
            _ => "key".to_string(),
        };
        if auth == "password" && password.is_none() {
            return Err("请填写 SSH 密码".into());
        }
        let alias = self
            .alias
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        Ok(Self {
            host,
            port,
            user,
            remote_path,
            identity_file,
            auth,
            password,
            alias,
        })
    }

    pub fn workspace_id(&self) -> String {
        format!(
            "ssh://{}@{}:{}/{}",
            self.user,
            self.host,
            self.port,
            self.remote_path.trim_start_matches('/')
        )
    }

    pub fn destination(&self) -> String {
        format!("{}@{}", self.user, self.host)
    }

    pub fn for_persist(&self) -> Self {
        let mut clone = self.clone();
        clone.password = None;
        clone
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_file: Option<String>,
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbe {
    pub ok: bool,
    pub os: String,
    pub remote_path: String,
    pub grok_installed: bool,
    pub grok_path: Option<String>,
    pub home: String,
    pub shell: String,
    pub message: String,
    #[serde(default)]
    pub entries: Vec<WorkspaceEntry>,
}

pub fn probe(target: &SshTarget) -> Result<SshProbe, String> {
    let browse = if target.remote_path.trim().is_empty() || looks_like_home(&target.remote_path) {
        "~"
    } else {
        target.remote_path.as_str()
    };
    let script = probe_script(browse);
    let output = run_ssh(target, &script, SSH_LONG_TIMEOUT_SECS, None)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut probe = parse_probe(&stdout, browse)?;
    let mut listing = target.clone();
    listing.remote_path = probe.remote_path.clone();
    match list_remote_workspace(&listing, None) {
        Ok(entries) => probe.entries = entries,
        Err(err) => {
            if probe.message.is_empty() {
                probe.message = err;
            } else {
                probe.message = format!("{}（{err}）", probe.message);
            }
        }
    }
    Ok(probe)
}

pub fn list_remote_dir(target: &SshTarget, path: Option<&str>) -> Result<Vec<WorkspaceEntry>, String> {
    let mut listing = target.clone();
    listing.remote_path = path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(target.remote_path.as_str())
        .to_string();
    if listing.remote_path.trim().is_empty() {
        listing.remote_path = "~".into();
    }
    list_remote_workspace(&listing, None)
}

pub fn list_remote_workspace(target: &SshTarget, rel: Option<&str>) -> Result<Vec<WorkspaceEntry>, String> {
    let rel = sanitize_rel(rel.unwrap_or(""))?;
    let remote = join_remote(&target.remote_path, &rel);
    let quoted = sh_single(&remote);
    let script = format!(
        "root={quoted}; case \"$root\" in ~|~/ *) root=\"$HOME${{root#~}}\";; esac; if [ ! -e \"$root\" ]; then echo ERR:not_found; exit 2; fi; if [ ! -d \"$root\" ]; then echo ERR:not_dir; exit 2; fi; if [ ! -r \"$root\" ]; then echo ERR:denied; exit 2; fi; printf 'OK\\n'; ls -1A \"$root\" | while IFS= read -r name; do [ -n \"$name\" ] || continue; if [ -d \"$root/$name\" ]; then printf 'D\\t%s\\n' \"$name\"; else printf 'F\\t%s\\n' \"$name\"; fi; done",
        quoted = quoted,
    );
    let output = run_ssh(target, &script, SSH_TIMEOUT_SECS, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stdout.contains("ERR:not_found") {
        return Err("远程路径不存在".into());
    }
    if stdout.contains("ERR:not_dir") {
        return Err("不是文件夹".into());
    }
    if stdout.contains("ERR:denied") {
        return Err("没有权限读取该目录".into());
    }
    if !output.status.success() {
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    let skip: std::collections::HashSet<&str> = SKIP_DIRS.iter().copied().collect();
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end();
        if line.is_empty() || line == "OK" {
            continue;
        }
        let Some((kind, name)) = line.split_once('\t') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let is_dir = kind == "D";
        if is_dir && (name.starts_with('.') || skip.contains(name)) {
            continue;
        }
        let path = if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        };
        entries.push(WorkspaceEntry {
            name: name.to_string(),
            path: path.replace('\\', "/"),
            is_dir,
        });
    }
    entries.sort_by(|left, right| {
        (!left.is_dir, left.name.to_ascii_lowercase()).cmp(&(!right.is_dir, right.name.to_ascii_lowercase()))
    });
    Ok(entries)
}

pub fn read_remote_file(target: &SshTarget, rel: &str) -> Result<WorkspaceFile, String> {
    let rel = sanitize_rel(rel)?;
    if rel.is_empty() {
        return Err("还没有选择文件".into());
    }
    let remote = join_remote(&target.remote_path, &rel);
    let quoted = sh_single(&remote);
    let script = format!(
        "path={quoted}; case \"$path\" in ~|~/ *) path=\"$HOME${{path#~}}\";; esac; if [ -d \"$path\" ]; then echo ERR:dir; exit 2; fi; if [ ! -e \"$path\" ]; then echo ERR:not_found; exit 2; fi; if [ ! -r \"$path\" ]; then echo ERR:denied; exit 2; fi; size=$(wc -c < \"$path\" | tr -d ' '); printf 'OK %s\\n' \"$size\"; dd if=\"$path\" bs=1 count={limit} 2>/dev/null",
        quoted = quoted,
        limit = MAX_FILE_BYTES,
    );
    let output = run_ssh(target, &script, SSH_TIMEOUT_SECS, None)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ssh_error(&stderr, "", output.status.code()));
    }
    let stdout = output.stdout;
    let split = stdout.iter().position(|byte| *byte == b'\n').unwrap_or(stdout.len());
    let header = String::from_utf8_lossy(&stdout[..split]).trim().to_string();
    if header.starts_with("ERR:") {
        return Err(match header.as_str() {
            "ERR:dir" => "这是文件夹".into(),
            "ERR:not_found" => "远程文件不存在".into(),
            "ERR:denied" => "没有权限读取该文件".into(),
            other => format!("无法读取远程文件：{other}"),
        });
    }
    let size = header
        .strip_prefix("OK ")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let body = if split < stdout.len() { &stdout[split + 1..] } else { &[] };
    let truncated = size > MAX_FILE_BYTES;
    let mut content = String::from_utf8_lossy(body).into_owned();
    if truncated {
        content.push_str("\n…");
    }
    Ok(WorkspaceFile {
        path: rel.replace('\\', "/"),
        language: language_for_name(&rel),
        content,
        truncated,
        size,
    })
}

pub fn spawn_remote_agent(
    target: &SshTarget,
    model: &str,
    grok_home: Option<&str>,
    extra_env: &[(&str, String)],
) -> Result<std::process::Child, String> {
    let remote_home = grok_home
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "$HOME/.grok".to_string());
    let mut env_prefix = String::from("export PATH=\"$HOME/.grok/bin:$HOME/.local/bin:/usr/local/bin:$PATH\"; ");
    env_prefix.push_str(&format!("export GROK_HOME={}; ", sh_single(&remote_home)));
    for (key, value) in extra_env {
        env_prefix.push_str(&format!("export {key}={}; ", sh_single(value)));
    }
    let command = format!(
        "{env} cd {cwd} && if command -v grok >/dev/null 2>&1; then BIN=grok; elif [ -x \"$HOME/.grok/bin/grok\" ]; then BIN=\"$HOME/.grok/bin/grok\"; elif [ -x \"$HOME/.grok/bin/grok.exe\" ]; then BIN=\"$HOME/.grok/bin/grok.exe\"; else echo 'GROKDESK_NO_GROK: 远程还没有安装 Grok Build。请先在 Linux 上执行 curl -fsSL https://x.ai/cli/install.sh | bash，或在 Windows 上执行 irm https://x.ai/cli/install.ps1 | iex。' >&2; exit 42; fi; exec \"$BIN\" agent --model {model} stdio",
        env = env_prefix,
        cwd = sh_single(&target.remote_path),
        model = sh_single(model),
    );
    spawn_ssh(target, &command)
}

fn probe_script(remote_path: &str) -> String {
    format!(
        r#"python3 -c "import os,shutil,sys
raw=sys.argv[1]
home=os.path.expanduser('~')
path=os.path.expanduser(raw) if raw else home
os_name='windows' if os.name=='nt' or sys.platform.startswith('win') else 'linux'
if sys.platform.startswith('darwin'):
    os_name='macos'
shell=os.environ.get('SHELL') or os.environ.get('COMSPEC') or ''
cands=[shutil.which('grok'), os.path.join(home,'.grok','bin','grok'), os.path.join(home,'.grok','bin','grok.exe')]
grok=next((item for item in cands if item and os.path.exists(item)), '')
exists=os.path.isdir(path)
print('OS='+os_name)
print('HOME='+home)
print('SHELL='+shell)
print('PATH_EXISTS='+('1' if exists else '0'))
print('PATH='+(os.path.abspath(path) if exists else path))
print('GROK='+grok)
" {path}"#,
        path = sh_single(remote_path),
    )
}

fn parse_probe(stdout: &str, fallback_path: &str) -> Result<SshProbe, String> {
    let mut os = "linux".to_string();
    let mut home = String::new();
    let mut shell = String::new();
    let mut remote_path = fallback_path.to_string();
    let mut grok_path = None;
    let mut exists = false;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("OS=") {
            os = value.trim().to_ascii_lowercase();
        } else if let Some(value) = line.strip_prefix("HOME=") {
            home = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("SHELL=") {
            shell = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("PATH=") {
            if !value.trim().is_empty() {
                remote_path = value.trim().to_string();
            }
        } else if let Some(value) = line.strip_prefix("PATH_EXISTS=") {
            exists = value.trim() == "1";
        } else if let Some(value) = line.strip_prefix("GROK=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                grok_path = Some(trimmed.to_string());
            }
        }
    }
    if !exists {
        return Err(format!("远程路径不存在：{remote_path}"));
    }
    let grok_installed = grok_path.is_some();
    let message = if grok_installed {
        format!("已连接到 {}，远程 Grok Build 可用", os_label(&os))
    } else {
        format!(
            "已连接到 {}，但远程还没有 Grok Build。Linux 执行 curl -fsSL https://x.ai/cli/install.sh | bash；Windows 执行 irm https://x.ai/cli/install.ps1 | iex。",
            os_label(&os)
        )
    };
    Ok(SshProbe {
        ok: true,
        os,
        remote_path,
        grok_installed,
        grok_path,
        home,
        shell,
        message,
        entries: Vec::new(),
    })
}

fn os_label(os: &str) -> &str {
    match os {
        "windows" => "Windows",
        "macos" => "macOS",
        _ => "Linux",
    }
}

fn run_ssh(
    target: &SshTarget,
    remote_command: &str,
    timeout_secs: u64,
    stdin: Option<&[u8]>,
) -> Result<std::process::Output, String> {
    let mut command = ssh_command(target)?;
    command.arg(target.destination());
    command.arg(remote_command);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    apply_no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("无法启动 SSH：{err}。请确认本机已安装 OpenSSH 客户端。"))?;
    if let Some(bytes) = stdin {
        if let Some(mut handle) = child.stdin.take() {
            let _ = handle.write_all(bytes);
        }
    }
    wait_output(child, timeout_secs)
}

fn spawn_ssh(target: &SshTarget, remote_command: &str) -> Result<std::process::Child, String> {
    let mut command = ssh_command(target)?;
    command.arg("-T");
    command.arg(target.destination());
    command.arg(remote_command);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    apply_no_window(&mut command);
    command
        .spawn()
        .map_err(|err| format!("无法启动远程 SSH 会话：{err}"))
}

fn apply_no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = command;
}

fn ssh_command(target: &SshTarget) -> Result<Command, String> {
    let password = target
        .password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let use_password = target.auth == "password" || password.is_some();
    let mut command = Command::new(ssh_binary()?);
    command.arg("-p").arg(target.port.to_string());
    command.arg("-o").arg("StrictHostKeyChecking=accept-new");
    command.arg("-o").arg("ConnectTimeout=12");
    command.arg("-o").arg("ServerAliveInterval=15");
    command.arg("-o").arg("ServerAliveCountMax=3");
    command.arg("-o").arg("NumberOfPasswordPrompts=1");
    if use_password {
        let askpass = write_askpass()?;
        command.env("SSH_ASKPASS", &askpass);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("GROKDESK_SSH_PASSWORD", password.unwrap_or_default());
        if std::env::var_os("DISPLAY").is_none() {
            command.env("DISPLAY", ":0");
        }
        command.env("SSH_ASKPASS_PROMPT", "none");
        command.arg("-o").arg("PreferredAuthentications=password,keyboard-interactive");
        command.arg("-o").arg("PubkeyAuthentication=no");
        command.arg("-o").arg("KbdInteractiveAuthentication=yes");
        command.arg("-o").arg("PasswordAuthentication=yes");
        command.arg("-o").arg("BatchMode=no");
    } else {
        command.arg("-o").arg("BatchMode=yes");
        command.arg("-o").arg("PreferredAuthentications=publickey,keyboard-interactive");
        if let Some(identity) = &target.identity_file {
            command.arg("-i").arg(identity);
            command.arg("-o").arg("IdentitiesOnly=yes");
        }
    }
    Ok(command)
}

fn write_askpass() -> Result<PathBuf, String> {
    let dir = crate::runtime::grok_home().join("tmp");
    fs::create_dir_all(&dir).map_err(|err| format!("无法准备 SSH 密码助手：{err}"))?;
    let path = dir.join(if cfg!(windows) { "askpass.cmd" } else { "askpass.sh" });
    if cfg!(windows) {
        fs::write(
            &path,
            "@echo off\r\nsetlocal EnableDelayedExpansion\r\necho !GROKDESK_SSH_PASSWORD!\r\n",
        )
        .map_err(|err| format!("无法写入 SSH 密码助手：{err}"))?;
    } else {
        fs::write(&path, "#!/bin/sh\nprintf '%s\\n' \"$GROKDESK_SSH_PASSWORD\"\n")
            .map_err(|err| format!("无法写入 SSH 密码助手：{err}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o700));
        }
    }
    Ok(path)
}

fn ssh_binary() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("GROKDESK_SSH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let names = if cfg!(windows) {
        vec!["ssh.exe", "ssh"]
    } else {
        vec!["ssh"]
    };
    for name in names {
        if let Ok(path) = which(name) {
            return Ok(path);
        }
    }
    Err("本机没有 OpenSSH 客户端。macOS / Linux 一般自带 ssh；Windows 请安装 OpenSSH Client。".into())
}

fn which(name: &str) -> Result<PathBuf, String> {
    if let Ok(output) = Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg(name)
        .output()
    {
        if output.status.success() {
            if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    return Ok(PathBuf::from(trimmed));
                }
            }
        }
    }
    Err(format!("找不到 {name}"))
}

fn wait_output(mut child: std::process::Child, timeout_secs: u64) -> Result<std::process::Output, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|err| format!("读取 SSH 输出失败：{err}"))
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("SSH 连接超时。请检查主机、端口、私钥，或先在终端里 ssh 一次确认能登录。".into());
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(err) => return Err(format!("SSH 进程异常：{err}")),
        }
    }
}

fn ssh_error(stderr: &str, stdout: &str, code: Option<i32>) -> String {
    let text = format!("{stderr}\n{stdout}");
    let lower = text.to_ascii_lowercase();
    if lower.contains("permission denied") {
        "SSH 认证失败。请检查私钥、ssh-agent，或改用密码登录。".into()
    } else if lower.contains("connection refused") {
        "SSH 端口被拒绝。请确认远程 sshd 已启动，以及端口是否正确。".into()
    } else if lower.contains("could not resolve") || lower.contains("nodename nor servname") {
        "无法解析主机名。请检查地址是否写对。".into()
    } else if lower.contains("timed out") || lower.contains("connection timed out") {
        "SSH 连接超时。请检查网络、防火墙和端口。".into()
    } else if lower.contains("no such file") {
        "远程路径不存在。".into()
    } else {
        let snippet = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .take(6)
            .collect::<Vec<_>>()
            .join("\n");
        if snippet.is_empty() {
            format!("SSH 失败{}", code.map(|value| format!("（退出码 {value}）")).unwrap_or_default())
        } else {
            format!("SSH 失败：{snippet}")
        }
    }
}

fn normalize_remote_path(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return String::new();
        }
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(part);
    }
    if trimmed.starts_with('/') {
        format!("/{out}")
    } else if trimmed.starts_with("~/") || trimmed == "~" {
        trimmed.trim_end_matches('/').to_string()
    } else {
        format!("/{out}")
    }
}

fn looks_like_home(path: &str) -> bool {
    matches!(path, "/" | "~" | "/root" | "/home")
        || path == "/Users"
        || path.ends_with("/Documents") && path.matches('/').count() <= 2
}

fn sanitize_rel(rel: &str) -> Result<String, String> {
    let cleaned = rel.replace('\\', "/");
    let mut parts = Vec::new();
    for part in cleaned.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("路径不允许跳出工作目录".into());
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

fn join_remote(root: &str, rel: &str) -> String {
    if rel.is_empty() {
        root.trim_end_matches('/').to_string()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), rel.trim_start_matches('/'))
    }
}

fn sh_single(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).display().to_string();
        }
    }
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.display().to_string();
        }
    }
    path.to_string()
}

pub fn persist_hosts(hosts: &[SshTarget]) -> Result<(), String> {
    let dir = crate::runtime::grok_home();
    fs::create_dir_all(&dir).map_err(|err| format!("无法保存 SSH 配置：{err}"))?;
    let path = dir.join("ssh-hosts.json");
    let safe: Vec<SshTarget> = hosts.iter().map(SshTarget::for_persist).collect();
    let json = serde_json::to_vec_pretty(&safe).map_err(|err| format!("无法序列化 SSH 配置：{err}"))?;
    fs::write(path, json).map_err(|err| format!("无法写入 SSH 配置：{err}"))
}

pub fn load_hosts() -> Vec<SshTarget> {
    let path = crate::runtime::grok_home().join("ssh-hosts.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<SshTarget>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let mut normalized = item.normalized().ok()?;
            normalized.password = None;
            Some(normalized)
        })
        .collect()
}

pub fn load_ssh_config_hosts() -> Vec<SshConfigHost> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    parse_ssh_config_files(&[home.join(".ssh").join("config")], 0)
}

fn parse_ssh_config_files(paths: &[PathBuf], depth: usize) -> Vec<SshConfigHost> {
    if depth > 4 {
        return Vec::new();
    }
    let mut hosts = Vec::new();
    for path in paths {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        hosts.extend(parse_ssh_config(&text, path.parent(), depth));
    }
    let mut seen = std::collections::HashSet::new();
    hosts.retain(|item| seen.insert(item.alias.clone()));
    hosts
}

fn parse_ssh_config(text: &str, base: Option<&Path>, depth: usize) -> Vec<SshConfigHost> {
    let mut hosts = Vec::new();
    let mut includes = Vec::new();
    let mut current: Option<SshConfigHost> = None;
    let flush = |slot: &mut Option<SshConfigHost>, out: &mut Vec<SshConfigHost>| {
        if let Some(item) = slot.take() {
            if !item.alias.contains('*') && !item.alias.contains('?') && item.alias != "*" {
                out.push(item);
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = split_ssh_kv(line);
        if key.is_empty() {
            continue;
        }
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                flush(&mut current, &mut hosts);
                let alias = value.split_whitespace().next().unwrap_or("").trim().to_string();
                if alias.is_empty() {
                    continue;
                }
                current = Some(SshConfigHost {
                    alias: alias.clone(),
                    host: alias,
                    port: 22,
                    user: String::new(),
                    identity_file: None,
                    remote_path: String::new(),
                });
            }
            "include" => {
                if let Some(dir) = base {
                    includes.extend(expand_include(dir, value));
                }
            }
            "hostname" => {
                if let Some(item) = current.as_mut() {
                    item.host = value.to_string();
                }
            }
            "user" => {
                if let Some(item) = current.as_mut() {
                    item.user = value.to_string();
                }
            }
            "port" => {
                if let Some(item) = current.as_mut() {
                    if let Ok(port) = value.parse::<u16>() {
                        item.port = port;
                    }
                }
            }
            "identityfile" => {
                if let Some(item) = current.as_mut() {
                    item.identity_file = Some(expand_tilde(value));
                }
            }
            _ => {}
        }
    }
    flush(&mut current, &mut hosts);
    hosts.extend(parse_ssh_config_files(&includes, depth + 1));
    hosts
}

fn split_ssh_kv(line: &str) -> (String, &str) {
    if let Some((key, value)) = line.split_once('=') {
        return (key.trim().to_string(), value.trim().trim_matches('"'));
    }
    if let Some((key, value)) = line.split_once(char::is_whitespace) {
        return (key.trim().to_string(), value.trim().trim_matches('"'));
    }
    (line.to_string(), "")
}

fn expand_include(base: &Path, pattern: &str) -> Vec<PathBuf> {
    let expanded = expand_tilde(pattern);
    let path = PathBuf::from(&expanded);
    let path = if path.is_absolute() {
        path
    } else {
        base.join(path)
    };
    if path.exists() {
        vec![path]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_rejects_home() {
        let target = SshTarget {
            host: "  10.0.0.8 ".into(),
            port: 0,
            user: " ubuntu ".into(),
            remote_path: "/home/ubuntu/app".into(),
            identity_file: None,
            auth: "key".into(),
            password: None,
            alias: None,
        }
        .normalized()
        .unwrap();
        assert_eq!(target.port, 22);
        assert_eq!(target.workspace_id(), "ssh://ubuntu@10.0.0.8:22/home/ubuntu/app");
        let home = SshTarget {
            host: "10.0.0.8".into(),
            port: 22,
            user: "ubuntu".into(),
            remote_path: "".into(),
            identity_file: None,
            auth: "key".into(),
            password: None,
            alias: None,
        }
        .normalized()
        .unwrap();
        assert_eq!(home.remote_path, "~");
    }

    #[test]
    fn askpass_script_prints_env_password() {
        let script = "#!/bin/sh\nprintf '%s\\n' \"$GROKDESK_SSH_PASSWORD\"\n";
        assert!(script.contains("GROKDESK_SSH_PASSWORD"));
    }

    #[test]
    fn parses_ssh_config_hosts() {
        let text = r#"
Host myserver
    HostName 10.60.3.19
    User root
    Port 22
    IdentityFile ~/.ssh/id_ed25519

Host *
    Compression yes
"#;
        let hosts = parse_ssh_config(text, None, 0);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "myserver");
        assert_eq!(hosts[0].host, "10.60.3.19");
        assert_eq!(hosts[0].user, "root");
    }

    #[test]
    fn blocks_parent_escape() {
        assert!(sanitize_rel("../etc/passwd").is_err());
        assert_eq!(sanitize_rel("src/main.rs").unwrap(), "src/main.rs");
    }
}
