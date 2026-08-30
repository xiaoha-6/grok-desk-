import type { Lang, TimelineEvent } from "./types";
import { t as translate } from "./i18n";

export type ActivityCategory =
  | "reasoning"
  | "skills"
  | "files"
  | "commands"
  | "hooks"
  | "context"
  | "plan"
  | "interactions"
  | "system"
  | "other";

export type ActivityRun = {
  id: string;
  category: ActivityCategory;
  events: TimelineEvent[];
};

const REDUNDANT = new Set([
  "available commands update",
  "tool call delta chunk",
  "pending interaction",
  "interaction resolved",
  "x.ai/queue/changed",
  "x.ai/announcements/update",
  "model changed",
  "x.ai/settings/update",
  "x.ai/mcp initialized",
  "x.ai/mcp/servers updated",
  "x.ai/mcp/init progress",
  "x.ai/mcp/server status",
  "response completed",
  "image compressed",
  "updating plan",
  "memory flush started",
  "memory flush completed",
  "memory_flush_started",
  "memory_flush_completed",
]);

export function categoryTitle(category: ActivityCategory, lang: Lang) {
  const copy = translate(lang);
  const titles: Record<ActivityCategory, string> = {
    reasoning: copy.catReasoning,
    skills: copy.catSkills,
    files: copy.catFiles,
    commands: copy.catCommands,
    hooks: copy.catHooks,
    context: copy.catContext,
    plan: copy.catPlan,
    interactions: copy.catInteractions,
    system: copy.catSystem,
    other: copy.catOther,
  };
  return titles[category];
}

export function isEditEvent(event: TimelineEvent) {
  if (event.diffs?.length) return true;
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  return ["edit", "write", "replace", "apply_patch", "applypatch", "str_replace"].some((item) => haystack.includes(item));
}

export function looksLikeCommand(text: string) {
  const line = String(text || "")
    .trim()
    .split("\n")[0]
    .replace(/^execute\s+/i, "")
    .replace(/^[`'" ]+|[`'" ]+$/g, "");
  if (!line) return false;
  return /^(?:sudo\s+)?(?:[A-Za-z_][\w-]*=\S+\s+)*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:pnpm|npm|yarn|bun|cargo|make|cmake|ninja|go|python3?|node|npx|pip3?|brew|hdiutil|xcodebuild|gradle|mvn|docker|git|swift|rustc|clang|gcc|tauri|vite)\b/.test(
    line,
  );
}

export function isCommandEvent(event: TimelineEvent) {
  if (isEditEvent(event)) return false;
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  if (
    [
      "execute",
      "command",
      "shell",
      "bash",
      "zsh",
      "terminal",
      "compile",
      "build",
      "cargo",
      "pnpm",
      "npm",
      "make",
      "background_task",
      "run_command",
      "run_terminal",
    ].some((item) => haystack.includes(item))
  ) {
    return true;
  }
  return looksLikeCommand(event.title) || looksLikeCommand(event.input || "");
}

export function isBuildCommand(event: TimelineEvent) {
  const haystack = `${event.kind} ${event.title} ${event.input || ""}`.toLowerCase();
  return /compile|xcodebuild|hdiutil|tauri build|\bcargo\b|\bmake\b|gradle|mvn |pnpm (?:exec )?tauri|npm run build|vite build/.test(
    haystack,
  );
}

export function isOpaqueJson(text?: string) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("{")) return false;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((key) => /^(sessionUpdate|session_update|_meta|eventId|event_id)$/i.test(key));
  } catch {
    return false;
  }
}

export function readableToolText(text?: string) {
  const raw = String(text || "").trim();
  if (!raw || isOpaqueJson(raw)) return "";
  if (!raw.startsWith("{") && !raw.startsWith("[")) return raw;
  try {
    const value = JSON.parse(raw) as unknown;
    const rec = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    if (!rec) return raw;
    const pick = (...keys: string[]) => {
      for (const key of keys) {
        const item = rec[key];
        if (typeof item === "string" && item.trim() && !isOpaqueJson(item)) return item.trim();
      }
      return "";
    };
    return pick("command", "cmd", "script", "stdout", "output", "text", "result") || raw;
  } catch {
    return raw;
  }
}

export function commandTitle(event: TimelineEvent, lang: Lang) {
  const copy = translate(lang);
  const haystack = `${event.kind} ${event.title} ${event.input || ""}`.toLowerCase();
  if (isBuildCommand(event) || haystack.includes("compile") || haystack.includes("tauri") || haystack.includes("hdiutil")) {
    return copy.cmdBuild;
  }
  if (haystack.includes("terminal") || haystack.includes("shell") || haystack.includes("bash")) {
    return copy.cmdTerminal;
  }
  return copy.cmdCommand;
}

export function editTitle(event: TimelineEvent) {
  const path = event.diffs?.find((item) => item.path)?.path || eventFilePath(event);
  const name = path.split("/").filter(Boolean).pop() || path;
  return name ? `Edit ${name}` : "Edit";
}

function toolArgs(event: TimelineEvent): Record<string, unknown> {
  return readRecord(event.input);
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function clipPattern(value: string, max = 48) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function eventFilePath(event: TimelineEvent) {
  const rec = toolArgs(event);
  const fromArgs = String(
    rec.path || rec.target_file || rec.targetFile || rec.file_path || rec.filePath || rec.uri || rec.glob || "",
  ).trim();
  if (fromArgs) return fromArgs;
  const tick = event.title.match(/`([^`]+)`/);
  return tick?.[1] || "";
}

export function eventLineRange(event: TimelineEvent) {
  const rec = toolArgs(event);
  const start = Number(rec.offset ?? rec.start_line ?? rec.startLine ?? rec.line ?? 0);
  const limit = Number(rec.limit ?? rec.count ?? 0);
  const end = Number(rec.end_line ?? rec.endLine ?? 0);
  if (start > 0 && end > start) return ` L${start}-${end}`;
  if (start > 0 && limit > 0) return ` L${start}-${start + limit - 1}`;
  if (start > 0) return ` L${start}`;
  const match = event.title.match(/\bL(\d+)(?:-(\d+))?/i);
  if (match) return match[2] ? ` L${match[1]}-${match[2]}` : ` L${match[1]}`;
  return "";
}

export function eventSearchPattern(event: TimelineEvent) {
  const rec = toolArgs(event);
  return String(rec.pattern || rec.query || rec.glob || rec.glob_pattern || rec.globPattern || "").trim();
}

export function isThoughtEvent(event: TimelineEvent) {
  return event.kind === "thought";
}

export function isReadEvent(event: TimelineEvent) {
  if (isEditEvent(event) || isCommandEvent(event)) return false;
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  if (event.kind === "read" || /\bread_file\b|read `|^\s*read\b|\bread\b/.test(haystack)) return true;
  if (/^(tool call|工具调用|工具呼叫)$/i.test(event.title.trim())) {
    const rec = toolArgs(event);
    if (rec.pattern || rec.query || rec.command || rec.old_string || rec.new_string || rec.contents) return false;
    return Boolean(rec.path || rec.target_file || rec.file_path || rec.filePath);
  }
  return false;
}

export function isSearchEvent(event: TimelineEvent) {
  if (isEditEvent(event) || isCommandEvent(event) || isReadEvent(event)) return false;
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  if (["search", "list", "fetch", "grep"].includes(event.kind)) return true;
  if (/grep|\brg\b|\bsearch\b|web_fetch|list_dir|list `|glob/.test(haystack)) return true;
  const rec = toolArgs(event);
  return Boolean(rec.pattern || rec.query || rec.glob || rec.glob_pattern || rec.globPattern);
}

export function isExploreEvent(event: TimelineEvent) {
  return isReadEvent(event) || isSearchEvent(event);
}

export function exploreTitle(event: TimelineEvent) {
  const path = eventFilePath(event);
  const name = baseName(path);
  const range = eventLineRange(event);
  const pattern = eventSearchPattern(event);
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  if (isReadEvent(event)) return name ? `Read ${name}${range}` : event.title;
  if (/glob/.test(haystack)) return pattern ? `Glob ${clipPattern(pattern)}` : event.title;
  if (/list_dir|^list$|list `/.test(haystack) || event.kind === "list") {
    return name ? `List ${name}` : event.title;
  }
  if (/web_search|web search/.test(haystack)) return pattern ? `Search ${clipPattern(pattern)}` : event.title;
  if (/fetch|web_fetch/.test(haystack) || event.kind === "fetch") {
    return `Fetch ${name || path || ""}`.trim();
  }
  if (pattern && name) return `Grep ${clipPattern(pattern)} in ${name}`;
  if (pattern) return `Grep ${clipPattern(pattern)}`;
  return event.title;
}

export function thoughtTiming(event?: TimelineEvent) {
  const rec = event ? toolArgs(event) : {};
  const startedAt = Number(rec.startedAt) || 0;
  const endedAt = Number(rec.endedAt) || 0;
  if (!startedAt || !endedAt || endedAt < startedAt) return 0;
  return Math.max(1, Math.round((endedAt - startedAt) / 1000));
}

export function categoryFor(event: TimelineEvent): ActivityCategory {
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  if (haystack.includes("hook") || haystack.includes("pre_tool_use") || haystack.includes("post_tool_use")) {
    return "hooks";
  }
  if (haystack.includes("skill") || haystack.includes("plugin") || haystack.includes("/skills/")) {
    return "skills";
  }
  if (event.kind === "thought") return "reasoning";
  if (event.kind === "plan") return "plan";
  if (event.kind === "context" || haystack.includes("compact") || haystack.includes("memory")) {
    return "context";
  }
  if (["permission", "question", "interaction"].some((item) => haystack.includes(item))) {
    return "interactions";
  }
  if (["read", "write", "edit", "search", "list", "file", "fetch"].some((item) => haystack.includes(item))) {
    return "files";
  }
  if (isCommandEvent(event) || ["execute", "command", "shell", "bash", "terminal", "background_task", "build"].some((item) => haystack.includes(item))) {
    return "commands";
  }
  if (["compact", "memory", "retry", "session", "turn_completed", "system"].some((item) => haystack.includes(item))) {
    return "system";
  }
  return "other";
}

export function isSubagentEvent(event: TimelineEvent) {
  if (isSubagentNoise(event) || isSubagentLifecycle(event)) return false;
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  return event.kind === "subagent" || /spawn_subagent/.test(haystack);
}

export function isSubagentLifecycle(event: TimelineEvent) {
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  return /subagent spawned|subagent progress|subagent finished|subagent_spawned|subagent_progress|subagent_finished/.test(
    haystack,
  );
}

export function isSubagentNoise(event: TimelineEvent) {
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  return event.kind === "subagent_poll" || /get_command_or_subagent|kill_command_or_subagent/.test(haystack);
}

export function isSubagentUpdate(type: string) {
  return /^subagent_(spawned|progress|finished)$/i.test(String(type || "").trim());
}

function readRecord(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function applySubagentUpdate(
  events: TimelineEvent[],
  update: Record<string, unknown>,
  type: string,
): TimelineEvent[] | null {
  if (!isSubagentUpdate(type)) return null;
  const id = String(update.subagent_id || update.subagentId || update.child_session_id || update.childSessionId || "").trim();
  if (!id) return null;
  const key = `subagent-${id}`;
  const prev = events.find((item) => item.id === key);
  const rec = readRecord(prev?.input);
  const description = String(update.description || rec.description || update.title || prev?.title || "").trim();
  const agentType = String(update.subagent_type || update.subagentType || update.role || rec.subagent_type || "").trim();
  const activity = String(
    update.activity || update.message || update.last_tool || update.lastTool || update.tool || "",
  ).trim();
  const steps = Array.isArray(rec.steps) ? rec.steps.map((item) => String(item)) : [];
  if (type === "subagent_spawned" && !steps.includes("spawned")) steps.push("spawned");
  if (activity && activity !== steps[steps.length - 1]) steps.push(activity);
  const status =
    type === "subagent_finished"
      ? String(update.status || "completed")
      : String(update.status || prev?.status || "in_progress");
  const next = {
    ...rec,
    subagent_id: id,
    description,
    subagent_type: agentType,
    model: String(update.model || rec.model || ""),
    activity: activity || rec.activity || "",
    steps: steps.slice(-10),
    turns: update.turns ?? rec.turns,
    tool_calls: update.tool_calls ?? update.toolCalls ?? rec.tool_calls,
    duration_ms: update.duration_ms ?? update.durationMs ?? rec.duration_ms,
  };
  const output =
    type === "subagent_finished"
      ? String(update.output || prev?.output || "")
      : prev?.output;
  const index = events.findIndex((item) => item.id === key);
  const event: TimelineEvent = {
    id: key,
    kind: "subagent",
    title: description || "Subagent",
    status,
    input: JSON.stringify(next),
    output: output || undefined,
  };
  if (index >= 0) {
    const copy = [...events];
    copy[index] = { ...copy[index], ...event };
    return copy;
  }
  return [...events, event];
}

export function isImageGenEvent(event: TimelineEvent) {
  // Kind/title only. Scanning output matched any 503 that mentioned grok-imagine-image.
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  if (/image[_-]?gen|imagegen|generate[- ]?image|文生图|文生圖|生成图片|生成圖片/.test(haystack)) return true;
  return /\bimagine\b/.test(haystack) && !haystack.includes("images/");
}

export function visibleEvents(events: TimelineEvent[]) {
  return events.filter((event) => {
    if (
      isEditEvent(event) ||
      isCommandEvent(event) ||
      isThoughtEvent(event) ||
      isExploreEvent(event) ||
      isImageGenEvent(event) ||
      isSubagentEvent(event) ||
      isSubagentNoise(event) ||
      isSubagentLifecycle(event)
    ) {
      return false;
    }
    if (event.kind === "extension" && REDUNDANT.has(normalize(event.title))) return false;
    if (
      /^(tool call|工具调用|工具呼叫)$/i.test(event.title.trim()) &&
      !readableToolText(event.input) &&
      !readableToolText(event.output) &&
      !event.diffs?.length
    ) {
      return false;
    }
    return categoryFor(event) !== "system";
  });
}

export function groupRuns(events: TimelineEvent[]): ActivityRun[] {
  const result: ActivityRun[] = [];
  for (const event of visibleEvents(events)) {
    const category = categoryFor(event);
    const last = result[result.length - 1];
    if (last && last.category === category) {
      last.events.push(event);
    } else {
      result.push({
        id: `${event.id}-${result.length}`,
        category,
        events: [event],
      });
    }
  }
  return result;
}

export function statusLabel(status: string, lang: Lang) {
  const copy = translate(lang);
  const value = status.toLowerCase();
  if (value === "completed" || value === "success") return copy.statusDone;
  if (value === "failed" || value === "error") return copy.statusFailed;
  if (value === "pending") return copy.statusPending;
  if (value === "in_progress" || value === "running") return copy.statusRunning;
  if (value === "approved") return copy.statusApproved;
  if (value === "cancelled") return copy.statusCancelled;
  return status;
}

export function eventProgress(event: TimelineEvent) {
  const status = (event.status || "").toLowerCase();
  if (status.includes("fail") || status.includes("error")) return 100;
  if (status.includes("complete") || status.includes("success")) return 100;
  if (status.includes("cancel")) return 100;
  if (status.includes("pending")) return 12;
  if (status.includes("in_progress") || status.includes("running")) return 62;
  return event.output || event.input ? 100 : 28;
}

export function eventIconKind(event: TimelineEvent) {
  if (event.kind === "thought") return "brain";
  if (event.kind === "plan") return "plan";
  if (event.kind === "compaction" || event.kind === "context") return "context";
  if (event.kind === "hook") return "hooks";
  if (event.kind === "permission" || event.kind === "question" || event.kind === "interaction") {
    return "permission";
  }
  const title = `${event.kind} ${event.title}`.toLowerCase();
  if (title.includes("shell") || title.includes("terminal") || title.includes("command") || title.includes("execute") || title.includes("build") || title.includes("compile")) {
    return "terminal";
  }
  if (title.includes("search")) return "search";
  if (title.includes("read") || title.includes("file") || title.includes("edit") || title.includes("write")) {
    return "file";
  }
  if (title.includes("skill")) return "skills";
  return "tool";
}

function normalize(value: string) {
  return value.trim().replace(/_/g, " ").toLowerCase();
}

export function jsonText(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (!text || text === "{}" || text === "[]" || text === "null") return undefined;
    return text;
  } catch {
    return String(value);
  }
}

export function isRedundantExtension(name: string) {
  return REDUNDANT.has(normalize(name));
}
