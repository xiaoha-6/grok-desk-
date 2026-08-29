import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  extractMessageMedia,
  hydrateHistoryMedia,
  isGeneratedImageProbe,
  isImageGenBusy,
  isImageProbeEvent,
  mergeMessageMedia,
  wantsImageGen,
  isDirectImagePrompt,
} from "./ChatImage";
import { ThinkingOrb, agentOrbForMessage } from "./components/thinking-orbs/ThinkingOrbs";
import { TranscriptRow, type TranscriptRowActions } from "./TranscriptRow";
import { extractFileDiffs } from "./diff";
import {
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCheck,
  IconCompose,
  IconCodePane,
  IconPanelLeft,
  IconFolder,
  IconFile,
  IconGlobe,
  IconLaptop,
  IconChat,
  IconMore,
  IconPlus,
  IconGauge,
  IconGear,
  IconBolt,
  IconInspector,
  IconPerson,
  IconPencil,
  IconPlan,
  IconRefresh,
  IconSearch,
  IconInfinity,
  IconSidebar,
  GrokMark,
  IconStop,
  IconTerminal,
  IconSsh,
} from "./icons";
import { detectLang, fill, htmlLang, parseLang, t as translate, type Copy } from "./i18n";
import {
  chordsMatch,
  formatChord,
  isImeEvent,
  resolvedBindings,
  withShortcut,
} from "./keybindings";
import { MorphingRings } from "./MorphingRings";
import { MarkdownPreview } from "./MarkdownPreview";
import { ModelPicker } from "./ModelPicker";
import { Select } from "./Select";
import { QuickOpen } from "./QuickOpen";
import { SettingsView } from "./SettingsView";
import type { AgentTermJob, PanelChannel } from "./TerminalPanel";
import type { RunJob } from "./launch";
import { isCommandEvent, isImageGenEvent, isRedundantExtension, jsonText } from "./timeline";
import {
  allSlashItems,
  filterSlashItems,
  parseSlashInput,
  slashQuery,
  wrapSkillPrompt,
} from "./slash";
import {
  canonicalModelId,
  defaultSettings,
  EFFORTS,
  mergeModelOptions,
  normalizePermissionMode,
  PERMISSION_MODES,
  permissionModeHint,
  permissionModeShort,
  type AccountRecord,
  type AccountState,
  type AcpTurnDone,
  type AcpUpdate,
  type AppSettings,
  type CatalogModel,
  type ChatMessage,
  type ContextUsage,
  type Conversation,
  type FileDiff,
  type ImportResult,
  type Lang,
  type LocalSessionHistory,
  type LocalSessionSummary,
  type MessageMedia,
  type ModelCatalog,
  type PendingPermission,
  type PendingPlan,
  type PendingQuestion,
  type PermissionOption,
  type AgentQuestion,
  type ProjectRecord,
  type PromptAttachment,
  type RelayImport,
  type RelayQuota,
  type RuntimeStatus,
  type SessionInfo,
  type SettingsPage,
  type SkillRecord,
  type SshConfigHost,
  type SshProbe,
  type SshTarget,
  type SnapshotFile,
  type WorkspaceEntry,
  type Theme,
  type TimelineEvent,
  type View,
} from "./types";

const LEGACY_CONTEXT_WINDOW = 225000;
const DEFAULT_CONTEXT_WINDOW = 500000;
const HISTORY_PAGE = 80;
const VIEW_PAGE = 80;
const MAX_ATTACHMENTS = 8;
const MAX_PENDING_FILES = 16;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type PendingFile = {
  id: string;
  path: string;
  name: string;
  mention: string;
  isDir: boolean;
};

type LocalPathInfo = {
  path: string;
  name: string;
  isDir: boolean;
};

const STORAGE_KEY = "grokdesk.workspace.v3";
const LEGACY_KEYS = ["grokdesk.workspace.v2", "grokdesk.workspace.v1"];
const WorkspacePanel = lazy(() => import("./WorkspacePanel").then((mod) => ({ default: mod.WorkspacePanel })));
const TerminalPanel = lazy(() => import("./TerminalPanel").then((mod) => ({ default: mod.TerminalPanel })));

function uid() {
  return crypto.randomUUID();
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function samePath(a: string, b: string) {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

function isHomeLikePath(path: string, homeDir = "") {
  const normalized = normalizePath(path);
  if (!normalized) return true;
  if (normalized === "/" || /^[a-zA-Z]:$/.test(normalized)) return true;
  if (homeDir && samePath(normalized, homeDir)) return true;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 2 && (parts[0] === "Users" || parts[0] === "home")) return true;
  return false;
}

function usableWorkspace(path: string, homeDir = "") {
  const trimmed = path.trim();
  return isHomeLikePath(trimmed, homeDir) ? "" : trimmed;
}

function workspaceLabel(path: string, homeDir: string, homeWord: string) {
  if (!path) return homeWord;
  if (isHomeLikePath(path, homeDir)) return homeWord;
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || homeWord;
}

function emptySshTarget(): SshTarget {
  return { host: "", port: 22, user: "", remotePath: "", identityFile: "", auth: "key", password: "", alias: "" };
}

function sshWorkspaceId(target: SshTarget) {
  const user = target.user.trim() || "root";
  const host = target.host.trim();
  const port = target.port || 22;
  const path = target.remotePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `ssh://${user}@${host}:${port}/${path}`;
}

function isSshWorkspace(path: string) {
  return /^ssh:\/\//i.test(path.trim());
}

function parseSshWorkspace(path: string): SshTarget | null {
  const trimmed = path.trim();
  const match = trimmed.match(/^ssh:\/\/([^@]+)@([^:/]+):(\d+)\/(.*)$/i);
  if (!match) return null;
  const remote = `/${match[4]}`.replace(/\/+/g, "/") || "/";
  return {
    host: match[2],
    port: Number(match[3]) || 22,
    user: match[1],
    remotePath: remote === "//" ? "/" : remote,
    identityFile: "",
    auth: "key",
    password: "",
    alias: "",
  };
}

function sameSshHost(left: SshTarget, right: SshTarget) {
  return (
    left.host.trim() === right.host.trim() &&
    (left.port || 22) === (right.port || 22) &&
    (left.user.trim() || "root") === (right.user.trim() || "root")
  );
}

/** Recover a usable SSH target from conversation state, cwd, or recent hosts. */
function resolveConversationSsh(conversation: Conversation, hosts: SshTarget[] = []): SshTarget | null {
  const fromField = conversation.ssh?.host ? conversation.ssh : null;
  const fromCwd = isSshWorkspace(conversation.cwd) ? parseSshWorkspace(conversation.cwd) : null;
  const base = fromField || fromCwd;
  if (!base) return null;
  const saved = hosts.find((item) => sameSshHost(item, base));
  return {
    host: base.host.trim(),
    port: base.port || saved?.port || 22,
    user: base.user.trim() || saved?.user || "root",
    remotePath: (fromField?.remotePath || fromCwd?.remotePath || saved?.remotePath || "/").trim() || "/",
    identityFile: fromField?.identityFile || saved?.identityFile || "",
    auth: fromField?.auth || saved?.auth || "key",
    password: fromField?.password || saved?.password || "",
    alias: fromField?.alias || saved?.alias || "",
  };
}

function fromSshConfigHost(item: SshConfigHost): SshTarget {
  return {
    host: item.host || item.alias,
    port: item.port || 22,
    user: item.user || "root",
    remotePath: item.remotePath || "",
    identityFile: item.identityFile || "",
    auth: "key",
    password: "",
    alias: item.alias,
  };
}

function sshLabel(target: SshTarget, path = target.remotePath) {
  const folder = workspaceLabel(path, "", target.host || "ssh");
  return `${target.user || "root"}@${target.host}:${folder}`;
}

function workspaceKey(cwd = "", ssh?: SshTarget | null) {
  if (ssh?.host) return sshWorkspaceId(ssh);
  return cwd || "";
}

function sameWorkspace(
  left: { cwd?: string; ssh?: SshTarget | null },
  right: { cwd?: string; ssh?: SshTarget | null },
) {
  return workspaceKey(left.cwd || "", left.ssh) === workspaceKey(right.cwd || "", right.ssh);
}

function hydrateProjects(list: ProjectRecord[] | undefined): ProjectRecord[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const next: ProjectRecord[] = [];
  for (const item of list) {
    const id = String(item?.id || "").trim();
    const cwd = String(item?.cwd || "").trim();
    if (!id || !cwd || seen.has(id)) continue;
    seen.add(id);
    next.push({
      id,
      name: String(item.name || "").trim() || workspaceLabel(cwd, "", "project"),
      cwd,
      ssh: item.ssh?.host ? item.ssh : isSshWorkspace(cwd) ? parseSshWorkspace(cwd) : null,
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now(),
    });
  }
  return next;
}

function isMissingCredentials(raw: string) {
  return /GROKDESK_NO_CREDENTIALS|还没有可用的登录或 API Key|還沒有可用的登入或 API Key|no login or api key/i.test(
    raw,
  );
}

function localizeThrown(error: unknown, copy: Copy) {
  const msg = String((error as { message?: string })?.message ?? error ?? "").trim();
  if (!msg) return copy.acpRequestFailed;
  if (/GROKDESK_IMAGE_TOO_LARGE|图片太大|圖片太大/i.test(msg)) return copy.imageTooLarge;
  if (/GROKDESK_IMAGE_READ_FAILED|无法读取图片|無法讀取圖片/i.test(msg)) return copy.cannotReadImage;
  if (isMissingCredentials(msg)) return copy.needCredentials;
  return msg;
}

function isContextTooLarge(raw?: string) {
  return /context_too_large|context too large|请求内容过大|上下文.{0,8}过大|超過了可處理|超过了可处理/i.test(
    String(raw || ""),
  );
}

function friendlyError(raw: string, copy: Copy) {
  const text = String(raw || "")
    .replace(/^GROKDESK_NO_CREDENTIALS:\s*/i, "")
    .trim() || copy.acpRequestFailed;
  if (isContextTooLarge(text)) return copy.contextTooLarge;
  if (/上游/.test(text) || /upstream (?:service )?(?:temporarily )?unavailable/i.test(text)) {
    return text;
  }
  if (/502|bad gateway|temporarily unavailable/i.test(text)) {
    return `${text}\n${copy.upstreamUnavailable}`;
  }
  if (/503/.test(text)) {
    return `${text}\n${copy.upstreamOverloaded}`;
  }
  if (/weekly limit|run out of credits|free usage limit|status 402|额度不足|周限额|額度不足|週限額/i.test(text)) {
    return `${text}\n${copy.officialQuotaHint}`;
  }
  return text;
}

function isUserCancelError(raw?: string) {
  const text = String(raw || "").trim();
  if (!text) return false;
  return /连接已取消|連線已取消|cancelled by user|session\/cancel|user cancel|canceled by the user|prompt cancelled|turn cancelled/i.test(
    text,
  );
}

function sealAssistantMessage(message: ChatMessage, options?: { error?: string; stopped?: boolean; copy?: Copy }): ChatMessage {
  const cancelled = Boolean(options?.stopped || isUserCancelError(options?.error));
  const err = options?.error && !cancelled ? friendlyError(options.error, options.copy || translate("zh")) : undefined;
  const thoughtOut =
    message.thought && message.thought.length > 8000 ? message.thought.slice(-8000) : message.thought;
  return {
    ...message,
    streaming: false,
    local: true,
    queued: false,
    stopped: cancelled || Boolean(message.stopped),
    error: err || (cancelled ? undefined : message.error),
    events: (message.events || []).map((event) => {
      let next = event;
      if (event.kind === "thought" && thoughtOut) {
        next = { ...event, output: thoughtOut };
      }
      if (!cancelled && err && isImageGenEvent(next)) {
        const status = String(next.status || "").toLowerCase();
        if (!status || /pending|in_progress|running|started/.test(status)) {
          return { ...next, status: "failed", output: next.output || err };
        }
      }
      if (!cancelled) return next;
      const status = String(next.status || "").toLowerCase();
      if (!status || /complete|success|approved|fail|error|cancel/.test(status)) return next;
      return { ...next, status: "cancelled" };
    }),
  };
}

function importSig(payload: RelayImport) {
  return `${payload.endpoint}\n${payload.apiKey}\n${payload.model}\n${payload.name}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lastUserMessageText(messages: ChatMessage[] | undefined) {
  return [...(messages || [])].reverse().find((item) => item.role === "user")?.text || "";
}

function pickPermissionChoice(options: Array<Record<string, unknown>> | undefined, reject: boolean) {
  return (options || []).find((option) => {
    const hay = `${option.optionId || option.option_id || option.id || ""} ${option.kind || ""} ${option.name || ""}`;
    return reject ? /reject|deny|cancel/i.test(hay) : /allow|accept|approve/i.test(hay);
  });
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      const joined = value.join(" ").trim();
      if (joined) return joined;
    }
  }
  return "";
}

function parseJsonRecord(text?: string): Record<string, unknown> | undefined {
  const raw = text?.trim();
  if (!raw || (raw[0] !== "{" && raw[0] !== "[")) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return asRecord(parsed[0]);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function parseAskQuestions(params: Record<string, unknown>): AgentQuestion[] {
  const readList = (raw: unknown): AgentQuestion[] => {
    const rec = asRecord(raw);
    const list = (rec?.questions as unknown[]) || (Array.isArray(raw) ? raw : []);
    return list
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((value) => ({
        id: value.id ? String(value.id) : undefined,
        question: String(value.question || value.prompt || value.header || value.title || ""),
        multiSelect: Boolean(value.multiSelect || value.multi_select),
        options: (((value.options as unknown[]) || [])
          .map((option) => asRecord(option))
          .filter((option): option is Record<string, unknown> => Boolean(option))
          .map((option) => ({
            id: option.id ? String(option.id) : undefined,
            label: String(option.label || option.name || option.id || ""),
            description: String(option.description || option.detail || ""),
            preview: option.preview ? String(option.preview) : undefined,
          }))
          .filter((option) => option.label)),
      }))
      .filter((item) => item.question || item.options.length);
  };
  const nested = asRecord(params.params);
  for (const source of [params, nested, asRecord(params.request)]) {
    if (!source) continue;
    const found = readList(source);
    if (found.length) return found;
  }
  const tool = asRecord(params.toolCall) || asRecord(params.tool_call);
  const input = tool?.rawInput ?? tool?.raw_input ?? tool?.input ?? params.rawInput ?? params.input;
  if (typeof input === "string") {
    try {
      return readList(JSON.parse(input) as unknown);
    } catch {
      return [];
    }
  }
  return readList(input);
}

function askQuestionKey(question: AgentQuestion) {
  return question.id || question.question;
}

function withAskOtherOption(question: AgentQuestion, otherLabel: string, otherHint: string): AgentQuestion {
  if (question.options.some((option) => /^(other|其他|其它)$/i.test(option.label.trim()))) {
    return question;
  }
  return {
    ...question,
    options: [...question.options, { label: otherLabel, description: otherHint }],
  };
}

function parsePermissionGate(params: Record<string, unknown>): PermissionOption[] {
  const options = ((params.options as Array<Record<string, unknown>>) || []).map((option) => ({
    id: String(option.optionId || option.option_id || option.id || ""),
    name: String(option.name || option.label || ""),
    kind: String(option.kind || ""),
  })).filter((option) => option.id);
  const gate = options.filter((option) => /allow|reject|deny|cancel/i.test(`${option.id} ${option.kind} ${option.name}`));
  return gate.length ? gate : [];
}

function permissionOptionKind(option: { id: string; kind: string; name: string }) {
  const hay = `${option.id} ${option.kind} ${option.name}`.toLowerCase();
  if (/differently|tell grok|something else|换个做法|換個做法/.test(hay)) return "redirect";
  if (/reject|deny|cancel|拒绝|拒絕/.test(hay)) return "reject";
  if (/session|always|allow_always|allow-session/.test(hay)) return "session";
  if (/allow|proceed|允许|允許/.test(hay)) return "allow";
  return "other";
}

function permissionOptionLabel(option: PermissionOption, copy: Copy) {
  switch (permissionOptionKind(option)) {
    case "reject":
      return copy.reject;
    case "redirect":
      return copy.tellGrokDifferently;
    case "session":
      return copy.allowSession;
    case "allow":
      return copy.allowOnce;
    default:
      return option.name;
  }
}

function permissionHeadline(title: string, command: string, copy: Copy) {
  if (/^execute\b/i.test(title) || command) return copy.runCommand;
  if (title.length > 88) return copy.needApprove;
  return title || copy.needApprove;
}

function permissionCommandText(title: string, command?: string) {
  const fromCmd = (command || "").trim();
  if (fromCmd) return fromCmd;
  const wrapped = title.match(/^execute\s+['`]([\s\S]+)['`]\s*$/i);
  if (wrapped?.[1]) return wrapped[1].trim();
  return title.trim();
}

function isAskToolTitle(title: string) {
  return /(?:^|\b)ask\b/i.test(title.trim());
}

function extractShellCommand(inputRec?: Record<string, unknown>, input?: string) {
  const rec = inputRec || parseJsonRecord(input) || {};
  const nested = asRecord(rec.command) || asRecord(rec.cmd);
  return firstString(
    rec.command,
    rec.cmd,
    rec.script,
    rec.bash,
    rec.shell_command,
    rec.shellCommand,
    rec.commandLine,
    rec.command_line,
    rec.argv,
    nested?.command,
    nested?.cmd,
    nested?.script,
    parseJsonRecord(input)?.command,
    parseJsonRecord(input)?.cmd,
  );
}

function extractShellOutput(output?: string) {
  const raw = (output || "").trim();
  if (!raw) return "";
  const rec = parseJsonRecord(raw);
  if (!rec) return raw;
  const nested = rec.content;
  const fromFields = firstString(rec.output, rec.stdout, rec.stderr, rec.text, rec.result, rec.content);
  if (fromFields && typeof rec.content !== "object") return fromFields;
  if (Array.isArray(nested)) {
    const lines = nested
      .map((item) => {
        const row = asRecord(item);
        return firstString(row?.text, row?.output, row?.stdout, typeof item === "string" ? item : "");
      })
      .filter(Boolean);
    if (lines.length) return lines.join("\n");
  }
  const nestedRec = asRecord(nested);
  const nestedText = firstString(nestedRec?.text, nestedRec?.output, nestedRec?.stdout);
  return nestedText || fromFields || raw;
}

function terminalJobTitle(command: string, fallback: string) {
  const line = (command || fallback).split("\n")[0].trim();
  if (line.length <= 28) return line || fallback;
  return `${line.slice(0, 27)}…`;
}

function upsertAgentJob(current: AgentTermJob[], next: AgentTermJob): AgentTermJob[] {
  const existing = current.find((item) => item.id === next.id);
  if (!existing) return [...current, next];
  return current.map((item) =>
    item.id === next.id
      ? {
          ...item,
          title: next.title || item.title,
          command: next.command || item.command,
          output: next.output || item.output,
          status: next.status || item.status,
        }
      : item,
  );
}

function agentJobFromEvent(event: TimelineEvent): AgentTermJob | null {
  if (!isCommandEvent(event)) return null;
  const id = event.id.replace(/^tool-/, "");
  const command = extractShellCommand(parseJsonRecord(event.input), event.input);
  return {
    id,
    title: terminalJobTitle(command, event.title),
    command: command || event.title,
    output: extractShellOutput(event.output),
    status: event.status || "pending",
  };
}

function contentText(update: Record<string, unknown>) {
  const content = asRecord(update.content);
  return String(content?.text ?? update.text ?? "");
}

function toolMeta(update: Record<string, unknown>) {
  const meta = asRecord(update._meta);
  return asRecord(meta?.["x.ai/tool"]) || asRecord(meta?.tool);
}

const MAX_LIVE_EVENTS = 80;
let uiLang: Lang = "zh";

function compactEvents(events: TimelineEvent[], copy: Copy = translate(uiLang)): TimelineEvent[] {
  if (events.length <= MAX_LIVE_EVENTS) return events;
  const dropped = events.length - MAX_LIVE_EVENTS;
  return [
    {
      id: "folded-events",
      kind: "context",
      title: fill(copy.foldedSteps, { n: dropped }),
      status: "completed",
    },
    ...events.slice(-MAX_LIVE_EVENTS),
  ];
}

function upsertEvent(events: TimelineEvent[], event: TimelineEvent, copy: Copy = translate(uiLang)) {
  const index = events.findIndex((item) => item.id === event.id);
  if (index >= 0) {
    const next = [...events];
    next[index] = {
      ...next[index],
      ...event,
      input: event.input ?? next[index].input,
      output: event.output ?? next[index].output,
      diffs: event.diffs?.length ? event.diffs : next[index].diffs,
    };
    return compactEvents(next, copy);
  }
  return compactEvents([...events, event], copy);
}

function extensionKind(method: string) {
  const value = method.toLowerCase();
  if (value.includes("hook")) return "hook";
  if (value.includes("skill") || value.includes("plugin")) return "skill";
  if (value.includes("memory") || value.includes("compact")) return "context";
  if (value.includes("retry") || value.includes("session") || value.includes("turn_")) return "system";
  if (value.includes("task")) return "background_task";
  return "extension";
}

function extensionTitle(method: string, params: Record<string, unknown>, lang: Lang) {
  const copy = translate(lang);
  if (method.toLowerCase().includes("hook")) {
    const event = String(params.event_name || params.eventName || "hook");
    const tool = params.tool_name || params.toolName;
    return `Hook · ${event}${tool ? ` · ${tool}` : ""}`;
  }
  const titles: Record<string, string> = {
    task_backgrounded: copy.taskBackgrounded,
    task_completed: copy.taskCompleted,
    retry_state: copy.runtimeRetrying,
    memory_flush_started: copy.writingMemory,
    memory_flush_completed: copy.memoryWritten,
    turn_completed: copy.turnCompleted,
    session_recap: copy.sessionRecap,
  };
  return titles[method] || method.replace(/_/g, " ");
}

function formatTokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

function permissionModeIcon(mode: string, size = 14) {
  switch (normalizePermissionMode(mode)) {
    case "acceptEdits":
      return <IconPencil size={size} />;
    case "plan":
      return <IconPlan size={size} />;
    case "auto":
      return <IconBolt size={size} />;
    case "bypassPermissions":
      return <IconInfinity size={size} />;
    default:
      return <IconChat size={size} />;
  }
}

function migrateSettings(saved?: Partial<AppSettings>): AppSettings {
  const merged = { ...defaultSettings(), ...saved };
  if (!saved?.contextWindowTokens || saved.contextWindowTokens === LEGACY_CONTEXT_WINDOW) {
    merged.contextWindowTokens = DEFAULT_CONTEXT_WINDOW;
  }
  merged.keybindings = saved?.keybindings && typeof saved.keybindings === "object" ? saved.keybindings : {};
  return merged;
}

function isGenericTitle(title: string) {
  const value = (title || "").trim();
  return !value || value === "Grok Session" || value === translate("zh").newChat || value === translate("zh-Hant").newChat || value === translate("en").newChat;
}

function mergeConversationMessages(left: ChatMessage[] = [], right: ChatMessage[] = []): ChatMessage[] {
  if (!left.length) return right;
  if (!right.length) return left;
  const byId = new Map<string, ChatMessage>();
  const order: string[] = [];
  const push = (item: ChatMessage) => {
    // Never collapse two different bubbles just because the text is the same
    // ("hi" sent twice, or a new send matching an older history "hi").
    const key = item.id || `tmp:${order.length}:${item.role}:${item.queued ? 1 : 0}:${item.streaming ? 1 : 0}`;
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, item);
      order.push(key);
      return;
    }
    const preferIncoming =
      (item.streaming && !prev.streaming) ||
      Boolean(item.local && !prev.local) ||
      ((item.text?.length || 0) > (prev.text?.length || 0)) ||
      ((item.thought?.length || 0) > (prev.thought?.length || 0)) ||
      ((item.events?.length || 0) > (prev.events?.length || 0)) ||
      ((item.media?.length || 0) > (prev.media?.length || 0));
    byId.set(key, {
      ...prev,
      ...(preferIncoming ? item : {}),
      id: prev.id || item.id,
      local: Boolean(prev.local || item.local),
      queued: Boolean(item.queued ?? prev.queued),
      stopped: Boolean(prev.stopped || item.stopped),
      text: (item.text?.length || 0) >= (prev.text?.length || 0) ? item.text : prev.text,
      thought: (item.thought?.length || 0) >= (prev.thought?.length || 0) ? item.thought : prev.thought,
      events: (item.events?.length || 0) >= (prev.events?.length || 0) ? item.events : prev.events,
      media: (item.media?.length || 0) >= (prev.media?.length || 0) ? item.media : prev.media,
      error: preferIncoming ? item.error ?? prev.error : prev.error ?? item.error,
    });
  };
  const pinned = [...left, ...right].filter((item) => item.local || item.queued);
  const rest = [...left, ...right].filter((item) => !item.local && !item.queued);
  for (const item of rest) push(item);
  for (const item of pinned) push(item);
  return order.map((key) => byId.get(key)!);
}

/** Keep sticky user bubbles in chronological place (above the live reply), not tacked on the end. */
function withStickyOutgoing(base: ChatMessage[], sticky: ChatMessage[]): ChatMessage[] {
  if (!sticky.length) return base;
  const stickyById = new Map(sticky.filter((item) => item.id).map((item) => [item.id, item]));
  const seen = new Set<string>();
  const next: ChatMessage[] = [];
  for (const item of base) {
    if (item.id && stickyById.has(item.id)) {
      next.push(stickyById.get(item.id)!);
      seen.add(item.id);
      continue;
    }
    next.push(item);
  }
  for (const item of sticky) {
    if (item.id && seen.has(item.id)) continue;
    if (item.queued) {
      next.push(item);
      continue;
    }
    const idx = next.findIndex((message) => message.role === "assistant" && message.streaming);
    if (idx >= 0) next.splice(idx, 0, item);
    else next.push(item);
  }
  return next;
}

function betterConversation(current: Conversation, incoming: Conversation) {
  const currentMsgs = current.messages?.length || 0;
  const incomingMsgs = incoming.messages?.length || 0;
  if (incomingMsgs !== currentMsgs) return incomingMsgs > currentMsgs;
  const currentGeneric = isGenericTitle(current.title);
  const incomingGeneric = isGenericTitle(incoming.title);
  if (currentGeneric !== incomingGeneric) return currentGeneric && !incomingGeneric;
  if ((incoming.updatedAt || 0) !== (current.updatedAt || 0)) {
    return (incoming.updatedAt || 0) > (current.updatedAt || 0);
  }
  return Boolean(incoming.grokSessionId) && !current.grokSessionId;
}

function combineConversations(current: Conversation, incoming: Conversation): Conversation {
  const winner = betterConversation(current, incoming) ? incoming : current;
  const loser = winner === incoming ? current : incoming;
  const sessionId = winner.grokSessionId || loser.grokSessionId || "";
  const stableId =
    (current.id && current.id !== sessionId ? current.id : "") ||
    (incoming.id && incoming.id !== sessionId ? incoming.id : "") ||
    current.id ||
    incoming.id;
  return {
    ...loser,
    ...winner,
    id: stableId,
    title: isGenericTitle(winner.title) && !isGenericTitle(loser.title) ? loser.title : winner.title,
    cwd: winner.cwd || loser.cwd,
    ssh: winner.ssh || loser.ssh || null,
    grokSessionId: sessionId || winner.grokSessionId || loser.grokSessionId,
    accountId: winner.accountId || loser.accountId,
    // Never drop bubbles from either side — length-based "winner" was swallowing just-sent user messages.
    messages: mergeConversationMessages(current.messages || [], incoming.messages || []),
    updatedAt: Math.max(winner.updatedAt || 0, loser.updatedAt || 0),
    archivedAt: winner.archivedAt ?? loser.archivedAt,
  };
}

function keepBetter(map: Map<string, Conversation>, key: string, item: Conversation) {
  const prev = map.get(key);
  map.set(key, prev ? combineConversations(prev, item) : item);
}

function hydrateConversation(item: Conversation): Conversation {
  const cwd = item.cwd || "";
  const ssh = item.ssh?.host ? item.ssh : isSshWorkspace(cwd) ? parseSshWorkspace(cwd) : null;
  return {
    ...item,
    title: item.title || "Grok Session",
    cwd,
    ssh,
    messages: (item.messages || []).map((message) => ({
      ...message,
      events: message.events || [],
      media: message.media || [],
      streaming: false,
      queued: Boolean(message.queued),
      local: Boolean(message.local),
      stopped: Boolean(message.stopped),
    })),
  };
}

function dedupeConversations(list: Conversation[]): Conversation[] {
  const byId = new Map<string, Conversation>();
  for (const item of list) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    keepBetter(byId, id, item);
  }
  return [...byId.values()].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

function persistConversations(list: Conversation[]): Conversation[] {
  return dedupeConversations(list).map((item) => ({
    ...item,
    messages: persistMessageWindow(item.messages).map((message) => ({
      ...message,
      streaming: false,
      thought: (message.thought || "").slice(-8000),
      // Queued drafts stay local. Completed turns drop the flag so session history
      // can reload and replace a stale assistant-only window.
      queued: Boolean(message.queued),
      local: Boolean(message.queued),
      stopped: Boolean(message.stopped),
      events: (message.events || []).slice(-16).map((event) =>
        event.kind === "thought" && event.output && event.output.length > 8000
          ? { ...event, output: event.output.slice(-8000) }
          : event,
      ),
      media: (message.media || []).map((media) => ({ ...media, data: undefined })),
    })),
  }));
}

/** Keep a balanced recent window so user turns are not dropped behind assistant fragments. */
function persistMessageWindow(messages: ChatMessage[], limit = 80): ChatMessage[] {
  if (messages.length <= limit) return messages;
  let start = messages.length - limit;
  // Prefer starting on a user bubble so the window does not open mid-turn.
  while (start > 0 && messages[start]?.role === "assistant") {
    start -= 1;
  }
  return messages.slice(start);
}

function resolveSelectedId(list: Conversation[], id: string | null) {
  if (id && list.some((item) => item.id === id && !item.archivedAt)) return id;
  if (id) {
    const match = list.find(
      (item) => !item.archivedAt && (item.grokSessionId === id || item.id === id),
    );
    if (match) return match.id;
  }
  return list.find((item) => !item.archivedAt)?.id ?? null;
}

function applyConversationUpdate(
  current: Conversation[],
  update: Conversation[] | ((list: Conversation[]) => Conversation[]),
) {
  const next = typeof update === "function" ? update(current) : update;
  const unique = dedupeConversations(next);
  const byId = new Map(unique.map((item) => [item.id, item]));
  for (const item of current) {
    const msgs = item.messages || [];
    const live = msgs.slice(-6).filter((message) => message.local || message.queued || message.streaming);
    if (!live.length) continue;
    const found = byId.get(item.id);
    if (!found) {
      byId.set(item.id, item);
      continue;
    }
    const missing = live.filter((message) => !found.messages.some((entry) => entry.id === message.id));
    if (missing.length) {
      byId.set(item.id, { ...found, messages: mergeConversationMessages(found.messages, missing) });
    }
  }
  const preserved = [...byId.values()].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  if (preserved.length === current.length && preserved.every((item, index) => item === current[index])) {
    return current;
  }
  return preserved;
}

type QueuedPrompt = {
  id: string;
  messageId: string;
  conversationId: string;
  text: string;
  displayText?: string;
  attachments: PromptAttachment[];
};

function mergeHistoryMessages(existing: ChatMessage[], incoming: ChatMessage[], prepend: boolean) {
  if (!incoming.length) return existing;
  const keep = existing.filter((item) => item.local || item.queued || item.streaming);
  // Initial history load replaces persisted transcript. Appending used to keep an
  // old assistant-only fragment window and hide the real user turns.
  if (!prepend) {
    return mergeConversationMessages(incoming, keep);
  }
  const rest = existing.filter((item) => !item.local && !item.queued && !item.streaming);
  return mergeConversationMessages([...incoming, ...rest], keep);
}

function mergeLocalSessions(list: Conversation[], summaries: LocalSessionSummary[]): Conversation[] {
  const unique = dedupeConversations(list);
  const known = new Set<string>();
  for (const item of unique) {
    if (item.id) known.add(item.id);
    if (item.grokSessionId) known.add(item.grokSessionId);
  }
  const seen = new Set<string>();
  const extras: Conversation[] = [];
  for (const item of summaries) {
    const sessionId = String(item.grokSessionId || item.id || "").trim();
    if (!sessionId || known.has(sessionId) || seen.has(sessionId)) continue;
    seen.add(sessionId);
    extras.push({
      id: sessionId,
      title: item.title || "Grok Session",
      cwd: item.cwd,
      grokSessionId: sessionId,
      messages: [],
      updatedAt: item.updatedAt,
      historyHasMore: true,
      historySkip: 0,
    });
  }
  const merged = unique.map((item) => {
    const summary = summaries.find(
      (entry) => entry.grokSessionId === item.grokSessionId,
    );
    if (!summary) return item;
    const untitled = isGenericTitle(item.title);
    return {
      ...item,
      title: untitled ? summary.title : item.title,
      cwd: item.cwd || summary.cwd,
      grokSessionId: item.grokSessionId || summary.grokSessionId,
      updatedAt: Math.max(item.updatedAt || 0, summary.updatedAt || 0),
      historyHasMore: item.historyHasMore !== false,
    };
  });
  return dedupeConversations([...merged, ...extras]);
}

function formatAmount(value: number) {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 100 || Number.isInteger(value)) return String(Math.round(value * 100) / 100);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatRelayQuota(quota: RelayQuota | null | undefined, copy: Copy) {
  if (!quota?.configured) return "";
  if (quota.remaining == null) return copy.quotaPending;
  if (quota.remaining < 0 || quota.remaining >= 99_000_000) return copy.relayUnlimited;
  const unit = quota.unit || "USD";
  return `${copy.remainingBalance} ${formatAmount(quota.remaining)} ${unit}`;
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(file.name);
}

function isImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(path);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAbsoluteLocalPath(path: string) {
  const normalized = normalizePath(path);
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
}

function parentDir(path: string) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? normalized : normalized.slice(0, index);
}

function mentionForDrop(absPath: string, workspaceRoot: string) {
  const abs = normalizePath(absPath);
  const root = normalizePath(workspaceRoot);
  if (root && (samePath(abs, root) || abs.toLowerCase().startsWith(`${root.toLowerCase()}/`))) {
    return abs.slice(root.length).replace(/^\/+/, "") || ".";
  }
  return abs;
}

function mentionReadTarget(cwd: string, mention: string) {
  const cleaned = mention.replace(/\\/g, "/");
  if (isAbsoluteLocalPath(cleaned)) {
    const name = cleaned.split("/").filter(Boolean).pop() || cleaned;
    return { root: parentDir(cleaned) || "/", path: name };
  }
  return { root: cwd, path: mention };
}

function appendMentions(text: string, mentions: string[]) {
  let next = text;
  for (const mention of mentions) {
    if (!mention) continue;
    const token = `@${mention}`;
    if (next.includes(token)) continue;
    next = next.trim() ? `${next.trimEnd()} ${token}` : token;
  }
  return next;
}

function stripMention(text: string, mention: string) {
  if (!mention) return text;
  return text
    .replace(new RegExp(`(^|\\s)@${escapeRegExp(mention)}(?=\\s|$)`, "g"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s+/, "");
}

function fileDropPath(file: File) {
  return String((file as File & { path?: string }).path || "").trim();
}

function fileToAttachment(file: File): Promise<PromptAttachment> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error("GROKDESK_IMAGE_TOO_LARGE"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve({
        mimeType: file.type || "image/png",
        data: comma >= 0 ? result.slice(comma + 1) : result,
        name: file.name || "paste.png",
      });
    };
    reader.onerror = () => reject(reader.error || new Error("GROKDESK_IMAGE_READ_FAILED"));
    reader.readAsDataURL(file);
  });
}

function mediaFromAttachment(item: PromptAttachment): MessageMedia {
  return {
    id: uid(),
    type: "image",
    mimeType: item.mimeType,
    data: item.data,
    name: item.name,
  };
}

function routingScore(account: AccountRecord) {
  if (account.quota?.weeklyRemainingPercent != null) return account.quota.weeklyRemainingPercent;
  if (account.quota?.monthlyRemaining != null) return account.quota.monthlyRemaining;
  return -1;
}

function pickRoutedAccount(accounts: AccountRecord[], settings: AppSettings, lastId?: string) {
  const loggedIn = accounts.filter((account) => account.enabled && account.loggedIn);
  const usable = loggedIn.filter(
    (account) => !account.quota?.error && (account.quota ? routingScore(account) > 0 : true),
  );
  const pool = usable.length ? usable : loggedIn;
  if (!pool.length) return undefined;
  if (settings.routingMode === "fixed") {
    return pool.find((account) => account.id === settings.preferredAccountId) || pool[0];
  }
  if (settings.routingMode === "sequential") return pool[0];
  if (settings.routingMode === "roundRobin") {
    const index = pool.findIndex((account) => account.id === lastId);
    if (index < 0) return pool[0];
    return pool[(index + 1) % pool.length];
  }
  return [...pool].sort((a, b) => routingScore(b) - routingScore(a))[0];
}

type PersistShape = {
  lang?: Lang;
  theme?: Theme;
  model?: string;
  cwd?: string;
  selectedId?: string | null;
  conversations?: Conversation[];
  projects?: ProjectRecord[];
  activeProjectId?: string | null;
  sidebarGroupMode?: "project" | "list";
  form?: Partial<RelayImport>;
  sidebarWidth?: number;
  workspaceWidth?: number;
  showWorkspace?: boolean;
  showTerminal?: boolean;
  showSidebar?: boolean;
  workspaceSide?: "left" | "right";
  terminalHeight?: number;
  settings?: Partial<AppSettings>;
  availableModels?: CatalogModel[];
  relayReady?: boolean;
};

function loadPersist(): PersistShape {
  try {
    for (const key of [STORAGE_KEY, ...LEGACY_KEYS]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      return JSON.parse(raw) as PersistShape;
    }
    return {};
  } catch {
    return {};
  }
}

function mentionQuery(text: string, cursor: number) {
  const before = text.slice(0, cursor);
  const match = before.match(/(^|[\s])@([^\s@]*)$/);
  if (!match) return null;
  return { start: cursor - match[2].length - 1, query: match[2] };
}

function checkpointKey(conversationId: string, userId: string) {
  return `${conversationId}:${userId}`;
}

function findLast<T>(items: T[] | undefined, pred: (item: T) => boolean): T | undefined {
  if (!items?.length) return undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (pred(items[i])) return items[i];
  }
  return undefined;
}

function previousUserId(messages: ChatMessage[], assistantId: string) {
  let prev = "";
  for (const message of messages) {
    if (message.role === "user") prev = message.id;
    if (message.id === assistantId) return prev;
  }
  return prev;
}

function relPath(cwd: string, raw: string) {
  const path = String(raw || "").replace(/\\/g, "/");
  const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path) return "";
  if (root && (path === root || path.startsWith(`${root}/`))) return path.slice(root.length + 1);
  return path.replace(/^\.\//, "");
}

async function expandPromptContext(text: string, cwd: string, ssh: SshTarget | null) {
  let next = text.trim();
  const askedImage = wantsImageGen(text);
  if (!askedImage) {
    next +=
      "\n\n<tool_policy>用户没有要求生成图片。不要调用 ImageGen、Imagine 或 grok-imagine-image。用读文件和改代码回答。</tool_policy>";
  }
  const mentions = [...text.matchAll(/(?:^|[\s])@([^\s@]+)/g)].map((item) => item[1]);
  if (!cwd && !mentions.some((path) => isAbsoluteLocalPath(path))) return next;
  const seen = new Set<string>();
  for (const path of mentions) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const target = mentionReadTarget(cwd, path);
    const localOnly = isAbsoluteLocalPath(path) ? null : ssh || null;
    try {
      const file = await invoke<{ content: string; truncated: boolean }>("read_workspace_file", {
        root: target.root,
        path: target.path,
        ssh: localOnly,
      });
      if (file.truncated || file.content.length > 80_000) {
        next += `\n\n<file path="${path}">\n[file too large to inline]\n</file>`;
      } else {
        next += `\n\n<file path="${path}">\n${file.content}\n</file>`;
      }
    } catch {
      try {
        const entries = await invoke<WorkspaceEntry[]>("list_workspace", {
          root: target.root,
          path: target.path,
          ssh: localOnly,
        });
        const names = (Array.isArray(entries) ? entries : []).slice(0, 40).map((item) => item.path).join("\n");
        next += `\n\n<folder path="${path}">\n${names}\n</folder>`;
      } catch {
        // ignore missing mentions
      }
    }
  }
  try {
    const rules = await invoke<{ path: string; content: string } | null>("read_project_rules", { root: cwd, ssh: ssh || null });
  if (rules?.content.trim() && !askedImage) {
        next += `\n\n<project_rules path="${rules.path}">\n${rules.content.slice(0, 20_000)}\n</project_rules>`;
      }
  } catch {
    // no rules file is fine
  }
  return next;
}

function notifyTurnDone(copy: Copy, ok: boolean) {
  if (typeof document === "undefined" || !document.hidden) return;
  const title = ok ? copy.notifyTurnDone : copy.notifyTurnFailed;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body: copy.turnCompleted });
    }
  } catch {
    // webview may not expose Notification
  }
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().requestUserAttention(1))
    .catch(() => undefined);
}

export default function App() {
  const saved = useMemo(loadPersist, []);
  const [lang, setLang] = useState<Lang>(() => parseLang(saved.lang) || detectLang());
  const [theme, setTheme] = useState<Theme>(saved.theme || "system");
  const [view, setView] = useState<View>("chat");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [showSidebar, setShowSidebar] = useState(saved.showSidebar !== false);
  const [showInspector, setShowInspector] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(Boolean(saved.showWorkspace));
  const [workspaceSide, setWorkspaceSide] = useState<"left" | "right">(saved.workspaceSide === "left" ? "left" : "right");
  const [showTerminal, setShowTerminal] = useState(Boolean(saved.showTerminal));
  const [terminalHeight, setTerminalHeight] = useState(Math.min(420, Math.max(160, saved.terminalHeight || 220)));
  const [agentTermJobs, setAgentTermJobs] = useState<AgentTermJob[]>([]);
  const [panelChannel, setPanelChannel] = useState<PanelChannel>("terminal");
  const [panelOutput, setPanelOutput] = useState<string[]>([]);
  const [runJob, setRunJob] = useState<RunJob | null>(null);
  const [workspaceFocusPath, setWorkspaceFocusPath] = useState("");
  const [workspaceFocusTick, setWorkspaceFocusTick] = useState(0);
  const [workspaceRestoreTick, setWorkspaceRestoreTick] = useState(0);
  const [paletteMode, setPaletteMode] = useState<null | "file" | "grep">(null);
  const [mention, setMention] = useState<{ start: number; query: string; items: WorkspaceEntry[]; index: number } | null>(null);
  const [checkpointFlags, setCheckpointFlags] = useState<Record<string, true>>({});
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showUsageCard, setShowUsageCard] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(Math.min(400, Math.max(220, saved.sidebarWidth || 280)));
  const [workspaceWidth, setWorkspaceWidth] = useState(Math.min(820, Math.max(420, saved.workspaceWidth || 560)));
  const [model, setModel] = useState(canonicalModelId(saved.model || "grok-4.5") || "grok-4.5");
  const [cwd, setCwd] = useState(saved.cwd || "");
  const [prompt, setPrompt] = useState("");
  const [editingCwd, setEditingCwd] = useState(false);
  const [showSshModal, setShowSshModal] = useState(false);
  const [sshForm, setSshForm] = useState<SshTarget>(emptySshTarget);
  const [sshHosts, setSshHosts] = useState<SshTarget[]>([]);
  const [sshConfigHosts, setSshConfigHosts] = useState<SshConfigHost[]>([]);
  const [sshProbe, setSshProbe] = useState<SshProbe | null>(null);
  const [sshBusy, setSshBusy] = useState(false);
  const [sshError, setSshError] = useState("");
  const [sshBrowsePath, setSshBrowsePath] = useState("");
  const [sshEntries, setSshEntries] = useState<WorkspaceEntry[]>([]);
  const [liveTurns, setLiveTurns] = useState<string[]>([]);
  const [statusText, setStatusText] = useState("");
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState("");
  const [installError, setInstallError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [form, setForm] = useState<RelayImport>({
    endpoint: saved.form?.endpoint || "https://api.xiaohaweb.com/v1",
    apiKey: "",
    model: canonicalModelId(saved.form?.model || saved.model || "grok-4.5") || "grok-4.5",
    name: saved.form?.name || "小哈AI",
  });
  const [availableModels, setAvailableModels] = useState<CatalogModel[]>(
    Array.isArray(saved.availableModels) ? saved.availableModels : [],
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [modelsMessage, setModelsMessage] = useState("");
  const [relayReady, setRelayReady] = useState(Boolean(saved.relayReady));
  const [settings, setSettings] = useState<AppSettings>(() => migrateSettings(saved.settings));
  const [conversations, setConversationsRaw] = useState<Conversation[]>(() =>
    dedupeConversations((saved.conversations || []).map(hydrateConversation)),
  );
  const setConversations = useCallback(
    (update: Conversation[] | ((list: Conversation[]) => Conversation[])) => {
      setConversationsRaw((current) => applyConversationUpdate(current, update));
    },
    [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    resolveSelectedId(
      dedupeConversations((saved.conversations || []).map(hydrateConversation)),
      saved.selectedId || null,
    ),
  );
  const [projectRecords, setProjectRecords] = useState<ProjectRecord[]>(() => hydrateProjects(saved.projects));
  const [activeProjectId, setActiveProjectId] = useState<string | null>(saved.activeProjectId || null);
  const [sidebarGroupMode, setSidebarGroupMode] = useState<"project" | "list">(
    saved.sidebarGroupMode === "list" ? "list" : "project",
  );
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [createProjectKind, setCreateProjectKind] = useState<"local" | "remote">("local");
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const sshForProjectRef = useRef(false);
  const [shownCount, setShownCount] = useState(VIEW_PAGE);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [addingAccount, setAddingAccount] = useState(false);
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [loginLog, setLoginLog] = useState("");
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillDirs, setSkillDirs] = useState<{ userDir: string; projectDir?: string | null; serverDir: string }>({
    userDir: "",
    projectDir: null,
    serverDir: "",
  });
  const [skillsQuery, setSkillsQuery] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<SkillRecord | null>(null);
  const [slash, setSlash] = useState<{ query: string; index: number; skillsOnly: boolean } | null>(null);
  const [activeSkill, setActiveSkill] = useState<SkillRecord | null>(null);
  const [usage, setUsage] = useState<ContextUsage>({
    usedTokens: 0,
    totalTokens: migrateSettings(saved.settings).contextWindowTokens,
    compactionCount: 0,
  });
  const [relayQuota, setRelayQuota] = useState<RelayQuota | null>(null);
  const [pendingImages, setPendingImages] = useState<PromptAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [rawEvents, setRawEvents] = useState<Array<{ method: string; payload: string }>>([]);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [permissionExpanded, setPermissionExpanded] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"tools" | "plan" | "events">("tools");
  const [questionNotes, setQuestionNotes] = useState<Record<string, string>>({});
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string[]>>({});
  const [planFeedback, setPlanFeedback] = useState("");
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  /** Sticky outgoing bubbles. History/session reloads cannot erase these from the UI. */
  const [stickyOutgoing, setStickyOutgoing] = useState<ChatMessage[]>([]);
  const stickyOutgoingRef = useRef<ChatMessage[]>([]);
  const [splash, setSplash] = useState(true);

  const t: Copy = translate(lang);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const lastImportRef = useRef("");
  const turnSeqRef = useRef<Record<string, number>>({});
  const conversationsRef = useRef(conversations);
  const selectedIdRef = useRef(selectedId);
  const runningRef = useRef(false);
  const liveTurnsRef = useRef(new Set<string>());
  const lastUsageTokensRef = useRef(0);
  const showInspectorRef = useRef(false);
  const persistTimerRef = useRef(0);
  const persistNowRef = useRef(() => {});
  const contextRetryRef = useRef(new Set<string>());
  const modelRef = useRef(model);
  const cwdRef = useRef(cwd);
  const statusRef = useRef(status);
  const tRef = useRef(t);
  const settingsRef = useRef(settings);
  const accountsRef = useRef(accounts);
  const pendingImagesRef = useRef(pendingImages);
  const pendingFilesRef = useRef(pendingFiles);
  const ingestDroppedPathsRef = useRef<(paths: string[]) => void>(() => undefined);
  const recentDropRef = useRef(new Set<string>());
  const pasteHandledRef = useRef(false);
  const formRef = useRef(form);
  const availableModelsRef = useRef(availableModels);
  const relayQuotaRef = useRef(relayQuota);
  const relayReadyRef = useRef(relayReady);
  const historyLoadedRef = useRef(new Set<string>());
  const historyBusyRef = useRef(new Set<string>());
  const historyLockedRef = useRef(false);
  const historyEpochRef = useRef<Record<string, number>>({});
  const checkpointsRef = useRef(new Map<string, SnapshotFile[]>());
  const turnUserIdRef = useRef<Record<string, string>>({});
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const activeSkillRef = useRef(activeSkill);
  activeSkillRef.current = activeSkill;
  const imeRef = useRef({ composing: false, until: 0 });
  const transcriptActionsRef = useRef<TranscriptRowActions>(null!);
  const newChatRef = useRef(() => {});
  const userPinnedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const promptQueueRef = useRef<QueuedPrompt[]>([]);
  const sendTextRef = useRef<(
    text: string,
    extraAttachments?: PromptAttachment[],
    options?: { fromQueue?: boolean; conversationId?: string; messageId?: string; interrupt?: boolean; displayText?: string },
  ) => Promise<void>>(async () => {});
  const shownCountRef = useRef(VIEW_PAGE);
  const showTerminalRef = useRef(showTerminal);
  const workspaceRootRef = useRef("");
  const activeSshRef = useRef<SshTarget | null>(null);
  conversationsRef.current = conversations;
  selectedIdRef.current = selectedId;
  runningRef.current = Boolean(selectedId && liveTurnsRef.current.has(selectedId));
  modelRef.current = model;
  cwdRef.current = cwd;
  statusRef.current = status;
  tRef.current = t;
  settingsRef.current = settings;
  accountsRef.current = accounts;
  pendingImagesRef.current = pendingImages;
  pendingFilesRef.current = pendingFiles;
  formRef.current = form;
  availableModelsRef.current = availableModels;
  relayQuotaRef.current = relayQuota;
  relayReadyRef.current = relayReady;
  shownCountRef.current = shownCount;
  showTerminalRef.current = showTerminal;
  sendTextRef.current = sendText;

  useEffect(() => {
    const next = resolveSelectedId(conversations, selectedId);
    if (next !== selectedId) setSelectedId(next);
  }, [conversations, selectedId]);

  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const running = Boolean(selectedId && liveTurns.includes(selectedId));
  const visibleQueued = queuedPrompts.filter((item) => item.conversationId === selectedId);

  function setConversationLive(id: string, live: boolean) {
    const next = new Set(liveTurnsRef.current);
    if (live) next.add(id);
    else next.delete(id);
    liveTurnsRef.current = next;
    setLiveTurns([...next]);
  }

  function bumpConversationTurn(id: string) {
    turnSeqRef.current[id] = (turnSeqRef.current[id] || 0) + 1;
    return turnSeqRef.current[id];
  }

  function conversationTurn(id: string) {
    return turnSeqRef.current[id] || 0;
  }

  useEffect(() => {
    if (!showTerminal) {
      setAgentTermJobs([]);
      return;
    }
    if (!runningRef.current) {
      setAgentTermJobs([]);
      return;
    }
    const conversation = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
    const last = findLast(conversation?.messages, (item) => item.role === "assistant");
    const jobs = (last?.events || [])
      .map(agentJobFromEvent)
      .filter((item): item is AgentTermJob => Boolean(item))
      .filter((item) => !isGeneratedImageProbe(item.command) && !/complete|success|fail|error|cancel/i.test(item.status));
    setAgentTermJobs(jobs);
  }, [showTerminal, selectedId, liveTurns]);
  const visibleMessages = useMemo(() => {
    const base = selected?.messages || [];
    if (!stickyOutgoing.length) return base;
    // Prefer sticky copies for outgoing user bubbles so a mid-turn conversations rewrite
    // cannot blank the transcript. Overlay in place so the user turn stays above Grok.
    return withStickyOutgoing(
      base,
      stickyOutgoing.filter((item) => !item.conversationId || item.conversationId === selectedId),
    );
  }, [selected?.messages, stickyOutgoing]);
  const liveImageBusy = useMemo(() => {
    const assistant = findLast(visibleMessages, (item) => item.role === "assistant" && Boolean(item.streaming));
    if (!assistant) return false;
    const prev = visibleMessages.find((item) => item.id === previousUserId(visibleMessages, assistant.id));
    return isImageGenBusy(assistant, prev?.text || "");
  }, [visibleMessages]);
  const liveActivity = useMemo(() => {
    if (!running) return null;
    if (liveImageBusy) return { state: "shaping" as const, label: t.generatingImage };
    if (statusText === t.connecting) return { state: "connecting" as const, label: t.connecting };
    const assistant = findLast(visibleMessages, (item) => item.role === "assistant" && Boolean(item.streaming));
    if (assistant) return agentOrbForMessage(assistant, t);
    return { state: "working" as const, label: statusText || t.running };
  }, [liveImageBusy, running, statusText, t, visibleMessages]);
  const slashDetected = useMemo(() => slashQuery(prompt), [prompt]);
  const slashMenuItems = useMemo(() => {
    if (!slashDetected && !slash?.skillsOnly) return [];
    return filterSlashItems(
      allSlashItems(t, skills),
      slashDetected?.query ?? slash?.query ?? "",
      Boolean(slash?.skillsOnly),
    ).slice(0, 16);
  }, [slashDetected, slash, t, skills]);
  const homeDir = status?.homeDir || "";
  const sessionCwd = selected?.cwd || cwd;
  const activeSsh = selected?.ssh || (isSshWorkspace(sessionCwd) ? parseSshWorkspace(sessionCwd) : null);
  const workspaceRoot = activeSsh ? activeSsh.remotePath : usableWorkspace(sessionCwd, homeDir);
  workspaceRootRef.current = workspaceRoot;
  activeSshRef.current = activeSsh;
  const keys = resolvedBindings(settings.keybindings);
  const projectName = activeSsh ? sshLabel(activeSsh, workspaceRoot) : workspaceLabel(sessionCwd, homeDir, t.home);
  const canSend = (prompt.trim().length > 0 || pendingImages.length > 0 || pendingFiles.length > 0 || Boolean(activeSkill)) && !installing;
  const relayConfigured = Boolean(relayQuota?.configured || relayReady);
  const routed = relayConfigured ? undefined : pickRoutedAccount(accounts, settings);
  const activeAccount = relayConfigured
    ? undefined
    : accounts.find((account) => account.id === selected?.accountId && account.enabled) || routed;
  const relayQuotaText = formatRelayQuota(relayQuota, t);
  const usingOfficialQuota = Boolean(
    !relayConfigured &&
      activeAccount?.enabled &&
      activeAccount?.loggedIn &&
      activeAccount.quota?.weeklyRemainingPercent != null,
  );
  const showRelayIdentity = Boolean(relayConfigured);
  const accountTitle = usingOfficialQuota
    ? activeAccount?.name || t.askAccount
    : showRelayIdentity
      ? relayQuota?.name || form.name || t.xiaohaRelay
      : activeAccount?.name || t.askAccount;
  const quotaText = usingOfficialQuota
    ? fill(t.weeklyRemaining, { n: Math.round(activeAccount!.quota!.weeklyRemainingPercent!) })
    : relayQuotaText
      || (activeAccount?.loggedIn
        ? t.quotaPending
        : status?.credentialsReady
          ? t.ready
          : t.notConfigured);

  const projectListSig = conversations
    .map((item) => `${item.id}\t${item.title}\t${item.cwd}\t${item.archivedAt || ""}\t${item.projectId || ""}\t${item.updatedAt}`)
    .join("\n");
  const projects = useMemo(() => {
    const explicit = hydrateProjects(projectRecords);
    const assigned = new Set<string>();
    const groups: Array<{
      id: string;
      path: string;
      name: string;
      cwd: string;
      ssh: SshTarget | null;
      explicit: boolean;
      items: Conversation[];
    }> = [];
    const live = dedupeConversations(conversationsRef.current).filter((conversation) => !conversation.archivedAt);
    for (const project of explicit) {
      const items = live.filter((item) => item.projectId === project.id || (!item.projectId && sameWorkspace(item, project)));
      for (const item of items) assigned.add(item.id);
      groups.push({
        id: project.id,
        path: workspaceKey(project.cwd, project.ssh),
        name: project.name,
        cwd: project.cwd,
        ssh: project.ssh || null,
        explicit: true,
        items,
      });
    }
    const leftovers = new Map<string, Conversation[]>();
    for (const item of live) {
      if (assigned.has(item.id)) continue;
      const key = workspaceKey(item.cwd, item.ssh);
      const list = leftovers.get(key) || [];
      list.push(item);
      leftovers.set(key, list);
    }
    for (const [path, items] of leftovers) {
      groups.push({
        id: `cwd:${path || "home"}`,
        path,
        name: items[0]?.ssh ? sshLabel(items[0].ssh) : workspaceLabel(path, homeDir, t.home),
        cwd: path,
        ssh: items[0]?.ssh || null,
        explicit: false,
        items,
      });
    }
    return groups.sort((a, b) => {
      const aTime = Math.max(a.explicit ? (explicit.find((item) => item.id === a.id)?.updatedAt || 0) : 0, a.items[0]?.updatedAt || 0);
      const bTime = Math.max(b.explicit ? (explicit.find((item) => item.id === b.id)?.updatedAt || 0) : 0, b.items[0]?.updatedAt || 0);
      return bTime - aTime;
    });
  }, [projectListSig, homeDir, t.home, projectRecords]);

  const modelOptions = useMemo(() => mergeModelOptions(availableModels, model), [availableModels, model]);
  const usagePercent = Math.round(
    Math.min(100, Math.max(0, usage.totalTokens ? (usage.usedTokens / usage.totalTokens) * 100 : 0)),
  );

  useEffect(() => {
    uiLang = lang;
    document.documentElement.lang = htmlLang(lang);
    document.documentElement.dataset.theme = theme;
  }, [lang, theme]);

  useEffect(() => {
    stickyOutgoingRef.current = stickyOutgoing;
  }, [stickyOutgoing]);

  useEffect(() => {
    // Only retire sticky copies after that conversation is idle. Background turns
    // must keep their outgoing bubbles even if the selected chat is idle.
    setStickyOutgoing((current) => {
      if (!current.length) return current;
      const next = current.filter((item) => {
        if (item.queued) return true;
        const cid = item.conversationId || selectedId;
        if (cid && liveTurns.includes(cid)) return true;
        const conv = conversations.find((entry) => entry.id === cid);
        if (!conv) return Boolean(cid);
        return !(item.id && conv.messages.some((message) => message.id === item.id));
      });
      return next.length === current.length ? current : next;
    });
  }, [conversations, selectedId, liveTurns]);

  persistNowRef.current = () => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          lang,
          theme,
          model,
          cwd,
          selectedId,
          conversations: persistConversations(conversations),
          projects: projectRecords,
          activeProjectId,
          sidebarGroupMode,
          sidebarWidth,
          workspaceWidth,
          showWorkspace,
          showTerminal,
          showSidebar,
          workspaceSide,
          terminalHeight,
          settings,
          form: { ...form, apiKey: "" },
          availableModels,
          relayReady,
        }),
      );
    } catch {
      // localStorage quota — drop the write rather than freeze the UI
    }
  };
  showInspectorRef.current = showInspector;

  useEffect(() => {
    const delay = liveTurns.length ? 1800 : 400;
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => persistNowRef.current(), delay);
    return () => window.clearTimeout(persistTimerRef.current);
  }, [lang, theme, model, cwd, selectedId, conversations, projectRecords, activeProjectId, sidebarGroupMode, sidebarWidth, workspaceWidth, showWorkspace, showTerminal, showSidebar, workspaceSide, terminalHeight, form, settings, availableModels, relayReady, liveTurns.length]);

  useEffect(() => {
    const flush = () => persistNowRef.current();
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    if (!mention || !workspaceRoot) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke<WorkspaceEntry[]>("search_workspace", {
        root: workspaceRoot,
        query: mention.query,
        limit: 20,
        ssh: activeSsh || null,
      })
        .then((rows) => {
          if (cancelled) return;
          setMention((current) =>
            current ? { ...current, items: Array.isArray(rows) ? rows.slice(0, 12) : [], index: 0 } : current,
          );
        })
        .catch(() => {
          if (cancelled) return;
          setMention((current) => (current ? { ...current, items: [], index: 0 } : current));
        });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeSsh, mention?.query, mention?.start, workspaceRoot]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const map = resolvedBindings(settingsRef.current.keybindings);
      if (chordsMatch(event, map.quickOpen)) {
        event.preventDefault();
        setView("chat");
        setPaletteMode("file");
        return;
      }
      if (chordsMatch(event, map.projectSearch)) {
        event.preventDefault();
        setView("chat");
        setPaletteMode("grep");
        return;
      }
      if (chordsMatch(event, map.openSettings)) {
        event.preventDefault();
        setView("settings");
        return;
      }
      if (chordsMatch(event, map.toggleSidebar)) {
        event.preventDefault();
        setShowSidebar((value) => !value);
        return;
      }
      if (chordsMatch(event, map.toggleWorkspace)) {
        event.preventDefault();
        setShowWorkspace((value) => !value);
        return;
      }
      if (chordsMatch(event, map.toggleTerminal)) {
        event.preventDefault();
        setShowTerminal((value) => !value);
        return;
      }
      if (chordsMatch(event, map.newChat)) {
        event.preventDefault();
        newChatRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setUsage((current) =>
      current.totalTokens === settings.contextWindowTokens
        ? current
        : { ...current, totalTokens: settings.contextWindowTokens },
    );
  }, [settings.contextWindowTokens]);

  const patchSettings = useCallback((patch: Partial<AppSettings>) => {
    const nextPatch =
      patch.permissionMode != null
        ? { ...patch, permissionMode: normalizePermissionMode(patch.permissionMode) }
        : patch;
    setSettings((current) => ({ ...current, ...nextPatch }));
    if (nextPatch.permissionMode != null) {
      void invoke("set_permission_mode", { mode: nextPatch.permissionMode }).catch(() => undefined);
    }
  }, []);

  const setPermissionMode = useCallback(
    (mode: string) => {
      const next = normalizePermissionMode(mode);
      settingsRef.current = { ...settingsRef.current, permissionMode: next };
      patchSettings({ permissionMode: next });
    },
    [patchSettings],
  );

  const persistAccounts = useCallback(async (next: AccountRecord[], extra?: Partial<AppSettings>) => {
    const merged = extra ? { ...settingsRef.current, ...extra } : settingsRef.current;
    try {
      const state = await invoke<AccountState>("save_account_state", {
        payload: {
          accounts: next,
          routingMode: merged.routingMode,
          preferredAccountId: merged.preferredAccountId,
        },
      });
      setAccounts(state.accounts);
      patchSettings({
        routingMode: state.routingMode,
        preferredAccountId: state.preferredAccountId,
      });
    } catch {
      setAccounts(next);
    }
  }, [patchSettings]);

  const ensureConversation = useCallback(
    (list: Conversation[], id: string | null, path: string) => {
      const unique = dedupeConversations(list);
      const live = unique.filter((item) => !item.archivedAt);
      if (live.length === 0) {
        const created: Conversation = {
          id: uid(),
          title: tRef.current.newChat,
          cwd: path,
          messages: [],
          updatedAt: Date.now(),
        };
        return { list: [created, ...unique.filter((item) => item.archivedAt)], id: created.id };
      }
      if (id && live.some((item) => item.id === id)) {
        return { list: unique, id };
      }
      const bySession = id ? live.find((item) => item.grokSessionId === id) : undefined;
      return { list: unique, id: bySession?.id || live[0].id };
    },
    [],
  );

  const syncJumpButton = useCallback((el: HTMLElement) => {
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpToBottom(gap > 80 && el.scrollHeight > el.clientHeight + 8);
  }, []);

  const updateFollowState = useCallback((el: HTMLElement) => {
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop + 1 < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    // Wheel/trackpad up unpins even while still close to the bottom, so a
    // streaming token cannot snatch the viewport back. Rubber-band past the
    // bottom keeps gap <= 0 and must not count as a user unpin.
    if (scrolledUp && gap >= 1) {
      followRef.current = false;
      userPinnedRef.current = true;
    } else if (gap < 48) {
      followRef.current = true;
      userPinnedRef.current = false;
    }
    syncJumpButton(el);
  }, [syncJumpButton]);

  const scrollToBottom = useCallback((force = false) => {
    const el = transcriptRef.current;
    if (!el) return;
    if (!force && (userPinnedRef.current || !followRef.current)) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    followRef.current = true;
    userPinnedRef.current = false;
    setShowJumpToBottom(false);
  }, []);

  const jumpToBottom = useCallback(() => {
    scrollToBottom(true);
  }, [scrollToBottom]);

  const mutateTargetRef = useRef<string | null>(null);
  const mutateAssistant = useCallback(
    (mutator: (assistant: ChatMessage, conversation: Conversation) => Conversation | void) => {
      setConversations((list) => {
        const currentId = mutateTargetRef.current || selectedIdRef.current;
        return list.map((conversation) => {
          if (conversation.id !== currentId) return conversation;
          const messages = [...conversation.messages];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === "assistant" && messages[i].streaming) {
              const assistant = { ...messages[i], events: [...messages[i].events], media: [...messages[i].media] };
              messages[i] = assistant;
              const next = mutator(assistant, { ...conversation, messages });
              return next || { ...conversation, messages };
            }
          }
          return conversation;
        });
      });
    },
    [],
  );

  const pendingStreamRef = useRef({
    buffers: new Map<string, { text: string; thought: string }>(),
    timer: 0,
  });
  const flushPendingStream = useCallback((onlyId?: string, final = false) => {
    const pending = pendingStreamRef.current;
    const ids = onlyId
      ? pending.buffers.has(onlyId)
        ? [onlyId]
        : []
      : [...pending.buffers.keys()];
    for (const id of ids) {
      const buf = pending.buffers.get(id);
      pending.buffers.delete(id);
      if (!buf || (!buf.text && !buf.thought)) continue;
      mutateTargetRef.current = id;
      mutateAssistant((assistant) => {
        if (buf.text) assistant.text += buf.text;
        if (buf.thought) {
          assistant.thought += buf.thought;
          const output =
            final || assistant.thought.length <= 8000
              ? assistant.thought
              : assistant.thought.slice(-8000);
          assistant.events = upsertEvent(assistant.events, {
            id: "thought",
            kind: "thought",
            title: translate(uiLang).thinking,
            output,
          });
        }
      });
    }
    if (!pending.buffers.size && pending.timer) {
      window.clearTimeout(pending.timer);
      pending.timer = 0;
    }
  }, [mutateAssistant]);
  const scheduleStreamFlush = useCallback(() => {
    const pending = pendingStreamRef.current;
    if (pending.timer) return;
    pending.timer = window.setTimeout(() => {
      pending.timer = 0;
      flushPendingStream();
      const el = transcriptRef.current;
      if (el && !userPinnedRef.current && followRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    }, 48);
  }, [flushPendingStream]);

  const finishTurn = useCallback((error?: string, conversationId?: string) => {
    const targetId = conversationId || selectedIdRef.current;
    flushPendingStream(targetId || undefined, true);
    const cancelled = isUserCancelError(error);
    const err = error && !cancelled ? friendlyError(error, tRef.current) : undefined;
    setConversations((list) => {
      const next = list.map((item) => {
        if (item.id !== targetId) return item;
        const sticky = stickyOutgoingRef.current.filter(
          (message) => !message.conversationId || message.conversationId === targetId,
        );
        // Only seal the live turn. Never rewrite older completed assistants on cancel.
        let sealedLive = false;
        const sealed = item.messages.map((message) => {
          if (message.role === "assistant" && message.streaming) {
            sealedLive = true;
            return sealAssistantMessage(message, { error, stopped: cancelled, copy: tRef.current });
          }
          return message;
        });
        // If stop raced ahead of React state and nothing is streaming anymore,
        // still mark the latest local assistant as stopped when this was a cancel.
        if (cancelled && !sealedLive) {
          for (let i = sealed.length - 1; i >= 0; i -= 1) {
            if (sealed[i].role === "assistant" && sealed[i].local) {
              sealed[i] = sealAssistantMessage(sealed[i], { stopped: true });
              break;
            }
          }
        }
        const merged = sticky.length
          ? mergeConversationMessages(
              sealed,
              sticky.map((message) => ({ ...message, queued: false, local: true })),
            )
          : sealed;
        const overflow = !cancelled && isContextTooLarge(error);
        return {
          ...item,
          messages: merged,
          grokSessionId: overflow ? "" : item.grokSessionId,
          updatedAt: Date.now(),
        };
      });
      conversationsRef.current = next;
      return next;
    });
    if (targetId && !cancelled && isContextTooLarge(error)) {
      void invoke("stop_session", { conversationId: targetId }).catch(() => undefined);
    }
    // Keep sticky until conversations have absorbed them on the next idle pass.
    if (targetId) {
      liveTurnsRef.current.delete(targetId);
      setLiveTurns([...liveTurnsRef.current]);
    }
    runningRef.current = Boolean(selectedIdRef.current && liveTurnsRef.current.has(selectedIdRef.current));
    if (!targetId || targetId === selectedIdRef.current) {
      setStatusText(cancelled ? tRef.current.stopped : err || tRef.current.ready);
    }
    notifyTurnDone(tRef.current, !cancelled && !err);
    if (!cancelled && !err && settingsRef.current.gitAutoCommit) {
      const root = workspaceRootRef.current;
      if (root) {
        const conv = conversationsRef.current.find((item) => item.id === targetId);
        const lastUser = [...(conv?.messages || [])].reverse().find((item) => item.role === "user");
        const title = (lastUser?.text || conv?.title || "update").replace(/\s+/g, " ").trim().slice(0, 72);
        const template = settingsRef.current.gitAutoCommitMessage || "xiaoha: {title}";
        const message = template.split("{title}").join(title || "update");
        const ssh = activeSshRef.current;
        void invoke<string>("git_commit", { root, message, ssh: ssh || null, all: null })
          .then((out) => {
            setPanelOutput((current) => [...current.slice(-200), `git commit: ${message}${out ? `\n${out}` : ""}`]);
            if (!settingsRef.current.gitAutoPush) return;
            return invoke<string>("git_push", { root, ssh: ssh || null }).then((push) => {
              setPanelOutput((current) => [...current.slice(-200), push || "git push"]);
            });
          })
          .catch((fail) => {
            setPanelOutput((current) => [...current.slice(-200), String(fail)]);
          });
      }
    }
    window.setTimeout(() => {
      const index = promptQueueRef.current.findIndex((item) => !targetId || item.conversationId === targetId);
      if (index < 0) return;
      const next = promptQueueRef.current[index];
      promptQueueRef.current = promptQueueRef.current.filter((_, i) => i !== index);
      setQueuedPrompts([...promptQueueRef.current]);
      if (!next) return;
      void sendTextRef.current(next.text, next.attachments, {
        fromQueue: true,
        conversationId: next.conversationId,
        messageId: next.messageId,
        displayText: next.displayText,
      });
    }, 40);
  }, [flushPendingStream]);

  async function completeDirectImageGen(conversationId: string, prompt: string, assistantId?: string, turnId?: number) {
    const copy = tRef.current;
    if (conversationId === selectedIdRef.current) setStatusText(copy.generatingImage);
    try {
      const image = await invoke<{ path: string; mimeType: string; name: string }>("generate_image", { prompt });
      if (turnId && turnId !== conversationTurn(conversationId)) return;
      setConversations((list) => {
        const next = list.map((item) => {
          if (item.id !== conversationId) return item;
          return {
            ...item,
            messages: item.messages.map((message) => {
              if (message.role !== "assistant") return message;
              if (assistantId) {
                if (message.id !== assistantId) return message;
              } else if (!message.streaming) {
                return message;
              }
              return {
                ...message,
                streaming: false,
                error: undefined,
                media: mergeMessageMedia(message.media, [
                  {
                    id: uid(),
                    type: "image",
                    mimeType: image.mimeType,
                    uri: image.path,
                    name: image.name,
                    at: Date.now(),
                  },
                ]),
                events: [
                  ...(message.events || []).filter((event) => !isImageGenEvent(event)),
                  {
                    id: uid(),
                    kind: "image_gen",
                    title: "Generate Image",
                    status: "completed",
                    output: JSON.stringify({
                      path: image.path,
                      filename: image.name,
                      type: "ImageGen",
                    }),
                  },
                ],
              };
            }),
            updatedAt: Date.now(),
          };
        });
        conversationsRef.current = next;
        return next;
      });
      finishTurn(undefined, conversationId);
    } catch (error) {
      finishTurn(String(error), conversationId);
    }
  }

  const handleAcpUpdate = useCallback(
    (payload: AcpUpdate) => {
      const copy = translate(lang);
      const params = payload.params || {};
      const targetId = String(payload.conversationId || selectedIdRef.current || "");
      const isActiveView = !payload.conversationId || payload.conversationId === selectedIdRef.current;
      mutateTargetRef.current = targetId;
      const meta = asRecord(params._meta);
      if (payload.method === "x.ai/models/update" || payload.method === "_x.ai/models/update") {
        const current = String(params.currentModelId || params.current_model_id || "");
        if (current && isActiveView) setModel(current);
        return;
      }
      const tokens = Number(meta?.totalTokens ?? meta?.total_tokens ?? 0);
      if (tokens > 0 && isActiveView) {
        const prev = lastUsageTokensRef.current;
        if (Math.abs(tokens - prev) >= 512) {
          lastUsageTokensRef.current = tokens;
          setUsage((current) => ({
            ...current,
            usedTokens: tokens,
            totalTokens: settingsRef.current.contextWindowTokens,
          }));
        }
      }
      if (showInspectorRef.current) {
        setRawEvents((rows) => {
          const next = [...rows, { method: payload.method, payload: jsonText(params) || "{}" }];
          return next.slice(-80);
        });
      }

      const update = asRecord(params.update) || (params.sessionUpdate || params.session_update ? params : undefined);
      if (!update) {
        if (payload.method === "session/request_permission" && payload.autoAllowed) {
          mutateAssistant((assistant) => {
            assistant.events = upsertEvent(assistant.events, {
              id: `permission-${Date.now()}`,
              kind: "permission",
              title: copy.allowedAutomatically,
              status: "approved",
            });
          });
        } else if (payload.method !== "session/update" && !isRedundantExtension(payload.method)) {
          const kind = extensionKind(payload.method);
          if (kind !== "system") {
            mutateAssistant((assistant) => {
              assistant.events = upsertEvent(assistant.events, {
                id: `extension-${Date.now()}`,
                kind,
                title: extensionTitle(payload.method, params, lang),
                output: jsonText(params),
              });
            });
          }
        }
        return;
      }

      const type = String(update.sessionUpdate || update.session_update || "unknown");
      if (type === "agent_message_chunk") {
        const content = asRecord(update.content) || {};
        const chunkType = String(content.type || "text");
        if (chunkType === "text" || !chunkType) {
          const id = targetId || selectedIdRef.current || "";
          if (!id) return;
          const pending = pendingStreamRef.current;
          const buf = pending.buffers.get(id) || { text: "", thought: "" };
          buf.text += contentText(update);
          pending.buffers.set(id, buf);
          scheduleStreamFlush();
          return;
        }
      }
      if (type === "agent_thought_chunk") {
        const id = targetId || selectedIdRef.current || "";
        if (!id) return;
        const pending = pendingStreamRef.current;
        const buf = pending.buffers.get(id) || { text: "", thought: "" };
        buf.thought += contentText(update);
        pending.buffers.set(id, buf);
        scheduleStreamFlush();
        return;
      }
      flushPendingStream(targetId || undefined);
      mutateAssistant((assistant, conversation) => {
        if (type === "agent_message_chunk") {
          const content = asRecord(update.content) || {};
          assistant.media = mergeMessageMedia(
              assistant.media,
              [
                {
                  id: uid(),
                  type: String(content.type || "text"),
                  mimeType: content.mimeType ? String(content.mimeType) : undefined,
                  data: content.data ? String(content.data) : undefined,
                  uri: content.uri ? String(content.uri) : undefined,
                  name: content.name ? String(content.name) : undefined,
                  at: assistant.text.length,
                },
              ],
              assistant.text.length,
            );
        } else if (type === "tool_call" || type === "tool_call_update") {
          const id = String(update.toolCallId || update.tool_call_id || uid());
          const metaTool = toolMeta(update);
          const metaKind = String(metaTool?.kind || metaTool?.name || "");
          const rawKind = String(update.kind || "");
          const kind = /^(other)?$/i.test(rawKind) && metaKind ? metaKind : rawKind || metaKind || "other";
          const rawTitle = String(
            update.title || metaTool?.label || metaTool?.name || update.name || copy.toolCall,
          );
          const diffs = extractFileDiffs(update);
          const inputRec = asRecord(update.rawInput ?? update.input ?? update.raw_input);
          const editPath = String(
            diffs.find((item) => item.path)?.path ||
              update.path ||
              metaTool?.path ||
              inputRec?.path ||
              inputRec?.file_path ||
              inputRec?.filePath ||
              "",
          );
          const isEdit = Boolean(
            diffs.length || /edit|write|replace|apply_patch|applypatch|str_replace/i.test(`${kind} ${rawTitle}`),
          );
          const input = diffs.length ? undefined : jsonText(update.rawInput ?? update.input ?? update.raw_input);
          const output = diffs.length ? undefined : jsonText(update.content ?? update.output ?? update.rawOutput);
          const askQuestions = parseAskQuestions(inputRec || { rawInput: update.rawInput ?? update.raw_input ?? update.input });
          const isAsk = Boolean(askQuestions.length) || isAskToolTitle(rawTitle);
          const imageLike = isImageGenEvent({
            id: `tool-${id}`,
            kind,
            title: rawTitle,
            input,
            output,
          });
          const askedImage = wantsImageGen(
            lastUserMessageText(conversationsRef.current.find((item) => item.id === targetId)?.messages),
          );
          const fileName = editPath.split("/").filter(Boolean).pop() || "";
          const title = imageLike ? copy.imageGenTool : isAsk ? (rawTitle.startsWith("Ask") ? rawTitle : `Ask: ${rawTitle}`) : isEdit ? (fileName ? `Edit ${fileName}` : "Edit") : rawTitle;
          if (!(imageLike && !askedImage)) {
            assistant.events = upsertEvent(assistant.events, {
              id: `tool-${id}`,
              kind: imageLike ? "image_gen" : isAsk ? "question" : isEdit ? "edit" : kind,
              title,
              status: String(update.status || "pending"),
              input: isAsk ? jsonText({ questions: askQuestions }) : input,
              output,
              diffs: diffs.length ? diffs : undefined,
            });
          }
          assistant.media = mergeMessageMedia(
            assistant.media,
            extractMessageMedia(
              [
                update.rawOutput,
                update.raw_output,
                update.content,
                update.output,
                update.embeddedContent,
                asRecord(update._meta),
              ],
              assistant.text.length,
            ),
            assistant.text.length,
          );
          if (
            isActiveView &&
            showTerminalRef.current &&
            isCommandEvent({
              id: `tool-${id}`,
              kind: isEdit ? "edit" : kind,
              title,
              status: String(update.status || "pending"),
              input,
              output,
              diffs: diffs.length ? diffs : undefined,
            })
          ) {
            const command = extractShellCommand(inputRec, input);
            if (!isGeneratedImageProbe(command || title) && !isImageProbeEvent({
              id: `tool-${id}`,
              kind: isEdit ? "edit" : kind,
              title,
              input,
              output,
            })) {
              setAgentTermJobs((current) =>
                upsertAgentJob(current, {
                  id,
                  title: terminalJobTitle(command, title),
                  command: command || title,
                  output: extractShellOutput(output),
                  status: update.status ? String(update.status) : "",
                }),
              );
            }
          }
          if (editPath && isEdit) {
            if (isActiveView) {
              setWorkspaceFocusPath(editPath);
              setWorkspaceFocusTick((tick) => tick + 1);
              setShowWorkspace(true);
            }
            const convId = targetId || selectedIdRef.current;
            const userId = convId ? turnUserIdRef.current[convId] : "";
            if (convId && userId) {
              const key = checkpointKey(convId, userId);
              const current = [...(checkpointsRef.current.get(key) || [])];
              for (const diff of diffs) {
                const path = relPath(conversation.cwd || cwdRef.current, diff.path || editPath);
                if (!path || current.some((item) => item.path === path)) continue;
                current.push({ path, content: diff.oldText ? diff.oldText : null });
              }
              checkpointsRef.current.set(key, current);
              if (current.length) setCheckpointFlags((flags) => ({ ...flags, [key]: true }));
            }
          }
        } else if (type === "plan") {
          const entries = (update.entries as Array<Record<string, unknown>> | undefined) || [];
          assistant.events = upsertEvent(assistant.events, {
            id: "plan",
            kind: "plan",
            title: copy.execPlan,
            output: entries
              .map((entry) => `[${entry.status || "pending"}] ${entry.content || entry.text || ""}`)
              .join("\n"),
          });
        } else if (type === "auto_compact_started") {
          assistant.events = upsertEvent(assistant.events, {
            id: "active-compaction",
            kind: "compaction",
            title: copy.autoCompacting,
            status: `${update.percentage || usagePercent}%`,
          });
        } else if (type === "auto_compact_completed") {
          const after = Number(update.tokens_after ?? update.tokensAfter ?? 0);
          if (isActiveView) {
            setUsage((current) => ({
              ...current,
              usedTokens: after || current.usedTokens,
              compactionCount: current.compactionCount + 1,
            }));
          }
          assistant.events = upsertEvent(assistant.events, {
            id: "active-compaction",
            kind: "compaction",
            title: copy.contextCompacted,
            status: "completed",
            input: update.tokens_before || update.tokensBefore
              ? `${copy.compactBefore}：${formatTokens(Number(update.tokens_before ?? update.tokensBefore))} tokens`
              : undefined,
            output: `${copy.compactAfter}：${formatTokens(after)} tokens`,
          });
        } else if (type === "auto_compact_failed") {
          assistant.events = upsertEvent(assistant.events, {
            id: "active-compaction",
            kind: "compaction",
            title: copy.autoCompactFailed,
            status: "failed",
            output: String(update.error || ""),
          });
        } else if (type === "session_summary_generated") {
          const title = String(update.sessionSummary || update.session_summary || "");
          if (title) return { ...conversation, title, updatedAt: Date.now() };
        } else if (type === "user_message_chunk" || type === "user_message") {
          // User bubbles are owned by the composer/optimistic insert. Never absorb them into the assistant bubble.
        } else if (type !== "user_message_chunk" && type !== "user_message" && !isRedundantExtension(type)) {
          const kind = extensionKind(type);
          if (kind !== "system") {
            assistant.events = upsertEvent(assistant.events, {
              id: `extension-${String(meta?.eventId || Date.now())}`,
              kind,
              title: extensionTitle(type, update, lang),
              status: update.status ? String(update.status) : undefined,
              output: jsonText(update),
            });
          }
        }
      });
      if (isActiveView && !userPinnedRef.current && followRef.current) {
        const el = transcriptRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    },
    [lang, mutateAssistant, flushPendingStream, scheduleStreamFlush, usagePercent],
  );

  const handleInteraction = useCallback((payload: {
    method: string;
    requestId: string;
    params: Record<string, unknown>;
    conversationId?: string;
  }) => {
    const copy = translate(lang);
    const params = payload.params || {};
    mutateTargetRef.current = payload.conversationId || selectedIdRef.current;
    const askQuestions = parseAskQuestions(params);
    if (payload.method.includes("ask_user_question") || askQuestions.length) {
      const questions = askQuestions.map((question) => withAskOtherOption(question, copy.askOther, copy.askOtherHint));
      if (questions.length) {
        setQuestionAnswers({});
        setQuestionNotes({});
        setPendingQuestion({
          id: payload.requestId,
          questions,
          planMode: params.mode === "plan",
          conversationId: payload.conversationId,
          permissionOptions: parsePermissionGate(params),
        });
        mutateAssistant((assistant) => {
          assistant.events = upsertEvent(assistant.events, {
            id: `interaction-${payload.requestId}`,
            kind: "question",
            title: questions[0]?.question ? `${copy.modeAsk}: ${questions[0].question}` : copy.grokNeedsInfo,
            status: "pending",
            input: jsonText({ questions }),
          });
        });
        return;
      }
    }
    if (payload.method === "x.ai/exit_plan_mode") {
      setPendingPlan({
        id: payload.requestId,
        content: String(params.planContent || params.plan_content || ""),
        conversationId: payload.conversationId,
      });
      mutateAssistant((assistant) => {
        assistant.events = upsertEvent(assistant.events, {
          id: `interaction-${payload.requestId}`,
          kind: "interaction",
          title: copy.grokNeedsPlan,
          status: "pending",
          input: jsonText(params),
        });
      });
      return;
    }
    const tool = asRecord(params.toolCall) || asRecord(params.tool_call) || {};
    const command = extractShellCommand(asRecord(tool.rawInput) || asRecord(tool.raw_input) || asRecord(tool.input), jsonText(tool));
    const probeText = `${tool.title || ""} ${command} ${jsonText(tool.rawInput ?? tool.raw_input ?? tool.input ?? tool)}`;
    const optionsRaw = (params.options as Array<Record<string, unknown>>) || [];
    if (isGeneratedImageProbe(probeText)) {
      const reject = pickPermissionChoice(optionsRaw, true);
      void invoke("answer_interaction", {
        requestId: payload.requestId,
        result: reject
          ? { outcome: { outcome: "selected", optionId: String(reject.optionId || reject.option_id || reject.id) } }
          : { outcome: { outcome: "cancelled" } },
        conversationId: payload.conversationId,
      }).catch(() => undefined);
      return;
    }
    const imageTool = isImageGenEvent({
      id: `perm-${payload.requestId}`,
      kind: String(tool.kind || tool.name || ""),
      title: String(tool.title || tool.name || ""),
      input: command,
    });
    if (imageTool) {
      const asked = wantsImageGen(
        lastUserMessageText(
          conversationsRef.current.find((item) => item.id === (payload.conversationId || selectedIdRef.current))?.messages,
        ),
      );
      const choice = pickPermissionChoice(optionsRaw, !asked);
      void invoke("answer_interaction", {
        requestId: payload.requestId,
        result: choice
          ? { outcome: { outcome: "selected", optionId: String(choice.optionId || choice.option_id || choice.id) } }
          : { outcome: { outcome: "cancelled" } },
        conversationId: payload.conversationId,
      }).catch(() => undefined);
      return;
    }
    const options = optionsRaw.map((option) => ({
      id: String(option.optionId || option.option_id || option.id || ""),
      name: String(option.name || copy.allow),
      kind: String(option.kind || ""),
    }));
    setPendingPermission({
      id: payload.requestId,
      title: String(tool.title || copy.grokWantsAction),
      command: command || undefined,
      options,
      conversationId: payload.conversationId,
    });
    setPermissionExpanded(false);
    mutateAssistant((assistant) => {
      assistant.events = upsertEvent(assistant.events, {
        id: `interaction-${payload.requestId}`,
        kind: "permission",
        title: String(tool.title || copy.grokWantsAction),
        status: "pending",
        input: jsonText(params),
      });
    });
  }, [lang, mutateAssistant]);

  const handleAcpUpdateRef = useRef(handleAcpUpdate);
  handleAcpUpdateRef.current = handleAcpUpdate;
  const finishTurnRef = useRef(finishTurn);
  finishTurnRef.current = finishTurn;
  const completeDirectImageGenRef = useRef(completeDirectImageGen);
  completeDirectImageGenRef.current = completeDirectImageGen;
  const handleInteractionRef = useRef(handleInteraction);
  handleInteractionRef.current = handleInteraction;

  const refresh = useCallback(async () => {
    setStatusError("");
    try {
      const next = await invoke<RuntimeStatus>("get_runtime_status");
      setStatus(next);
      setCwd((value) => (isHomeLikePath(value, next.homeDir) ? "" : value));
      return next;
    } catch (error) {
      setStatusError(String(error));
      return null;
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const state = await invoke<AccountState>("list_accounts");
      setAccounts(state.accounts);
      patchSettings({
        routingMode: state.routingMode || "quota",
        preferredAccountId: state.preferredAccountId,
      });
    } catch {
      // ignore
    }
  }, [patchSettings]);

  const loadSessionHistory = useCallback(async (conversationId: string, older = false) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation?.grokSessionId || historyBusyRef.current.has(conversationId)) return;
    // Remote SSH chats must never pull local ~/.grok session history.
    if (conversation.ssh || isSshWorkspace(conversation.cwd)) return;
    // Freeze history entirely while sending or while sticky outgoing bubbles exist.
    if (
      liveTurnsRef.current.has(conversationId) ||
      conversation.messages.some((item) => item.streaming || item.queued || item.local)
    ) {
      return;
    }
    if (older && conversation.historyHasMore === false) return;
    if (!older && historyLoadedRef.current.has(conversationId)) return;
    if (!older) historyLoadedRef.current.add(conversationId);
    historyBusyRef.current.add(conversationId);
    const epoch = historyEpochRef.current[conversationId] || 0;
    if (older && conversationId === selectedIdRef.current) setLoadingOlder(true);
    const skip = older ? conversation.historySkip || conversation.messages.length : 0;
    try {
      const history = await invoke<LocalSessionHistory>("load_session_history", {
        sessionId: conversation.grokSessionId,
        limit: HISTORY_PAGE,
        skip,
      });
      // Drop stale responses that finished after a new send started.
      if (epoch !== (historyEpochRef.current[conversationId] || 0)) return;
      const latest = conversationsRef.current.find((item) => item.id === conversationId);
      if (
        !latest ||
        liveTurnsRef.current.has(conversationId) ||
        latest.messages.some((item) => item.streaming || item.queued || item.local)
      ) {
        return;
      }
      const incoming: ChatMessage[] = (history.messages || []).map((item) => ({
        id: uid(),
        role: item.role === "assistant" ? "assistant" : "user",
        text: item.text || "",
        thought: "",
        events: (item.events || []).map((event) => ({
          id: event.id || uid(),
          kind: event.kind || "other",
          title: event.title || event.kind || t.toolCall,
          status: event.status,
          input: event.input,
          output: event.output,
        })),
        media: hydrateHistoryMedia(item.events || [], item.text || "", history.sessionDir),
        streaming: false,
      }));
      const el = transcriptRef.current;
      const prevHeight = el?.scrollHeight || 0;
      const prevTop = el?.scrollTop || 0;
      const hasMore = incoming.length === 0
        ? Boolean(history.hasMore)
        : incoming.length >= HISTORY_PAGE || Boolean(history.hasMore);
      setConversations((list) =>
        list.map((item) => {
          if (item.id !== conversationId) return item;
          // Never rewrite a transcript that already has local/optimistic bubbles.
          if (item.messages.some((message) => message.streaming || message.queued || message.local)) {
            return item;
          }
          const messages = incoming.length
            ? mergeHistoryMessages(item.messages, incoming, older)
            : item.messages;
          return {
            ...item,
            messages,
            sessionDir: history.sessionDir || item.sessionDir,
            historyHasMore: hasMore,
            historySkip: skip + incoming.length,
          };
        }),
      );
      if (!older) {
        setShownCount((count) => Math.max(VIEW_PAGE, count, incoming.length, conversation.messages.length));
        requestAnimationFrame(() => {
          const box = transcriptRef.current;
          if (!box) return;
          if (!userPinnedRef.current && followRef.current) {
            box.scrollTop = box.scrollHeight;
            setShowJumpToBottom(false);
          } else {
            syncJumpButton(box);
          }
        });
      }
      if (older && conversationId === selectedIdRef.current) {
        setShownCount((count) => Math.max(count, conversation.messages.length) + incoming.length);
        requestAnimationFrame(() => {
          const box = transcriptRef.current;
          if (!box) return;
          box.scrollTop = box.scrollHeight - prevHeight + prevTop;
          historyLockedRef.current = true;
          window.setTimeout(() => {
            historyLockedRef.current = false;
          }, 240);
          updateFollowState(box);
        });
      }
      if (!older && history.usedTokens != null && conversationId === selectedIdRef.current) {
        setUsage({
          usedTokens: Number(history.usedTokens) || 0,
          totalTokens: Number(history.totalTokens) || settingsRef.current.contextWindowTokens,
          compactionCount: Number(history.compactionCount) || 0,
        });
      }
    } catch {
      if (!older) historyLoadedRef.current.delete(conversationId);
    } finally {
      historyBusyRef.current.delete(conversationId);
      if (conversationId === selectedIdRef.current) setLoadingOlder(false);
    }
  }, [updateFollowState]);

  useLayoutEffect(() => {
    followRef.current = true;
    setShowJumpToBottom(false);
    scrollToBottom(true);
  }, [selectedId, scrollToBottom]);

  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (el) syncJumpButton(el);
  }, [selectedId, shownCount, running, syncJumpButton]);

  useEffect(() => {
    const root = transcriptRef.current;
    if (!root) return;
    let raf = 0;
    const sync = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        scrollToBottom();
        syncJumpButton(root);
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    const inner = root.querySelector(".messages, .empty");
    if (inner) observer.observe(inner);
    window.addEventListener("resize", sync);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [selectedId, shownCount, scrollToBottom, syncJumpButton, visibleMessages.length === 0]);

  useEffect(() => {
    const root = transcriptRef.current;
    const target = topSentinelRef.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (historyLockedRef.current || liveTurnsRef.current.has(selectedIdRef.current || "") || stickyOutgoingRef.current.some((item) => !item.conversationId || item.conversationId === selectedIdRef.current)) return;
        if (followRef.current && !userPinnedRef.current) return;
        const rootEl = transcriptRef.current;
        if (!rootEl || rootEl.scrollTop > 8) return;
        const conversation = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
        if (!conversation) return;
        if (conversation.messages.some((item) => item.streaming || item.queued || item.local)) return;
        revealOlder(conversation.id);
      },
      { root, rootMargin: "0px", threshold: 1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [selectedId, selected?.messages.length, loadSessionHistory]);

  const loadLocalSessions = useCallback(async () => {
    try {
      const summaries = await invoke<LocalSessionSummary[]>("list_local_sessions");
      setConversations((current) => mergeLocalSessions(current, summaries || []));
      return conversationsRef.current;
    } catch {
      return conversationsRef.current;
    }
  }, []);

  const loadRelayQuota = useCallback(async () => {
    try {
      const next = await invoke<RelayQuota>("get_relay_quota");
      setRelayQuota(next);
      if (next.configured) setRelayReady(true);
    } catch {
      setRelayQuota(null);
    }
  }, []);

  const selectModel = useCallback((id: string) => {
    const next = canonicalModelId(id.trim());
    if (!next) return;
    setModel(next);
    setForm((current) => (current.model === next ? current : { ...current, model: next }));
    const item = availableModelsRef.current.find((entry) => entry.id === next);
    void invoke("set_active_model", {
      model: next,
      contextWindow: item?.contextWindow ?? null,
    }).catch(() => undefined);
  }, []);

  const loadRelayModels = useCallback(
    async (fromForm = false) => {
      setModelsLoading(true);
      setModelsError("");
      setModelsMessage("");
      try {
        const currentForm = formRef.current;
        const payload =
          fromForm && currentForm.endpoint.trim()
            ? { endpoint: currentForm.endpoint.trim(), apiKey: currentForm.apiKey.trim() }
            : null;
        const catalog = await invoke<ModelCatalog>("list_relay_models", { payload });
        const models = catalog.models || [];
        setAvailableModels(models);
        if (!models.length) {
          setModelsError(tRef.current.modelsEmpty);
          return;
        }
        setModelsMessage(`${tRef.current.modelsFetched} (${models.length})`);
        const current = modelRef.current || currentForm.model;
        if (!models.some((item) => item.id === current)) {
          selectModel(models[0].id);
        }
      } catch (error) {
        setModelsError(String(error));
      } finally {
        setModelsLoading(false);
      }
    },
    [selectModel],
  );

  const addPendingImages = useCallback((items: PromptAttachment[]) => {
    setPendingImages((current) => {
      const next = [...current];
      for (const item of items) {
        if (!item.data || next.length >= MAX_ATTACHMENTS) continue;
        const key = `${item.name || ""}:${item.data.slice(0, 64)}`;
        if (next.some((existing) => `${existing.name || ""}:${existing.data?.slice(0, 64)}` === key)) continue;
        next.push(item);
      }
      return next;
    });
  }, []);
  const addPendingImagesRef = useRef(addPendingImages);
  addPendingImagesRef.current = addPendingImages;

  const refreshSkills = useCallback(async () => {
    const localCwd = isSshWorkspace(cwdRef.current) ? null : cwdRef.current || null;
    try {
      const [next, dirs] = await Promise.all([
        invoke<SkillRecord[]>("list_skills", { cwd: localCwd }),
        invoke<{ userDir: string; projectDir?: string | null; serverDir: string }>("list_skill_dirs", { cwd: localCwd }),
      ]);
      setSkills(next);
      setSkillDirs(dirs);
    } catch {
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    void refreshSkills();
  }, [cwd, refreshSkills]);

  const refreshQuotas = useCallback(async () => {
    setRefreshingQuota(true);
    try {
      const next: AccountRecord[] = [];
      for (const account of accountsRef.current.filter((item) => item.enabled && item.loggedIn)) {
        next.push(await invoke<AccountRecord>("refresh_account_quota", { account }));
      }
      const merged = accountsRef.current.map((account) => next.find((item) => item.id === account.id) || account);
      await persistAccounts(merged);
      await loadRelayQuota();
      setStatusText(tRef.current.refreshQuota);
    } finally {
      setRefreshingQuota(false);
    }
  }, [loadRelayQuota, persistAccounts]);

  const applyImport = useCallback(
    async (payload: RelayImport) => {
      setImporting(true);
      setImportError("");
      setImportMessage("");
      try {
        const result = await invoke<ImportResult>("import_relay", { payload });
        setForm((current) => ({
          ...current,
          endpoint: result.endpoint,
          model: result.model,
          apiKey: payload.apiKey,
        }));
        setModel(canonicalModelId(result.model) || result.model);
        setRelayReady(true);
        const backup = result.backupPath ? `\n${tRef.current.backup}: ${result.backupPath}` : "";
        setImportMessage(`${tRef.current.wrote} ${result.configPath}${backup}\n${tRef.current.imported}`);
        await refresh();
        await loadRelayQuota();
        await loadRelayModels(false);
        setView("chat");
        setStatusText(tRef.current.imported);
        try {
          await invoke("stop_session");
        } catch {
          // no live session
        }
      } catch (error) {
        setImportError(String(error));
        setView("settings");
        setSettingsPage("relay");
      } finally {
        setImporting(false);
      }
    },
    [loadRelayModels, loadRelayQuota, refresh],
  );

  const consumeDeeplink = useCallback(
    async (payload: RelayImport) => {
      const sig = importSig(payload);
      if (sig === lastImportRef.current) return;
      lastImportRef.current = sig;
      setForm({
        endpoint: payload.endpoint,
        apiKey: payload.apiKey,
        model: payload.model || "grok-4.5",
        name: payload.name || "小哈AI",
      });
      setModel(payload.model || "grok-4.5");
      try {
        await invoke("take_pending_import");
      } catch {
        // ignore
      }
      await applyImport(payload);
    },
    [applyImport],
  );
  const consumeDeeplinkRef = useRef(consumeDeeplink);
  consumeDeeplinkRef.current = consumeDeeplink;

  const installOfficial = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    setInstallError("");
    setInstallLog(`${tRef.current.installing}\n`);
    setShowInstallPrompt(false);
    setView("settings");
    setSettingsPage("runtime");
    try {
      const path = await invoke<string>("install_runtime");
      setInstallLog((log) => `${log}${t.installedPrefix}${path}\n`);
      await refresh();
    } catch (error) {
      setInstallError(String(error));
      setInstallLog((log) => `${log}${String(error)}\n`);
    } finally {
      setInstalling(false);
    }
  }, [installing, lang, refresh]);

  useEffect(() => {
    const { list, id } = ensureConversation(conversationsRef.current, selectedIdRef.current, cwd);
    if (list !== conversationsRef.current) setConversations(list);
    if (id !== selectedIdRef.current) setSelectedId(id);
  }, [cwd, ensureConversation]);

  useEffect(() => {
    if (!pendingQuestion && !pendingPlan && !pendingPermission) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector(".ask-card")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingQuestion?.id, pendingPlan?.id, pendingPermission?.id]);

  useEffect(() => {
    const stops: UnlistenFn[] = [];
    let alive = true;
    const add = async (promise: Promise<UnlistenFn>) => {
      const stop = await promise;
      if (!alive) stop();
      else stops.push(stop);
    };
    (async () => {
      const runtime = await refresh();
      await loadAccounts();
      void loadRelayQuota();
      void loadRelayModels(false);
      await refreshSkills();
      const imported = await loadLocalSessions();
      const path = usableWorkspace(cwdRef.current, runtime?.homeDir || "");
      const ensured = ensureConversation(imported, selectedIdRef.current, path);
      setConversations((current) => {
        const live = current.some((item) => item.messages.some((message) => message.streaming || message.queued));
        return live ? current : ensured.list;
      });
      setSelectedId(ensured.id);
      if (ensured.id && !runningRef.current) void loadSessionHistory(ensured.id);
      setStatusText(
        runtime?.installed
          ? runtime.credentialsReady
            ? tRef.current.ready
            : tRef.current.needCredentials
          : tRef.current.needRuntime,
      );
      if (runtime && !runtime.installed) setShowInstallPrompt(true);
      await add(listen<string>("install-log", (event) => setInstallLog((log) => `${log}${event.payload}\n`)));
      await add(listen<AcpUpdate>("acp-update", (event) => handleAcpUpdateRef.current(event.payload)));
      await add(
        listen<AcpTurnDone>("acp-turn-done", (event) => {
          const error = event.payload.error;
          const conversationId = event.payload.conversationId;
          if (!event.payload.ok && isContextTooLarge(error)) {
            const targetId = conversationId || selectedIdRef.current;
            const conv = conversationsRef.current.find((item) => item.id === targetId);
            const lastUser = [...(conv?.messages || [])].reverse().find((item) => item.role === "user");
            const assistant = [...(conv?.messages || [])].reverse().find((item) => item.role === "assistant" && item.streaming);
            if (conv && lastUser && isDirectImagePrompt(lastUser.text)) {
              const key = `${conv.id}:${lastUser.id}:imagine`;
              if (!contextRetryRef.current.has(key)) {
                contextRetryRef.current.add(key);
                void invoke("stop_session", { conversationId: conv.id }).catch(() => undefined);
                setConversations((list) => {
                  const next = list.map((item) => (item.id === conv.id ? { ...item, grokSessionId: "" } : item));
                  conversationsRef.current = next;
                  return next;
                });
                void completeDirectImageGenRef.current(
                  conv.id,
                  lastUser.text,
                  assistant?.id,
                  turnSeqRef.current[conv.id],
                );
                return;
              }
            }
          }
          finishTurnRef.current(event.payload.ok ? undefined : error, conversationId);
        }),
      );
      await add(
        listen<{ method: string; requestId: string; params: Record<string, unknown>; conversationId?: string }>("acp-interaction", (event) =>
          handleInteractionRef.current(event.payload),
        ),
      );
      await add(listen<string>("account-login-log", (event) => setLoginLog((log) => `${log}${event.payload}\n`)));
      await add(
        listen<{ ok: boolean; error?: string }>("account-login-done", async (event) => {
          setAddingAccount(false);
          setLoginLog((log) => `${log}${event.payload.ok ? tRef.current.login : event.payload.error || tRef.current.failed}\n`);
          await loadAccounts();
          if (event.payload.ok) await refreshQuotas();
        }),
      );
      await add(listen<RelayImport>("relay-import", (event) => void consumeDeeplinkRef.current(event.payload)));
      await add(
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "over" || event.payload.type === "enter") setDragOver(true);
          else if (event.payload.type === "drop") {
            setDragOver(false);
            ingestDroppedPathsRef.current(event.payload.paths || []);
          } else {
            setDragOver(false);
          }
        }),
      );
      try {
        const pending = await invoke<RelayImport | null>("take_pending_import");
        if (pending) await consumeDeeplinkRef.current(pending);
      } catch {
        // ignore
      }
    })();
    return () => {
      alive = false;
      stops.forEach((stop) => stop());
    };
  }, [ensureConversation, loadAccounts, loadLocalSessions, loadRelayModels, loadRelayQuota, loadSessionHistory, refresh, refreshQuotas, refreshSkills]);

  function newConversation(
    account?: AccountRecord,
    projectRef?: string | ProjectRecord,
    workspace?: { cwd: string; ssh?: SshTarget | null },
  ) {
    const project =
      typeof projectRef === "object"
        ? projectRef
        : projectRecords.find((item) => item.id === (projectRef || activeProjectId)) || null;
    const blank = conversations.find(
      (item) =>
        item.messages.length === 0 &&
        !item.archivedAt &&
        !item.grokSessionId &&
        (project ? item.projectId === project.id || (!item.projectId && sameWorkspace(item, project)) : !item.projectId),
    );
    if (blank && !account) {
      followRef.current = true;
      setShowJumpToBottom(false);
      setSelectedId(blank.id);
      setView("chat");
      if (project) setActiveProjectId(project.id);
      if (blank.cwd) setCwd(blank.cwd);
      return;
    }

    const nextCwd = project
      ? project.ssh
        ? sshWorkspaceId(project.ssh)
        : project.cwd
      : workspace
        ? workspace.ssh
          ? sshWorkspaceId(workspace.ssh)
          : workspace.cwd
        : usableWorkspace(cwd, homeDir);
    const nextSsh =
      project?.ssh ||
      workspace?.ssh ||
      activeSsh ||
      (isSshWorkspace(nextCwd) ? parseSshWorkspace(nextCwd) : null) ||
      resolveConversationSsh({ id: "", title: "", cwd: nextCwd, messages: [], updatedAt: 0, ssh: null }, sshHosts);
    const created: Conversation = {
      id: uid(),
      title: t.newChat,
      cwd: nextCwd,
      ssh: nextSsh,
      projectId: project?.id,
      accountId: account?.id || activeAccount?.id,
      messages: [],
      updatedAt: Date.now(),
    };

    setConversations((list) => [created, ...list.filter((item) => item.id !== created.id)]);
    setSelectedId(created.id);
    if (project) {
      setActiveProjectId(project.id);
      setProjectRecords((list) =>
        list.map((item) => (item.id === project.id ? { ...item, updatedAt: Date.now() } : item)),
      );
    }
    if (project || workspace) setCwd(nextCwd);
    setView("chat");
    setPrompt("");
    setPendingImages([]);
    setPendingFiles([]);
    setUsage({ usedTokens: 0, totalTokens: settings.contextWindowTokens, compactionCount: 0 });
    followRef.current = true;
    setShowJumpToBottom(false);
  }

  newChatRef.current = () => newConversation();

  function selectConversation(id: string) {
    const item = conversations.find((entry) => entry.id === id);
    setSelectedId(id);
    setShownCount(VIEW_PAGE);
    setView("chat");
    followRef.current = true;
    setShowJumpToBottom(false);
    // Allow history to reload so repaired reconstructions replace stale local windows.
    historyLoadedRef.current.delete(id);
    if (item?.projectId) setActiveProjectId(item.projectId);
    if (item?.cwd) setCwd(item.cwd);
    if (!liveTurnsRef.current.has(id) && !item?.ssh && !isSshWorkspace(item?.cwd || "")) {
      void loadSessionHistory(id);
    }
  }

  function deleteConversation(id: string) {
    if (liveTurnsRef.current.has(id)) {
      bumpConversationTurn(id);
      setConversationLive(id, false);
      void invoke("stop_session", { conversationId: id }).catch(() => undefined);
    }
    const next = conversations.filter((item) => item.id !== id);
    const ensured = ensureConversation(next, id === selectedId ? null : selectedId, usableWorkspace(cwd, homeDir));
    setConversations(ensured.list);
    setSelectedId(ensured.id);
  }
  function applyCwd(path: string, ssh?: SshTarget | null) {
    const trimmed = path.trim();
    const nextSsh = ssh === undefined ? (isSshWorkspace(trimmed) ? parseSshWorkspace(trimmed) : null) : ssh;
    setCwd(trimmed);
    setConversations((list) =>
      list.map((item) => (item.id === selectedId ? { ...item, cwd: trimmed, ssh: nextSsh } : item)),
    );
  }

  function selectProjectGroup(group: { id: string; path: string; cwd: string; ssh: SshTarget | null; explicit: boolean; items?: Conversation[] }) {
    setActiveProjectId(group.explicit ? group.id : null);
    setCollapsed((current) => ({ ...current, [group.path]: false }));
    const currentId = selectedIdRef.current;
    const items = group.items || [];
    if (items.some((item) => item.id === currentId)) {
      setCwd(group.path);
      setShowWorkspace(true);
      setView("chat");
      return;
    }
    if (items[0]) {
      selectConversation(items[0].id);
      setShowWorkspace(true);
      return;
    }
    setCwd(group.path);
    setShowWorkspace(true);
    setView("chat");
  }

  function finishCreateProject(input: { cwd: string; ssh?: SshTarget | null; name?: string }) {
    const cwd = input.cwd.trim();
    const ssh = input.ssh || (isSshWorkspace(cwd) ? parseSshWorkspace(cwd) : null);
    const existing = projectRecords.find((item) => sameWorkspace(item, { cwd, ssh }));
    const name =
      input.name ||
      (ssh ? sshLabel(ssh) : workspaceLabel(cwd, homeDir, t.home));
    const record: ProjectRecord = existing || {
      id: uid(),
      name,
      cwd,
      ssh,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!existing) setProjectRecords((list) => [record, ...list.filter((item) => item.id !== record.id)]);
    else {
      setProjectRecords((list) =>
        list.map((item) => (item.id === record.id ? { ...item, updatedAt: Date.now() } : item)),
      );
    }
    setConversations((list) =>
      list.map((item) =>
        !item.projectId && sameWorkspace(item, record) ? { ...item, projectId: record.id } : item,
      ),
    );
    setActiveProjectId(record.id);
    setCollapsed((current) => ({ ...current, [workspaceKey(record.cwd, record.ssh)]: false }));
    setCwd(cwd);
    setShowCreateProject(false);
    setShowWorkspace(true);
    setView("chat");
    const matching = conversations
      .filter((item) => !item.archivedAt && (item.projectId === record.id || sameWorkspace(item, record)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!matching.length) newConversation(undefined, record);
    else selectConversation(matching[0].id);
  }

  async function createLocalProject() {
    try {
      const picked = await invoke<string | null>("pick_workspace_folder", {
        current: workspaceRoot || sessionCwd || null,
      });
      if (!picked) return;
      if (isHomeLikePath(picked, homeDir)) {
        setStatusText(t.workspaceHomeHint);
        return;
      }
      finishCreateProject({ cwd: picked, ssh: null });
    } catch (error) {
      setStatusText(localizeThrown(error, t));
    }
  }

  async function startRemoteProject() {
    setShowCreateProject(false);
    sshForProjectRef.current = true;
    await openSshModal();
  }

  function deleteProject(id: string) {
    setProjectRecords((list) => list.filter((item) => item.id !== id));
    setConversations((list) =>
      list.map((item) => (item.projectId === id ? { ...item, projectId: undefined } : item)),
    );
    if (activeProjectId === id) setActiveProjectId(null);
  }
  async function loadSshHosts() {
    try {
      const [hosts, configHosts] = await Promise.all([
        invoke<SshTarget[]>("list_ssh_hosts"),
        invoke<SshConfigHost[]>("list_ssh_config_hosts"),
      ]);
      setSshHosts(Array.isArray(hosts) ? hosts : []);
      setSshConfigHosts(Array.isArray(configHosts) ? configHosts : []);
    } catch {
      setSshHosts([]);
      setSshConfigHosts([]);
    }
  }

  async function openSshModal() {
    setSshError("");
    setSshProbe(null);
    setSshEntries([]);
    setSshBrowsePath("");
    setSshForm(activeSsh ? { ...emptySshTarget(), ...activeSsh } : emptySshTarget());
    setShowSshModal(true);
    await loadSshHosts();
  }

  async function pickSshIdentity() {
    try {
      const picked = await invoke<string | null>("pick_ssh_identity");
      if (!picked) return;
      setSshForm((current) => ({ ...current, identityFile: picked, auth: "key" }));
    } catch (error) {
      setSshError(String(error));
    }
  }

  async function testSsh(target = sshForm) {
    setSshBusy(true);
    setSshError("");
    setStatusText(`${t.sshConnecting} ${t.sshAutoSetup}`);
    try {
      const probe = await invoke<SshProbe>("probe_ssh_host", {
        target: { ...target, remotePath: "" },
      });
      setSshProbe(probe);
      // Prefer filesystem root so the picker starts at the top-level path.
      const start = probe.remotePath || "/";
      setSshBrowsePath(start);
      setSshEntries(probe.entries || []);
      setSshForm((current) => ({ ...current, remotePath: start }));
      setStatusText(probe.message);
      return probe;
    } catch (error) {
      const message = String(error);
      setSshError(message);
      setSshProbe(null);
      setSshEntries([]);
      setStatusText(message);
      return null;
    } finally {
      setSshBusy(false);
    }
  }

  async function browseSshDir(path: string, target = sshForm) {
    setSshBusy(true);
    setSshError("");
    try {
      const entries = await invoke<WorkspaceEntry[]>("list_ssh_dir", { target, path });
      setSshBrowsePath(path);
      setSshEntries(Array.isArray(entries) ? entries : []);
      setSshForm((current) => ({ ...current, remotePath: path }));
    } catch (error) {
      setSshError(String(error));
    } finally {
      setSshBusy(false);
    }
  }

  function sshParentPath(path: string) {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized || normalized === "/" || normalized === "~") return "";
    const parts = normalized.split("/").filter(Boolean);
    if (normalized.startsWith("/")) {
      return parts.length <= 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
    }
    return parts.slice(0, -1).join("/") || "~";
  }

  async function applySshWorkspace(target = sshForm) {
    const folder = (sshBrowsePath || target.remotePath).trim();
    if (!folder) {
      setSshError(t.sshConnectedPick);
      return;
    }
    const probe = sshProbe || (await testSsh(target));
    if (!probe) return;
    const normalized: SshTarget = {
      ...target,
      host: target.host.trim(),
      user: target.user.trim() || "root",
      port: target.port || 22,
      remotePath: folder,
      identityFile: target.identityFile || "",
      auth: target.auth === "password" ? "password" : "key",
      password: target.auth === "password" ? target.password || "" : "",
      alias: target.alias || "",
    };
    const id = sshWorkspaceId(normalized);
    if (sshForProjectRef.current) {
      sshForProjectRef.current = false;
      finishCreateProject({ cwd: id, ssh: normalized });
      setShowSshModal(false);
    } else {
      applyCwd(id, normalized);
      setShowWorkspace(true);
      setShowSshModal(false);
      setView("chat");
    }
    try {
      const next = [normalized, ...sshHosts.filter((item) => sshWorkspaceId(item) !== id)].slice(0, 12);
      setSshHosts(next);
      await invoke("save_ssh_hosts", { hosts: next });
    } catch {
      // keep the workspace even if history save fails
    }
  }

  async function pickWorkspaceFolder() {
    try {
      const picked = await invoke<string | null>("pick_workspace_folder", {
        current: workspaceRoot || sessionCwd || null,
      });
      if (!picked) return;
      if (isHomeLikePath(picked, homeDir)) {
        setStatusText(t.workspaceHomeHint);
        return;
      }
      applyCwd(picked, null);
    } catch (error) {
      setStatusText(localizeThrown(error, t));
    }
  }

  async function sendText(
    text: string,
    extraAttachments?: PromptAttachment[],
    options?: { fromQueue?: boolean; conversationId?: string; messageId?: string; interrupt?: boolean; displayText?: string },
  ) {
    const conversation = conversationsRef.current.find((item) => item.id === (options?.conversationId || selectedIdRef.current));
    const attachments = (extraAttachments ?? pendingImagesRef.current).filter((item) => item.data);
    const outbound = appendMentions(
      text,
      pendingFilesRef.current.map((item) => item.mention),
    ).trim();
    if ((!outbound && !attachments.length) || !conversation) return;
    const existingQueued = options?.messageId
      ? conversation.messages.find((item) => item.id === options.messageId)
      : undefined;
    const visible =
      (options?.displayText || (options?.fromQueue ? existingQueued?.text : "") || outbound).trim() || outbound;
    if (liveTurnsRef.current.has(conversation.id) && !options?.fromQueue) {
      if (options?.interrupt) {
        promptQueueRef.current = promptQueueRef.current.filter((item) => item.conversationId !== conversation.id);
        setQueuedPrompts([...promptQueueRef.current]);
        bumpConversationTurn(conversation.id);
        // Seal the in-flight assistant BEFORE tearing down the session so tool/
        // process output cannot vanish when stop_session races history merges.
        setConversations((list) => {
          const next = list.map((item) =>
            item.id === conversation.id
              ? {
                  ...item,
                  messages: item.messages.map((message) =>
                    message.role === "assistant" && message.streaming
                      ? sealAssistantMessage(message, { stopped: true })
                      : message,
                  ),
                  updatedAt: Date.now(),
                }
              : item,
          );
          conversationsRef.current = next;
          return next;
        });
        setConversationLive(conversation.id, false);
        if (conversation.id === selectedIdRef.current) setStatusText(t.stopped);
        try {
          await invoke("cancel_turn", { conversationId: conversation.id });
        } catch {
          // ignore
        }
        try {
          await invoke("stop_session", { conversationId: conversation.id });
        } catch {
          // ignore
        }
      } else {
        const queuedUser: ChatMessage = {
          id: uid(),
          role: "user",
          text: visible,
          thought: "",
          events: [],
          media: attachments.map(mediaFromAttachment),
          streaming: false,
          queued: true,
          local: true,
          conversationId: conversation.id,
        };
        const queued: QueuedPrompt = {
          id: uid(),
          messageId: queuedUser.id,
          conversationId: conversation.id,
          text: outbound,
          displayText: visible,
          attachments,
        };
        promptQueueRef.current = [...promptQueueRef.current, queued];
        setQueuedPrompts(promptQueueRef.current);
        historyEpochRef.current[conversation.id] = (historyEpochRef.current[conversation.id] || 0) + 1;
        const queuedConversation = {
          ...conversation,
          messages: [...conversation.messages, queuedUser],
          updatedAt: Date.now(),
        };
        conversationsRef.current = conversationsRef.current.map((item) =>
          item.id === conversation.id ? queuedConversation : item,
        );
        setConversations((list) =>
          list.map((item) => (item.id === conversation.id ? queuedConversation : item)),
        );
        setStickyOutgoing((current) => [...current.filter((item) => item.id !== queuedUser.id), queuedUser]);
        setShownCount((count) => Math.max(count, conversation.messages.length + 1, VIEW_PAGE));
        setPrompt("");
        setPendingImages([]);
        setPendingFiles([]);
        if (composerRef.current) composerRef.current.style.height = "30px";
        if (conversation.id === selectedIdRef.current) {
          setStatusText(`${t.queued} ${promptQueueRef.current.filter((item) => item.conversationId === conversation.id).length}`);
        }
        requestAnimationFrame(() => scrollToBottom(true));
        return;
      }
    }
    if (liveTurnsRef.current.has(conversation.id)) return;
    const runtime = statusRef.current;
    const sshTarget = resolveConversationSsh(conversation, sshHosts);
    if (!sshTarget && !runtime?.installed) {
      setShowInstallPrompt(true);
      return;
    }
    if (sshTarget?.auth === "password" && !String(sshTarget.password || "").trim()) {
      setShowSshModal(true);
      setSshForm({ ...emptySshTarget(), ...sshTarget, password: "" });
      setSshError(t.reenterSshPassword);
      setStatusText(t.reenterSshPasswordStatus);
      return;
    }
    const relayOn = Boolean(relayQuotaRef.current?.configured || relayReadyRef.current);
    const named = accountsRef.current.find((item) => item.id === conversation.accountId);
    const account = relayOn
      ? undefined
      : named?.enabled && named?.loggedIn
        ? named
        : pickRoutedAccount(accountsRef.current, settingsRef.current);
    if (!sshTarget && runtime?.credentialsReady === false && !account?.loggedIn) {
      setView("settings");
      setSettingsPage("relay");
      setStatusText(t.needCredentials);
      return;
    }
    const turnId = bumpConversationTurn(conversation.id);
    // Invalidate any in-flight history fetch immediately, before React re-renders.
    historyEpochRef.current[conversation.id] = (historyEpochRef.current[conversation.id] || 0) + 1;
    historyBusyRef.current.delete(conversation.id);
    setPrompt("");
    setPendingImages([]);
    setPendingFiles([]);
    if (composerRef.current) composerRef.current.style.height = "30px";
    setConversationLive(conversation.id, true);
    if (conversation.id === selectedIdRef.current) setStatusText(t.connecting);
    followRef.current = true;
    setShowJumpToBottom(false);
    const title =
      conversation.title === translate("zh").newChat || conversation.title === translate("zh-Hant").newChat || conversation.title === translate("en").newChat
        ? (visible || attachments[0]?.name || t.newChat).slice(0, 28)
        : conversation.title;
    const existingUser = existingQueued;
    const user: ChatMessage = existingUser
      ? { ...existingUser, text: visible, media: attachments.map(mediaFromAttachment), queued: false, streaming: false, local: true, conversationId: conversation.id }
      : {
          id: uid(),
          role: "user",
          text: visible,
          thought: "",
          events: [],
          media: attachments.map(mediaFromAttachment),
          streaming: false,
          local: true,
          conversationId: conversation.id,
        };
    const assistant: ChatMessage = {
      id: uid(),
      role: "assistant",
      text: "",
      thought: "",
      events: [],
      media: [],
      streaming: true,
      local: true,
      conversationId: conversation.id,
    };
    userPinnedRef.current = false;
    followRef.current = true;
    setShownCount((count) => Math.max(count, conversation.messages.length + 2, VIEW_PAGE));
    turnUserIdRef.current[conversation.id] = user.id;
    const optimisticMessages = existingUser
      ? [
          ...conversation.messages.map((item) => (item.id === existingUser.id ? user : item)).filter((item) => !item.queued || item.id === user.id),
          assistant,
        ]
      : [...conversation.messages, user, assistant];
    const optimisticConversation = { ...conversation, title, messages: optimisticMessages, updatedAt: Date.now() };
    // Keep the ref in sync before await points so history merges see the local bubbles.
    conversationsRef.current = conversationsRef.current.map((item) =>
      item.id === conversation.id ? optimisticConversation : item,
    );
    setConversations((list) =>
      list.map((item) => (item.id === conversation.id ? optimisticConversation : item)),
    );
    setStickyOutgoing((current) => [...current.filter((item) => item.id !== user.id), user]);
    requestAnimationFrame(() => scrollToBottom(true));
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
    try {
      if (isDirectImagePrompt(visible, attachments.length > 0)) {
        if (conversation.id === selectedIdRef.current) setStatusText(t.generatingImage);
        setConversations((list) => {
          const next = list.map((item) => {
            if (item.id !== conversation.id) return item;
            return {
              ...item,
              title,
              messages: item.messages.map((message) =>
                message.id === assistant.id
                  ? {
                      ...message,
                      events: [
                        {
                          id: uid(),
                          kind: "image_gen",
                          title: "Generate Image",
                          status: "in_progress",
                        },
                      ],
                    }
                  : message,
              ),
            };
          });
          conversationsRef.current = next;
          return next;
        });
        await completeDirectImageGen(conversation.id, visible, assistant.id, turnId);
        return;
      }
      const workspaceCwd = sshTarget ? sshWorkspaceId(sshTarget) : conversation.cwd || cwdRef.current;
      const promptCwd = sshTarget?.remotePath || conversation.cwd || cwdRef.current;
      const checkpointPromise = promptCwd
        ? invoke<SnapshotFile[]>("capture_checkpoint", { root: promptCwd, ssh: sshTarget || null }).catch(() => [])
        : Promise.resolve([] as SnapshotFile[]);
      const expanded = await expandPromptContext(outbound, promptCwd, sshTarget || null);
      const session = await invoke<SessionInfo>("ensure_session", {
        options: {
          model: canonicalModelId(modelRef.current),
          cwd: sshTarget?.remotePath || conversation.cwd || cwdRef.current,
          ssh: sshTarget,
          existingSessionId: conversation.grokSessionId ?? null,
          grokHome: relayOn ? null : account?.homePath || null,
          permissionMode: settingsRef.current.permissionMode,
          reasoningEffort: settingsRef.current.reasoningEffort,
          contextWindowTokens: settingsRef.current.contextWindowTokens,
          autoCompactThresholdPercent: settingsRef.current.autoCompactThresholdPercent,
          enableMemory: settingsRef.current.enableMemory,
          enableWebSearch: settingsRef.current.enableWebSearch,
          enableSubagents: settingsRef.current.enableSubagents,
          conversationId: conversation.id,
        },
      });
      if (turnId !== conversationTurn(conversation.id)) return;
      setConversations((list) => {
        const next = list.map((item) => {
          if (item.id !== conversation.id) return item;
          // Re-assert optimistic bubbles after session id attach — history merge may race here.
          const hasUser = item.messages.some((message) => message.id === user.id);
          const hasAssistant = item.messages.some((message) => message.id === assistant.id);
          const messages =
            hasUser && hasAssistant
              ? item.messages
              : mergeConversationMessages(item.messages, [user, assistant]);
          return {
            ...item,
            title,
            messages,
            grokSessionId: session.sessionId,
            cwd: workspaceCwd,
            ssh: sshTarget || item.ssh || null,
            accountId: relayOn ? undefined : account?.id,
          };
        });
        conversationsRef.current = next;
        return next;
      });
      if (conversation.id === selectedIdRef.current) setStatusText(t.running);
      const snapshot = await checkpointPromise;
      const key = checkpointKey(conversation.id, user.id);
      if (snapshot.length) {
        checkpointsRef.current.set(key, snapshot);
        setCheckpointFlags((flags) => ({ ...flags, [key]: true }));
      }
      await invoke("send_prompt", {
        text: expanded,
        attachments: attachments.length ? attachments : null,
        conversationId: conversation.id,
      });
    } catch (error) {
      if (turnId !== conversationTurn(conversation.id)) return;
      setPendingImages(attachments);
      const message = String(error);
      if (isMissingCredentials(message)) {
        setView("settings");
        setSettingsPage("relay");
      }
      finishTurn(message, conversation.id);
    }
  }

  async function send() {
    const parsed = parseSlashInput(prompt, skillsRef.current);
    if (parsed?.kind === "mode" && parsed.mode) {
      setPermissionMode(parsed.mode);
      setPrompt("");
      setSlash(null);
      if (parsed.rest || pendingImagesRef.current.length || pendingFilesRef.current.length) await sendText(parsed.rest);
      return;
    }
    if (parsed?.kind === "skills") {
      setPrompt(parsed.rest ? `/${parsed.rest}` : "/");
      setSlash({ query: parsed.rest, index: 0, skillsOnly: true });
      return;
    }
    if (prompt.trim() === "/") {
      setSlash({ query: "", index: 0, skillsOnly: false });
      return;
    }
    const skill = parsed?.kind === "skill" ? parsed.skill : activeSkillRef.current;
    const task = parsed?.kind === "skill" ? parsed.rest : prompt;
    if (skill) {
      const display =
        parsed?.kind === "skill" ? `/${skill.name}${parsed.rest ? ` ${parsed.rest}` : ""}` : prompt.trim() || `/${skill.name}`;
      setActiveSkill(null);
      setSlash(null);
      await sendText(wrapSkillPrompt(skill, task), undefined, { displayText: display });
      return;
    }
    setSlash(null);
    await sendText(prompt);
  }

  async function stopTurn() {
    const id = selectedIdRef.current;
    if (id) bumpConversationTurn(id);
    // Freeze the live assistant first so cancel/stop cannot blank the transcript.
    finishTurn(t.connectionCancelled, id || undefined);
    try {
      await invoke("cancel_turn", { conversationId: id });
    } catch {
      // ignore
    }
    try {
      await invoke("stop_session", { conversationId: id });
    } catch {
      // ignore
    }
  }

  function startEditingMessage(message: ChatMessage) {
    if (message.role !== "user") return;
    setEditingMessageId(message.id);
    setEditingDraft(message.text);
  }

  async function saveEditedMessage() {
    const messageId = editingMessageId;
    const draft = editingDraft.trim();
    if (!messageId || !draft) {
      setEditingMessageId(null);
      return;
    }
    const conversation = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
    if (!conversation) return;
    const original = conversation.messages.find((item) => item.id === messageId);
    setConversations((list) =>
      list.map((item) => {
        if (item.id !== conversation.id) return item;
        const index = item.messages.findIndex((message) => message.id === messageId);
        if (index < 0) return item;
        const messages = item.messages.slice(0, index + 1).map((message) =>
          message.id === messageId ? { ...message, text: draft, queued: false, streaming: false, local: true } : message,
        );
        return { ...item, messages, updatedAt: Date.now() };
      }),
    );
    promptQueueRef.current = promptQueueRef.current.filter((item) => item.messageId !== messageId);
    setQueuedPrompts([...promptQueueRef.current]);
    setEditingMessageId(null);
    setEditingDraft("");
    const extras = (original?.media || [])
      .filter((item) => item.data)
      .map((item) => ({ mimeType: item.mimeType, data: item.data, name: item.name }));
    await sendText(draft, extras, { conversationId: conversation.id, interrupt: liveTurnsRef.current.has(conversation.id), messageId });
  }

  function sendQueuedNow(item: QueuedPrompt) {
    promptQueueRef.current = promptQueueRef.current.filter((entry) => entry.id !== item.id);
    setQueuedPrompts([...promptQueueRef.current]);
    void sendText(item.text, item.attachments, {
      conversationId: item.conversationId,
      messageId: item.messageId,
      interrupt: liveTurnsRef.current.has(item.conversationId),
    });
  }

  function removeQueued(item: QueuedPrompt) {
    promptQueueRef.current = promptQueueRef.current.filter((entry) => entry.id !== item.id);
    setQueuedPrompts([...promptQueueRef.current]);
    setConversations((list) =>
      list.map((conversation) =>
        conversation.id === item.conversationId
          ? { ...conversation, messages: conversation.messages.filter((message) => message.id !== item.messageId) }
          : conversation,
      ),
    );
  }

  function clearQueue() {
    const selected = selectedIdRef.current;
    const removed = promptQueueRef.current.filter((item) => item.conversationId === selected);
    const ids = new Set(removed.map((item) => item.messageId));
    promptQueueRef.current = promptQueueRef.current.filter((item) => item.conversationId !== selected);
    setQueuedPrompts([...promptQueueRef.current]);
    setConversations((list) =>
      list.map((conversation) =>
        conversation.id === selected
          ? { ...conversation, messages: conversation.messages.filter((message) => !ids.has(message.id)) }
          : conversation,
      ),
    );
  }

  async function regenerate() {
    const conversation = selected;
    if (!conversation || running) return;
    const lastUser = [...conversation.messages].reverse().find((item) => item.role === "user");
    if (!lastUser) return;
    setConversations((list) =>
      list.map((item) => {
        if (item.id !== conversation.id) return item;
        const messages = [...item.messages];
        if (messages[messages.length - 1]?.role === "assistant") messages.pop();
        return { ...item, messages };
      }),
    );
    const extras = lastUser.media
      .filter((item) => item.data)
      .map((item) => ({ mimeType: item.mimeType, data: item.data, name: item.name }));
    await sendText(lastUser.text, extras);
  }

  function applySlashItem(item: ReturnType<typeof allSlashItems>[number], rest = "") {
    setSlash(null);
    if (item.kind === "mode" && item.mode) {
      setPermissionMode(item.mode);
      const next = rest.trim();
      setPrompt(next);
      if (next || pendingImagesRef.current.length || pendingFilesRef.current.length) void sendText(next);
      return;
    }
    if (item.kind === "skills") {
      setPrompt("/");
      setSlash({ query: "", index: 0, skillsOnly: true });
      return;
    }
    if (item.kind === "skill" && item.skill) {
      const task = rest.trim();
      setPrompt(task);
      if (task || pendingImagesRef.current.length || pendingFilesRef.current.length) {
        void sendText(wrapSkillPrompt(item.skill, task), undefined, {
          displayText: `/${item.skill.name}${task ? ` ${task}` : ""}`,
        });
        setActiveSkill(null);
      } else {
        setActiveSkill(item.skill);
      }
    }
  }

  function isImeBlocked(event: { nativeEvent?: globalThis.KeyboardEvent } & { isComposing?: boolean; keyCode?: number; key?: string }) {
    const native = event.nativeEvent || (event as globalThis.KeyboardEvent);
    if (isImeEvent(native)) return true;
    if (imeRef.current.composing) return true;
    if (Date.now() < imeRef.current.until) return true;
    return false;
  }
  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeBlocked(event)) return;
    const detected = slashQuery(event.currentTarget.value, event.currentTarget.selectionStart || 0);
    const slashMenu = slashRef.current || (detected ? { query: detected.query, index: 0, skillsOnly: false } : null);
    if (slashMenu && (detected || slashMenu.skillsOnly)) {
      const items = filterSlashItems(
        allSlashItems(tRef.current, skillsRef.current),
        detected?.query ?? slashMenu.query,
        slashMenu.skillsOnly,
      );
      const ensure = (index: number) =>
        setSlash((current) => ({
          query: detected?.query ?? current?.query ?? "",
          skillsOnly: Boolean(current?.skillsOnly),
          index,
        }));
      if (event.key === "ArrowDown") {
        event.preventDefault();
        ensure(Math.min(Math.max(items.length - 1, 0), (slashMenu.index || 0) + 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        ensure(Math.max(0, (slashMenu.index || 0) - 1));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[slashMenu.index] || items[0];
        if (item) {
          event.preventDefault();
          applySlashItem(item);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlash(null);
        return;
      }
    }
    const menu = mentionRef.current;
    if (menu) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMention((current) => current && { ...current, index: Math.min(current.items.length - 1, current.index + 1) });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMention((current) => current && { ...current, index: Math.max(0, current.index - 1) });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = menu.items[menu.index];
        if (item) {
          event.preventDefault();
          insertMention(item.path);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    const map = resolvedBindings(settingsRef.current.keybindings);
    if (chordsMatch(event.nativeEvent, map.sendMessage)) {
      event.preventDefault();
      void send();
      return;
    }
    if (chordsMatch(event.nativeEvent, map.newLine)) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      pasteHandledRef.current = false;
      window.setTimeout(() => {
        if (pasteHandledRef.current) return;
        void invoke<PromptAttachment | null>("read_clipboard_image")
          .then((native) => {
            if (native?.data) addPendingImages([native]);
          })
          .catch(() => undefined);
      }, 80);
    }
  }

  function resizeComposer() {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "30px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  async function onComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement | HTMLDivElement>) {
    const clipboard = event.clipboardData;
    const hasText = Boolean(clipboard?.getData("text/plain")?.trim());
    const images: File[] = [];
    if (clipboard?.files) {
      for (const file of Array.from(clipboard.files)) {
        if (isImageFile(file)) images.push(file);
      }
    }
    if (clipboard?.items) {
      for (const item of Array.from(clipboard.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file && !images.some((current) => current === file)) images.push(file);
        }
      }
    }
    if (images.length) {
      event.preventDefault();
      pasteHandledRef.current = true;
      try {
        addPendingImages(await Promise.all(images.map(fileToAttachment)));
      } catch (error) {
        setStatusText(localizeThrown(error, t));
      }
      return;
    }
    if (hasText) {
      pasteHandledRef.current = true;
      return;
    }
    event.preventDefault();
    pasteHandledRef.current = true;
    try {
      const native = await invoke<PromptAttachment | null>("read_clipboard_image");
      if (native?.data) addPendingImages([native]);
    } catch (error) {
      setStatusText(localizeThrown(error, t));
    }
  }

  function rememberDrop(key: string) {
    if (!key || recentDropRef.current.has(key)) return true;
    recentDropRef.current.add(key);
    window.setTimeout(() => recentDropRef.current.delete(key), 600);
    return false;
  }

  async function ingestDroppedPaths(paths: string[]) {
    const images: string[] = [];
    const others: string[] = [];
    for (const path of paths) {
      const trimmed = path.trim();
      if (!trimmed || rememberDrop(normalizePath(trimmed))) continue;
      if (isImagePath(trimmed)) images.push(trimmed);
      else others.push(trimmed);
    }
    for (const path of images) {
      try {
        addPendingImages([await invoke<PromptAttachment>("read_image_file", { path })]);
      } catch (error) {
        setStatusText(localizeThrown(error, tRef.current));
      }
    }
    if (!others.length) return;
    const next: PendingFile[] = [];
    for (const path of others) {
      try {
        const info = await invoke<LocalPathInfo>("inspect_local_path", { path });
        let root = workspaceRootRef.current;
        if (!root && !activeSshRef.current) {
          const candidate = info.isDir ? info.path : parentDir(info.path);
          if (usableWorkspace(candidate, statusRef.current?.homeDir || "")) {
            applyCwd(candidate, null);
            workspaceRootRef.current = candidate;
            root = candidate;
          }
        }
        next.push({
          id: uid(),
          path: info.path,
          name: info.name,
          mention: mentionForDrop(info.path, root),
          isDir: info.isDir,
        });
      } catch (error) {
        setStatusText(localizeThrown(error, tRef.current));
      }
    }
    if (!next.length) return;
    setPendingFiles((current) => {
      const merged = [...current];
      for (const item of next) {
        if (merged.length >= MAX_PENDING_FILES) break;
        if (merged.some((existing) => samePath(existing.path, item.path))) continue;
        merged.push(item);
      }
      return merged;
    });
    setPrompt((current) => appendMentions(current, next.map((item) => item.mention)));
    setShowWorkspace(true);
    const focus = next.find((item) => !isAbsoluteLocalPath(item.mention));
    if (focus) {
      setWorkspaceFocusPath(focus.mention === "." ? "" : focus.mention);
      setWorkspaceFocusTick((tick) => tick + 1);
    }
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      resizeComposer();
    });
  }
  ingestDroppedPathsRef.current = (paths) => {
    void ingestDroppedPaths(paths);
  };

  function removePendingFile(id: string) {
    const item = pendingFilesRef.current.find((file) => file.id === id);
    setPendingFiles((current) => current.filter((file) => file.id !== id));
    if (item) setPrompt((current) => stripMention(current, item.mention));
  }

  function openDroppedFile(item: PendingFile) {
    if (!isAbsoluteLocalPath(item.mention)) {
      setShowWorkspace(true);
      setWorkspaceFocusPath(item.mention === "." ? "" : item.mention);
      setWorkspaceFocusTick((tick) => tick + 1);
    }
  }

  function revealDroppedFile(path: string) {
    void invoke("reveal_in_folder", { path }).catch((error) => setStatusText(localizeThrown(error, t)));
  }

  function onChatDragOver(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    setDragOver(true);
  }

  function onChatDragLeave(event: ReactDragEvent<HTMLElement>) {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDragOver(false);
  }

  async function onChatDrop(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    setDragOver(false);
    const workspaceFile = event.dataTransfer.getData("application/x-grokdesk-file");
    if (workspaceFile) {
      try {
        const item = JSON.parse(workspaceFile) as { mention?: string; name?: string; isDir?: boolean; path?: string };
        const mention = String(item.mention || "").trim();
        if (mention) {
          const file: PendingFile = {
            id: uid(),
            path: item.path || mention,
            name: item.name || mention.split("/").pop() || mention,
            mention,
            isDir: Boolean(item.isDir),
          };
          setPendingFiles((current) =>
            current.some((existing) => existing.mention === file.mention) ? current : [...current, file].slice(0, MAX_PENDING_FILES),
          );
          setPrompt((current) => appendMentions(current, [mention]));
          openDroppedFile(file);
          requestAnimationFrame(() => {
            composerRef.current?.focus();
            resizeComposer();
          });
        }
      } catch {
        // ignore malformed workspace drags
      }
      return;
    }
    const files = Array.from(event.dataTransfer.files || []);
    const paths = files.map(fileDropPath).filter(Boolean);
    if (paths.length) {
      await ingestDroppedPaths(paths);
      return;
    }
    if (recentDropRef.current.size) return;
    const images = files.filter(isImageFile);
    if (!images.length) return;
    const keys = images.map((file) => `blob:${file.name}:${file.size}`);
    if (keys.every((key) => rememberDrop(key))) return;
    try {
      addPendingImages(await Promise.all(images.map(fileToAttachment)));
    } catch (error) {
      setStatusText(localizeThrown(error, t));
    }
  }

  function insertMention(path: string) {
    const menu = mentionRef.current;
    const el = composerRef.current;
    if (!menu || !el) return;
    const cursor = el.selectionStart ?? prompt.length;
    const next = `${prompt.slice(0, menu.start)}@${path} ${prompt.slice(cursor)}`;
    setPrompt(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = menu.start + path.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
      resizeComposer();
    });
  }

  async function restoreTurn(userMessageId: string) {
    const key = checkpointKey(selectedId || "", userMessageId);
    const files = checkpointsRef.current.get(key) || [];
    if (!files.length || !workspaceRoot) {
      setStatusText(t.restoreTurnEmpty);
      return;
    }
    setStatusText(t.restoringTurn);
    try {
      await invoke("restore_checkpoint", { root: workspaceRoot, files, ssh: activeSsh || null });
      setWorkspaceRestoreTick((tick) => tick + 1);
      setWorkspaceFocusTick((tick) => tick + 1);
      setShowWorkspace(true);
      setStatusText(t.restoredTurn);
    } catch (error) {
      setStatusText(localizeThrown(error, t));
    }
  }

  function revealOlder(conversationId: string) {
    if (historyLockedRef.current || historyBusyRef.current.has(conversationId) || liveTurnsRef.current.has(conversationId) || stickyOutgoingRef.current.some((item) => !item.conversationId || item.conversationId === conversationId)) return;
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation) return;
    if (conversation.ssh || isSshWorkspace(conversation.cwd)) return;
    if (conversation.messages.some((item) => item.streaming || item.queued || item.local)) return;
    if (followRef.current && !userPinnedRef.current) return;
    const el = transcriptRef.current;
    if (el && el.scrollTop > 24) return;
    if (shownCountRef.current < conversation.messages.length) {
      const el = transcriptRef.current;
      const prevHeight = el?.scrollHeight || 0;
      const prevTop = el?.scrollTop || 0;
      setShownCount((count) => Math.min(conversation.messages.length, count + VIEW_PAGE));
      requestAnimationFrame(() => {
        const box = transcriptRef.current;
        if (!box) return;
        box.scrollTop = box.scrollHeight - prevHeight + prevTop;
        updateFollowState(box);
      });
      return;
    }
    if (conversation.grokSessionId && conversation.historyHasMore !== false) {
      void loadSessionHistory(conversation.id, true);
    }
  }

  function onTranscriptScroll() {
    const el = transcriptRef.current;
    if (!el) return;
    updateFollowState(el);
    if (historyLockedRef.current || liveTurnsRef.current.has(selectedIdRef.current || "") || stickyOutgoingRef.current.some((item) => !item.conversationId || item.conversationId === selectedIdRef.current)) return;
    if (followRef.current && !userPinnedRef.current) return;
    if (el.scrollTop > 8) return;
    if (selectedIdRef.current) revealOlder(selectedIdRef.current);
  }

  function onTranscriptWheel(event: ReactWheelEvent<HTMLElement>) {
    if (event.deltaY < 0) {
      followRef.current = false;
      userPinnedRef.current = true;
    }
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    const start = sidebarWidth;
    const origin = event.clientX;
    const move = (next: PointerEvent) => {
      setSidebarWidth(Math.min(400, Math.max(220, start + next.clientX - origin)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function beginWorkspaceResize(event: ReactPointerEvent<HTMLDivElement>) {
    const start = workspaceWidth;
    const origin = event.clientX;
    const sign = workspaceSide === "left" ? 1 : -1;
    const move = (next: PointerEvent) => {
      setWorkspaceWidth(Math.min(920, Math.max(380, start + sign * (next.clientX - origin))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function answerPermission(optionId: string | null) {
    if (!pendingPermission) return;
    try {
      await invoke("answer_interaction", {
        requestId: pendingPermission.id,
        result: optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } },
        conversationId: pendingPermission.conversationId,
      });
      mutateTargetRef.current = pendingPermission.conversationId || selectedIdRef.current;
      mutateAssistant((assistant) => {
        assistant.events = upsertEvent(assistant.events, {
          id: `interaction-${pendingPermission.id}`,
          kind: "permission",
          title: pendingPermission.title,
          status: optionId ? "approved" : "cancelled",
        });
      });
    } catch (error) {
      setStatusText(localizeThrown(error, t));
    }
    setPendingPermission(null);
  }

  async function answerQuestions(action: string) {
    if (!pendingQuestion) return;
    const answers: Record<string, string[]> = {};
    const annotations: Record<string, { notes: string }> = {};
    for (const question of pendingQuestion.questions) {
      const key = askQuestionKey(question);
      const note = (questionNotes[key] || "").trim();
      let picked = [...(questionAnswers[key] || [])];
      if (!picked.length && note) picked = [t.askOther];
      if (picked.length) answers[question.question || key] = picked;
      if (note) annotations[question.question || key] = { notes: note };
    }
    const gate = pendingQuestion.permissionOptions || [];
    const allow = gate.find((option) => /allow/i.test(`${option.id} ${option.kind} ${option.name}`));
    const reject = gate.find((option) => /reject|deny|cancel/i.test(`${option.id} ${option.kind} ${option.name}`));
    const permissionPick = action === "cancelled" ? reject : allow;
    const askResult =
      action === "cancelled"
        ? { outcome: "cancelled" }
        : {
            outcome: "accepted",
            answers,
            ...(Object.keys(annotations).length ? { annotations } : {}),
          };
    try {
      await invoke("answer_interaction", {
        requestId: pendingQuestion.id,
        result: permissionPick
          ? {
              ...askResult,
              outcome: { outcome: "selected", optionId: permissionPick.id },
            }
          : askResult,
        conversationId: pendingQuestion.conversationId,
      });
      mutateTargetRef.current = pendingQuestion.conversationId || selectedIdRef.current;
      mutateAssistant((assistant) => {
        assistant.events = upsertEvent(assistant.events, {
          id: `interaction-${pendingQuestion.id}`,
          kind: "question",
          title: pendingQuestion.questions[0]?.question
            ? `${t.modeAsk}: ${pendingQuestion.questions[0].question}`
            : t.grokNeedsChoice,
          status: action === "cancelled" ? "cancelled" : "approved",
          input: jsonText({ questions: pendingQuestion.questions, answers }),
        });
      });
    } catch (error) {
      setStatusText(localizeThrown(error, t));
    }
    setPendingQuestion(null);
    setQuestionAnswers({});
    setQuestionNotes({});
  }

  async function answerPlan(approved: boolean) {
    if (!pendingPlan) return;
    try {
      await invoke("answer_interaction", {
        requestId: pendingPlan.id,
        result: {
          outcome: approved ? "approved" : "cancelled",
          feedback: planFeedback || undefined,
        },
        conversationId: pendingPlan.conversationId,
      });
    } catch (error) {
      setStatusText(localizeThrown(error, t));
    }
    setPendingPlan(null);
    setPlanFeedback("");
  }

  async function onAddAccount(name: string) {
    setAddingAccount(true);
    setLoginLog(`${t.waitingLogin}\n`);
    try {
      await invoke("add_account", { name });
    } catch (error) {
      setAddingAccount(false);
      setLoginLog((log) => `${log}${String(error)}\n`);
    }
  }

  async function onLogin(account: AccountRecord) {
    setLoginLog(`${t.waitingLogin}\n`);
    try {
      await invoke("login_account", { account });
    } catch (error) {
      setLoginLog((log) => `${log}${String(error)}\n`);
    }
  }

  const osLabel =
    status?.os === "windows" ? "Windows" : status?.os === "macos" ? "macOS" : status?.os === "linux" ? "Linux" : "";
  const lastAssistant = findLast(selected?.messages, (item) => item.role === "assistant");
  const lastVisibleAssistantId = findLast(visibleMessages, (item) => item.role === "assistant")?.id || "";
  const toolEvents = lastAssistant?.events.filter((event) => event.id.startsWith("tool-")) || [];
  const planEvent = lastAssistant?.events.find((event) => event.kind === "plan");
  const fileDiffs = useMemo(() => {
    const latest = new Map<string, FileDiff>();
    const messages = selected?.messages || [];
    const scan = running && lastAssistant ? [lastAssistant] : messages;
    for (const message of scan) {
      for (const event of message.events || []) {
        for (const diff of event.diffs || []) {
          latest.set(diff.path || `anon-${latest.size}`, diff);
        }
      }
    }
    return [...latest.values()];
  }, [running, lastAssistant, selected?.messages]);
  const changedPaths = useMemo(
    () => fileDiffs.map((diff) => diff.path).filter((path): path is string => Boolean(path)),
    [fileDiffs],
  );
  transcriptActionsRef.current = {
    imeRef,
    saveEditedMessage: () => void saveEditedMessage(),
    cancelEdit: () => {
      setEditingMessageId(null);
      setEditingDraft("");
    },
    setEditingDraft,
    regenerate: () => void regenerate(),
    restoreTurn: (userId) => void restoreTurn(userId),
    startEditingMessage,
    sendRedraw: (_message, prevUser, retryFailed) => {
      if (retryFailed) {
        void regenerate();
        return;
      }
      const extras = (prevUser.media || [])
        .filter((item) => item.data)
        .map((item) => ({ mimeType: item.mimeType, data: item.data, name: item.name }));
      void sendText(prevUser.text, extras);
    },
  };

  const sshModal = showSshModal ? (
          <div className="overlay" onClick={() => { if (!sshBusy) { sshForProjectRef.current = false; setShowSshModal(false); } }}>
          <div className="modal wide" onClick={(event) => event.stopPropagation()}>
            <h3>{t.sshConnect}</h3>
            <p>{t.sshDetail}</p>
            <div className="ssh-grid">
              <label className="ssh-span">
                {t.sshFromConfig}
                <Select
                  variant="field"
                  align="start"
                  ariaLabel={t.sshFromConfig}
                  value={sshForm.alias || ""}
                  onChange={(value) => {
                    const found = sshConfigHosts.find((item) => item.alias === value);
                    if (found) setSshForm({ ...emptySshTarget(), ...fromSshConfigHost(found) });
                  }}
                  options={[
                    { id: "", label: sshConfigHosts.length ? t.sshFromConfig : t.sshConfigEmpty },
                    ...sshConfigHosts.map((item) => ({
                      id: item.alias,
                      label: item.user ? `${item.alias} · ${item.user}@${item.host}` : `${item.alias} · ${item.host}`,
                    })),
                  ]}
                />
              </label>
              <label>
                {t.sshUser}
                <input value={sshForm.user} spellCheck={false} placeholder="ubuntu" onChange={(event) => setSshForm((current) => ({ ...current, user: event.target.value }))} />
              </label>
              <label>
                {t.sshHost}
                <input value={sshForm.host} spellCheck={false} placeholder="10.0.0.8" onChange={(event) => setSshForm((current) => ({ ...current, host: event.target.value, alias: "" }))} />
              </label>
              <label>
                {t.sshPort}
                <input value={sshForm.port} spellCheck={false} onChange={(event) => setSshForm((current) => ({ ...current, port: Number(event.target.value) || 22 }))} />
              </label>
              <label>
                {t.sshAuth}
                <Select
                  variant="field"
                  align="start"
                  ariaLabel={t.sshAuth}
                  value={sshForm.auth === "password" ? "password" : "key"}
                  onChange={(value) => setSshForm((current) => ({ ...current, auth: value, password: value === "password" ? current.password || "" : "" }))}
                  options={[
                    { id: "key", label: t.sshAuthKey },
                    { id: "password", label: t.sshAuthPassword },
                  ]}
                />
              </label>
              {sshForm.auth === "password" ? (
                <label className="ssh-span">
                  {t.sshPassword}
                  <input type="password" value={sshForm.password || ""} autoComplete="off" onChange={(event) => setSshForm((current) => ({ ...current, password: event.target.value, auth: "password" }))} />
                </label>
              ) : (
                <label className="ssh-span">
                  {t.sshIdentity}
                  <div className="model-pick">
                    <input value={sshForm.identityFile || ""} spellCheck={false} placeholder="~/.ssh/id_ed25519" onChange={(event) => setSshForm((current) => ({ ...current, identityFile: event.target.value, auth: "key" }))} />
                    <button className="ghost compact nowrap" type="button" onClick={() => void pickSshIdentity()}>
                      {t.sshPickKey}
                    </button>
                  </div>
                </label>
              )}
            </div>
            <p className="hint">{t.sshIdentityHint}</p>
            {sshProbe ? (
              <div className="ssh-browser">
                <div className="ssh-browser-head">
                  <span>{t.sshBrowse}</span>
                  <code>{sshBrowsePath || sshForm.remotePath || "~"}</code>
                </div>
                <p className="hint left">{t.sshConnectedPick}</p>
                <div className="ssh-browser-actions">
                  {sshParentPath(sshBrowsePath || sshForm.remotePath) ? (
                    <button className="ghost compact nowrap" type="button" disabled={sshBusy} onClick={() => void browseSshDir(sshParentPath(sshBrowsePath || sshForm.remotePath))}>
                      {t.sshParent}
                    </button>
                  ) : null}
                </div>
                <div className="ssh-browser-list">
                  {sshEntries.filter((item) => item.isDir).length === 0 ? (
                    <div className="hint left" style={{ padding: "8px 12px" }}>{sshBusy ? t.sshConnecting : (sshError || t.sshConnectedPick)}</div>
                  ) : null}
                  {sshEntries.filter((item) => item.isDir).map((item) => {
                    const base = (sshBrowsePath || sshForm.remotePath || "~").replace(/\/+$/, "");
                    const full = (base === "/" ? `/${item.name}` : `${base}/${item.name}`).replace(/\/+/g, "/");
                    const selected = sshForm.remotePath === full;
                    return (
                      <button
                        key={full}
                        className={`ssh-dir${selected ? " selected" : ""}`}
                        type="button"
                        disabled={sshBusy}
                        onClick={() => void browseSshDir(full)}
                      >
                        <span>{item.name}/</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {sshHosts.length ? (
              <div className="ssh-recent">
                <div className="row-title">{t.sshRecent}</div>
                {sshHosts.map((item) => (
                  <button key={sshWorkspaceId(item)} className="ghost compact nowrap" type="button" onClick={() => setSshForm({ ...emptySshTarget(), ...item, password: "" })}>
                    {item.alias || sshLabel(item)}
                  </button>
                ))}
              </div>
            ) : null}
            {sshProbe ? <p className="ok-text">{sshProbe.message}</p> : null}
            {sshError ? <p className="error">{sshError}</p> : null}
            <div className="actions">
              <button className="ghost compact nowrap" type="button" disabled={sshBusy} onClick={() => { sshForProjectRef.current = false; setShowSshModal(false); }}>
                {t.close}
              </button>
              <button className="ghost compact nowrap" type="button" disabled={sshBusy || !sshForm.host.trim() || (sshForm.auth === "password" && !String(sshForm.password || "").trim())} onClick={() => void testSsh()}>
                {sshBusy ? t.sshConnecting : t.sshTest}
              </button>
              <button className="primary compact nowrap" type="button" disabled={sshBusy || !sshProbe || !(sshBrowsePath || sshForm.remotePath).trim()} onClick={() => void applySshWorkspace()}>
                {t.sshPickFolder}
              </button>
            </div>
          </div>
        </div>
      ) : null;

  const createProjectModal = showCreateProject ? (
        <div className="overlay" onClick={() => setShowCreateProject(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>{t.createProject}</h3>
              <button className="icon-btn" type="button" title={t.close} onClick={() => setShowCreateProject(false)}>
                <IconClose />
              </button>
            </div>
            <div className="type-label">{t.projectType}</div>
            <div className="type-cards">
              <button
                type="button"
                className={createProjectKind === "local" ? "type-card on" : "type-card"}
                onClick={() => setCreateProjectKind("local")}
              >
                <span className="type-check">{createProjectKind === "local" ? <IconCheck size={11} /> : null}</span>
                <span className="type-ico local">
                  <IconLaptop size={20} />
                </span>
                <strong>{t.projectLocal}</strong>
                <span className="type-hint">{t.projectLocalHint}</span>
              </button>
              <button
                type="button"
                className={createProjectKind === "remote" ? "type-card on" : "type-card"}
                onClick={() => setCreateProjectKind("remote")}
              >
                <span className="type-check">{createProjectKind === "remote" ? <IconCheck size={11} /> : null}</span>
                <span className="type-ico remote">
                  <IconGlobe size={20} />
                </span>
                <strong>{t.projectRemote}</strong>
                <span className="type-hint">{t.projectRemoteHint}</span>
              </button>
            </div>
            <div className="modal-foot">
              <button
                className="primary compact nowrap"
                type="button"
                onClick={() => void (createProjectKind === "remote" ? startRemoteProject() : createLocalProject())}
              >
                {t.projectNext}
              </button>
            </div>
          </div>
        </div>
      ) : null;

  const splashOverlay = splash ? (
    <div
      className="launch-splash empty"
      role="button"
      tabIndex={0}
      aria-label={t.splashHint}
      onClick={() => setSplash(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
          event.preventDefault();
          setSplash(false);
        }
      }}
    >
      <MorphingRings className="empty-rings" />
      <div className="empty-copy">
        <div className="empty-hero">
          <GrokMark size={28} className="empty-mark" />
          <div className="empty-wordmark">{t.emptyWordmark}</div>
        </div>
        <h1>{t.emptyTitle}</h1>
        <p className="launch-hint">{t.splashHint}</p>
      </div>
    </div>
  ) : null;

  if (view === "settings") {
    return (
      <>
      {splashOverlay}
      <SettingsView
        t={t}
        lang={lang}
        theme={theme}
        setLang={setLang}
        setTheme={setTheme}
        sidebarWidth={sidebarWidth}
        beginResize={beginResize}
        settingsPage={settingsPage}
        setSettingsPage={setSettingsPage}
        onBack={() => setView("chat")}
        settings={settings}
        patchSettings={(patch) => {
          patchSettings(patch);
          if (patch.routingMode != null || patch.preferredAccountId !== undefined) {
            void persistAccounts(accounts, patch);
          }
        }}
        model={model}
        setModel={selectModel}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        modelsMessage={modelsMessage}
        onRefreshModels={(fromForm) => void loadRelayModels(Boolean(fromForm))}
        cwd={sessionCwd}
        applyCwd={applyCwd}
        onPickWorkspace={() => void pickWorkspaceFolder()}
        onConnectSsh={() => void openSshModal()}
        ssh={activeSsh}
        sshHosts={sshHosts}
        status={status}
        statusError={statusError}
        installing={installing}
        installLog={installLog}
        installError={installError}
        installOfficial={() => void installOfficial()}
        refreshRuntime={() => void refresh()}
        form={form}
        setForm={setForm}
        importing={importing}
        importMessage={importMessage}
        importError={importError}
        applyImport={(payload) => void applyImport(payload)}
        accounts={accounts}
        setAccounts={(next) => void persistAccounts(next)}
        loginLog={loginLog}
        addingAccount={addingAccount}
        refreshingQuota={refreshingQuota}
        onAddAccount={(name) => void onAddAccount(name)}
        onLogin={(account) => void onLogin(account)}
        onRefreshQuotas={() => void refreshQuotas()}
        relayQuota={relayQuota}
        relayQuotaText={relayQuotaText}
        onOpenAccount={(account) => newConversation(account)}
        onRemoveAccount={(id) => void persistAccounts(accounts.filter((account) => account.id !== id))}
        routedAccountId={routed?.id}
        skills={skills}
        skillsQuery={skillsQuery}
        setSkillsQuery={setSkillsQuery}
        onRefreshSkills={() => void refreshSkills()}
        skillDirs={skillDirs}
        onOpenSkillsDir={(kind) => {
          const localCwd = isSshWorkspace(cwdRef.current) ? null : cwdRef.current || null;
          void invoke<string>("open_skills_dir", { kind, cwd: localCwd })
            .then(() => refreshSkills())
            .catch((error) => setStatusText(localizeThrown(error, t)));
        }}
        onRevealSkill={(path) => {
          if (!path) return;
          void invoke("reveal_in_folder", { path }).catch((error) => setStatusText(localizeThrown(error, t)));
        }}
        onUseSkill={(skill) => {
          setSelectedSkill(null);
          setActiveSkill(skill);
          setPrompt("");
          setView("chat");
          requestAnimationFrame(() => composerRef.current?.focus());
        }}
        selectedSkill={selectedSkill}
        setSelectedSkill={setSelectedSkill}
        archived={conversations.filter((item) => item.archivedAt).map((item) => ({ id: item.id, title: item.title, cwd: item.cwd }))}
        onDeleteArchived={deleteConversation}
      />
      {sshModal}
      {createProjectModal}
      <QuickOpen
        open={paletteMode != null}
        mode={paletteMode || "file"}
        cwd={workspaceRoot}
        ssh={activeSsh}
        copy={t}
        onClose={() => setPaletteMode(null)}
        onOpenFile={(path) => {
          setShowWorkspace(true);
          setWorkspaceFocusPath(path);
          setWorkspaceFocusTick((tick) => tick + 1);
          setView("chat");
        }}
      />
      </>
    );
  }

  return (
    <div className={`app${workspaceSide === "left" ? " ws-left" : " ws-right"}`} onClick={() => { setShowAccountMenu(false); setShowProjectMenu(false); }}>
      {splashOverlay}
      {showSidebar ? (
        <>
          <aside className="sidebar" style={{ width: sidebarWidth }}>
            <div className="brand-row">
              <GrokMark size={22} className="brand-mark" />
              <div className="brand-name">{t.brand}</div>
              <button className="icon-btn" type="button" title={withShortcut(t.hideSidebar, keys.toggleSidebar)} onClick={() => setShowSidebar(false)}>
                <IconSidebar />
              </button>
              <button className="icon-btn" type="button" title={withShortcut(t.newChat, keys.newChat)} onClick={() => newConversation()}>
                <IconCompose />
              </button>
            </div>
            <button className="new-chat" type="button" onClick={() => newConversation()}>
              <IconCompose />
              {t.newChat}
            </button>
            <div className="section-label-row">
              <div className="section-label">{t.projects}</div>
              <button
                className="icon-btn"
                type="button"
                title={t.organizeSidebar}
                onClick={(event) => {
                  event.stopPropagation();
                  setShowProjectMenu((value) => !value);
                }}
              >
                <IconMore />
              </button>
              <button
                className="icon-btn"
                type="button"
                title={t.addProject}
                onClick={(event) => {
                  event.stopPropagation();
                  setCreateProjectKind("local");
                  setShowCreateProject(true);
                }}
              >
                <IconPlus />
              </button>
              {showProjectMenu ? (
                <div className="project-menu" onClick={(event) => event.stopPropagation()}>
                  <div className="project-menu-label">{t.organizeSidebar}</div>
                  <button
                    type="button"
                    className={sidebarGroupMode === "project" ? "on" : ""}
                    onClick={() => {
                      setSidebarGroupMode("project");
                      setShowProjectMenu(false);
                    }}
                  >
                    {t.groupByProject}
                    {sidebarGroupMode === "project" ? <IconCheck size={13} /> : null}
                  </button>
                  <button
                    type="button"
                    className={sidebarGroupMode === "list" ? "on" : ""}
                    onClick={() => {
                      setSidebarGroupMode("list");
                      setShowProjectMenu(false);
                    }}
                  >
                    {t.groupAsList}
                    {sidebarGroupMode === "list" ? <IconCheck size={13} /> : null}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="session-list">
              {sidebarGroupMode === "list"
                ? projects
                    .flatMap((project) => project.items)
                    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                    .map((item) => (
                      <button
                        key={item.grokSessionId || item.id}
                        className={item.id === selectedId ? "session on" : "session"}
                        type="button"
                        onClick={() => selectConversation(item.id)}
                      >
                        <IconChat className="session-ico" size={15} />
                        <span className="session-title">{item.title}</span>
                        {liveTurns.includes(item.id) ? <span className="mini-spin" /> : null}
                        <span
                          className="session-delete"
                          title={t.deleteChat}
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteConversation(item.id);
                          }}
                        >
                          <IconClose />
                        </span>
                      </button>
                    ))
                : projects.map((project) => {
                const open = !collapsed[project.path];
                const selected = project.explicit
                  ? activeProjectId === project.id
                  : !activeProjectId && workspaceKey(cwd, activeSsh) === project.path;
                return (
                  <div key={project.id} className="project">
                    <button
                      className={selected ? "project-head on" : "project-head"}
                      type="button"
                      onClick={() => selectProjectGroup(project)}
                    >
                      <span
                        className={open ? "chevron open" : "chevron"}
                        onClick={(event) => {
                          event.stopPropagation();
                          setCollapsed((current) => ({ ...current, [project.path]: !current[project.path] }));
                        }}
                      >
                        <IconChevronRight />
                      </span>
                      <span className="project-ico">
                        <IconFolder size={13} />
                      </span>
                      <span className="project-name">{project.name}</span>
                      <span
                        className="project-add"
                        title={t.newChatInProject}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (project.explicit) {
                            const record = projectRecords.find((item) => item.id === project.id);
                            if (record) newConversation(undefined, record);
                            else newConversation();
                          } else {
                            selectProjectGroup(project);
                            newConversation(undefined, undefined, { cwd: project.path, ssh: project.ssh });
                          }
                        }}
                      >
                        <IconPlus size={13} />
                      </span>
                      {project.explicit ? (
                        <span
                          className="project-delete"
                          title={t.deleteProject}
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteProject(project.id);
                          }}
                        >
                          <IconClose />
                        </span>
                      ) : null}
                    </button>
                    {open
                      ? project.items.map((item) => (
                          <button
                            key={item.grokSessionId || item.id}
                            className={item.id === selectedId ? "session on" : "session"}
                            type="button"
                            onClick={() => selectConversation(item.id)}
                          >
                            <IconChat className="session-ico" size={15} />
                            <span className="session-title">{item.title}</span>
                            {liveTurns.includes(item.id) ? <span className="mini-spin" /> : null}
                            <span
                              className="session-delete"
                              title={t.deleteChat}
                              onClick={(event) => {
                                event.stopPropagation();
                                deleteConversation(item.id);
                              }}
                            >
                              <IconClose />
                            </span>
                          </button>
                        ))
                      : null}
                  </div>
                );
              })}
            </div>
            <div className="sidebar-foot account-foot" onClick={(event) => event.stopPropagation()}>
              <button
                className="account-btn"
                type="button"
                onClick={() => setShowAccountMenu((value) => !value)}
              >
                <span className="avatar">{(accountTitle || "G").slice(0, 1)}</span>
                <span className="account">
                  <span className="account-model">{accountTitle}</span>
                  <span className="account-name">{quotaText}</span>
                </span>
                <span className={showAccountMenu ? "chevron open" : "chevron"}>
                  <IconChevronRight />
                </span>
              </button>
              {showAccountMenu ? (
                <div className="account-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setShowUsageCard(true);
                      setShowAccountMenu(false);
                    }}
                  >
                    <IconGauge /> {t.accounts}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void refreshQuotas();
                      setShowAccountMenu(false);
                    }}
                  >
                    <IconRefresh /> {t.refreshQuota}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setView("settings");
                      setSettingsPage("accounts");
                      setShowAccountMenu(false);
                    }}
                  >
                    <IconGear /> {t.settings}
                  </button>
                </div>
              ) : null}
            </div>
          </aside>
          <div className="resize sidebar-edge" onPointerDown={beginResize} />
        </>
      ) : null}

      <main
        className={dragOver ? "main drop-target" : "main"}
        onDragOver={onChatDragOver}
        onDragLeave={onChatDragLeave}
        onDrop={(event) => void onChatDrop(event)}
      >
        {dragOver ? (
          <div className="chat-drop-overlay">
            <strong>{t.dropFilesTitle}</strong>
            <span>{t.dropFilesHint}</span>
          </div>
        ) : null}
        <header className="chat-header">
          <div className="crumb">
            <button className="crumb-folder" type="button" title={t.pickWorkspace} onClick={() => void pickWorkspaceFolder()}>
              <IconFolder />
              <span>{workspaceRoot ? projectName : t.chooseFolder}</span>
            </button>
            <button className="icon-btn" type="button" title={t.sshConnect} onClick={() => void openSshModal()}>
              <IconSsh />
            </button>
            <span className="sep">
              <IconChevronRight />
            </span>
            <span className="muted">{selected?.title || t.newChat}</span>
          </div>
          <div className="live-row">
            {liveActivity ? (
              <div className="live">
                <ThinkingOrb state={liveActivity.state} size={20} />
                {liveActivity.label}
              </div>
            ) : osLabel ? (
              <div className="live quiet">{osLabel}</div>
            ) : null}
            <button
              className={`icon-btn${showSidebar ? " on" : ""}`}
              type="button"
              title={withShortcut(showSidebar ? t.hideSidebar : t.showSidebar, keys.toggleSidebar)}
              onClick={() => setShowSidebar((value) => !value)}
            >
              <IconSidebar />
            </button>
            <button
              className={`icon-btn${showWorkspace ? " on" : ""}`}
              type="button"
              title={withShortcut(showWorkspace ? t.hideWorkspace : t.showWorkspace, keys.toggleWorkspace)}
              onClick={() => setShowWorkspace((value) => !value)}
            >
              {workspaceSide === "left" ? <IconPanelLeft /> : <IconCodePane />}
            </button>
            {showWorkspace ? (
              <button
                className="icon-btn"
                type="button"
                title={workspaceSide === "left" ? t.workspaceMoveRight : t.workspaceMoveLeft}
                onClick={() => setWorkspaceSide((value) => (value === "left" ? "right" : "left"))}
              >
                {workspaceSide === "left" ? <IconCodePane /> : <IconPanelLeft />}
              </button>
            ) : null}
            <button
              className={`header-tool${showTerminal ? " on" : ""}`}
              type="button"
              title={withShortcut(showTerminal ? t.hideTerminal : t.showTerminal, keys.toggleTerminal)}
              onClick={() => setShowTerminal((value) => !value)}
            >
              <IconTerminal />
              <span>{t.terminal}</span>
            </button>
            <button
              className={`icon-btn${showInspector ? " on" : ""}`}
              type="button"
              title={t.inspector}
              onClick={() => setShowInspector((value) => !value)}
            >
              <IconInspector />
            </button>
            <button
              className="icon-btn"
              type="button"
              title={withShortcut(t.quickOpen, keys.quickOpen)}
              onClick={() => setPaletteMode("file")}
            >
              <IconSearch />
            </button>
            <button
              className="icon-btn"
              type="button"
              title={withShortcut(t.settings, keys.openSettings)}
              onClick={() => {
                setView("settings");
                setSettingsPage("general");
              }}
            >
              <IconGear />
            </button>
          </div>
        </header>

        <div className="transcript-shell">
          <section
            ref={transcriptRef}
            className="transcript"
            onScroll={onTranscriptScroll}
            onWheel={onTranscriptWheel}
          >
            {selected?.grokSessionId || visibleMessages.length ? (
              <div className="history-more-bar">
                {visibleMessages.length > shownCount || (selected?.grokSessionId && selected.historyHasMore !== false) ? (
                  <button
                    className="ghost compact history-more"
                    type="button"
                    disabled={loadingOlder || !selected}
                    onClick={() => selected && revealOlder(selected.id)}
                  >
                    {loadingOlder ? t.loadingOlder : t.loadOlder}
                  </button>
                ) : (
                  <span className="history-start">{t.historyStart}</span>
                )}
              </div>
            ) : null}
            {!visibleMessages.length && !pendingQuestion && !pendingPlan && !pendingPermission ? (
              <div className="empty">
                <MorphingRings className="empty-rings" />
                <div className="empty-copy">
                  <div className="empty-hero">
                    <GrokMark size={28} className="empty-mark" />
                    <div className="empty-wordmark">{t.emptyWordmark}</div>
                  </div>
                  <h1>{t.emptyTitle}</h1>
                  <p>{projectName || t.emptyHint}</p>
                  {!accounts.some((account) => account.loggedIn) && !status?.credentialsReady ? (
                    <button
                      className="primary"
                      type="button"
                      onClick={() => {
                        setView("settings");
                        setSettingsPage("relay");
                      }}
                    >
                      {t.xiaohaRelay}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="messages">
                <div ref={topSentinelRef} className="history-sentinel" />
                {visibleMessages.slice(Math.max(0, visibleMessages.length - shownCount)).map((message) => {
                  const prevUser =
                    message.role === "assistant"
                      ? visibleMessages.find((item) => item.id === previousUserId(visibleMessages, message.id))
                      : undefined;
                  const restoreUserId =
                    message.role === "assistant" && !message.streaming
                      ? previousUserId(visibleMessages, message.id)
                      : "";
                  return (
                    <TranscriptRow
                      key={message.id}
                      message={message}
                      prevUser={prevUser}
                      copy={t}
                      lang={lang}
                      running={running}
                      editing={editingMessageId === message.id}
                      editingDraft={editingMessageId === message.id ? editingDraft : ""}
                      canRestore={Boolean(
                        restoreUserId && checkpointFlags[checkpointKey(selected?.id || "", restoreUserId)],
                      )}
                      restoreUserId={restoreUserId || undefined}
                      sessionDir={selected?.sessionDir}
                      isLatestAssistant={lastVisibleAssistantId === message.id}
                      actionsRef={transcriptActionsRef}
                    />
                  );
                })}
                {pendingPermission
                && (!pendingPermission.conversationId || pendingPermission.conversationId === selectedId) ? (
                  <article className="ask-card" aria-label={t.needApprove}>
                    <div className="ask-card-kicker">{t.needApprove}</div>
                    <h3 className="ask-card-title">
                      {permissionHeadline(pendingPermission.title, pendingPermission.command || "", t)}
                    </h3>
                    {(() => {
                      const command = permissionCommandText(pendingPermission.title, pendingPermission.command);
                      const long = command.length > 220 || command.split("\n").length > 5;
                      const shown = permissionExpanded || !long
                        ? command
                        : `${command.split("\n").slice(0, 4).join("\n").slice(0, 260)}…`;
                      return command ? (
                        <div className="ask-cmd">
                          <pre>{shown}</pre>
                          {long ? (
                            <button
                              className="ask-cmd-toggle"
                              type="button"
                              onClick={() => setPermissionExpanded((value) => !value)}
                            >
                              {permissionExpanded ? t.collapseCommand : t.expandCommand}
                            </button>
                          ) : null}
                        </div>
                      ) : null;
                    })()}
                    <div className="ask-card-actions">
                      {(pendingPermission.options.length
                        ? pendingPermission.options
                        : [{ id: "", name: t.reject, kind: "reject" }]
                      )
                        .slice()
                        .sort((left, right) => {
                          const rank = (option: PermissionOption) => {
                            const kind = permissionOptionKind(option);
                            if (kind === "allow" || kind === "session") return 1;
                            return 0;
                          };
                          return rank(left) - rank(right);
                        })
                        .map((option) => {
                          const kind = permissionOptionKind(option);
                          return (
                            <button
                              key={option.id || "reject"}
                              className={kind === "allow" || kind === "session" ? "primary" : "ghost"}
                              type="button"
                              onClick={() => void answerPermission(option.id || null)}
                            >
                              {permissionOptionLabel(option, t)}
                            </button>
                          );
                        })}
                    </div>
                  </article>
                ) : null}
                {pendingQuestion
                && (!pendingQuestion.conversationId || pendingQuestion.conversationId === selectedId) ? (
                  <article className="ask-card" aria-label={t.grokNeedsChoice}>
                    <div className="ask-card-kicker">{pendingQuestion.planMode ? t.modePlan : t.modeAsk}</div>
                    <h3 className="ask-card-title">
                      {pendingQuestion.questions.length === 1
                        ? pendingQuestion.questions[0]?.question || t.grokNeedsChoice
                        : t.grokNeedsChoice}
                    </h3>
                    {pendingQuestion.questions.map((question) => {
                      const key = askQuestionKey(question);
                      const selectedOpts = questionAnswers[key] || [];
                      const otherOn = selectedOpts.some((item) => /^(other|其他|其它)$/i.test(item.trim()));
                      return (
                        <div key={key} className="ask-question">
                          {pendingQuestion.questions.length > 1 ? (
                            <div className="ask-question-title">
                              <strong>{question.question}</strong>
                              <span>{question.multiSelect ? t.askSelectMany : t.askSelectOne}</span>
                            </div>
                          ) : null}
                          <div className="ask-options">
                            {question.options.map((option) => {
                              const on = selectedOpts.includes(option.label);
                              const isOther = /^(other|其他|其它)$/i.test(option.label.trim());
                              return (
                                <button
                                  key={option.id || option.label}
                                  type="button"
                                  className={`ask-option${on ? " on" : ""}${question.multiSelect ? " multi" : ""}${isOther ? " other" : ""}`}
                                  onClick={() => {
                                    setQuestionAnswers((current) => {
                                      const prev = current[key] || [];
                                      if (question.multiSelect) {
                                        return {
                                          ...current,
                                          [key]: on ? prev.filter((item) => item !== option.label) : [...prev, option.label],
                                        };
                                      }
                                      return { ...current, [key]: [option.label] };
                                    });
                                  }}
                                >
                                  <span className="ask-option-mark" aria-hidden />
                                  <span className="ask-option-copy">
                                    <strong>{option.label}</strong>
                                    {option.description ? <em>{option.description}</em> : null}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                          {otherOn ? (
                            <input
                              className="ask-note"
                              placeholder={t.askOptionalNote}
                              autoFocus
                              value={questionNotes[key] || ""}
                              onChange={(event) => setQuestionNotes((current) => ({ ...current, [key]: event.target.value }))}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                    <div className="ask-card-actions">
                      <button className="ghost" type="button" onClick={() => void answerQuestions("cancelled")}>
                        {t.cancel}
                      </button>
                      <button
                        className="primary"
                        type="button"
                        disabled={pendingQuestion.questions.some((question) => {
                          const key = askQuestionKey(question);
                          const picked = questionAnswers[key] || [];
                          const otherOn = picked.some((item) => /^(other|其他|其它)$/i.test(item.trim()));
                          return !picked.length || (otherOn && !(questionNotes[key] || "").trim());
                        })}
                        onClick={() => void answerQuestions("accepted")}
                      >
                        {t.askContinue}
                      </button>
                    </div>
                  </article>
                ) : null}
                {pendingPlan
                && (!pendingPlan.conversationId || pendingPlan.conversationId === selectedId) ? (
                  <article className="ask-card plan-card" aria-label={t.reviewPlan}>
                    <div className="ask-card-kicker">{t.modePlan}</div>
                    <h3 className="ask-card-title">{t.reviewPlan}</h3>
                    <div className="ask-plan-body">
                      <MarkdownPreview text={pendingPlan.content || t.reviewPlan} />
                    </div>
                    <input
                      className="ask-note"
                      value={planFeedback}
                      placeholder={t.planFeedback}
                      onChange={(event) => setPlanFeedback(event.target.value)}
                    />
                    <div className="ask-card-actions">
                      <button className="ghost" type="button" onClick={() => void answerPlan(false)}>
                        {t.requestChanges}
                      </button>
                      <button className="primary" type="button" onClick={() => void answerPlan(true)}>
                        {t.approvePlan}
                      </button>
                    </div>
                  </article>
                ) : null}
              </div>
            )}
          </section>
          {showJumpToBottom && visibleMessages.length ? (
            <button
              className="jump-bottom"
              type="button"
              title={t.scrollToBottom}
              aria-label={t.scrollToBottom}
              onClick={jumpToBottom}
            >
              <IconChevronDown />
              <span>{t.scrollToBottom}</span>
            </button>
          ) : null}
        </div>

        <footer className="composer-wrap">
          <div className={dragOver ? "composer drop-target" : "composer"} onPaste={onComposerPaste}>
            {editingCwd ? (
              <input
                className="cwd-input"
                autoFocus
                value={sessionCwd}
                spellCheck={false}
                onChange={(event) => applyCwd(event.target.value)}
                onBlur={() => setEditingCwd(false)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setEditingCwd(false);
                  if (event.key === "Escape") setEditingCwd(false);
                }}
              />
            ) : (
              <div className="composer-workspace">
                <button
                  className="workspace-chip"
                  type="button"
                  title={t.composerWorkspace}
                  onClick={() => void pickWorkspaceFolder()}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setEditingCwd(true);
                  }}
                >
                  <IconFolder />
                  <span>{workspaceRoot ? projectName : t.chooseFolder}</span>
                  <IconChevronDown />
                </button>
                <button className="ghost compact nowrap" type="button" title={t.sshConnect} onClick={() => void openSshModal()}>
                  {t.sshShort}
                </button>
              </div>
            )}
            {pendingImages.length || pendingFiles.length ? (
              <div className="attach-row">
                {pendingFiles.map((item) => (
                  <div key={item.id} className="attach-chip file">
                    {item.isDir ? <IconFolder /> : <IconFile />}
                    <button
                      type="button"
                      className="attach-name"
                      title={t.selectDroppedFile}
                      onClick={() => openDroppedFile(item)}
                    >
                      {item.name}
                    </button>
                    <button type="button" title={t.revealInFolder} onClick={() => revealDroppedFile(item.path)}>
                      <IconFolder />
                    </button>
                    <button type="button" title={t.cancel} onClick={() => removePendingFile(item.id)}>
                      <IconClose />
                    </button>
                  </div>
                ))}
                {pendingImages.map((item, index) => (
                  <div key={`${item.name || "img"}-${index}`} className="attach-chip">
                    {item.data ? (
                      <img
                        className="attach-thumb"
                        src={`data:${item.mimeType || "image/png"};base64,${item.data}`}
                        alt={item.name || ""}
                      />
                    ) : null}
                    <span>{item.name || t.pasteImage}</span>
                    <button
                      type="button"
                      title={t.cancel}
                      onClick={() => setPendingImages((current) => current.filter((_, i) => i !== index))}
                    >
                      <IconClose />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {visibleQueued.length ? (
              <div className="prompt-queue">
                <div className="prompt-queue-head">
                  <span>{t.queued} {visibleQueued.length}</span>
                  <em>{t.queuedNext}</em>
                  <button className="ghost compact nowrap" type="button" onClick={clearQueue}>
                    {t.clearQueue}
                  </button>
                </div>
                {visibleQueued.map((item) => (
                  <div key={item.id} className="prompt-queue-item">
                    <p>{item.text || t.pasteImage}</p>
                    <button className="ghost compact nowrap" type="button" onClick={() => sendQueuedNow(item)}>
                      {liveTurns.includes(item.conversationId) ? t.interruptSend : t.sendNow}
                    </button>
                    <button className="ghost compact nowrap" type="button" onClick={() => removeQueued(item)}>
                      {t.cancel}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {activeSkill ? (
              <div className="slash-chip-row">
                <span className="slash-chip" title={t.usingSkill}>
                  /{activeSkill.name}
                  <button type="button" title={t.cancel} onClick={() => setActiveSkill(null)}>
                    <IconClose />
                  </button>
                </span>
                <em>{t.usingSkill}</em>
              </div>
            ) : null}
            <div className="composer-input-wrap">
              {slashMenuItems.length || slash?.skillsOnly ? (
                <div className="mention-menu slash-menu" role="listbox" aria-label={t.slashCommands}>
                  <div className="slash-menu-head">
                    <strong>{t.slashCommands}</strong>
                    <span>{t.slashMenuHint}</span>
                  </div>
                  {slashMenuItems.map((item, index) => {
                    const prev = slashMenuItems[index - 1];
                    const section =
                      index === 0 && item.kind !== "skill"
                        ? t.slashMenuModes
                        : item.kind === "skill" && prev?.kind !== "skill"
                          ? t.slashMenuSkills
                          : "";
                    return (
                      <Fragment key={item.id}>
                        {section ? <div className="slash-menu-label">{section}</div> : null}
                        <button
                          type="button"
                          className={index === (slash?.index || 0) ? "on" : ""}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            applySlashItem(item);
                          }}
                        >
                          <kbd>/{item.command}</kbd>
                          <span className="slash-menu-copy">
                            <strong>{item.title}</strong>
                            <em>{item.hint}</em>
                          </span>
                        </button>
                      </Fragment>
                    );
                  })}
                  {slashMenuItems.length ? null : <div className="slash-empty">{t.skillsEmpty}</div>}
                </div>
              ) : null}
              {mention?.items.length ? (
                <div className="mention-menu" role="listbox" aria-label={t.mentionFiles}>
                  {mention.items.map((item, index) => (
                    <button
                      key={item.path}
                      type="button"
                      className={index === mention.index ? "on" : ""}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        insertMention(item.path);
                      }}
                    >
                      <span>{item.name}</span>
                      <em>{item.path}{item.isDir ? "/" : ""}</em>
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={composerRef}
                rows={1}
                value={prompt}
                placeholder={pendingImages.length || pendingFiles.length ? t.dropFiles : t.composer}
                onChange={(event) => {
                  const value = event.target.value;
                  setPrompt(value);
                  const cursor = event.target.selectionStart || 0;
                  const found = mentionQuery(value, cursor);
                  setMention(found ? { start: found.start, query: found.query, items: mentionRef.current?.query === found.query ? mentionRef.current.items : [], index: 0 } : null);
                  const nextSlash = slashQuery(value, cursor);
                  setSlash((current) => {
                    if (!nextSlash) return null;
                    return {
                      query: nextSlash.query,
                      index: current?.query === nextSlash.query ? current.index : 0,
                      skillsOnly: Boolean(current?.skillsOnly),
                    };
                  });
                  requestAnimationFrame(resizeComposer);
                }}
                onClick={(event) => {
                  const found = mentionQuery(prompt, event.currentTarget.selectionStart || 0);
                  if (!found) setMention(null);
                }}
                onKeyUp={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === "Tab" || event.key === "Escape") return;
                  const found = mentionQuery(prompt, event.currentTarget.selectionStart || 0);
                  if (!found) setMention(null);
                }}
                onCompositionStart={() => {
                  imeRef.current = { composing: true, until: 0 };
                }}
                onCompositionEnd={() => {
                  imeRef.current = { composing: false, until: Date.now() + 120 };
                }}
                onKeyDown={onComposerKey}
              />
            </div>
            <div className="composer-bar">
              <Select
                className="perm-mode"
                menuClassName="mode-menu"
                dense
                showHint={false}
                value={normalizePermissionMode(settings.permissionMode)}
                onChange={(value) => setPermissionMode(value)}
                variant="inline"
                align="start"
                ariaLabel={t.permissionMode}
                options={PERMISSION_MODES.map((item) => ({
                  id: item.id,
                  label: permissionModeShort(item.id),
                  hint: permissionModeHint(item.id, lang),
                  icon: permissionModeIcon(item.id, 13),
                }))}
              />
              <button className="icon-btn context-btn" type="button" onClick={() => setShowContext((value) => !value)}>
                <span className="context-ring" style={{ background: `conic-gradient(currentColor ${usagePercent}%, var(--hairline) 0)` }} />
              </button>
              <span className="composer-bar-spacer" />
              <ModelPicker
                value={modelOptions.some((item) => item.id === model) ? model : modelOptions[0]?.id || model}
                options={modelOptions}
                onChange={selectModel}
                disabled={running}
                variant="inline"
                align="end"
                searchPlaceholder={t.searchModels}
                emptyLabel={t.noMatchingModels}
              />
              <Select
                className="effort-mini"
                value={settings.reasoningEffort}
                onChange={(value) => patchSettings({ reasoningEffort: value })}
                disabled={running}
                variant="inline"
                align="end"
                ariaLabel={t.effort}
                options={EFFORTS.map((item) => ({ id: item.id, label: item.label }))}
              />
              {running ? (
                <button className="send stop" type="button" title="Stop" onClick={() => void stopTurn()}>
                  <IconStop />
                </button>
              ) : (
                <button className="send" type="button" disabled={!canSend} title={`${formatChord(keys.sendMessage)} ${t.cmdSendMessage} · ${formatChord(keys.newLine)} ${t.composerNewLine}`} onClick={() => void send()}>
                  <IconArrowUp />
                </button>
              )}
            </div>
            {showContext ? (
              <div className="context-pop">
                <strong>{t.contextWindow}</strong>
                <div className="quota-row">
                  <span>{t.usage}</span>
                  <span>{usagePercent}%</span>
                </div>
                <div className="quota-bar">
                  <i style={{ width: `${usagePercent}%` }} />
                </div>
                <p>
                  {formatTokens(usage.usedTokens)} / {formatTokens(usage.totalTokens)} tokens
                </p>
                <p>
                  {t.compactAt} {settings.autoCompactThresholdPercent}%
                </p>
                {usage.compactionCount ? (
                  <p>
                    {t.compacted} {usage.compactionCount}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </footer>
        {showTerminal ? (
          <Suspense fallback={<div className="term-pane" style={{ height: terminalHeight }} />}>
            <TerminalPanel
              cwd={workspaceRoot || homeDir}
              ssh={activeSsh}
              theme={theme}
              copy={t}
              height={terminalHeight}
              agentJobs={agentTermJobs}
              channel={panelChannel}
              onChannel={setPanelChannel}
              outputLines={panelOutput}
              runJob={runJob}
              onResize={setTerminalHeight}
              onClose={() => setShowTerminal(false)}
            />
          </Suspense>
        ) : null}
      </main>

      {showWorkspace ? (
        <>
          <div className="resize workspace-edge" onPointerDown={beginWorkspaceResize} />
          <Suspense fallback={<aside className="workspace" style={{ width: workspaceWidth, minWidth: workspaceWidth, flex: "0 0 auto" }} />}>
            <WorkspacePanel
              cwd={workspaceRoot}
              ssh={activeSsh}
              changedPaths={changedPaths}
              diffs={fileDiffs}
              focusPath={workspaceFocusPath}
              focusTick={workspaceFocusTick}
              restoreTick={workspaceRestoreTick}
              saveChord={keys.saveFile}
              copy={t}
              side={workspaceSide}
              onClose={() => setShowWorkspace(false)}
              onMoveSide={() => setWorkspaceSide((value) => (value === "left" ? "right" : "left"))}
              onPickFolder={() => void pickWorkspaceFolder()}
              onConnectSsh={() => void openSshModal()}
              width={workspaceWidth}
              gitAutoCommit={Boolean(settings.gitAutoCommit)}
              gitAutoPush={Boolean(settings.gitAutoPush)}
              gitAutoCommitMessage={settings.gitAutoCommitMessage || "xiaoha: {title}"}
              onGitSettings={(patch) => patchSettings(patch)}
              onOpenPanel={(next) => {
                setShowTerminal(true);
                setPanelChannel(next);
              }}
              onRun={(job) => {
                setShowTerminal(true);
                setPanelChannel("debug");
                setRunJob(job);
                setPanelOutput((current) => [...current.slice(-200), `$ ${job.argv.join(" ")}`]);
              }}
              onLog={(line) => setPanelOutput((current) => [...current.slice(-200), line])}
              onAskAgent={(text) => {
                setView("chat");
                setShowSidebar(true);
                setPrompt(text);
              }}
            />
          </Suspense>
        </>
      ) : null}

      {showInspector ? (
        <aside className="inspector">
          <header>
            <strong>{t.inspector}</strong>
            <div className="insp-tabs">
              <button className={inspectorTab === "tools" ? "on" : ""} type="button" onClick={() => setInspectorTab("tools")}>
                {t.tools}
              </button>
              <button className={inspectorTab === "plan" ? "on" : ""} type="button" onClick={() => setInspectorTab("plan")}>
                {t.plan}
              </button>
              <button className={inspectorTab === "events" ? "on" : ""} type="button" onClick={() => setInspectorTab("events")}>
                {t.events}
              </button>
            </div>
          </header>
          <div className="insp-body">
            {inspectorTab === "tools" &&
              (toolEvents.length ? (
                toolEvents.map((event) => (
                  <details key={event.id} className="insp-card">
                    <summary>
                      {event.title} <em>{event.status}</em>
                    </summary>
                    {event.input ? <pre>{event.input}</pre> : null}
                    {event.output ? <pre>{event.output}</pre> : null}
                  </details>
                ))
              ) : (
                <p className="hint">{t.noTools}</p>
              ))}
            {inspectorTab === "plan" && (planEvent?.output ? <pre className="log">{planEvent.output}</pre> : <p className="hint">{t.noPlan}</p>)}
            {inspectorTab === "events" &&
              (rawEvents.length ? (
                rawEvents
                  .slice()
                  .reverse()
                  .slice(0, 40)
                  .map((event, index) => (
                    <details key={`${event.method}-${index}`} className="insp-card">
                      <summary>{event.method}</summary>
                      <pre>{event.payload}</pre>
                    </details>
                  ))
              ) : (
                <p className="hint">{t.noEvents}</p>
              ))}
          </div>
        </aside>
      ) : null}

      {sshModal}
      {createProjectModal}

      {showInstallPrompt && !status?.installed ? (
        <div className="overlay" onClick={() => setShowInstallPrompt(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>{t.needRuntime}</h3>
            <p>{t.needRuntimeBody}</p>
            <div className="actions">
              <button className="primary" type="button" disabled={installing} onClick={() => void installOfficial()}>
                {t.installLatest}
              </button>
              <button className="ghost" type="button" onClick={() => setShowInstallPrompt(false)}>
                {t.later}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showUsageCard ? (
        <div className="overlay" onClick={() => setShowUsageCard(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>{t.usageTitle}</h3>
            <div className="usage-list">
              {relayQuota?.configured ? (
                <div className="usage-row">
                  <header>
                    <span className="dot on" />
                    <strong>{relayQuota.name || t.xiaohaRelay}</strong>
                    <span className="pill ok">{t.relayQuota}</span>
                  </header>
                  {relayQuotaText ? <p className="hint left">{relayQuotaText}</p> : <p className="hint left">{t.quotaPending}</p>}
                  {relayQuota.planName ? <p className="hint left">{relayQuota.planName}</p> : null}
                  {relayQuota.error ? <p className="error">{relayQuota.error}</p> : null}
                </div>
              ) : null}
              {accounts.filter((account) => account.enabled).map((account) => (
                <div key={account.id} className="usage-row">
                  <header>
                    <span className={account.loggedIn ? "dot on" : "dot"} />
                    <strong>{account.name}</strong>
                    {routed?.id === account.id ? <span className="pill ok">{t.currentPreferred}</span> : null}
                  </header>
                  {account.quota?.weeklyRemainingPercent != null ? (
                    <>
                      <div className="quota-row">
                        <span>{t.weeklyLeft}</span>
                        <span>{Math.round(account.quota.weeklyRemainingPercent)}%</span>
                      </div>
                      <div className="quota-bar">
                        <i style={{ width: `${account.quota.weeklyRemainingPercent}%` }} />
                      </div>
                    </>
                  ) : (
                    <p className="hint left">{account.loggedIn ? t.quotaPending : t.notLoggedIn}</p>
                  )}
                </div>
              ))}
            </div>
            <div className="actions">
              <button
                className="ghost"
                type="button"
                onClick={() => {
                  setShowUsageCard(false);
                  setView("settings");
                  setSettingsPage("accounts");
                }}
              >
                <IconPerson /> {t.manageAccounts}
              </button>
              <button className="primary" type="button" disabled={refreshingQuota} onClick={() => void refreshQuotas()}>
                {refreshingQuota ? t.refreshing : t.refreshQuota}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <QuickOpen
        open={paletteMode != null}
        mode={paletteMode || "file"}
        cwd={workspaceRoot}
        ssh={activeSsh}
        copy={t}
        onClose={() => setPaletteMode(null)}
        onOpenFile={(path) => {
          setShowWorkspace(true);
          setWorkspaceFocusPath(path);
          setWorkspaceFocusTick((tick) => tick + 1);
        }}
      />
    </div>
  );
}
