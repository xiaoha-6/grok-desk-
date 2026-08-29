use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    "vendor",
    ".grok",
    "grokdesk-relay",
];
pub const SHOW_DOT_DIRS: &[&str] = &[".vscode", ".cursor", ".github", ".grok"];
pub const MAX_ENTRIES: usize = 250;
pub const MAX_FILE_BYTES: u64 = 400_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub language: String,
    pub content: String,
    pub truncated: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

pub fn inspect_local_path(path: &str) -> Result<LocalPathInfo, String> {
    let raw = PathBuf::from(path.trim());
    if raw.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    let canon = fs::canonicalize(&raw).map_err(|err| format!("路径无效：{err}"))?;
    let name = canon
        .file_name()
        .map(|item| item.to_string_lossy().into_owned())
        .unwrap_or_else(|| canon.display().to_string());
    Ok(LocalPathInfo {
        path: canon.to_string_lossy().into_owned(),
        name,
        is_dir: canon.is_dir(),
    })
}

pub fn list_workspace(root: &str, rel: Option<&str>) -> Result<Vec<WorkspaceEntry>, String> {
    let dir = resolve_in_root(root, rel.unwrap_or(""))?;
    if !dir.is_dir() {
        return Err("不是文件夹".into());
    }
    if rel.unwrap_or("").is_empty() && is_home_like_root(&dir) {
        return Err("请选择项目文件夹，不能把用户主目录当作工作区".into());
    }
    let mut entries = Vec::new();
    let reader = fs::read_dir(&dir).map_err(|err| format!("无法读取工作区：{err}"))?;
    for item in reader.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = item.path().is_dir();
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if is_dir && name.starts_with('.') && !SHOW_DOT_DIRS.contains(&name.as_str()) {
            continue;
        }
        let child = if rel.unwrap_or("").is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel.unwrap_or("").trim_end_matches('/'), name)
        };
        entries.push(WorkspaceEntry {
            name,
            path: child.replace('\\', "/"),
            is_dir,
        });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

pub fn read_workspace_file(root: &str, rel: &str) -> Result<WorkspaceFile, String> {
    let path = resolve_in_root(root, rel)?;
    if path.is_dir() {
        return Err("这是文件夹".into());
    }
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let truncated = size > MAX_FILE_BYTES;
    let bytes = if truncated {
        let data = fs::read(&path).map_err(|err| format!("无法读取文件：{err}"))?;
        data.into_iter().take(MAX_FILE_BYTES as usize).collect::<Vec<_>>()
    } else {
        fs::read(&path).map_err(|err| format!("无法读取文件：{err}"))?
    };
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        content.push_str("\n…");
    }
    Ok(WorkspaceFile {
        path: rel.replace('\\', "/"),
        language: language_for_name(&rel.replace('\\', "/")),
        content,
        truncated,
        size,
    })
}

fn is_home_like_root(path: &Path) -> bool {
    if path.parent().is_none() {
        return true;
    }
    if let Some(home) = dirs::home_dir() {
        if let (Ok(canon), Ok(home)) = (fs::canonicalize(path), fs::canonicalize(&home)) {
            return canon == home;
        }
        return path == home;
    }
    false
}

fn resolve_in_root(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root.trim());
    if root.as_os_str().is_empty() {
        return Err("还没有工作目录".into());
    }
    let root = fs::canonicalize(&root).map_err(|err| format!("工作目录无效：{err}"))?;
    let joined = if rel.trim().is_empty() {
        root.clone()
    } else {
        let cleaned = rel.replace('\\', "/");
        let mut cur = root.clone();
        for part in cleaned.split('/') {
            if part.is_empty() || part == "." {
                continue;
            }
            if part == ".." {
                return Err("路径不允许跳出工作目录".into());
            }
            cur.push(part);
        }
        cur
    };
    let canon = fs::canonicalize(&joined).unwrap_or(joined);
    if !canon.starts_with(&root) {
        return Err("路径超出工作目录".into());
    }
    Ok(canon)
}

pub fn write_workspace_file(root: &str, rel: &str, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES * 8 {
        return Err("文件太大，无法写入".into());
    }
    let path = resolve_in_root_for_write(root, rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法创建目录：{err}"))?;
    }
    fs::write(&path, content.as_bytes()).map_err(|err| format!("无法写入文件：{err}"))
}

pub fn search_workspace(root: &str, query: &str, limit: usize) -> Result<Vec<WorkspaceEntry>, String> {
    let root_path = resolve_in_root(root, "")?;
    let needle = query.trim().to_ascii_lowercase();
    let mut out = Vec::new();
    walk_search(&root_path, "", &needle, limit.max(1).min(400), &mut out)?;
    Ok(out)
}

fn walk_search(dir: &Path, rel: &str, needle: &str, limit: usize, out: &mut Vec<WorkspaceEntry>) -> Result<(), String> {
    if out.len() >= limit {
        return Ok(());
    }
    let reader = match fs::read_dir(dir) {
        Ok(items) => items,
        Err(_) => return Ok(()),
    };
    let mut entries: Vec<_> = reader.flatten().collect();
    entries.sort_by_key(|item| item.file_name());
    for item in entries {
        if out.len() >= limit {
            break;
        }
        let name = item.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = item.path().is_dir();
        if name.starts_with('.') || (is_dir && SKIP_DIRS.contains(&name.as_str())) {
            continue;
        }
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let hay = child.to_ascii_lowercase();
        if needle.is_empty() || hay.contains(needle) || name.to_ascii_lowercase().contains(needle) {
            out.push(WorkspaceEntry {
                name,
                path: child.replace('\\', "/"),
                is_dir,
            });
        }
        if is_dir {
            walk_search(&item.path(), &child, needle, limit, out)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

pub fn grep_workspace(root: &str, query: &str, limit: usize) -> Result<Vec<GrepHit>, String> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = resolve_in_root(root, "")?;
    let mut out = Vec::new();
    walk_grep(&root_path, "", &needle.to_ascii_lowercase(), limit.max(1).min(80), &mut out)?;
    Ok(out)
}

fn walk_grep(dir: &Path, rel: &str, needle: &str, limit: usize, out: &mut Vec<GrepHit>) -> Result<(), String> {
    if out.len() >= limit {
        return Ok(());
    }
    let reader = match fs::read_dir(dir) {
        Ok(items) => items,
        Err(_) => return Ok(()),
    };
    let mut entries: Vec<_> = reader.flatten().collect();
    entries.sort_by_key(|item| item.file_name());
    for item in entries {
        if out.len() >= limit {
            break;
        }
        let name = item.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." || name.starts_with('.') {
            continue;
        }
        let is_dir = item.path().is_dir();
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if is_dir {
            walk_grep(&item.path(), &child, needle, limit, out)?;
            continue;
        }
        let meta = match fs::metadata(item.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let bytes = match fs::read(item.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.lines().enumerate() {
            if out.len() >= limit {
                break;
            }
            if line.to_ascii_lowercase().contains(needle) {
                let clipped: String = line.chars().take(160).collect();
                out.push(GrepHit {
                    path: child.replace('\\', "/"),
                    line: (index + 1) as u32,
                    text: clipped,
                });
            }
        }
    }
    Ok(())
}

const RULE_FILES: &[&str] = &["AGENTS.md", "GROK.md", ".cursorrules", ".grok/rules.md"];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRules {
    pub path: String,
    pub content: String,
}

pub fn read_project_rules(root: &str) -> Result<Option<ProjectRules>, String> {
    for rel in RULE_FILES {
        if let Ok(file) = read_workspace_file(root, rel) {
            return Ok(Some(ProjectRules {
                path: (*rel).into(),
                content: file.content,
            }));
        }
    }
    Ok(None)
}

pub fn write_project_rules(root: &str, content: &str) -> Result<ProjectRules, String> {
    let rel = RULE_FILES
        .iter()
        .find(|item| read_workspace_file(root, item).is_ok())
        .copied()
        .unwrap_or("AGENTS.md");
    write_workspace_file(root, rel, content)?;
    Ok(ProjectRules {
        path: rel.into(),
        content: content.to_string(),
    })
}

fn resolve_in_root_for_write(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root.trim());
    if root.as_os_str().is_empty() {
        return Err("还没有工作目录".into());
    }
    let root = fs::canonicalize(&root).map_err(|err| format!("工作目录无效：{err}"))?;
    let cleaned = rel.replace('\\', "/");
    let mut cur = root.clone();
    for part in cleaned.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("路径不允许跳出工作目录".into());
        }
        cur.push(part);
    }
    if cur.exists() {
        let canon = fs::canonicalize(&cur).unwrap_or(cur.clone());
        if !canon.starts_with(&root) {
            return Err("路径超出工作目录".into());
        }
        return Ok(canon);
    }
    if let Some(parent) = cur.parent() {
        if parent.exists() {
            let parent_canon = fs::canonicalize(parent).unwrap_or(parent.to_path_buf());
            if !parent_canon.starts_with(&root) {
                return Err("路径超出工作目录".into());
            }
        } else if !parent.starts_with(&root) {
            return Err("路径超出工作目录".into());
        }
    }
    Ok(cur)
}

pub fn language_for_name(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "ts" | "tsx" => "typescript".into(),
        "js" | "jsx" | "mjs" => "javascript".into(),
        "rs" => "rust".into(),
        "go" => "go".into(),
        "py" => "python".into(),
        "json" => "json".into(),
        "toml" => "toml".into(),
        "md" => "markdown".into(),
        "lua" => "lua".into(),
        "css" => "css".into(),
        "html" => "html".into(),
        "yml" | "yaml" => "yaml".into(),
        "sh" | "zsh" => "shell".into(),
        "swift" => "swift".into(),
        _ => "text".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_escape() {
        let dir = std::env::temp_dir().join(format!("ws-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let err = resolve_in_root(dir.to_str().unwrap(), "../secret").unwrap_err();
        assert!(err.contains("跳出"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_home_like_root() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let Some(root) = home.to_str() else {
            return;
        };
        let err = list_workspace(root, None).unwrap_err();
        assert!(err.contains("主目录") || err.contains("工作区"));
    }

    #[test]
    fn lists_and_reads_files() {
        let dir = std::env::temp_dir().join(format!("ws-read-{}", std::process::id()));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        let root = dir.to_str().unwrap();
        let entries = list_workspace(root, None).unwrap();
        assert!(entries.iter().any(|item| item.name == "src" && item.is_dir));
        let nested = list_workspace(root, Some("src")).unwrap();
        assert!(nested.iter().any(|item| item.path == "src/main.rs"));
        let file = read_workspace_file(root, "src/main.rs").unwrap();
        assert_eq!(file.language, "rust");
        assert_eq!(language_for_name("src/main.rs"), "rust");
        assert!(file.content.contains("fn main"));
        write_workspace_file(root, "src/main.rs", "fn main() { println!(\"hi\"); }\n").unwrap();
        let updated = read_workspace_file(root, "src/main.rs").unwrap();
        assert!(updated.content.contains("println"));
        let info = inspect_local_path(dir.join("src/main.rs").to_str().unwrap()).unwrap();
        assert_eq!(info.name, "main.rs");
        assert!(!info.is_dir);
        let folder = inspect_local_path(dir.to_str().unwrap()).unwrap();
        assert!(folder.is_dir);
        let _ = fs::remove_dir_all(&dir);
    }
}
