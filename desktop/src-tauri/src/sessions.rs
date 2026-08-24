use crate::runtime::grok_home;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SKIP_DIRS: &[&str] = &[
    "terminal",
    "assets",
    "images",
    "compaction",
    "compaction_checkpoints",
    "compaction_requests",
    "recap_requests",
    "mcp",
    "web_fetch",
    "prompts",
    "subagents",
    "hunk_records",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionSummary {
    pub id: String,
    pub grok_session_id: String,
    pub title: String,
    pub cwd: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionMessage {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionHistory {
    pub session_id: String,
    pub messages: Vec<LocalSessionMessage>,
    pub used_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub compaction_count: Option<u64>,
}

pub fn list_local_sessions() -> Vec<LocalSessionSummary> {
    let root = grok_home().join("sessions");
    let mut out = Vec::new();
    visit_summaries(&root, &mut out);
    out.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    out.truncate(400);
    out
}

pub fn load_session_history(session_id: &str) -> Result<LocalSessionHistory, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("缺少 session id".into());
    }
    let dir = find_session_dir(&grok_home().join("sessions"), session_id)
        .ok_or_else(|| "找不到本机 Grok 对话".to_string())?;
    let messages = parse_chat_history(&dir.join("chat_history.jsonl"));
    let (used_tokens, total_tokens, compaction_count) = parse_signals(&dir.join("signals.json"));
    Ok(LocalSessionHistory {
        session_id: session_id.to_string(),
        messages,
        used_tokens,
        total_tokens,
        compaction_count,
    })
}

fn visit_summaries(dir: &Path, out: &mut Vec<LocalSessionSummary>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name) {
                continue;
            }
            visit_summaries(&path, out);
            continue;
        }
        if name == "summary.json" {
            if let Some(summary) = parse_summary(&path) {
                out.push(summary);
            }
        }
    }
}

fn find_session_dir(root: &Path, session_id: &str) -> Option<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !path.is_dir() {
            continue;
        }
        if SKIP_DIRS.contains(&name) {
            continue;
        }
        if name == session_id && path.join("chat_history.jsonl").is_file() {
            return Some(path);
        }
        if let Some(found) = find_session_dir(&path, session_id) {
            return Some(found);
        }
    }
    None
}

fn parse_summary(path: &Path) -> Option<LocalSessionSummary> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if value.get("hidden").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let kind = value
        .get("session_kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind.contains("subagent") {
        return None;
    }
    let info = value.get("info")?.as_object()?;
    let session_id = info.get("id")?.as_str()?.trim().to_string();
    if session_id.is_empty() {
        return None;
    }
    let cwd = info
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let title = first_nonempty(&[
        value.get("generated_title").and_then(Value::as_str),
        value.get("session_summary").and_then(Value::as_str),
        value.get("last_turn_summary").and_then(Value::as_str),
    ])
    .unwrap_or_else(|| "Grok Session".to_string());
    let created_at = parse_time(value.get("created_at").and_then(Value::as_str));
    let updated_at = parse_time(
        value
            .get("last_active_at")
            .and_then(Value::as_str)
            .or_else(|| value.get("updated_at").and_then(Value::as_str)),
    )
    .max(created_at);
    Some(LocalSessionSummary {
        id: session_id.clone(),
        grok_session_id: session_id,
        title,
        cwd,
        created_at,
        updated_at,
    })
}

fn parse_chat_history(path: &Path) -> Vec<LocalSessionMessage> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut messages = Vec::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            continue;
        };
        if kind == "user" {
            if value.get("prompt_index").is_none() {
                continue;
            }
            let raw = content_text(&value);
            let text = extract_user_query(&raw);
            if !text.is_empty() {
                messages.push(LocalSessionMessage {
                    role: "user".into(),
                    text,
                });
            }
        } else if kind == "assistant" {
            let text = content_text(&value);
            if !text.is_empty() {
                messages.push(LocalSessionMessage {
                    role: "assistant".into(),
                    text,
                });
            }
        }
        if messages.len() >= 800 {
            break;
        }
    }
    messages
}

fn parse_signals(path: &Path) -> (Option<u64>, Option<u64>, Option<u64>) {
    let Ok(value) = serde_json::from_slice::<Value>(&fs::read(path).unwrap_or_default()) else {
        return (None, None, None);
    };
    (
        json_u64(&value, "contextTokensUsed"),
        json_u64(&value, "contextWindowTokens"),
        json_u64(&value, "compactionCount"),
    )
}

fn content_text(value: &Value) -> String {
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return text.to_string();
    }
    let Some(blocks) = value.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_user_query(text: &str) -> String {
    if let (Some(start), Some(end_tag)) = (text.find("<user_query>"), text.find("</user_query>")) {
        let inner_start = start + "<user_query>".len();
        if end_tag > inner_start {
            return text[inner_start..end_tag].trim().to_string();
        }
    }
    if text.contains("<system-reminder>") || text.contains("<user_info>") {
        return String::new();
    }
    text.trim().to_string()
}

fn first_nonempty(values: &[Option<&str>]) -> Option<String> {
    values.iter().find_map(|value| {
        value
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
    })
}

fn parse_time(value: Option<&str>) -> u64 {
    let Some(text) = value else {
        return now_millis();
    };
    chrono_like_millis(text).unwrap_or_else(now_millis)
}

fn chrono_like_millis(text: &str) -> Option<u64> {
    let parsed = DateTime::parse(text)?;
    Some(parsed)
}

struct DateTime;

impl DateTime {
    fn parse(text: &str) -> Option<u64> {
        let cleaned = text.trim().trim_end_matches('Z');
        let (date, time) = cleaned.split_once('T')?;
        let mut date_parts = date.split('-');
        let year: i64 = date_parts.next()?.parse().ok()?;
        let month: u32 = date_parts.next()?.parse().ok()?;
        let day: u32 = date_parts.next()?.parse().ok()?;
        let time = time.split(['.', '+']).next().unwrap_or(time);
        let mut time_parts = time.split(':');
        let hour: u32 = time_parts.next()?.parse().ok()?;
        let minute: u32 = time_parts.next()?.parse().ok()?;
        let second: u32 = time_parts.next()?.parse().ok()?;
        days_to_unix(year, month, day).map(|days| {
            ((days * 86400) + (hour as i64) * 3600 + (minute as i64) * 60 + second as i64) as u64
                * 1000
        })
    }
}

fn days_to_unix(year: i64, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut days = 0i64;
    for y in 1970..year {
        days += if is_leap(y) { 366 } else { 365 };
    }
    const CUM: [u32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    days += i64::from(CUM[(month as usize) - 1]);
    if month > 2 && is_leap(year) {
        days += 1;
    }
    days += i64::from(day) - 1;
    Some(days)
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn json_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|item| {
        item.as_u64()
            .or_else(|| item.as_i64().map(|n| n.max(0) as u64))
            .or_else(|| item.as_f64().map(|n| n.max(0.0) as u64))
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_user_query_and_skips_system_blocks() {
        assert_eq!(
            extract_user_query("<user_info>os</user_info>\n<user_query>你好</user_query>"),
            "你好"
        );
        assert!(extract_user_query("<system-reminder>ignore</system-reminder>").is_empty());
        assert_eq!(extract_user_query("plain hi"), "plain hi");
    }

    #[test]
    fn parses_iso_time() {
        let ms = chrono_like_millis("2026-08-24T15:24:34.738448Z").unwrap();
        assert!(ms > 1_700_000_000_000);
    }

    #[test]
    fn parses_summary_and_history() {
        let dir = std::env::temp_dir().join(format!("grokdesk-sess-{}", std::process::id()));
        let session = dir.join("workspace").join("01abc");
        fs::create_dir_all(&session).unwrap();
        fs::write(
            session.join("summary.json"),
            r#"{
              "info": { "id": "01abc", "cwd": "/Users/ha" },
              "generated_title": "您好",
              "created_at": "2026-08-20T20:11:41Z",
              "updated_at": "2026-08-24T15:24:34Z",
              "last_active_at": "2026-08-24T15:24:34Z"
            }"#,
        )
        .unwrap();
        fs::write(
            session.join("chat_history.jsonl"),
            r#"{"type":"system","content":"ignore"}
{"type":"user","prompt_index":0,"content":[{"type":"text","text":"<user_query>您好</user_query>"}]}
{"type":"assistant","content":"你好，我是 Grok"}
"#,
        )
        .unwrap();
        let summary = parse_summary(&session.join("summary.json")).unwrap();
        assert_eq!(summary.title, "您好");
        assert_eq!(summary.cwd, "/Users/ha");
        let messages = parse_chat_history(&session.join("chat_history.jsonl"));
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "您好");
        assert_eq!(messages[1].text, "你好，我是 Grok");
        let _ = fs::remove_dir_all(&dir);
    }
}
