use crate::runtime::grok_home;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
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
    pub message_count: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalTimelineEvent {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionMessage {
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<LocalTimelineEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionHistory {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub session_dir: String,
    pub messages: Vec<LocalSessionMessage>,
    pub used_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub compaction_count: Option<u64>,
    pub has_more: bool,
}

pub fn list_local_sessions() -> Vec<LocalSessionSummary> {
    let root = grok_home().join("sessions");
    let mut out = Vec::new();
    visit_summaries(&root, &mut out);
    unique_sessions(out)
}

fn unique_sessions(mut out: Vec<LocalSessionSummary>) -> Vec<LocalSessionSummary> {
    out.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let mut seen = HashSet::new();
    out.retain(|item| seen.insert(item.grok_session_id.clone()));
    out.truncate(400);
    out
}

pub fn load_session_history(
    session_id: &str,
    limit: usize,
    skip: usize,
) -> Result<LocalSessionHistory, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("缺少 session id".into());
    }
    let dir = find_session_dir(&grok_home().join("sessions"), session_id)
        .ok_or_else(|| "找不到本机 Grok 对话".to_string())?;
    let limit = limit.max(1);
    let history_path = dir.join("chat_history.jsonl");
    let segments = compaction_segment_files(&dir);
    let mut all = reconstruct_turns(&history_path);
    attach_session_images(&dir, &mut all);
    let hist_total = all.len();
    let (messages, hist_more) = slice_end(&all, limit, skip);
    let has_more;
    let messages = if messages.is_empty() && !hist_more {
        let seg_skip = skip.saturating_sub(hist_total);
        let (extra, seg_more) = parse_compaction_segments(&segments, limit, seg_skip);
        has_more = seg_more;
        extra
    } else {
        has_more = hist_more || !segments.is_empty();
        messages
    };
    let (used_tokens, total_tokens, compaction_count) = parse_signals(&dir.join("signals.json"));
    Ok(LocalSessionHistory {
        session_id: session_id.to_string(),
        session_dir: dir.to_string_lossy().into_owned(),
        messages,
        used_tokens,
        total_tokens,
        compaction_count,
        has_more,
    })
}

fn list_session_images(dir: &Path) -> Vec<PathBuf> {
    let folder = dir.join("images");
    let Ok(entries) = fs::read_dir(&folder) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| {
                    matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "heic" | "heif"
                    )
                })
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    files
}

fn looks_like_image_blob(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif"]
        .iter()
        .any(|ext| lower.contains(ext))
}

fn event_has_image_path(event: &LocalTimelineEvent) -> bool {
    event
        .output
        .as_deref()
        .map(looks_like_image_blob)
        .unwrap_or(false)
        || event
            .input
            .as_deref()
            .map(looks_like_image_blob)
            .unwrap_or(false)
}

fn is_image_gen_event(event: &LocalTimelineEvent) -> bool {
    let hay = format!("{} {}", event.kind, event.title).to_ascii_lowercase();
    hay.contains("image_gen")
        || hay.contains("imagegen")
        || hay.contains("generate image")
        || hay == "imagine"
        || hay.starts_with("imagine ")
        || hay.contains(" grok-imagine")
}

fn attach_session_images(dir: &Path, messages: &mut [LocalSessionMessage]) {
    let files = list_session_images(dir);
    if files.is_empty() {
        return;
    }
    let mut unused = files;
    for msg in messages.iter() {
        let blob = format!(
            "{} {}",
            msg.text,
            msg.events
                .iter()
                .map(|event| format!(
                    "{} {}",
                    event.input.as_deref().unwrap_or(""),
                    event.output.as_deref().unwrap_or("")
                ))
                .collect::<Vec<_>>()
                .join(" ")
        );
        unused.retain(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let full = path.to_string_lossy();
            !blob.contains(name) && !blob.contains(full.as_ref())
        });
    }
    for msg in messages.iter_mut() {
        if msg.role != "assistant" {
            continue;
        }
        let wants = msg.events.iter().any(is_image_gen_event)
            || msg.text.to_ascii_lowercase().contains("images/");
        if !wants {
            continue;
        }
        if msg.events.iter().any(event_has_image_path) {
            continue;
        }
        let Some(path) = unused.first().cloned() else {
            break;
        };
        unused.remove(0);
        let payload = serde_json::json!({
            "path": path.to_string_lossy(),
            "filename": path.file_name().and_then(|name| name.to_str()).unwrap_or("image.jpg"),
            "type": "ImageGen",
        })
        .to_string();
        if let Some(event) = msg
            .events
            .iter_mut()
            .find(|event| is_image_gen_event(event) && event.output.is_none())
        {
            event.output = Some(payload);
        } else if let Some(event) = msg
            .events
            .iter_mut()
            .find(|event| is_image_gen_event(event) && !event_has_image_path(event))
        {
            event.output = Some(payload);
        } else {
            msg.events.push(LocalTimelineEvent {
                id: format!(
                    "image-{}",
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("1")
                ),
                kind: "image_gen".into(),
                title: "Generate Image".into(),
                status: Some("completed".into()),
                input: None,
                output: Some(payload),
            });
        }
    }
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
        message_count: value
            .get("num_chat_messages")
            .and_then(Value::as_u64)
            .or_else(|| value.get("num_messages").and_then(Value::as_u64))
            .unwrap_or(0),
    })
}

fn slice_end(all: &[LocalSessionMessage], limit: usize, skip: usize) -> (Vec<LocalSessionMessage>, bool) {
    if skip >= all.len() {
        return (Vec::new(), false);
    }
    let end = all.len() - skip;
    let start = end.saturating_sub(limit);
    (all[start..end].to_vec(), start > 0)
}

fn reconstruct_turns(path: &Path) -> Vec<LocalSessionMessage> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut events: Vec<LocalTimelineEvent> = Vec::new();
    let mut text = String::new();
    for range in line_ranges(&bytes) {
        let line = &bytes[range];
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            continue;
        };
        match kind {
            "user" => {
                // One assistant bubble per user turn. Flushing every assistant chunk
                // used to explode history into dozens of fragments and push real
                // user messages out of the visible / persisted window.
                flush_assistant(&mut out, &mut text, &mut events);
                if let Some(message) = user_message_from_value(&value) {
                    out.push(message);
                }
            }
            "reasoning" => {
                if let Some(event) = reasoning_event(&value) {
                    upsert_timeline_event(&mut events, event);
                }
            }
            "assistant" | "backend_tool_call" => {
                push_tool_calls(&mut events, &value);
                let raw = content_text(&value);
                if !raw.trim().is_empty() {
                    merge_assistant_text(&mut text, &raw);
                }
            }
            "tool_result" => apply_tool_result(&mut events, &value),
            _ => {}
        }
    }
    flush_assistant(&mut out, &mut text, &mut events);
    out
}

fn merge_assistant_text(text: &mut String, raw: &str) {
    let next = raw.trim();
    if next.is_empty() {
        return;
    }
    if text.is_empty() {
        *text = truncate_text(next, 16_000);
        return;
    }
    if text == next || text.contains(next) {
        return;
    }
    // Later chunks often replace or extend an earlier draft in the same turn.
    if next.contains(text.as_str()) || next.starts_with(text.as_str()) {
        *text = truncate_text(next, 16_000);
        return;
    }
    let combined = format!("{text}\n\n{next}");
    *text = truncate_text(&combined, 16_000);
}

fn upsert_timeline_event(events: &mut Vec<LocalTimelineEvent>, event: LocalTimelineEvent) {
    if let Some(existing) = events.iter_mut().rev().find(|item| item.id == event.id) {
        if (event.output.as_ref().map(String::len).unwrap_or(0))
            >= (existing.output.as_ref().map(String::len).unwrap_or(0))
        {
            *existing = event;
        }
        return;
    }
    events.push(event);
}

fn flush_assistant(
    out: &mut Vec<LocalSessionMessage>,
    text: &mut String,
    events: &mut Vec<LocalTimelineEvent>,
) {
    if text.is_empty() && events.is_empty() {
        return;
    }
    out.push(LocalSessionMessage {
        role: "assistant".into(),
        text: std::mem::take(text),
        events: std::mem::take(events),
    });
}

fn user_message_from_value(value: &Value) -> Option<LocalSessionMessage> {
    let raw = content_text(value);
    // Synthetic injections (skills, MCP, background-task notices) are typed as
    // "user" in chat_history.jsonl but must not become chat bubbles.
    if value.get("synthetic_reason").is_some() && !raw.contains("<user_query>") {
        return None;
    }
    if value.get("prompt_index").is_none() && !raw.contains("<user_query>") {
        return None;
    }
    let text = extract_user_query(&raw);
    if text.is_empty() {
        return None;
    }
    Some(LocalSessionMessage {
        role: "user".into(),
        text: truncate_text(&text, 12_000),
        events: Vec::new(),
    })
}

fn reasoning_event(value: &Value) -> Option<LocalTimelineEvent> {
    let summary = value.get("summary").and_then(Value::as_array)?;
    let text = summary
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return None;
    }
    Some(LocalTimelineEvent {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("thought")
            .to_string(),
        kind: "thought".into(),
        title: "思考过程".into(),
        status: Some("completed".into()),
        input: None,
        output: Some(truncate_text(&text, 4000)),
    })
}

fn push_tool_calls(events: &mut Vec<LocalTimelineEvent>, value: &Value) {
    let Some(calls) = value.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    for call in calls {
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool");
        let args = parse_args(call.get("arguments"));
        let (kind, title) = tool_label(name, &args);
        let input = serde_json::to_string_pretty(&args).ok();
        upsert_timeline_event(
            events,
            LocalTimelineEvent {
                id: if id.is_empty() {
                    format!("tool-{}", events.len())
                } else {
                    format!("tool-{id}")
                },
                kind: kind.into(),
                title,
                status: Some("completed".into()),
                input,
                output: None,
            },
        );
    }
}

fn apply_tool_result(events: &mut [LocalTimelineEvent], value: &Value) {
    let Some(id) = value.get("tool_call_id").and_then(Value::as_str) else {
        return;
    };
    let key = format!("tool-{id}");
    let output = content_text(value);
    if output.trim().is_empty() {
        return;
    }
    if let Some(event) = events.iter_mut().rev().find(|item| item.id == key) {
        event.output = Some(truncate_text(&output, 4000));
        event.status = Some("completed".into());
    }
}

fn parse_args(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => serde_json::from_str(text).unwrap_or(Value::String(text.clone())),
        Some(other) => other.clone(),
        None => Value::Null,
    }
}

fn tool_label(name: &str, args: &Value) -> (&'static str, String) {
    let path = args
        .get("target_file")
        .or_else(|| args.get("path"))
        .or_else(|| args.get("file_path"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("");
    let pattern = args
        .get("pattern")
        .or_else(|| args.get("query"))
        .and_then(Value::as_str)
        .unwrap_or("");
    match name {
        "read_file" | "Read" => ("read", format!("Read `{path}`")),
        "search_replace" | "Write" | "write" | "edit" => ("edit", format!("Edit `{path}`")),
        "run_terminal_command" | "bash" | "Shell" => (
            "execute",
            if command.is_empty() {
                "Run command".into()
            } else {
                format!("Run `{command}`")
            },
        ),
        "grep" | "rg" => (
            "search",
            if pattern.is_empty() {
                "Search".into()
            } else {
                format!("Search `{pattern}`")
            },
        ),
        "web_search" => ("search", "Web search".into()),
        "web_fetch" => ("fetch", "Fetch URL".into()),
        "list_dir" | "Glob" => ("list", format!("List `{path}`")),
        "image_gen" | "imagine" | "ImageGen" => ("image_gen", "Generate Image".into()),
        _ => ("other", name.replace('_', " ")),
    }
}

fn compaction_segment_files(dir: &Path) -> Vec<PathBuf> {
    let folder = dir.join("compaction");
    let Ok(entries) = fs::read_dir(&folder) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
            name.starts_with("segment_") && name.ends_with(".md")
        })
        .collect();
    files.sort();
    files
}

fn parse_compaction_segments(
    files: &[PathBuf],
    limit: usize,
    skip: usize,
) -> (Vec<LocalSessionMessage>, bool) {
    if files.is_empty() {
        return (Vec::new(), false);
    }
    let newest_first: Vec<&PathBuf> = files.iter().rev().collect();
    let has_more = newest_first.len() > skip + limit;
    let page: Vec<LocalSessionMessage> = newest_first
        .into_iter()
        .skip(skip)
        .take(limit)
        .filter_map(|path| {
            let name = path.file_stem()?.to_string_lossy().to_string();
            let raw = fs::read_to_string(path).ok()?;
            let body = raw.trim();
            if body.is_empty() {
                return None;
            }
            Some(LocalSessionMessage {
                role: "assistant".into(),
                text: format!(
                    "更早的对话摘要（{name}）\n\n{}",
                    truncate_text(body, 8000)
                ),
                events: Vec::new(),
            })
        })
        .collect();
    let more = has_more || skip + page.len() < files.len();
    (page, more)
}

fn parse_chat_history(path: &Path, limit: usize, skip: usize) -> (Vec<LocalSessionMessage>, bool) {
    slice_end(&reconstruct_turns(path), limit, skip)
}

fn line_ranges(bytes: &[u8]) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            ranges.push(start..index);
            start = index + 1;
        }
    }
    if start < bytes.len() {
        ranges.push(start..bytes.len());
    }
    ranges
}

fn truncate_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &text[..end])
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
    let raw = if let (Some(start), Some(end_tag)) = (text.find("<user_query>"), text.find("</user_query>")) {
        let inner_start = start + "<user_query>".len();
        if end_tag > inner_start {
            text[inner_start..end_tag].to_string()
        } else {
            text.to_string()
        }
    } else if text.contains("<system-reminder>") || text.contains("<user_info>") {
        return String::new();
    } else {
        text.to_string()
    };
    strip_injected_prompt_context(&raw)
}

/// Drop desktop-injected wrappers so history bubbles match what the user typed.
fn strip_injected_prompt_context(text: &str) -> String {
    let mut out = text.to_string();
    for tag in ["tool_policy", "file", "folder", "project_rules"] {
        out = strip_xml_blocks(&out, tag);
    }
    collapse_blank_lines(&out)
}

fn strip_xml_blocks(text: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        let after_name = &rest[start + open.len()..];
        let is_tag = after_name.starts_with('>')
            || after_name.starts_with(|ch: char| ch.is_ascii_whitespace());
        if !is_tag {
            out.push_str(&rest[..start + open.len()]);
            rest = after_name;
            continue;
        }
        out.push_str(&rest[..start]);
        let Some(gt) = after_name.find('>') else {
            break;
        };
        let after_open = &after_name[gt + 1..];
        if let Some(end) = after_open.find(&close) {
            rest = &after_open[end + close.len()..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    out
}

fn collapse_blank_lines(text: &str) -> String {
    let mut lines = Vec::new();
    let mut blank = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            blank += 1;
            if blank <= 1 && !lines.is_empty() {
                lines.push(String::new());
            }
            continue;
        }
        blank = 0;
        lines.push(line.trim_end().to_string());
    }
    lines.join("\n").trim().to_string()
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
        assert_eq!(
            extract_user_query("hi\n\n<tool_policy>不要出图</tool_policy>"),
            "hi"
        );
        assert!(extract_user_query("<tool_policy>不要出图</tool_policy>").is_empty());
        assert_eq!(
            extract_user_query("看 @src/App.tsx\n\n<file path=\"src/App.tsx\">\ncode\n</file>"),
            "看 @src/App.tsx"
        );
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
        assert_eq!(summary.message_count, 0);
        assert_eq!(summary.cwd, "/Users/ha");
        let (messages, has_more) = parse_chat_history(&session.join("chat_history.jsonl"), 40, 0);
        assert!(!has_more);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "您好");
        assert_eq!(messages[1].text, "你好，我是 Grok");
        let (latest, more) = parse_chat_history(&session.join("chat_history.jsonl"), 1, 0);
        assert!(more);
        assert_eq!(latest[0].text, "你好，我是 Grok");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merges_assistant_chunks_into_one_turn_and_keeps_users() {
        let dir = std::env::temp_dir().join(format!("grokdesk-hist-{}", std::process::id()));
        let path = dir.join("chat_history.jsonl");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &path,
            r#"{"type":"user","content":[{"type":"text","text":"<user_info>os</user_info>"}]}
{"type":"user","synthetic_reason":"skills","content":[{"type":"text","text":"<system-reminder>skills</system-reminder>"}]}
{"type":"user","prompt_index":0,"content":[{"type":"text","text":"<user_query>第一句</user_query>"}]}
{"type":"assistant","content":"草稿"}
{"type":"assistant","content":"完整回答一"}
{"type":"user","prompt_index":1,"content":[{"type":"text","text":"<user_query>第二句</user_query>"}]}
{"type":"assistant","content":"回答二"}
"#,
        )
        .unwrap();
        let messages = reconstruct_turns(&path);
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "第一句");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].text, "完整回答一");
        assert_eq!(messages[2].text, "第二句");
        assert_eq!(messages[3].text, "回答二");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_strips_injected_tool_policy_from_user_bubbles() {
        let dir = std::env::temp_dir().join(format!("grokdesk-policy-{}", std::process::id()));
        let path = dir.join("chat_history.jsonl");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &path,
            r#"{"type":"user","prompt_index":0,"content":[{"type":"text","text":"hi\n\n<tool_policy>用户没有要求生成图片。不要调用 ImageGen。</tool_policy>"}]}
{"type":"assistant","content":"你好"}
"#,
        )
        .unwrap();
        let messages = reconstruct_turns(&path);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "hi");
        assert!(!messages[0].text.contains("tool_policy"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_sessions_keeps_newest_of_duplicate_ids() {
        let older = LocalSessionSummary {
            id: "sess".into(),
            grok_session_id: "sess".into(),
            title: "old".into(),
            cwd: "/tmp".into(),
            created_at: 1,
            updated_at: 1,
            message_count: 1,
        };
        let newer = LocalSessionSummary {
            id: "sess".into(),
            grok_session_id: "sess".into(),
            title: "new".into(),
            cwd: "/tmp".into(),
            created_at: 1,
            updated_at: 2,
            message_count: 2,
        };
        let other = LocalSessionSummary {
            id: "other".into(),
            grok_session_id: "other".into(),
            title: "other".into(),
            cwd: "/tmp".into(),
            created_at: 1,
            updated_at: 3,
            message_count: 1,
        };
        let out = unique_sessions(vec![older, newer, other]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].grok_session_id, "other");
        assert_eq!(out[1].title, "new");
    }
}
