use crate::config::{is_relay_configured, read_relay_profile, render_config, RelayImport};
use crate::runtime::grok_home;
use crate::text_decode::decode_text_bytes;
use crate::workspace::{
    image_mime_for_name, language_for_name, WorkspaceEntry, WorkspaceFile, WorkspaceImage, MAX_FILE_BYTES,
    MAX_IMAGE_PREVIEW_BYTES, SKIP_DIRS,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const SSH_TIMEOUT_SECS: u64 = 20;
const SSH_LONG_TIMEOUT_SECS: u64 = 90;
const SSH_INSTALL_TIMEOUT_SECS: u64 = 600;

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
    /// True when this connect call installed grok on the remote host.
    #[serde(default)]
    pub grok_setup: bool,
    /// True when local relay config was synced to the remote host.
    #[serde(default)]
    pub config_synced: bool,
}

pub fn probe(target: &SshTarget) -> Result<SshProbe, String> {
    // Always probe "/" first so the folder browser can start at the filesystem root.
    // Fall back to "~" only if root listing is unavailable (rare permission cases).
    let preferred = if target.remote_path.trim().is_empty()
        || looks_like_home(&target.remote_path)
        || target.remote_path.trim() == "/"
    {
        "/"
    } else {
        target.remote_path.as_str()
    };
    let browse = preferred;
    let script = probe_script(browse);
    let output = run_ssh(target, &script, SSH_LONG_TIMEOUT_SECS, None)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut probe = parse_probe(&stdout, browse)?;
    // Auto-setup: install remote grok when missing, then sync local relay config.
    if !probe.grok_installed {
        match ensure_remote_grok(target, &probe.os) {
            Ok(path) => {
                probe.grok_installed = true;
                probe.grok_path = Some(path);
                probe.grok_setup = true;
            }
            Err(err) => {
                probe.message = format!("{}（自动安装失败：{err}）", probe.message);
            }
        }
    }
    if probe.grok_installed {
        match sync_remote_relay_config(target) {
            Ok(true) => {
                probe.config_synced = true;
            }
            Ok(false) => {}
            Err(err) => {
                probe.message = format!("{}（配置同步失败：{err}）", probe.message);
            }
        }
    }
    if probe.grok_installed {
        let mut parts = vec![format!("已连接到 {}，远程 Grok Build 可用", os_label(&probe.os))];
        if probe.grok_setup {
            parts.push("已自动安装".into());
        }
        if probe.config_synced {
            parts.push("已同步中转站配置".into());
        }
        probe.message = parts.join("，");
    }
    // Prefer listing "/" after connect so the UI shows top-level dirs (bin, etc, home, root…).
    let list_path = if preferred == "/" {
        "/".to_string()
    } else {
        probe.remote_path.clone()
    };
    probe.remote_path = list_path.clone();
    let mut listing = target.clone();
    listing.remote_path = list_path;
    match list_remote_workspace(&listing, None) {
        Ok(entries) => probe.entries = entries,
        Err(err) => {
            if preferred == "/" {
                // Root listing failed — fall back to home.
                listing.remote_path = "~".into();
                match list_remote_workspace(&listing, None) {
                    Ok(entries) => {
                        probe.remote_path = probe.home.clone();
                        if probe.remote_path.is_empty() {
                            probe.remote_path = "~".into();
                        }
                        probe.entries = entries;
                    }
                    Err(home_err) => {
                        probe.message = format!("{}（{err}；回退家目录也失败：{home_err}）", probe.message);
                    }
                }
            } else if probe.message.is_empty() {
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
    // Use python3 (same as probe) so remote zsh never parses shell globs like "~/)*".
    let script = format!(
        r#"python3 -c "import os,sys
raw=sys.argv[1]
root=os.path.expanduser(raw)
if not os.path.exists(root):
    print('ERR:not_found'); raise SystemExit(2)
if not os.path.isdir(root):
    print('ERR:not_dir'); raise SystemExit(2)
if not os.access(root, os.R_OK):
    print('ERR:denied'); raise SystemExit(2)
sys.stdout.buffer.write(b'OK\n')
for name in os.listdir(root):
    path=os.path.join(root, name)
    line=('D' if os.path.isdir(path) else 'F') + '\t' + name + '\n'
    sys.stdout.buffer.write(line.encode('utf-8', 'surrogateescape'))
" {path}"#,
        path = sh_single(&remote),
    );
    let output = run_ssh(target, &script, SSH_TIMEOUT_SECS, None)?;
    let stdout = decode_text_bytes(&output.stdout);
    let stderr = decode_text_bytes(&output.stderr);
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
        let name = decode_text_bytes(name.trim().as_bytes());
        if name.is_empty() {
            continue;
        }
        let is_dir = kind == "D" || kind == "d";
        if name.starts_with('.') || (is_dir && skip.contains(name.as_str())) {
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
    // Avoid nested shell case patterns with "*" — remote login shells are often zsh.
    let script = format!(
        r#"python3 -c "import os,sys
path=os.path.expanduser(sys.argv[1])
limit=int(sys.argv[2])
if os.path.isdir(path):
    sys.stdout.write('ERR:dir\n'); raise SystemExit(2)
if not os.path.exists(path):
    sys.stdout.write('ERR:not_found\n'); raise SystemExit(2)
if not os.access(path, os.R_OK):
    sys.stdout.write('ERR:denied\n'); raise SystemExit(2)
size=os.path.getsize(path)
sys.stdout.buffer.write(('OK %d\n' % size).encode())
with open(path, 'rb') as handle:
    sys.stdout.buffer.write(handle.read(limit))
" {path} {limit}"#,
        path = sh_single(&remote),
        limit = MAX_FILE_BYTES,
    );
    let output = run_ssh(target, &script, SSH_TIMEOUT_SECS, None)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("ERR:dir") {
            return Err("这是文件夹".into());
        }
        if stdout.contains("ERR:not_found") {
            return Err("远程文件不存在".into());
        }
        if stdout.contains("ERR:denied") {
            return Err("没有权限读取该文件".into());
        }
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
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
    let mut content = decode_text_bytes(body);
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

pub fn read_remote_image(target: &SshTarget, rel: &str) -> Result<WorkspaceImage, String> {
    let rel = sanitize_rel(rel)?;
    if rel.is_empty() {
        return Err("还没有选择文件".into());
    }
    let mime = image_mime_for_name(&rel).ok_or_else(|| "不是图片文件".to_string())?;
    let remote = join_remote(&target.remote_path, &rel);
    let script = format!(
        r#"python3 -c "import os,sys
path=os.path.expanduser(sys.argv[1])
limit=int(sys.argv[2])
if os.path.isdir(path):
    sys.stdout.write('ERR:dir\n'); raise SystemExit(2)
if not os.path.exists(path):
    sys.stdout.write('ERR:not_found\n'); raise SystemExit(2)
if not os.access(path, os.R_OK):
    sys.stdout.write('ERR:denied\n'); raise SystemExit(2)
size=os.path.getsize(path)
if size > limit:
    sys.stdout.write('ERR:too_large %d\n' % size); raise SystemExit(2)
sys.stdout.buffer.write(('OK %d\n' % size).encode())
with open(path, 'rb') as handle:
    sys.stdout.buffer.write(handle.read(limit))
" {path} {limit}"#,
        path = sh_single(&remote),
        limit = MAX_IMAGE_PREVIEW_BYTES,
    );
    let output = run_ssh(target, &script, SSH_TIMEOUT_SECS, None)?;
    let stdout = output.stdout;
    let split = stdout.iter().position(|byte| *byte == b'\n').unwrap_or(stdout.len());
    let header = String::from_utf8_lossy(&stdout[..split]).trim().to_string();
    if header.starts_with("ERR:dir") {
        return Err("这是文件夹".into());
    }
    if header.starts_with("ERR:not_found") {
        return Err("远程文件不存在".into());
    }
    if header.starts_with("ERR:denied") {
        return Err("没有权限读取该文件".into());
    }
    if header.starts_with("ERR:too_large") {
        return Err("图片太大，无法预览".into());
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ssh_error(&stderr, &header, output.status.code()));
    }
    if !header.starts_with("OK ") {
        return Err(format!("无法读取远程图片：{header}"));
    }
    let size = header
        .strip_prefix("OK ")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let body = if split < stdout.len() { &stdout[split + 1..] } else { &[] };
    Ok(WorkspaceImage {
        path: rel.replace('\\', "/"),
        mime_type: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(body),
        size,
    })
}

pub fn write_remote_file(target: &SshTarget, rel: &str, content: &str) -> Result<(), String> {
    let rel = sanitize_rel(rel)?;
    if rel.is_empty() {
        return Err("还没有选择文件".into());
    }
    if content.len() as u64 > MAX_FILE_BYTES * 8 {
        return Err("文件太大，无法写入".into());
    }
    let remote = join_remote(&target.remote_path, &rel);
    let script = format!(
        r#"python3 -c "import os,sys
path=os.path.expanduser(sys.argv[1])
parent=os.path.dirname(path)
if parent:
    os.makedirs(parent, exist_ok=True)
data=sys.stdin.buffer.read()
with open(path,'wb') as handle:
    handle.write(data)
" {path}"#,
        path = sh_single(&remote),
    );
    let output = run_ssh(target, &script, SSH_TIMEOUT_SECS, Some(content.as_bytes()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    Ok(())
}

pub fn search_remote_workspace(target: &SshTarget, query: &str, limit: usize) -> Result<Vec<WorkspaceEntry>, String> {
    let limit = limit.max(1).min(400);
    let script = format!(
        r#"python3 -c "import os,sys
root=os.path.expanduser(sys.argv[1])
needle=sys.argv[2].lower()
limit=int(sys.argv[3])
skip={skip}
out=0
def emit(kind, rel):
    global out
    print(kind + '\t' + rel.replace('\\\\','/'))
    out += 1
    return out >= limit
if os.path.isdir(root):
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip and not d.startswith('.')]
        rel=os.path.relpath(dirpath, root)
        rel='' if rel=='.' else rel.replace('\\\\','/')
        for name in files:
            if name.startswith('.'):
                continue
            path=name if not rel else rel+'/'+name
            if (not needle) or needle in path.lower() or needle in name.lower():
                if emit('F', path):
                    raise SystemExit(0)
        for name in dirs:
            path=name if not rel else rel+'/'+name
            if (not needle) or needle in path.lower() or needle in name.lower():
                if emit('D', path):
                    raise SystemExit(0)
" {root} {query} {limit}"#,
        skip = r"{'.git','node_modules','target','dist','build','.next','__pycache__','.venv','venv','vendor','.grok','grokdesk-relay'}",
        root = sh_single(&target.remote_path),
        query = sh_single(query.trim()),
        limit = limit,
    );
    let output = run_ssh(target, &script, SSH_LONG_TIMEOUT_SECS, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && !stdout.contains('\t') {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let Some((kind, path)) = line.split_once('\t') else { continue };
        let path = path.trim().replace('\\', "/");
        if path.is_empty() { continue; }
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        entries.push(WorkspaceEntry {
            name,
            path,
            is_dir: kind == "D" || kind == "d",
        });
    }
    Ok(entries)
}

pub fn grep_remote_workspace(target: &SshTarget, query: &str, limit: usize) -> Result<Vec<crate::workspace::GrepHit>, String> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.max(1).min(80);
    let script = format!(
        r#"python3 -c "import os,sys
root=os.path.expanduser(sys.argv[1])
needle=sys.argv[2].lower()
limit=int(sys.argv[3])
skip={skip}
count=0
if os.path.isdir(root) and needle:
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip and not d.startswith('.')]
        rel=os.path.relpath(dirpath, root)
        rel='' if rel=='.' else rel.replace('\\\\','/')
        for name in files:
            if name.startswith('.'):
                continue
            path=os.path.join(dirpath, name)
            try:
                if os.path.getsize(path)>400000:
                    continue
                with open(path,'rb') as handle:
                    data=handle.read()
                if b'\0' in data:
                    continue
                text=data.decode('utf-8','replace')
            except Exception:
                continue
            relpath=name if not rel else rel+'/'+name
            for i,line in enumerate(text.splitlines(),1):
                if needle in line.lower():
                    print(relpath + '\t' + str(i) + '\t' + line[:160].replace('\t',' '))
                    count += 1
                    if count>=limit:
                        raise SystemExit(0)
" {root} {query} {limit}"#,
        skip = r"{'.git','node_modules','target','dist','build','.next','__pycache__','.venv','venv','vendor','.grok','grokdesk-relay'}",
        root = sh_single(&target.remote_path),
        query = sh_single(needle),
        limit = limit,
    );
    let output = run_ssh(target, &script, SSH_LONG_TIMEOUT_SECS, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && !stdout.contains('\t') {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    let mut hits = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(3, '\t');
        let Some(path) = parts.next() else { continue };
        let Some(line_no) = parts.next() else { continue };
        let text = parts.next().unwrap_or("").trim();
        let path = path.trim().replace('\\', "/");
        if path.is_empty() { continue; }
        hits.push(crate::workspace::GrepHit {
            path,
            line: line_no.parse().unwrap_or(0),
            text: text.to_string(),
        });
    }
    Ok(hits)
}

pub fn remote_git_status(target: &SshTarget) -> Result<crate::git::GitStatus, String> {
    let script = format!(
        "cd {path} && git status --porcelain=v1 -b",
        path = sh_single(&target.remote_path),
    );
    let output = run_ssh(target, &script, SSH_TIMEOUT_SECS, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") || stdout.contains("not a git repository") {
            return Ok(crate::git::GitStatus {
                available: false,
                branch: String::new(),
                ahead: 0,
                behind: 0,
                dirty: false,
                files: Vec::new(),
                remotes: Vec::new(),
                message: "不是 Git 仓库".into(),
            });
        }
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    let mut status = crate::git::parse_porcelain(&stdout);
    status.remotes = remote_git_remotes(target).unwrap_or_default();
    Ok(status)
}

fn remote_git_script(target: &SshTarget, command: &str, timeout: u64) -> Result<String, String> {
    let script = format!(
        "cd {path} && {command}",
        path = sh_single(&target.remote_path),
        command = command,
    );
    let output = run_ssh(target, &script, timeout, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") || stdout.contains("not a git repository") {
            return Err("不是 Git 仓库".into());
        }
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    Ok(stdout)
}

fn quote_git_paths(paths: &[String]) -> String {
    paths
        .iter()
        .map(|path| sh_single(path))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn remote_git_remotes(target: &SshTarget) -> Result<Vec<crate::git::GitRemote>, String> {
    let stdout = remote_git_script(target, "git remote -v", SSH_TIMEOUT_SECS)?;
    Ok(crate::git::parse_remotes(&stdout))
}

pub fn remote_git_init(target: &SshTarget) -> Result<String, String> {
    remote_git_script(target, "git init", SSH_TIMEOUT_SECS)
}

pub fn remote_git_set_remote(target: &SshTarget, name: &str, url: &str) -> Result<String, String> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() {
        return Err("请填写远程名称".into());
    }
    if url.is_empty() {
        return Err("请填写远程仓库地址".into());
    }
    let remotes = remote_git_remotes(target).unwrap_or_default();
    let command = if remotes.iter().any(|item| item.name == name) {
        format!("git remote set-url {name} {url}", name = sh_single(name), url = sh_single(url))
    } else {
        format!("git remote add {name} {url}", name = sh_single(name), url = sh_single(url))
    };
    remote_git_script(target, &command, SSH_TIMEOUT_SECS)
}

pub fn remote_git_stage(target: &SshTarget, paths: &[String]) -> Result<String, String> {
    let command = if paths.is_empty() {
        "git add -A".to_string()
    } else {
        format!("git add -- {}", quote_git_paths(paths))
    };
    remote_git_script(target, &command, SSH_LONG_TIMEOUT_SECS)
}

pub fn remote_git_unstage(target: &SshTarget, paths: &[String]) -> Result<String, String> {
    let command = if paths.is_empty() {
        "git restore --staged . || git reset HEAD".to_string()
    } else {
        let quoted = quote_git_paths(paths);
        format!("git restore --staged -- {quoted} || git reset HEAD -- {quoted}")
    };
    remote_git_script(target, &command, SSH_LONG_TIMEOUT_SECS)
}

pub fn remote_git_commit(target: &SshTarget, message: &str, all: Option<bool>) -> Result<String, String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err("请填写提交说明".into());
    }
    let stage_all = all.unwrap_or(true);
    let command = if stage_all {
        format!("git add -A && git commit -m {msg}", msg = sh_single(msg))
    } else {
        format!("git commit -m {msg}", msg = sh_single(msg))
    };
    remote_git_script(target, &command, SSH_LONG_TIMEOUT_SECS)
}

pub fn remote_git_push(target: &SshTarget) -> Result<String, String> {
    let remotes = remote_git_remotes(target)?;
    if remotes.is_empty() {
        return Err("还没有绑定远程仓库".into());
    }
    remote_git_script(
        target,
        &format!("git push -u {} HEAD", sh_single(&remotes[0].name)),
        SSH_LONG_TIMEOUT_SECS,
    )
}

pub fn remote_git_pull(target: &SshTarget) -> Result<String, String> {
    remote_git_script(target, "git pull --ff-only || git pull", SSH_LONG_TIMEOUT_SECS)
}

pub fn remote_git_fetch(target: &SshTarget) -> Result<String, String> {
    remote_git_script(target, "git fetch --all --prune", SSH_LONG_TIMEOUT_SECS)
}

pub fn remote_git_discard(target: &SshTarget, paths: &[String]) -> Result<String, String> {
    let command = if paths.is_empty() {
        "git restore --worktree --source=HEAD . 2>/dev/null; git checkout -- . 2>/dev/null; git clean -fd".to_string()
    } else {
        let quoted = quote_git_paths(paths);
        format!(
            "git restore --worktree --source=HEAD -- {quoted} 2>/dev/null; git checkout -- {quoted} 2>/dev/null; git clean -f -- {quoted}"
        )
    };
    remote_git_script(target, &command, SSH_LONG_TIMEOUT_SECS)
}

pub fn remote_git_log(target: &SshTarget, limit: u32) -> Result<Vec<crate::git::GitCommit>, String> {
    let cap = limit.clamp(8, 80);
    let stdout = remote_git_script(
        target,
        &format!("git log -n {cap} --pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ar%x1f%D"),
        SSH_TIMEOUT_SECS,
    )?;
    Ok(crate::git::parse_log(&stdout))
}

pub fn remote_git_file_diff(target: &SshTarget, path: &str, staged: bool) -> Result<crate::git::GitFileDiff, String> {
    let rel = path.replace('\\', "/").trim_start_matches('/').to_string();
    if rel.is_empty() {
        return Err("还没有选择文件".into());
    }
    let head_spec = sh_single(&format!("HEAD:{rel}"));
    let index_spec = sh_single(&format!(":{rel}"));
    let old_text = remote_git_script(
        target,
        &format!("git show {head_spec} 2>/dev/null || true"),
        SSH_TIMEOUT_SECS,
    )
    .unwrap_or_default();
    let new_text = if staged {
        remote_git_script(
            target,
            &format!("git show {index_spec} 2>/dev/null || true"),
            SSH_TIMEOUT_SECS,
        )
        .unwrap_or_default()
    } else {
        match read_remote_file(target, &rel) {
            Ok(file) => file.content,
            Err(_) => String::new(),
        }
    };
    Ok(crate::git::GitFileDiff {
        path: rel,
        old_text,
        new_text,
    })
}

pub fn remote_git_review(target: &SshTarget) -> Result<crate::git::GitReview, String> {
    let base = remote_git_script(
        target,
        "for n in origin/main main origin/master master; do git rev-parse --verify $n >/dev/null 2>&1 && echo $n && exit 0; done; echo HEAD",
        SSH_TIMEOUT_SECS,
    )?
    .trim()
    .to_string();
    let base = if base.is_empty() { "HEAD".into() } else { base };
    let quoted = sh_single(&base);
    let names = remote_git_script(
        target,
        &format!("git diff --name-only {quoted}...HEAD; git diff --name-only {quoted}"),
        SSH_LONG_TIMEOUT_SECS,
    )
    .unwrap_or_default();
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in names.lines() {
        let path = line.trim().replace('\\', "/");
        if path.is_empty() || !seen.insert(path.clone()) {
            continue;
        }
        files.push(path);
    }
    let diff = remote_git_script(target, &format!("git diff {quoted}"), SSH_LONG_TIMEOUT_SECS).unwrap_or_default();
    Ok(crate::git::GitReview { base, files, diff })
}

pub fn remote_capture_snapshot(target: &SshTarget) -> Result<Vec<crate::git::SnapshotFile>, String> {
    let status = remote_git_status(target)?;
    if !status.available {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for file in status.files {
        match read_remote_file(target, &file.path) {
            Ok(item) => out.push(crate::git::SnapshotFile {
                path: file.path,
                content: Some(item.content),
            }),
            Err(_) if file.status.contains('D') => out.push(crate::git::SnapshotFile {
                path: file.path,
                content: None,
            }),
            Err(_) => {}
        }
    }
    Ok(out)
}

pub fn remote_restore_snapshot(target: &SshTarget, files: &[crate::git::SnapshotFile]) -> Result<(), String> {
    for file in files {
        match &file.content {
            Some(content) => write_remote_file(target, &file.path, content)?,
            None => {
                let remote = join_remote(&target.remote_path, &file.path);
                let script = format!("rm -f {path}", path = sh_single(&remote));
                let _ = run_ssh(target, &script, SSH_TIMEOUT_SECS, None);
            }
        }
    }
    Ok(())
}

pub fn remote_read_rules(target: &SshTarget) -> Result<Option<crate::workspace::ProjectRules>, String> {
    for rel in ["AGENTS.md", "GROK.md", ".cursorrules", ".grok/rules.md"] {
        if let Ok(file) = read_remote_file(target, rel) {
            return Ok(Some(crate::workspace::ProjectRules {
                path: rel.into(),
                content: file.content,
            }));
        }
    }
    Ok(None)
}

pub fn remote_write_rules(target: &SshTarget, content: &str) -> Result<crate::workspace::ProjectRules, String> {
    let rel = match remote_read_rules(target)? {
        Some(existing) => existing.path,
        None => "AGENTS.md".into(),
    };
    write_remote_file(target, &rel, content)?;
    Ok(crate::workspace::ProjectRules {
        path: rel,
        content: content.to_string(),
    })
}

pub fn pty_ssh_command(
    target: &SshTarget,
    argv: Option<&[String]>,
) -> Result<portable_pty::CommandBuilder, String> {
    let mut cmd = portable_pty::CommandBuilder::new(ssh_binary()?);
    cmd.arg("-p");
    cmd.arg(target.port.to_string());
    cmd.arg("-tt");
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o");
    cmd.arg("ConnectTimeout=12");
    cmd.arg("-o");
    cmd.arg("ServerAliveInterval=15");
    let password = target
        .password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let use_password = target.auth == "password" || password.is_some();
    if use_password {
        let askpass = write_askpass()?;
        cmd.env("SSH_ASKPASS", askpass.to_string_lossy().as_ref());
        cmd.env("SSH_ASKPASS_REQUIRE", "force");
        cmd.env("GROKDESK_SSH_PASSWORD", password.unwrap_or_default());
        if std::env::var_os("DISPLAY").is_none() {
            cmd.env("DISPLAY", ":0");
        }
        cmd.arg("-o");
        cmd.arg("PreferredAuthentications=password,keyboard-interactive");
        cmd.arg("-o");
        cmd.arg("PubkeyAuthentication=no");
    } else {
        cmd.arg("-o");
        cmd.arg("BatchMode=yes");
        if let Some(identity) = &target.identity_file {
            cmd.arg("-i");
            cmd.arg(identity);
            cmd.arg("-o");
            cmd.arg("IdentitiesOnly=yes");
        }
    }
    cmd.arg(target.destination());
    let remote = if let Some(args) = argv.filter(|items| !items.is_empty()) {
        let command = args.iter().map(|item| sh_single(item)).collect::<Vec<_>>().join(" ");
        format!(
            "cd {path} >/dev/null 2>&1 || cd ~; exec {command}",
            path = sh_single(&target.remote_path),
            command = command,
        )
    } else {
        format!(
            "cd {path} >/dev/null 2>&1 || cd ~; exec ${{SHELL:-/bin/sh}} -l",
            path = sh_single(&target.remote_path),
        )
    };
    cmd.arg(remote);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    Ok(cmd)
}

pub fn spawn_remote_agent(
    target: &SshTarget,
    model: &str,
    grok_home: Option<&str>,
    extra_env: &[(&str, String)],
) -> Result<std::process::Child, String> {
    // Always expand on the remote shell. Quoting "$HOME/.grok" with sh_single would
    // set GROK_HOME to the literal characters $HOME/.grok and break config lookup.
    let remote_home = grok_home
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains("$HOME") && *value != "~/.grok")
        .map(|value| sh_single(value))
        .unwrap_or_else(|| "\"$HOME/.grok\"".to_string());
    let mut env_prefix = String::from("export PATH=\"$HOME/.grok/bin:$HOME/.local/bin:/usr/local/bin:$PATH\"; ");
    env_prefix.push_str(&format!("export GROK_HOME={remote_home}; "));
    for (key, value) in extra_env {
        env_prefix.push_str(&format!("export {key}={}; ", sh_single(value)));
    }
    // Don't block session start on Mac-only MCP binaries that may linger in synced configs.
    env_prefix.push_str("export GROK_MCP_STARTUP_TIMEOUT_SECS=1; ");
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
        grok_setup: false,
        config_synced: false,
    })
}

fn ensure_remote_grok(target: &SshTarget, os: &str) -> Result<String, String> {
    if os.contains("windows") {
        return Err("Windows 远程主机请先手动安装：irm https://x.ai/cli/install.ps1 | iex".into());
    }
    let script = r#"set -e
export PATH="$HOME/.grok/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
if command -v grok >/dev/null 2>&1; then
  command -v grok
  exit 0
fi
if [ -x "$HOME/.grok/bin/grok" ]; then
  printf '%s\n' "$HOME/.grok/bin/grok"
  exit 0
fi
mkdir -p "$HOME/.grok/downloads" "$HOME/.grok/bin"
ARCH=$(uname -m 2>/dev/null || echo x86_64)
case "$ARCH" in
  x86_64|amd64) PLATFORM=linux-x86_64 ;;
  aarch64|arm64) PLATFORM=linux-aarch64 ;;
  *) echo "GROKDESK_INSTALL: unsupported arch $ARCH" >&2; exit 3 ;;
esac
VERSION=""
if VERSION=$(curl -fsSL --connect-timeout 20 https://storage.googleapis.com/grok-build-public-artifacts/cli/stable 2>/dev/null); then
  :
elif VERSION=$(curl -fsSL --connect-timeout 20 https://x.ai/cli/stable 2>/dev/null); then
  :
else
  echo "GROKDESK_INSTALL: cannot fetch stable version" >&2
  exit 4
fi
VERSION=$(printf '%s' "$VERSION" | tr -d '\r\n')
OUT="$HOME/.grok/downloads/grok-$PLATFORM"
URL_GCS="https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${VERSION}-${PLATFORM}"
URL_XAI="https://x.ai/cli/grok-${VERSION}-${PLATFORM}"
if ! curl -fsSL --connect-timeout 30 --retry 2 -o "$OUT" "$URL_GCS"; then
  curl -fsSL --connect-timeout 30 --retry 2 -o "$OUT" "$URL_XAI"
fi
chmod +x "$OUT"
ln -sfn "../downloads/grok-$PLATFORM" "$HOME/.grok/bin/grok"
if [ -w /usr/local/bin ] 2>/dev/null; then
  ln -sfn "$HOME/.grok/bin/grok" /usr/local/bin/grok 2>/dev/null || true
fi
"$HOME/.grok/bin/grok" --version >/dev/null
printf '%s\n' "$HOME/.grok/bin/grok"
"#;
    let output = run_ssh(target, script, SSH_INSTALL_TIMEOUT_SECS, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    let path = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()
        .unwrap_or("")
        .to_string();
    if path.is_empty() {
        return Err("安装完成，但没有找到 grok 路径".into());
    }
    Ok(path)
}

fn sync_remote_relay_config(target: &SshTarget) -> Result<bool, String> {
    let home = grok_home();
    if !is_relay_configured(&home) {
        return Ok(false);
    }
    let profile = read_relay_profile(&home).ok_or_else(|| "本机没有可用的中转站配置".to_string())?;
    let rendered = render_config(&RelayImport {
        endpoint: profile.endpoint,
        api_key: profile.api_key,
        model: profile.model,
        name: profile.name,
    });
    // Strip any accidental mcp_servers blocks (Mac-only paths must not go remote).
    let rendered = strip_mcp_servers(&rendered);
    let encoded = base64::engine::general_purpose::STANDARD.encode(rendered.as_bytes());
    let script = format!(
        r#"python3 -c "import base64,os,sys
raw=sys.argv[1]
home=os.path.expanduser('~')
path=os.path.join(home,'.grok','config.toml')
os.makedirs(os.path.dirname(path), exist_ok=True)
data=base64.b64decode(raw)
if os.path.exists(path):
    bak=path+'.bak-grokdesk-ssh'
    try:
        if not os.path.exists(bak):
            open(bak,'wb').write(open(path,'rb').read())
    except Exception:
        pass
open(path,'wb').write(data)
os.chmod(path, 0o600)
print('OK', path)
" {payload}"#,
        payload = sh_single(&encoded),
    );
    let output = run_ssh(target, &script, SSH_LONG_TIMEOUT_SECS, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() || !stdout.contains("OK") {
        return Err(ssh_error(&stderr, &stdout, output.status.code()));
    }
    Ok(true)
}

fn strip_mcp_servers(text: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[mcp_servers") {
            skip = true;
            continue;
        }
        if skip {
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                skip = false;
            } else {
                continue;
            }
        }
        if !skip {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
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
    crate::runtime::hide_console(command);
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
    command.arg("-o").arg("RequestTTY=no");
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
    let mut command = Command::new(if cfg!(windows) { "where.exe" } else { "which" });
    crate::runtime::hide_console(&mut command);
    if let Ok(output) = command.arg(name).output()
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
    if trimmed == "/" {
        return "/".into();
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
    let root = root.trim();
    if rel.is_empty() {
        // Keep "/" as the filesystem root; trim_end_matches('/') would turn it into "".
        if root == "/" {
            return "/".into();
        }
        return root.trim_end_matches('/').to_string();
    }
    if root == "/" {
        return format!("/{}", rel.trim_start_matches('/'));
    }
    format!("{}/{}", root.trim_end_matches('/'), rel.trim_start_matches('/'))
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

    #[test]
    fn join_remote_keeps_filesystem_root() {
        assert_eq!(join_remote("/", ""), "/");
        assert_eq!(join_remote("/", "etc"), "/etc");
        assert_eq!(join_remote("/root", ""), "/root");
        assert_eq!(normalize_remote_path("/"), "/");
    }
}
