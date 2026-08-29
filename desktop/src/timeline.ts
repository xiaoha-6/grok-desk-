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

export function isCommandEvent(event: TimelineEvent) {
  if (isEditEvent(event)) return false;
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  return [
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
    "task_",
  ].some((item) => haystack.includes(item));
}

export function commandTitle(event: TimelineEvent, lang: Lang) {
  const copy = translate(lang);
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  if (haystack.includes("compile") || haystack.includes("build") || haystack.includes("cargo") || haystack.includes("pnpm")) {
    return copy.cmdBuild;
  }
  if (haystack.includes("terminal") || haystack.includes("shell") || haystack.includes("bash")) {
    return copy.cmdTerminal;
  }
  return copy.cmdCommand;
}

export function editTitle(event: TimelineEvent) {
  const path = event.diffs?.find((item) => item.path)?.path || "";
  const name = path.split("/").filter(Boolean).pop() || path;
  return name ? `Edit ${name}` : "Edit";
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
  if (["execute", "command", "shell", "bash", "terminal", "background_task", "task_"].some((item) => haystack.includes(item))) {
    return "commands";
  }
  if (["compact", "memory", "retry", "session", "turn_completed", "system"].some((item) => haystack.includes(item))) {
    return "system";
  }
  return "other";
}

export function isImageGenEvent(event: TimelineEvent) {
  // Kind/title only. Scanning output matched any 503 that mentioned grok-imagine-image.
  const haystack = `${event.kind} ${event.title}`.toLowerCase();
  if (/image[_-]?gen|imagegen|generate[- ]?image|文生图|文生圖|生成图片|生成圖片/.test(haystack)) return true;
  return /\bimagine\b/.test(haystack) && !haystack.includes("images/");
}

export function visibleEvents(events: TimelineEvent[]) {
  return events.filter((event) => {
    if (isEditEvent(event) || isCommandEvent(event) || isImageGenEvent(event)) return false;
    if (event.kind === "extension" && REDUNDANT.has(normalize(event.title))) return false;
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
