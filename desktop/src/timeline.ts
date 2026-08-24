import type { TimelineEvent } from "./types";

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

export function categoryTitle(category: ActivityCategory, lang: "zh" | "en") {
  const zh: Record<ActivityCategory, string> = {
    reasoning: "思考过程",
    skills: "Skills 与扩展",
    files: "文件与搜索",
    commands: "命令与任务",
    hooks: "Hooks",
    context: "上下文与记忆",
    plan: "执行计划",
    interactions: "权限与交互",
    system: "运行与系统",
    other: "其他操作",
  };
  const en: Record<ActivityCategory, string> = {
    reasoning: "Thinking",
    skills: "Skills & extensions",
    files: "Files & search",
    commands: "Commands & tasks",
    hooks: "Hooks",
    context: "Context & memory",
    plan: "Plan",
    interactions: "Permissions",
    system: "Runtime",
    other: "Other",
  };
  return lang === "en" ? en[category] : zh[category];
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

export function visibleEvents(events: TimelineEvent[]) {
  return events.filter((event) => {
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

export function statusLabel(status: string, lang: "zh" | "en") {
  const value = status.toLowerCase();
  if (value === "completed" || value === "success") return lang === "en" ? "Done" : "完成";
  if (value === "failed" || value === "error") return lang === "en" ? "Failed" : "失败";
  if (value === "pending") return lang === "en" ? "Pending" : "等待";
  if (value === "in_progress" || value === "running") return lang === "en" ? "Running" : "运行中";
  if (value === "approved") return lang === "en" ? "Approved" : "已允许";
  if (value === "cancelled") return lang === "en" ? "Cancelled" : "已取消";
  return status;
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
  if (title.includes("shell") || title.includes("terminal") || title.includes("command") || title.includes("execute")) {
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
