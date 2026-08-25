import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ActivityTimeline } from "./ActivityTimeline";
import { extractFileDiffs } from "./diff";
import {
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCompose,
  IconCodePane,
  IconFolder,
  IconGauge,
  IconGear,
  IconInspector,
  IconPerson,
  IconRefresh,
  IconShield,
  IconSidebar,
  GrokMark,
  IconStop,
} from "./icons";
import { t as translate, type Copy } from "./i18n";
import { MessageBody } from "./markdown";
import { ModelPicker } from "./ModelPicker";
import { SettingsView } from "./SettingsView";
import { isRedundantExtension, jsonText } from "./timeline";
import {
  canonicalModelId,
  defaultSettings,
  EFFORTS,
  mergeModelOptions,
  PERMISSION_MODES,
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
  type PromptAttachment,
  type RelayImport,
  type RelayQuota,
  type RuntimeStatus,
  type SessionInfo,
  type SettingsPage,
  type SkillRecord,
  type Theme,
  type TimelineEvent,
  type View,
} from "./types";

const LEGACY_CONTEXT_WINDOW = 225000;
const DEFAULT_CONTEXT_WINDOW = 500000;
const HISTORY_PAGE = 80;
const VIEW_PAGE = 80;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const STORAGE_KEY = "grokdesk.workspace.v3";
const LEGACY_KEYS = ["grokdesk.workspace.v2", "grokdesk.workspace.v1"];
const WorkspacePanel = lazy(() => import("./WorkspacePanel").then((mod) => ({ default: mod.WorkspacePanel })));

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

function friendlyError(raw: string) {
  const text = String(raw || "")
    .replace(/^GROKDESK_NO_CREDENTIALS:\s*/i, "")
    .trim() || "ACP 请求失败";
  if (/上游/.test(text) || /upstream (?:service )?(?:temporarily )?unavailable/i.test(text)) {
    return text;
  }
  if (/502|bad gateway|temporarily unavailable/i.test(text)) {
    return `${text}\n上游模型服务暂时不可用。这通常是中转站或 xAI 上游波动，不是本机 Grok Build 没装好。请稍后重试。`;
  }
  if (/503/.test(text)) {
    return `${text}\n上游暂时过载（503）。请稍后重试。`;
  }
  if (/weekly limit|run out of credits|free usage limit|status 402|额度不足|周限额/i.test(text)) {
    return `${text}\n这是官方 Grok 的周额度/登录限制，不是中转站余额。中转站显示「额度不限」时，请开一个新对话，让桌面端走中转站而不是 grok.com。`;
  }
  return text;
}

function importSig(payload: RelayImport) {
  return `${payload.endpoint}\n${payload.apiKey}\n${payload.model}\n${payload.name}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function compactEvents(events: TimelineEvent[]): TimelineEvent[] {
  if (events.length <= MAX_LIVE_EVENTS) return events;
  const dropped = events.length - MAX_LIVE_EVENTS;
  return [
    {
      id: "folded-events",
      kind: "context",
      title: `已折叠 ${dropped} 个早期步骤`,
      status: "completed",
    },
    ...events.slice(-MAX_LIVE_EVENTS),
  ];
}

function upsertEvent(events: TimelineEvent[], event: TimelineEvent) {
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
    return compactEvents(next);
  }
  return compactEvents([...events, event]);
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
  if (method.toLowerCase().includes("hook")) {
    const event = String(params.event_name || params.eventName || "hook");
    const tool = params.tool_name || params.toolName;
    return `Hook · ${event}${tool ? ` · ${tool}` : ""}`;
  }
  const titles: Record<string, [string, string]> = {
    task_backgrounded: ["任务已转入后台", "Task moved to background"],
    task_completed: ["后台任务完成", "Background task finished"],
    retry_state: ["Runtime 正在重试", "Runtime is retrying"],
    memory_flush_started: ["正在写入 Memory", "Writing memory"],
    memory_flush_completed: ["Memory 写入完成", "Memory written"],
    turn_completed: ["本轮执行完成", "Turn completed"],
    session_recap: ["Session 回顾", "Session recap"],
  };
  const pair = titles[method];
  if (pair) return lang === "en" ? pair[1] : pair[0];
  return method.replace(/_/g, " ");
}

function formatTokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

function migrateSettings(saved?: Partial<AppSettings>): AppSettings {
  const merged = { ...defaultSettings(), ...saved };
  if (!saved?.contextWindowTokens || saved.contextWindowTokens === LEGACY_CONTEXT_WINDOW) {
    merged.contextWindowTokens = DEFAULT_CONTEXT_WINDOW;
  }
  return merged;
}

function isGenericTitle(title: string) {
  const value = (title || "").trim();
  return !value || value === "Grok Session" || value === "新对话" || value === "New chat";
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
    grokSessionId: sessionId || winner.grokSessionId || loser.grokSessionId,
    accountId: winner.accountId || loser.accountId,
    messages: (winner.messages?.length || 0) >= (loser.messages?.length || 0) ? winner.messages : loser.messages,
    updatedAt: Math.max(winner.updatedAt || 0, loser.updatedAt || 0),
    archivedAt: winner.archivedAt ?? loser.archivedAt,
  };
}

function keepBetter(map: Map<string, Conversation>, key: string, item: Conversation) {
  const prev = map.get(key);
  map.set(key, prev ? combineConversations(prev, item) : item);
}

function hydrateConversation(item: Conversation): Conversation {
  return {
    ...item,
    title: item.title || "Grok Session",
    cwd: item.cwd || "",
    messages: (item.messages || []).map((message) => ({
      ...message,
      events: message.events || [],
      media: message.media || [],
      streaming: false,
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
  const byKey = new Map<string, Conversation>();
  for (const item of byId.values()) {
    keepBetter(byKey, item.grokSessionId || item.id, item);
  }
  return [...byKey.values()].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

function persistConversations(list: Conversation[]): Conversation[] {
  return dedupeConversations(list).map((item) => ({
    ...item,
    messages: item.grokSessionId
      ? []
      : item.messages.slice(-30).map((message) => ({
          ...message,
          streaming: false,
          events: (message.events || []).slice(-12),
          media: (message.media || []).map((media) => ({ ...media, data: undefined })),
        })),
  }));
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
  if (unique.length === current.length && unique.every((item, index) => item === current[index])) {
    return current;
  }
  return unique;
}

function mergeHistoryMessages(existing: ChatMessage[], incoming: ChatMessage[], prepend: boolean) {
  if (!incoming.length) return existing;
  if (!existing.length) return incoming;
  const keys = new Set(existing.map((item) => `${item.role}:${item.text.slice(0, 160)}`));
  const extra = incoming.filter((item) => !keys.has(`${item.role}:${item.text.slice(0, 160)}`));
  if (!extra.length) return existing;
  return prepend ? [...extra, ...existing] : [...existing, ...extra];
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
      (entry) => entry.grokSessionId === item.grokSessionId || entry.grokSessionId === item.id,
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

function fileToAttachment(file: File): Promise<PromptAttachment> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error("图片太大，请控制在 25MB 以内"));
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
    reader.onerror = () => reject(reader.error || new Error("无法读取图片"));
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
  form?: Partial<RelayImport>;
  sidebarWidth?: number;
  workspaceWidth?: number;
  showWorkspace?: boolean;
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

export default function App() {
  const saved = useMemo(loadPersist, []);
  const [lang, setLang] = useState<Lang>(saved.lang === "en" ? "en" : "zh");
  const [theme, setTheme] = useState<Theme>(saved.theme || "system");
  const [view, setView] = useState<View>("chat");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [showSidebar, setShowSidebar] = useState(true);
  const [showInspector, setShowInspector] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(Boolean(saved.showWorkspace));
  const [workspaceFocusPath, setWorkspaceFocusPath] = useState("");
  const [workspaceFocusTick, setWorkspaceFocusTick] = useState(0);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showUsageCard, setShowUsageCard] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(Math.min(400, Math.max(220, saved.sidebarWidth || 280)));
  const [workspaceWidth, setWorkspaceWidth] = useState(Math.min(820, Math.max(420, saved.workspaceWidth || 560)));
  const [model, setModel] = useState(canonicalModelId(saved.model || "grok-4.5") || "grok-4.5");
  const [cwd, setCwd] = useState(saved.cwd || "");
  const [prompt, setPrompt] = useState("");
  const [editingCwd, setEditingCwd] = useState(false);
  const [running, setRunning] = useState(false);
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
  const [shownCount, setShownCount] = useState(VIEW_PAGE);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [addingAccount, setAddingAccount] = useState(false);
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [loginLog, setLoginLog] = useState("");
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillsQuery, setSkillsQuery] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<SkillRecord | null>(null);
  const [usage, setUsage] = useState<ContextUsage>({
    usedTokens: 0,
    totalTokens: migrateSettings(saved.settings).contextWindowTokens,
    compactionCount: 0,
  });
  const [relayQuota, setRelayQuota] = useState<RelayQuota | null>(null);
  const [pendingImages, setPendingImages] = useState<PromptAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [rawEvents, setRawEvents] = useState<Array<{ method: string; payload: string }>>([]);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"tools" | "plan" | "events">("tools");
  const [questionNotes, setQuestionNotes] = useState<Record<string, string>>({});
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string[]>>({});
  const [planFeedback, setPlanFeedback] = useState("");

  const t: Copy = translate(lang);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const lastImportRef = useRef("");
  const turnIdRef = useRef(0);
  const conversationsRef = useRef(conversations);
  const selectedIdRef = useRef(selectedId);
  const runningRef = useRef(running);
  const modelRef = useRef(model);
  const cwdRef = useRef(cwd);
  const statusRef = useRef(status);
  const tRef = useRef(t);
  const settingsRef = useRef(settings);
  const accountsRef = useRef(accounts);
  const pendingImagesRef = useRef(pendingImages);
  const pasteHandledRef = useRef(false);
  const formRef = useRef(form);
  const availableModelsRef = useRef(availableModels);
  const relayQuotaRef = useRef(relayQuota);
  const relayReadyRef = useRef(relayReady);
  const historyLoadedRef = useRef(new Set<string>());
  const historyBusyRef = useRef(false);
  const shownCountRef = useRef(VIEW_PAGE);
  conversationsRef.current = conversations;
  selectedIdRef.current = selectedId;
  runningRef.current = running;
  modelRef.current = model;
  cwdRef.current = cwd;
  statusRef.current = status;
  tRef.current = t;
  settingsRef.current = settings;
  accountsRef.current = accounts;
  pendingImagesRef.current = pendingImages;
  formRef.current = form;
  availableModelsRef.current = availableModels;
  relayQuotaRef.current = relayQuota;
  relayReadyRef.current = relayReady;
  shownCountRef.current = shownCount;

  useEffect(() => {
    const next = resolveSelectedId(conversations, selectedId);
    if (next !== selectedId) setSelectedId(next);
  }, [conversations, selectedId]);

  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const homeDir = status?.homeDir || "";
  const sessionCwd = selected?.cwd || cwd;
  const workspaceRoot = usableWorkspace(sessionCwd, homeDir);
  const projectName = workspaceLabel(sessionCwd, homeDir, t.home);
  const canSend = (prompt.trim().length > 0 || pendingImages.length > 0) && !installing && !running;
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
    ? lang === "en"
      ? `${Math.round(activeAccount!.quota!.weeklyRemainingPercent!)}% weekly remaining`
      : `本周剩余 ${Math.round(activeAccount!.quota!.weeklyRemainingPercent!)}%`
    : relayQuotaText
      || (activeAccount?.loggedIn
        ? t.quotaPending
        : status?.credentialsReady
          ? t.ready
          : t.notConfigured);

  const projects = useMemo(() => {
    const groups = new Map<string, Conversation[]>();
    for (const item of dedupeConversations(conversations).filter((conversation) => !conversation.archivedAt)) {
      const key = item.cwd || homeDir || "";
      const list = groups.get(key) || [];
      list.push(item);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([path, items]) => ({
        path,
        name: workspaceLabel(path, homeDir, t.home),
        items: dedupeConversations(items),
      }))
      .sort((a, b) => (b.items[0]?.updatedAt || 0) - (a.items[0]?.updatedAt || 0));
  }, [conversations, homeDir, t.home]);

  const modelOptions = useMemo(() => mergeModelOptions(availableModels, model), [availableModels, model]);
  const usagePercent = Math.round(
    Math.min(100, Math.max(0, usage.totalTokens ? (usage.usedTokens / usage.totalTokens) * 100 : 0)),
  );

  useEffect(() => {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.documentElement.dataset.theme = theme;
  }, [lang, theme]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        lang,
        theme,
        model,
        cwd,
        selectedId,
        conversations: persistConversations(conversations),
        sidebarWidth,
        workspaceWidth,
        showWorkspace,
        settings,
        form: { ...form, apiKey: "" },
        availableModels,
        relayReady,
      }),
    );
  }, [lang, theme, model, cwd, selectedId, conversations, sidebarWidth, workspaceWidth, showWorkspace, form, settings, availableModels, relayReady]);

  useEffect(() => {
    setUsage((current) =>
      current.totalTokens === settings.contextWindowTokens
        ? current
        : { ...current, totalTokens: settings.contextWindowTokens },
    );
  }, [settings.contextWindowTokens]);

  const patchSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

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

  const scrollToBottom = useCallback((force = false) => {
    const el = transcriptRef.current;
    if (!el) return;
    if (!force && !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const mutateAssistant = useCallback(
    (mutator: (assistant: ChatMessage, conversation: Conversation) => Conversation | void) => {
      setConversations((list) => {
        const currentId = selectedIdRef.current;
        return list.map((conversation) => {
          if (conversation.id !== currentId) return conversation;
          const messages = [...conversation.messages];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === "assistant" && messages[i].streaming) {
              const assistant = { ...messages[i], events: [...messages[i].events], media: [...messages[i].media] };
              messages[i] = assistant;
              const next = mutator(assistant, { ...conversation, messages });
              return next || { ...conversation, messages, updatedAt: Date.now() };
            }
          }
          return conversation;
        });
      });
    },
    [],
  );

  const finishTurn = useCallback((error?: string) => {
    const err = error ? friendlyError(error) : undefined;
    setConversations((list) =>
      list.map((item) => {
        if (item.id !== selectedIdRef.current) return item;
        return {
          ...item,
          messages: item.messages.map((message) =>
            message.streaming ? { ...message, streaming: false, error: err || message.error } : message,
          ),
        };
      }),
    );
    setRunning(false);
    setStatusText(err || tRef.current.ready);
  }, []);

  const handleAcpUpdate = useCallback(
    (payload: AcpUpdate) => {
      const params = payload.params || {};
      const meta = asRecord(params._meta);
      if (payload.method === "x.ai/models/update" || payload.method === "_x.ai/models/update") {
        const current = String(params.currentModelId || params.current_model_id || "");
        if (current) setModel(current);
        return;
      }
      const tokens = Number(meta?.totalTokens ?? meta?.total_tokens ?? 0);
      if (tokens > 0) {
        setUsage((current) => ({
          ...current,
          usedTokens: tokens,
          totalTokens: settingsRef.current.contextWindowTokens,
        }));
      }
      setRawEvents((rows) => {
        const next = [...rows, { method: payload.method, payload: jsonText(params) || "{}" }];
        return next.slice(-200);
      });

      const update = asRecord(params.update) || (params.sessionUpdate || params.session_update ? params : undefined);
      if (!update) {
        if (payload.method === "session/request_permission" && payload.autoAllowed) {
          mutateAssistant((assistant) => {
            assistant.events = upsertEvent(assistant.events, {
              id: `permission-${Date.now()}`,
              kind: "permission",
              title: lang === "en" ? "Allowed automatically" : "已自动允许操作",
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
      mutateAssistant((assistant, conversation) => {
        if (type === "agent_message_chunk") {
          const content = asRecord(update.content) || {};
          const chunkType = String(content.type || "text");
          if (chunkType === "text" || !chunkType) {
            assistant.text += contentText(update);
          } else {
            assistant.media = [
              ...assistant.media,
              {
                id: uid(),
                type: chunkType,
                mimeType: content.mimeType ? String(content.mimeType) : undefined,
                data: content.data ? String(content.data) : undefined,
                uri: content.uri ? String(content.uri) : undefined,
                name: content.name ? String(content.name) : undefined,
              },
            ];
          }
        } else if (type === "agent_thought_chunk") {
          assistant.thought += contentText(update);
          assistant.events = upsertEvent(assistant.events, {
            id: "thought",
            kind: "thought",
            title: lang === "en" ? "Thinking" : "思考过程",
            output: assistant.thought,
          });
        } else if (type === "tool_call" || type === "tool_call_update") {
          const id = String(update.toolCallId || update.tool_call_id || uid());
          const metaTool = toolMeta(update);
          const kind = String(update.kind || metaTool?.kind || metaTool?.name || "other");
          const title = String(
            update.title || metaTool?.label || metaTool?.name || update.name || (lang === "en" ? "Tool" : "工具调用"),
          );
          const diffs = extractFileDiffs(update);
          const input = diffs.length ? undefined : jsonText(update.rawInput ?? update.input ?? update.raw_input);
          const output = diffs.length ? undefined : jsonText(update.content ?? update.output ?? update.rawOutput);
          assistant.events = upsertEvent(assistant.events, {
            id: `tool-${id}`,
            kind,
            title,
            status: String(update.status || "pending"),
            input,
            output,
            diffs: diffs.length ? diffs : undefined,
          });
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
          if (editPath && /edit|write|replace|file/i.test(`${kind} ${title}`)) {
            setWorkspaceFocusPath(editPath);
            setWorkspaceFocusTick((tick) => tick + 1);
            setShowWorkspace(true);
          }
        } else if (type === "plan") {
          const entries = (update.entries as Array<Record<string, unknown>> | undefined) || [];
          assistant.events = upsertEvent(assistant.events, {
            id: "plan",
            kind: "plan",
            title: lang === "en" ? "Plan" : "执行计划",
            output: entries
              .map((entry) => `[${entry.status || "pending"}] ${entry.content || entry.text || ""}`)
              .join("\n"),
          });
        } else if (type === "auto_compact_started") {
          assistant.events = upsertEvent(assistant.events, {
            id: "active-compaction",
            kind: "compaction",
            title: lang === "en" ? "Auto-compacting context" : "正在自动压缩上下文",
            status: `${update.percentage || usagePercent}%`,
          });
        } else if (type === "auto_compact_completed") {
          const after = Number(update.tokens_after ?? update.tokensAfter ?? 0);
          setUsage((current) => ({
            ...current,
            usedTokens: after || current.usedTokens,
            compactionCount: current.compactionCount + 1,
          }));
          assistant.events = upsertEvent(assistant.events, {
            id: "active-compaction",
            kind: "compaction",
            title: lang === "en" ? "Context compacted" : "上下文已自动压缩",
            status: "completed",
            input: update.tokens_before || update.tokensBefore
              ? `${lang === "en" ? "Before" : "压缩前"}：${formatTokens(Number(update.tokens_before ?? update.tokensBefore))} tokens`
              : undefined,
            output: `${lang === "en" ? "After" : "压缩后"}：${formatTokens(after)} tokens`,
          });
        } else if (type === "auto_compact_failed") {
          assistant.events = upsertEvent(assistant.events, {
            id: "active-compaction",
            kind: "compaction",
            title: lang === "en" ? "Auto-compact failed" : "自动压缩失败",
            status: "failed",
            output: String(update.error || ""),
          });
        } else if (type === "session_summary_generated") {
          const title = String(update.sessionSummary || update.session_summary || "");
          if (title) return { ...conversation, title, updatedAt: Date.now() };
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
        return { ...conversation, updatedAt: Date.now() };
      });
      scrollToBottom();
    },
    [lang, mutateAssistant, scrollToBottom, usagePercent],
  );

  const handleInteraction = useCallback((payload: {
    method: string;
    requestId: string;
    params: Record<string, unknown>;
  }) => {
    const params = payload.params || {};
    if (payload.method === "x.ai/ask_user_question") {
      const questions = ((params.questions as Array<Record<string, unknown>>) || []).map((value) => ({
        question: String(value.question || ""),
        multiSelect: Boolean(value.multiSelect),
        options: ((value.options as Array<Record<string, unknown>>) || []).map((option) => ({
          label: String(option.label || ""),
          description: String(option.description || ""),
          preview: option.preview ? String(option.preview) : undefined,
        })),
      }));
      setPendingQuestion({
        id: payload.requestId,
        questions,
        planMode: params.mode === "plan",
      });
      mutateAssistant((assistant) => {
        assistant.events = upsertEvent(assistant.events, {
          id: `interaction-${payload.requestId}`,
          kind: "question",
          title: lang === "en" ? "Grok needs more information" : "Grok 请求补充信息",
          status: "pending",
          input: jsonText(params),
        });
      });
      return;
    }
    if (payload.method === "x.ai/exit_plan_mode") {
      setPendingPlan({
        id: payload.requestId,
        content: String(params.planContent || params.plan_content || ""),
      });
      mutateAssistant((assistant) => {
        assistant.events = upsertEvent(assistant.events, {
          id: `interaction-${payload.requestId}`,
          kind: "interaction",
          title: lang === "en" ? "Review the plan" : "Grok 请求确认计划",
          status: "pending",
          input: jsonText(params),
        });
      });
      return;
    }
    const tool = asRecord(params.toolCall) || asRecord(params.tool_call) || {};
    const options = ((params.options as Array<Record<string, unknown>>) || []).map((option) => ({
      id: String(option.optionId || option.option_id || option.id || ""),
      name: String(option.name || (lang === "en" ? "Allow" : "允许")),
      kind: String(option.kind || ""),
    }));
    setPendingPermission({
      id: payload.requestId,
      title: String(tool.title || (lang === "en" ? "Grok wants to run an action" : "Grok 请求执行操作")),
      options,
    });
    mutateAssistant((assistant) => {
      assistant.events = upsertEvent(assistant.events, {
        id: `interaction-${payload.requestId}`,
        kind: "permission",
        title: String(tool.title || (lang === "en" ? "Permission request" : "Grok 请求执行操作")),
        status: "pending",
        input: jsonText(params),
      });
    });
  }, [lang, mutateAssistant]);

  const handleAcpUpdateRef = useRef(handleAcpUpdate);
  handleAcpUpdateRef.current = handleAcpUpdate;
  const finishTurnRef = useRef(finishTurn);
  finishTurnRef.current = finishTurn;
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
    if (!conversation?.grokSessionId || historyBusyRef.current) return;
    if (older && conversation.historyHasMore === false) return;
    if (!older && historyLoadedRef.current.has(conversationId)) return;
    if (!older) historyLoadedRef.current.add(conversationId);
    historyBusyRef.current = true;
    if (older) setLoadingOlder(true);
    const skip = older ? conversation.historySkip || conversation.messages.length : 0;
    try {
      const history = await invoke<LocalSessionHistory>("load_session_history", {
        sessionId: conversation.grokSessionId,
        limit: HISTORY_PAGE,
        skip,
      });
      const incoming: ChatMessage[] = (history.messages || []).map((item) => ({
        id: uid(),
        role: item.role === "assistant" ? "assistant" : "user",
        text: item.text || "",
        thought: "",
        events: (item.events || []).map((event) => ({
          id: event.id || uid(),
          kind: event.kind || "other",
          title: event.title || event.kind || "工具调用",
          status: event.status,
          input: event.input,
          output: event.output,
        })),
        media: [],
        streaming: false,
      }));
      const el = transcriptRef.current;
      const prevHeight = el?.scrollHeight || 0;
      const prevTop = el?.scrollTop || 0;
      const hasMore = incoming.length === 0 ? skip > 0 && Boolean(history.hasMore) : incoming.length >= HISTORY_PAGE || Boolean(history.hasMore);
      setConversations((list) =>
        list.map((item) => {
          if (item.id !== conversationId) return item;
          const messages = mergeHistoryMessages(item.messages, incoming, older || item.messages.length > 0);
          return {
            ...item,
            messages,
            historyHasMore: incoming.length === 0 ? false : hasMore,
            historySkip: skip + incoming.length,
          };
        }),
      );
      if (!older) {
        setShownCount(Math.max(VIEW_PAGE, incoming.length));
      }
      if (older || skip > 0) {
        setShownCount((count) => count + incoming.length);
        requestAnimationFrame(() => {
          const box = transcriptRef.current;
          if (!box) return;
          box.scrollTop = box.scrollHeight - prevHeight + prevTop;
        });
      }
      if (!older && history.usedTokens != null) {
        setUsage({
          usedTokens: Number(history.usedTokens) || 0,
          totalTokens: Number(history.totalTokens) || settingsRef.current.contextWindowTokens,
          compactionCount: Number(history.compactionCount) || 0,
        });
      }
    } catch {
      if (!older) historyLoadedRef.current.delete(conversationId);
    } finally {
      historyBusyRef.current = false;
      setLoadingOlder(false);
    }
  }, []);

  useEffect(() => {
    const root = transcriptRef.current;
    const target = topSentinelRef.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const conversation = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
        if (!conversation) return;
        revealOlder(conversation.id);
      },
      { root, rootMargin: "160px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [selectedId, selected?.messages.length, loadSessionHistory]);

  const loadLocalSessions = useCallback(async () => {
    try {
      const summaries = await invoke<LocalSessionSummary[]>("list_local_sessions");
      const merged = mergeLocalSessions(conversationsRef.current, summaries || []);
      setConversations(merged);
      conversationsRef.current = merged;
      return merged;
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
    try {
      const next = await invoke<SkillRecord[]>("list_skills", { cwd: cwdRef.current || null });
      setSkills(next);
    } catch {
      setSkills([]);
    }
  }, []);

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
      setInstallLog((log) => `${log}${lang === "en" ? "Installed: " : "安装完成："}${path}\n`);
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
      setConversations(ensured.list);
      setSelectedId(ensured.id);
      if (ensured.id) void loadSessionHistory(ensured.id);
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
          if (!runningRef.current) return;
          finishTurnRef.current(event.payload.ok ? undefined : event.payload.error);
        }),
      );
      await add(
        listen<{ method: string; requestId: string; params: Record<string, unknown> }>("acp-interaction", (event) =>
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
            for (const path of event.payload.paths) {
              if (!isImagePath(path)) continue;
              void invoke<PromptAttachment>("read_image_file", { path })
                .then((item) => addPendingImagesRef.current([item]))
                .catch((error) => setStatusText(String(error)));
            }
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

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        const blank = conversationsRef.current.find(
          (item) => item.messages.length === 0 && !item.archivedAt && !item.grokSessionId,
        );
        if (blank) {
          setSelectedId(blank.id);
          setView("chat");
          return;
        }
        const created: Conversation = {
          id: uid(),
          title: tRef.current.newChat,
          cwd: usableWorkspace(cwdRef.current, statusRef.current?.homeDir || ""),
          messages: [],
          updatedAt: Date.now(),
        };
        setConversations((list) => [created, ...list]);
        setSelectedId(created.id);
        setView("chat");
        setPrompt("");
      }
      if (meta && event.key === ",") {
        event.preventDefault();
        setView("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function newConversation(account?: AccountRecord) {
    const blank = conversations.find((item) => item.messages.length === 0 && !item.archivedAt && !item.grokSessionId);
    if (blank && !account) {
      setSelectedId(blank.id);
      setView("chat");
      return;
    }
    const created: Conversation = {
      id: uid(),
      title: t.newChat,
      cwd: usableWorkspace(cwd, homeDir),
      accountId: account?.id || activeAccount?.id,
      messages: [],
      updatedAt: Date.now(),
    };
    setConversations((list) => [created, ...list]);
    setSelectedId(created.id);
    setView("chat");
    setPrompt("");
    setPendingImages([]);
    setUsage({ usedTokens: 0, totalTokens: settings.contextWindowTokens, compactionCount: 0 });
  }

  function selectConversation(id: string) {
    const item = conversations.find((entry) => entry.id === id);
    setSelectedId(id);
    setShownCount(VIEW_PAGE);
    setView("chat");
    followRef.current = true;
    if (item?.cwd) setCwd(item.cwd);
    void loadSessionHistory(id);
  }

  function deleteConversation(id: string) {
    const next = conversations.filter((item) => item.id !== id);
    const ensured = ensureConversation(next, id === selectedId ? null : selectedId, usableWorkspace(cwd, homeDir));
    setConversations(ensured.list);
    setSelectedId(ensured.id);
  }

  function applyCwd(path: string) {
    const trimmed = path.trim();
    setCwd(trimmed);
    setConversations((list) =>
      list.map((item) => (item.id === selectedId ? { ...item, cwd: trimmed } : item)),
    );
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
      applyCwd(picked);
    } catch (error) {
      setStatusText(String(error));
    }
  }

  async function sendText(text: string, extraAttachments?: PromptAttachment[]) {
    const conversation = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
    const attachments = (extraAttachments ?? pendingImagesRef.current).filter((item) => item.data);
    if ((!text.trim() && !attachments.length) || !conversation || runningRef.current) return;
    const runtime = statusRef.current;
    if (!runtime?.installed) {
      setShowInstallPrompt(true);
      return;
    }
    const relayOn = Boolean(relayQuotaRef.current?.configured || relayReadyRef.current);
    const named = accountsRef.current.find((item) => item.id === conversation.accountId);
    const account = relayOn
      ? undefined
      : named?.enabled && named?.loggedIn
        ? named
        : pickRoutedAccount(accountsRef.current, settingsRef.current);
    if (runtime.credentialsReady === false && !account?.loggedIn) {
      setView("settings");
      setSettingsPage("relay");
      setStatusText(t.needCredentials);
      return;
    }
    const turnId = ++turnIdRef.current;
    setPrompt("");
    setPendingImages([]);
    if (composerRef.current) composerRef.current.style.height = "30px";
    setRunning(true);
    setStatusText(t.connecting);
    followRef.current = true;
    const title =
      conversation.title === translate("zh").newChat || conversation.title === translate("en").newChat
        ? (text.trim() || attachments[0]?.name || t.newChat).slice(0, 28)
        : conversation.title;
    const user: ChatMessage = {
      id: uid(),
      role: "user",
      text: text.trim(),
      thought: "",
      events: [],
      media: attachments.map(mediaFromAttachment),
      streaming: false,
    };
    const assistant: ChatMessage = { id: uid(), role: "assistant", text: "", thought: "", events: [], media: [], streaming: true };
    setConversations((list) =>
      list.map((item) =>
        item.id === conversation.id
          ? { ...item, title, messages: [...item.messages, user, assistant], updatedAt: Date.now() }
          : item,
      ),
    );
    requestAnimationFrame(() => scrollToBottom(true));
    try {
      const session = await invoke<SessionInfo>("ensure_session", {
        options: {
          model: canonicalModelId(modelRef.current),
          cwd: conversation.cwd || cwdRef.current,
          existingSessionId: conversation.grokSessionId ?? null,
          grokHome: relayOn ? null : account?.homePath || null,
          permissionMode: settingsRef.current.permissionMode,
          reasoningEffort: settingsRef.current.reasoningEffort,
          contextWindowTokens: settingsRef.current.contextWindowTokens,
          autoCompactThresholdPercent: settingsRef.current.autoCompactThresholdPercent,
          enableMemory: settingsRef.current.enableMemory,
          enableWebSearch: settingsRef.current.enableWebSearch,
          enableSubagents: settingsRef.current.enableSubagents,
        },
      });
      if (turnId !== turnIdRef.current) return;
      setConversations((list) =>
        list.map((item) =>
          item.id === conversation.id
            ? { ...item, grokSessionId: session.sessionId, cwd: session.cwd, accountId: relayOn ? undefined : account?.id }
            : item,
        ),
      );
      setStatusText(t.running);
      await invoke("send_prompt", {
        text: text.trim(),
        attachments: attachments.length ? attachments : null,
      });
    } catch (error) {
      if (turnId !== turnIdRef.current) return;
      setPendingImages(attachments);
      const message = String(error);
      if (/GROKDESK_NO_CREDENTIALS|还没有可用的登录或 API Key/.test(message)) {
        setView("settings");
        setSettingsPage("relay");
      }
      finishTurn(message);
    }
  }

  async function send() {
    await sendText(prompt);
  }

  async function stopTurn() {
    turnIdRef.current += 1;
    finishTurn();
    try {
      await invoke("cancel_turn");
    } catch {
      // ignore
    }
    try {
      await invoke("stop_session");
    } catch {
      // ignore
    }
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

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
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
        setStatusText(String(error));
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
      setStatusText(String(error));
    }
  }

  async function onComposerDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files || []).filter(isImageFile);
    if (!files.length) return;
    try {
      addPendingImages(await Promise.all(files.map(fileToAttachment)));
    } catch (error) {
      setStatusText(String(error));
    }
  }

  function revealOlder(conversationId: string) {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation) return;
    if (shownCountRef.current < conversation.messages.length) {
      const el = transcriptRef.current;
      const prevHeight = el?.scrollHeight || 0;
      const prevTop = el?.scrollTop || 0;
      setShownCount((count) => Math.min(conversation.messages.length, count + VIEW_PAGE));
      requestAnimationFrame(() => {
        const box = transcriptRef.current;
        if (!box) return;
        box.scrollTop = box.scrollHeight - prevHeight + prevTop;
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
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    if (el.scrollTop > 80) return;
    if (selectedIdRef.current) revealOlder(selectedIdRef.current);
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
    const move = (next: PointerEvent) => {
      setWorkspaceWidth(Math.min(920, Math.max(380, start - (next.clientX - origin))));
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
      });
      mutateAssistant((assistant) => {
        assistant.events = upsertEvent(assistant.events, {
          id: `interaction-${pendingPermission.id}`,
          kind: "permission",
          title: pendingPermission.title,
          status: optionId ? "approved" : "cancelled",
        });
      });
    } catch (error) {
      setStatusText(String(error));
    }
    setPendingPermission(null);
  }

  async function answerQuestions(action: string) {
    if (!pendingQuestion) return;
    const answers = questionAnswers;
    try {
      await invoke("answer_interaction", {
        requestId: pendingQuestion.id,
        result: {
          outcome: action,
          answers,
          annotations: Object.fromEntries(
            Object.entries(questionNotes)
              .filter(([, value]) => value.trim())
              .map(([key, value]) => [key, { notes: value }]),
          ),
        },
      });
    } catch (error) {
      setStatusText(String(error));
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
      });
    } catch (error) {
      setStatusText(String(error));
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
  const lastAssistant = [...(selected?.messages || [])].reverse().find((item) => item.role === "assistant");
  const toolEvents = lastAssistant?.events.filter((event) => event.id.startsWith("tool-")) || [];
  const planEvent = lastAssistant?.events.find((event) => event.kind === "plan");
  const fileDiffs = useMemo(() => {
    const latest = new Map<string, FileDiff>();
    for (const message of selected?.messages || []) {
      for (const event of message.events || []) {
        for (const diff of event.diffs || []) {
          latest.set(diff.path || `anon-${latest.size}`, diff);
        }
      }
    }
    return [...latest.values()];
  }, [selected?.messages]);
  const changedPaths = useMemo(
    () => fileDiffs.map((diff) => diff.path).filter((path): path is string => Boolean(path)),
    [fileDiffs],
  );

  if (view === "settings") {
    return (
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
        selectedSkill={selectedSkill}
        setSelectedSkill={setSelectedSkill}
        archived={conversations.filter((item) => item.archivedAt).map((item) => ({ id: item.id, title: item.title, cwd: item.cwd }))}
        onDeleteArchived={deleteConversation}
      />
    );
  }

  return (
    <div className="app" onClick={() => setShowAccountMenu(false)}>
      {showSidebar ? (
        <>
          <aside className="sidebar" style={{ width: sidebarWidth }}>
            <div className="brand-row">
              <GrokMark size={22} className="brand-mark" />
              <div className="brand-name">{t.brand}</div>
              <button className="icon-btn" type="button" title={t.hideSidebar} onClick={() => setShowSidebar(false)}>
                <IconSidebar />
              </button>
              <button className="icon-btn" type="button" title={t.newChat} onClick={() => newConversation()}>
                <IconCompose />
              </button>
            </div>
            <button className="new-chat" type="button" onClick={() => newConversation()}>
              <IconCompose />
              {t.newChat}
            </button>
            <div className="section-label">{t.projects}</div>
            <div className="session-list">
              {projects.map((project) => {
                const open = !collapsed[project.path];
                return (
                  <div key={project.path || "home"} className="project">
                    <button
                      className="project-head"
                      type="button"
                      onClick={() => setCollapsed((current) => ({ ...current, [project.path]: !current[project.path] }))}
                    >
                      <span className={open ? "chevron open" : "chevron"}>
                        <IconChevronRight />
                      </span>
                      <IconFolder />
                      <span className="project-name">{project.name}</span>
                    </button>
                    {open
                      ? project.items.map((item) => (
                          <button
                            key={item.grokSessionId || item.id}
                            className={item.id === selectedId ? "session on" : "session"}
                            type="button"
                            onClick={() => selectConversation(item.id)}
                          >
                            <span className="session-title">{item.title}</span>
                            {running && item.id === selectedId ? <span className="mini-spin" /> : null}
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
          <div className="resize" onPointerDown={beginResize} />
        </>
      ) : null}

      <main className="main">
        <header className="chat-header">
          <div className="crumb">
            {!showSidebar ? (
              <button className="icon-btn" type="button" title={t.showSidebar} onClick={() => setShowSidebar(true)}>
                <IconSidebar />
              </button>
            ) : null}
            <button className="crumb-folder" type="button" title={t.pickWorkspace} onClick={() => void pickWorkspaceFolder()}>
              <IconFolder />
              <span>{workspaceRoot ? projectName : t.chooseFolder}</span>
            </button>
            <span className="sep">
              <IconChevronRight />
            </span>
            <span className="muted">{selected?.title || t.newChat}</span>
          </div>
          <div className="live-row">
            {running ? (
              <div className="live">
                <span className="spinner" />
                {statusText || t.running}
              </div>
            ) : osLabel ? (
              <div className="live quiet">{osLabel}</div>
            ) : null}
            <button
              className={`icon-btn${showWorkspace ? " on" : ""}`}
              type="button"
              title={showWorkspace ? t.hideWorkspace : t.showWorkspace}
              onClick={() => setShowWorkspace((value) => !value)}
            >
              <IconCodePane />
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
              title={t.settings}
              onClick={() => {
                setView("settings");
                setSettingsPage("general");
              }}
            >
              <IconGear />
            </button>
          </div>
        </header>

        <section ref={transcriptRef} className="transcript" onScroll={onTranscriptScroll}>
          {selected?.grokSessionId || selected?.messages.length ? (
            <div className="history-more-bar">
              {selected.messages.length > shownCount || (selected.grokSessionId && selected.historyHasMore !== false) ? (
                <button
                  className="ghost compact history-more"
                  type="button"
                  disabled={loadingOlder}
                  onClick={() => revealOlder(selected.id)}
                >
                  {loadingOlder ? t.loadingOlder : t.loadOlder}
                </button>
              ) : (
                <span className="history-start">{t.historyStart}</span>
              )}
            </div>
          ) : null}
          {!selected?.messages.length ? (
            <div className="empty">
              <div className="empty-hero">
                <GrokMark size={72} className="empty-mark" />
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
          ) : (
            <div className="messages">
              <div ref={topSentinelRef} className="history-sentinel" />
              {selected.messages.slice(Math.max(0, selected.messages.length - shownCount)).map((message) => (
                <article key={message.id} className={`row ${message.role}`}>
                  <div className={message.role === "user" ? "bubble user" : "bubble assistant"}>
                    {message.role === "assistant" && message.events.length ? (
                      <ActivityTimeline
                        events={message.events}
                        lang={lang}
                        defaultOpen={message.streaming || message.events.length > 0}
                      />
                    ) : message.thought ? (
                      <details className="thought" open={message.streaming && !message.text}>
                        <summary>{t.thinking}</summary>
                        <pre>{message.thought}</pre>
                      </details>
                    ) : null}
                    {message.text || message.streaming ? (
                      <MessageBody
                        text={message.text || (message.streaming && !message.events.length ? t.thinkingNow : "")}
                        streaming={message.streaming && Boolean(message.text)}
                      />
                    ) : null}
                    {message.media.map((item) =>
                      item.type === "image" && item.data ? (
                        <img key={item.id} className="chat-media" src={`data:${item.mimeType || "image/png"};base64,${item.data}`} alt={item.name || ""} />
                      ) : (
                        <a key={item.id} className="media-link" href={item.uri} target="_blank" rel="noreferrer">
                          {item.name || item.uri || item.type}
                        </a>
                      ),
                    )}
                    {message.streaming ? (
                      <div className="working">
                        <span className="spinner" />
                        {t.working}
                      </div>
                    ) : null}
                    {message.error ? (
                      <div className="fail">
                        <div className="fail-title">{t.failed}</div>
                        <pre>{message.error}</pre>
                        <button className="ghost compact" type="button" onClick={() => void regenerate()}>
                          {t.regenerate}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <footer className="composer-wrap">
          <div
            className={dragOver ? "composer drop-target" : "composer"}
            onPaste={onComposerPaste}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => void onComposerDrop(event)}
          >
            {!selected?.messages.length ? (
              editingCwd ? (
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
                <button
                  className="workspace-chip"
                  type="button"
                  title={t.pickWorkspace}
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
              )
            ) : null}
            {pendingImages.length ? (
              <div className="attach-row">
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
            <textarea
              ref={composerRef}
              rows={1}
              value={prompt}
              placeholder={pendingImages.length ? t.pasteImage : t.composer}
              onChange={(event) => {
                setPrompt(event.target.value);
                requestAnimationFrame(resizeComposer);
              }}
              onKeyDown={onComposerKey}
            />
            <div className="composer-bar">
              <label className="perm-chip">
                <IconShield />
                <select
                  value={settings.permissionMode}
                  onChange={(event) => patchSettings({ permissionMode: event.target.value })}
                >
                  {PERMISSION_MODES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {lang === "en" ? item.labelEn : item.labelZh}
                    </option>
                  ))}
                </select>
              </label>
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
              <select
                className="effort-mini"
                value={settings.reasoningEffort}
                onChange={(event) => patchSettings({ reasoningEffort: event.target.value })}
                disabled={running}
              >
                {EFFORTS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              {running ? (
                <button className="send stop" type="button" title="Stop" onClick={() => void stopTurn()}>
                  <IconStop />
                </button>
              ) : (
                <button className="send" type="button" disabled={!canSend} title={t.sendHint} onClick={() => void send()}>
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
      </main>

      {showWorkspace ? (
        <>
          <div className="resize workspace-edge" onPointerDown={beginWorkspaceResize} />
          <Suspense fallback={<aside className="workspace" style={{ width: workspaceWidth, minWidth: workspaceWidth, flex: "0 0 auto" }} />}>
            <WorkspacePanel
              cwd={workspaceRoot}
              changedPaths={changedPaths}
              diffs={fileDiffs}
              focusPath={workspaceFocusPath}
              focusTick={workspaceFocusTick}
              copy={t}
              onClose={() => setShowWorkspace(false)}
              onPickFolder={() => void pickWorkspaceFolder()}
              width={workspaceWidth}
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

      {pendingPermission ? (
        <div className="overlay">
          <div className="modal">
            <h3>{t.needApprove}</h3>
            <p>{pendingPermission.title}</p>
            <div className="actions">
              <button className="ghost" type="button" onClick={() => void answerPermission(null)}>
                {t.reject}
              </button>
              {pendingPermission.options.map((option) => (
                <button
                  key={option.id}
                  className={option.kind.includes("allow") ? "primary" : "ghost"}
                  type="button"
                  onClick={() => void answerPermission(option.id)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {pendingQuestion ? (
        <div className="overlay">
          <div className="modal wide">
            <h3>{t.grokNeedsChoice}</h3>
            {pendingQuestion.questions.map((question) => (
              <div key={question.question} className="question">
                <strong>{question.question}</strong>
                {question.options.map((option) => {
                  const selectedOpts = questionAnswers[question.question] || [];
                  const on = selectedOpts.includes(option.label);
                  return (
                    <label key={option.label} className="check">
                      <input
                        type={question.multiSelect ? "checkbox" : "radio"}
                        checked={on}
                        onChange={() => {
                          setQuestionAnswers((current) => {
                            const prev = current[question.question] || [];
                            if (question.multiSelect) {
                              return {
                                ...current,
                                [question.question]: on ? prev.filter((item) => item !== option.label) : [...prev, option.label],
                              };
                            }
                            return { ...current, [question.question]: [option.label] };
                          });
                        }}
                      />
                      <span>
                        {option.label}
                        <em>{option.description}</em>
                      </span>
                    </label>
                  );
                })}
                <input
                  placeholder={lang === "en" ? "Optional notes" : "补充说明（可选）"}
                  value={questionNotes[question.question] || ""}
                  onChange={(event) => setQuestionNotes((current) => ({ ...current, [question.question]: event.target.value }))}
                />
              </div>
            ))}
            <div className="actions">
              <button className="ghost" type="button" onClick={() => void answerQuestions("cancelled")}>
                {t.cancel}
              </button>
              <button className="primary" type="button" onClick={() => void answerQuestions("accepted")}>
                {t.submit}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingPlan ? (
        <div className="overlay">
          <div className="modal wide">
            <h3>{t.reviewPlan}</h3>
            <pre className="log">{pendingPlan.content}</pre>
            <input value={planFeedback} placeholder={lang === "en" ? "Feedback" : "修改意见"} onChange={(event) => setPlanFeedback(event.target.value)} />
            <div className="actions">
              <button className="ghost" type="button" onClick={() => void answerPlan(false)}>
                {t.requestChanges}
              </button>
              <button className="primary" type="button" onClick={() => void answerPlan(true)}>
                {t.approvePlan}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
