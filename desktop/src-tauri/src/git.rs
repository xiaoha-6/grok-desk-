use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub status: String,
    #[serde(default)]
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub available: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub files: Vec<GitFile>,
    #[serde(default)]
    pub remotes: Vec<GitRemote>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub path: String,
    pub content: Option<String>,
}

pub fn status(root: &str) -> Result<GitStatus, String> {
    let root = PathBuf::from(root.trim());
    if !root.is_dir() {
        return Err("工作目录无效".into());
    }
    match git(&root, &["status", "--porcelain=v1", "-b"]) {
        Ok(out) => {
            let mut next = parse_porcelain(&out);
            next.remotes = list_remotes(&root).unwrap_or_default();
            Ok(next)
        }
        Err(err) => Ok(GitStatus {
            available: false,
            branch: String::new(),
            ahead: 0,
            behind: 0,
            dirty: false,
            files: Vec::new(),
            remotes: Vec::new(),
            message: err,
        }),
    }
}

pub fn init(root: &str) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    if !root.is_dir() {
        return Err("工作目录无效".into());
    }
    git(&root, &["init"])
}

pub fn set_remote(root: &str, name: &str, url: &str) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() {
        return Err("请填写远程名称".into());
    }
    if url.is_empty() {
        return Err("请填写远程仓库地址".into());
    }
    let remotes = list_remotes(&root).unwrap_or_default();
    if remotes.iter().any(|item| item.name == name) {
        git(&root, &["remote", "set-url", name, url])
    } else {
        git(&root, &["remote", "add", name, url])
    }
}

pub fn stage(root: &str, paths: &[String]) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    if paths.is_empty() {
        return git(&root, &["add", "-A"]);
    }
    let mut args = vec!["add".into(), "--".into()];
    args.extend(paths.iter().cloned());
    git_owned(&root, &args)
}

pub fn unstage(root: &str, paths: &[String]) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    if paths.is_empty() {
        return git(&root, &["restore", "--staged", "."]);
    }
    let mut args = vec!["restore".into(), "--staged".into(), "--".into()];
    args.extend(paths.iter().cloned());
    match git_owned(&root, &args) {
        Ok(out) => Ok(out),
        Err(_) => {
            let mut fallback = vec!["reset".into(), "HEAD".into(), "--".into()];
            fallback.extend(paths.iter().cloned());
            git_owned(&root, &fallback)
        }
    }
}

pub fn commit(root: &str, message: &str, all: Option<bool>) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    let msg = message.trim();
    if msg.is_empty() {
        return Err("请填写提交说明".into());
    }
    let stage_all = match all {
        Some(value) => value,
        None => {
            let current = status(root.to_string_lossy().as_ref())?;
            !current.files.iter().any(|file| file.staged)
        }
    };
    if stage_all {
        git(&root, &["add", "-A"])?;
    }
    git(&root, &["commit", "-m", msg])
}

pub fn push(root: &str) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    let remotes = list_remotes(&root)?;
    if remotes.is_empty() {
        return Err("还没有绑定远程仓库".into());
    }
    git(&root, &["push", "-u", &remotes[0].name, "HEAD"])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub rel_time: String,
    pub refs: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReview {
    pub base: String,
    pub files: Vec<String>,
    pub diff: String,
}

pub fn pull(root: &str) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    match git(&root, &["pull", "--ff-only"]) {
        Ok(out) => Ok(out),
        Err(_) => git(&root, &["pull"]),
    }
}

pub fn fetch(root: &str) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    git(&root, &["fetch", "--all", "--prune"])
}

pub fn discard(root: &str, paths: &[String]) -> Result<String, String> {
    let root = PathBuf::from(root.trim());
    let current = status(root.to_string_lossy().as_ref())?;
    let selected: Vec<String> = if paths.is_empty() {
        current
            .files
            .iter()
            .filter(|file| !file.staged)
            .map(|file| file.path.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect()
    } else {
        paths.to_vec()
    };
    if selected.is_empty() {
        return Ok(String::new());
    }
    let untracked: HashSet<String> = current
        .files
        .iter()
        .filter(|file| !file.staged && (file.status == "U" || file.status == "?"))
        .map(|file| file.path.clone())
        .collect();
    let mut last = String::new();
    for path in selected {
        if untracked.contains(&path) {
            last = match git(&root, &["clean", "-f", "--", &path]) {
                Ok(out) => out,
                Err(_) => {
                    let dest = safe_join(&root, &path)?;
                    if dest.is_file() {
                        std::fs::remove_file(&dest).map_err(|err| format!("无法丢弃 {}：{err}", path))?;
                    }
                    String::new()
                }
            };
        } else {
            last = match git(&root, &["restore", "--worktree", "--source=HEAD", "--", &path]) {
                Ok(out) => out,
                Err(_) => git(&root, &["checkout", "--", &path])?,
            };
        }
    }
    Ok(last)
}

pub fn log(root: &str, limit: u32) -> Result<Vec<GitCommit>, String> {
    let root = PathBuf::from(root.trim());
    let cap = limit.clamp(8, 80).to_string();
    let out = git(
        &root,
        &[
            "log",
            "-n",
            &cap,
            "--pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ar%x1f%D",
        ],
    )?;
    Ok(parse_log(&out))
}

pub fn file_diff(root: &str, path: &str, staged: bool) -> Result<GitFileDiff, String> {
    let root = PathBuf::from(root.trim());
    let rel = path.replace('\\', "/").trim_start_matches('/').to_string();
    if rel.is_empty() {
        return Err("还没有选择文件".into());
    }
    let spec = format!("HEAD:{rel}");
    let old_text = git(&root, &["show", &spec]).unwrap_or_default();
    let new_text = if staged {
        git(&root, &["show", &format!(":{rel}")]).unwrap_or_default()
    } else {
        let dest = safe_join(&root, &rel)?;
        std::fs::read_to_string(&dest).unwrap_or_default()
    };
    Ok(GitFileDiff {
        path: rel,
        old_text,
        new_text,
    })
}

pub fn review(root: &str) -> Result<GitReview, String> {
    let root = PathBuf::from(root.trim());
    let base = resolve_base(&root);
    let mut names: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let range = format!("{base}...HEAD");
    if let Ok(out) = git(&root, &["diff", "--name-only", &range]) {
        push_names(&mut names, &mut seen, &out);
    }
    if let Ok(out) = git(&root, &["diff", "--name-only", &base]) {
        push_names(&mut names, &mut seen, &out);
    }
    let diff = git(&root, &["diff", &base]).unwrap_or_default();
    Ok(GitReview {
        base,
        files: names,
        diff,
    })
}

pub fn parse_log(raw: &str) -> Vec<GitCommit> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 6 {
            continue;
        }
        out.push(GitCommit {
            hash: parts[0].to_string(),
            short: parts[1].to_string(),
            parents: parts[2]
                .split_whitespace()
                .filter(|item| !item.is_empty())
                .map(|item| item.to_string())
                .collect(),
            subject: parts[3].to_string(),
            author: parts[4].to_string(),
            rel_time: parts[5].to_string(),
            refs: parts.get(6).unwrap_or(&"").to_string(),
        });
    }
    out
}

fn resolve_base(root: &Path) -> String {
    for name in ["origin/main", "main", "origin/master", "master"] {
        if git(root, &["rev-parse", "--verify", name]).is_ok() {
            return name.to_string();
        }
    }
    "HEAD".into()
}

fn push_names(out: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    for line in raw.lines() {
        let path = line.trim().replace('\\', "/");
        if path.is_empty() || !seen.insert(path.clone()) {
            continue;
        }
        out.push(path);
    }
}

pub fn capture_snapshot(root: &str) -> Result<Vec<SnapshotFile>, String> {
    let status = status(root)?;
    if !status.available {
        return Ok(Vec::new());
    }
    let root_path = PathBuf::from(root.trim());
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for file in status.files {
        if !seen.insert(file.path.clone()) {
            continue;
        }
        let path = root_path.join(&file.path);
        if file.status.contains('D') && !path.exists() {
            out.push(SnapshotFile {
                path: file.path,
                content: None,
            });
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(value) => Some(value),
            Err(_) if !path.exists() => None,
            Err(_) => continue,
        };
        out.push(SnapshotFile {
            path: file.path,
            content,
        });
    }
    Ok(out)
}

pub fn restore_snapshot(root: &str, files: &[SnapshotFile]) -> Result<(), String> {
    let root = PathBuf::from(root.trim());
    for file in files {
        let dest = safe_join(&root, &file.path)?;
        match &file.content {
            None => {
                if dest.exists() {
                    std::fs::remove_file(&dest).map_err(|err| format!("无法删除 {}：{err}", file.path))?;
                }
            }
            Some(content) => {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|err| format!("无法创建目录：{err}"))?;
                }
                std::fs::write(&dest, content.as_bytes()).map_err(|err| format!("无法还原 {}：{err}", file.path))?;
            }
        }
    }
    Ok(())
}

pub fn parse_porcelain(raw: &str) -> GitStatus {
    let mut branch = "HEAD".to_string();
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest
                .split("...")
                .next()
                .unwrap_or(rest)
                .split_whitespace()
                .next()
                .unwrap_or(rest)
                .to_string();
            if let Some(start) = rest.find('[') {
                let info = &rest[start..];
                ahead = capture_num(info, "ahead ");
                behind = capture_num(info, "behind ");
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        let path = line[3..].trim().replace(" -> ", "/");
        let path = path.split(" -> ").last().unwrap_or(&path).replace('\\', "/");
        if path.is_empty() {
            continue;
        }
        if x != ' ' && x != '?' {
            files.push(GitFile {
                path: path.clone(),
                status: x.to_string(),
                staged: true,
            });
        }
        if (y != ' ' && y != '\t') || (x == '?' && y == '?') {
            let status = if x == '?' { "U".into() } else { y.to_string() };
            files.push(GitFile {
                path,
                status,
                staged: false,
            });
        }
    }
    GitStatus {
        available: true,
        dirty: !files.is_empty(),
        branch,
        ahead,
        behind,
        files,
        remotes: Vec::new(),
        message: String::new(),
    }
}

pub fn parse_remotes(raw: &str) -> Vec<GitRemote> {
    let mut out: Vec<GitRemote> = Vec::new();
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        let kind = parts.next().unwrap_or("");
        if !kind.is_empty() && !kind.contains("fetch") {
            continue;
        }
        if out.iter().any(|item| item.name == name) {
            continue;
        }
        out.push(GitRemote {
            name: name.to_string(),
            url: url.to_string(),
        });
    }
    out
}

fn list_remotes(root: &Path) -> Result<Vec<GitRemote>, String> {
    let out = git(root, &["remote", "-v"])?;
    Ok(parse_remotes(&out))
}

fn capture_num(haystack: &str, key: &str) -> u32 {
    let Some(index) = haystack.find(key) else {
        return 0;
    };
    haystack[index + key.len()..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

fn git_command() -> Command {
    let mut command = Command::new(if cfg!(windows) { "git.exe" } else { "git" });
    crate::runtime::hide_console(&mut command);
    command
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command()
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|_| "当前环境没有 git".to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.contains("not a git repository") {
        return Err("不是 Git 仓库".into());
    }
    Err(if stderr.is_empty() {
        "git 命令失败".into()
    } else {
        stderr
    })
}

fn git_owned(root: &Path, args: &[String]) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(root, &refs)
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut cur = root.to_path_buf();
    for part in rel.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("路径不允许跳出工作目录".into());
        }
        cur.push(part);
    }
    Ok(cur)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIdentity {
    pub login: String,
    pub name: String,
    pub source: String,
    pub repos: Vec<GithubRepo>,
}

pub fn github_identities() -> Vec<GithubIdentity> {
    let mut out: Vec<GithubIdentity> = Vec::new();
    if let Some(item) = identity_from_gh() {
        out.push(item);
    }
    if let Some(login) = git_global("github.user") {
        if !out.iter().any(|item| item.login.eq_ignore_ascii_case(&login)) {
            out.push(GithubIdentity {
                login: login.clone(),
                name: git_global("user.name").unwrap_or_default(),
                source: "gitconfig".into(),
                repos: Vec::new(),
            });
        }
    }
    if out.is_empty() {
        if let Some(name) = git_global("user.name") {
            out.push(GithubIdentity {
                login: name.clone(),
                name: git_global("user.email").unwrap_or_default(),
                source: "gitconfig".into(),
                repos: Vec::new(),
            });
        }
    }
    if ssh_has_github() && !out.iter().any(|item| item.source == "ssh") {
        if let Some(first) = out.first_mut() {
            if first.source == "gh" {
                // already have gh
            } else {
                first.source = format!("{}, ssh", first.source);
            }
        } else {
            out.push(GithubIdentity {
                login: "git@github.com".into(),
                name: String::new(),
                source: "ssh".into(),
                repos: Vec::new(),
            });
        }
    }
    out
}

fn identity_from_gh() -> Option<GithubIdentity> {
    let login = gh_output(&["api", "user", "--jq", ".login"])
        .or_else(|| gh_user_from_hosts())
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())?;
    let name = gh_output(&["api", "user", "--jq", ".name"]).unwrap_or_default();
    let repos = parse_gh_repos(&gh_output(&["repo", "list", "--limit", "8", "--json", "nameWithOwner,url"]).unwrap_or_default());
    Some(GithubIdentity {
        login,
        name: name.trim().to_string(),
        source: "gh".into(),
        repos,
    })
}

fn gh_output(args: &[&str]) -> Option<String> {
    let mut command = Command::new(if cfg!(windows) { "gh.exe" } else { "gh" });
    crate::runtime::hide_console(&mut command);
    let output = command.args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn gh_user_from_hosts() -> Option<String> {
    let path = dirs::home_dir()?.join(".config").join("gh").join("hosts.yml");
    let text = std::fs::read_to_string(path).ok()?;
    let mut in_github = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("github.com:") {
            in_github = true;
            continue;
        }
        if in_github && trimmed.ends_with(':') && !trimmed.starts_with(' ') && !line.starts_with(' ') && !line.starts_with('\t') {
            if trimmed != "github.com:" {
                in_github = false;
            }
        }
        if in_github {
            if let Some(user) = trimmed.strip_prefix("user:") {
                let user = user.trim().trim_matches('"');
                if !user.is_empty() {
                    return Some(user.to_string());
                }
            }
        }
    }
    None
}

fn parse_gh_repos(raw: &str) -> Vec<GithubRepo> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(rows) = value.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let name = row
                .get("nameWithOwner")
                .or_else(|| row.get("name"))
                .and_then(|item| item.as_str())?
                .to_string();
            let url = row
                .get("url")
                .and_then(|item| item.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("https://github.com/{name}.git"));
            Some(GithubRepo { name, url })
        })
        .collect()
}

fn git_global(key: &str) -> Option<String> {
    let output = git_command().args(["config", "--global", key]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn ssh_has_github() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let text = std::fs::read_to_string(home.join(".ssh").join("config")).unwrap_or_default();
    text.to_ascii_lowercase().contains("github.com")
}
