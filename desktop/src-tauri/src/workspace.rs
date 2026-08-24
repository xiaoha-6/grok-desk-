use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const SKIP_DIRS: &[&str] = &[
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
const MAX_ENTRIES: usize = 250;
const MAX_FILE_BYTES: u64 = 400_000;

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
        if is_dir && (name.starts_with('.') || SKIP_DIRS.contains(&name.as_str())) {
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
        language: language_for(&path),
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

fn language_for(path: &Path) -> String {
    match path
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
        assert!(file.content.contains("fn main"));
        let _ = fs::remove_dir_all(&dir);
    }
}
