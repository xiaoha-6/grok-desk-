import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ActivityTimeline } from "./ActivityTimeline";
import {
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCompose,
  IconFolder,
  IconGauge,
  IconGear,
  IconInspector,
  IconPerson,
  IconRefresh,
  IconShield,
  IconSidebar,
  IconSpark,
  IconStop,
} from "./icons";
import { t as translate, type Copy } from "./i18n";
import { MessageBody } from "./markdown";
import { SettingsView } from "./SettingsView";
import { isRedundantExtension, jsonText } from "./timeline";
import {
  defaultSettings,
  EFFORTS,
  MODELS,
  PERMISSION_MODES,
  type AccountRecord,
  type AccountState,
  type AcpTurnDone,
  type AcpUpdate,
  type AppSettings,
  type ChatMessage,
  type ContextUsage,
  type Conversation,
  type ImportResult,
  type Lang,
  type PendingPermission,
  type PendingPlan,
  type PendingQuestion,
  type RelayImport,
  type RuntimeStatus,
  type SessionInfo,
  type SettingsPage,
  type SkillRecord,
  type Theme,
  type TimelineEvent,
  type View,
} from "./types";

const STORAGE_KEY = "grokdesk.workspace.v3";
const LEGACY_KEYS = ["grokdesk.workspace.v2", "grokdesk.workspace.v1"];

function uid() {
  return crypto.randomUUID();
}

function workspaceLabel(path: string, homeDir: string, homeWord: string) {
  if (!path) return homeWord;
  const normalized = path.replace(/[\\/]+$/, "");
  if (homeDir && normalized.replace(/\\/g, "/") === homeDir.replace(/\\/g, "/")) {
    return homeWord;
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
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

function upsertEvent(events: TimelineEvent[], event: TimelineEvent) {
  const index = events.findIndex((item) => item.id === event.id);
  if (index >= 0) {
    const next = [...events];
    next[index] = { ...next[index], ...event, input: event.input ?? next[index].input, output: event.output ?? next[index].output };
    return next;
  }
  return [...events, event];
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
  settings?: Partial<AppSettings>;
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
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showUsageCard, setShowUsageCard] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(Math.min(400, Math.max(220, saved.sidebarWidth || 280)));
  const [model, setModel] = useState(saved.model || "grok-4.5");
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
    model: saved.form?.model || "grok-4.5",
    name: saved.form?.name || "小哈AI",
  });
  const [settings, setSettings] = useState<AppSettings>({ ...defaultSettings(), ...saved.settings });
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    return (saved.conversations || []).map((item) => ({
      ...item,
      messages: (item.messages || []).map((message) => ({
        ...message,
        events: message.events || [],
        media: message.media || [],
        streaming: false,
      })),
    }));
  });
  const [selectedId, setSelectedId] = useState<string | null>(saved.selectedId || null);
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
    totalTokens: saved.settings?.contextWindowTokens || 225000,
    compactionCount: 0,
  });
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
  conversationsRef.current = conversations;
  selectedIdRef.current = selectedId;
  runningRef.current = running;
  modelRef.current = model;
  cwdRef.current = cwd;
  statusRef.current = status;
  tRef.current = t;
  settingsRef.current = settings;
  accountsRef.current = accounts;

  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const homeDir = status?.homeDir || "";
  const projectName = workspaceLabel(selected?.cwd || cwd, homeDir, t.home);
  const canSend = prompt.trim().length > 0 && !installing && !running;
  const routed = pickRoutedAccount(accounts, settings);
  const activeAccount =
    accounts.find((account) => account.id === selected?.accountId) || routed;
  const quotaText = activeAccount?.quota?.weeklyRemainingPercent != null
    ? lang === "en"
      ? `${Math.round(activeAccount.quota.weeklyRemainingPercent)}% weekly remaining`
      : `本周剩余 ${Math.round(activeAccount.quota.weeklyRemainingPercent)}%`
    : activeAccount?.loggedIn
      ? t.quotaPending
      : status?.credentialsReady
        ? t.ready
        : t.notConfigured;

  const projects = useMemo(() => {
    const groups = new Map<string, Conversation[]>();
    for (const item of conversations.filter((conversation) => !conversation.archivedAt)) {
      const key = item.cwd || homeDir || "";
      const list = groups.get(key) || [];
      list.push(item);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([path, items]) => ({
        path,
        name: workspaceLabel(path, homeDir, t.home),
        items: [...items].sort((a, b) => b.updatedAt - a.updatedAt),
      }))
      .sort((a, b) => (b.items[0]?.updatedAt || 0) - (a.items[0]?.updatedAt || 0));
  }, [conversations, homeDir, t.home]);

  const effortLabel = EFFORTS.find((item) => item.id === settings.reasoningEffort)?.label || settings.reasoningEffort;
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
        conversations,
        sidebarWidth,
        settings,
        form: { ...form, apiKey: "" },
      }),
    );
  }, [lang, theme, model, cwd, selectedId, conversations, sidebarWidth, form, settings]);

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
      const live = list.filter((item) => !item.archivedAt);
      if (live.length === 0) {
        const created: Conversation = {
          id: uid(),
          title: tRef.current.newChat,
          cwd: path,
          messages: [],
          updatedAt: Date.now(),
        };
        return { list: [created, ...list.filter((item) => item.archivedAt)], id: created.id };
      }
      if (!id || !list.some((item) => item.id === id && !item.archivedAt)) {
        return { list, id: live[0].id };
      }
      return { list, id };
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
          const input = jsonText(update.rawInput ?? update.input ?? update.raw_input);
          const output = jsonText(update.content ?? update.output ?? update.rawOutput);
          assistant.events = upsertEvent(assistant.events, {
            id: `tool-${id}`,
            kind,
            title,
            status: String(update.status || "pending"),
            input,
            output,
          });
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
      setCwd((value) => value || next.homeDir);
      setConversations((list) => list.map((item) => (item.cwd ? item : { ...item, cwd: next.homeDir })));
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
      setStatusText(tRef.current.refreshQuota);
    } finally {
      setRefreshingQuota(false);
    }
  }, [persistAccounts]);

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
        setModel(result.model);
        const backup = result.backupPath ? `\n${tRef.current.backup}: ${result.backupPath}` : "";
        setImportMessage(`${tRef.current.wrote} ${result.configPath}${backup}\n${tRef.current.imported}`);
        await refresh();
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
    [refresh],
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
      await refreshSkills();
      const path = cwdRef.current || runtime?.homeDir || "";
      const ensured = ensureConversation(conversationsRef.current, selectedIdRef.current, path);
      setConversations(ensured.list);
      setSelectedId(ensured.id);
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
  }, [ensureConversation, loadAccounts, refresh, refreshQuotas, refreshSkills]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        const blank = conversationsRef.current.find((item) => item.messages.length === 0 && !item.archivedAt);
        if (blank) {
          setSelectedId(blank.id);
          setView("chat");
          return;
        }
        const created: Conversation = {
          id: uid(),
          title: tRef.current.newChat,
          cwd: cwdRef.current || statusRef.current?.homeDir || "",
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
    const blank = conversations.find((item) => item.messages.length === 0 && !item.archivedAt);
    if (blank && !account) {
      setSelectedId(blank.id);
      setView("chat");
      return;
    }
    const created: Conversation = {
      id: uid(),
      title: t.newChat,
      cwd: cwd || homeDir,
      accountId: account?.id || activeAccount?.id,
      messages: [],
      updatedAt: Date.now(),
    };
    setConversations((list) => [created, ...list]);
    setSelectedId(created.id);
    setView("chat");
    setPrompt("");
    setUsage({ usedTokens: 0, totalTokens: settings.contextWindowTokens, compactionCount: 0 });
  }

  function selectConversation(id: string) {
    setSelectedId(id);
    setView("chat");
    followRef.current = true;
  }

  function deleteConversation(id: string) {
    const next = conversations.filter((item) => item.id !== id);
    const ensured = ensureConversation(next, id === selectedId ? null : selectedId, cwd || homeDir);
    setConversations(ensured.list);
    setSelectedId(ensured.id);
  }

  function applyCwd(path: string) {
    const trimmed = path.trim();
    setCwd(trimmed);
    setConversations((list) =>
      list.map((item) => (item.id === selectedId && item.messages.length === 0 ? { ...item, cwd: trimmed } : item)),
    );
  }

  async function sendText(text: string) {
    const conversation = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
    if (!text.trim() || !conversation || runningRef.current) return;
    const runtime = statusRef.current;
    if (!runtime?.installed) {
      setShowInstallPrompt(true);
      return;
    }
    const named = accountsRef.current.find((item) => item.id === conversation.accountId);
    const account = named?.loggedIn
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
    if (composerRef.current) composerRef.current.style.height = "30px";
    setRunning(true);
    setStatusText(t.connecting);
    followRef.current = true;
    const title =
      conversation.title === translate("zh").newChat || conversation.title === translate("en").newChat
        ? text.trim().slice(0, 28)
        : conversation.title;
    const user: ChatMessage = { id: uid(), role: "user", text: text.trim(), thought: "", events: [], media: [], streaming: false };
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
          model: modelRef.current,
          cwd: conversation.cwd || cwdRef.current,
          existingSessionId: conversation.grokSessionId ?? null,
          grokHome: account?.homePath || null,
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
            ? { ...item, grokSessionId: session.sessionId, cwd: session.cwd, accountId: account?.id }
            : item,
        ),
      );
      setStatusText(t.running);
      await invoke("send_prompt", { text: text.trim() });
    } catch (error) {
      if (turnId !== turnIdRef.current) return;
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
    await sendText(lastUser.text);
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function resizeComposer() {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "30px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  function onTranscriptScroll() {
    const el = transcriptRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
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
        setModel={setModel}
        cwd={cwd}
        applyCwd={applyCwd}
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
              <img className="brand-mark" src="/app-icon.png" alt="" />
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
                            key={item.id}
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
                <span className="avatar">{(activeAccount?.name || "G").slice(0, 1)}</span>
                <span className="account">
                  <span className="account-model">{activeAccount?.name || t.askAccount}</span>
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
            <IconFolder />
            <span>{projectName}</span>
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
              className="icon-btn"
              type="button"
              title={t.inspector}
              onClick={() => setShowInspector((value) => !value)}
            >
              <IconInspector />
            </button>
          </div>
        </header>

        <section ref={transcriptRef} className="transcript" onScroll={onTranscriptScroll}>
          {!selected?.messages.length ? (
            <div className="empty">
              <div className="spark">
                <IconSpark />
              </div>
              <h1>{t.emptyTitle}</h1>
              <p>{projectName || t.emptyHint}</p>
              {!accounts.some((account) => account.loggedIn) ? (
                <button
                  className="primary"
                  type="button"
                  onClick={() => {
                    setView("settings");
                    setSettingsPage("accounts");
                  }}
                >
                  {t.addAccount}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="messages">
              {selected.messages.map((message) => (
                <article key={message.id} className={`row ${message.role}`}>
                  <div className={message.role === "user" ? "bubble user" : "bubble assistant"}>
                    {message.role === "assistant" && message.events.length ? (
                      <ActivityTimeline events={message.events} lang={lang} defaultOpen={message.streaming} />
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
          <div className="composer">
            {!selected?.messages.length ? (
              editingCwd ? (
                <input
                  className="cwd-input"
                  autoFocus
                  value={cwd}
                  spellCheck={false}
                  onChange={(event) => applyCwd(event.target.value)}
                  onBlur={() => setEditingCwd(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setEditingCwd(false);
                  }}
                />
              ) : (
                <button className="workspace-chip" type="button" onClick={() => setEditingCwd(true)}>
                  <IconFolder />
                  <span>{projectName || t.chooseFolder}</span>
                  <IconChevronDown />
                </button>
              )
            ) : null}
            <textarea
              ref={composerRef}
              rows={1}
              value={prompt}
              placeholder={t.composer}
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
              <span className="hint inline">{`${model} · ${effortLabel}`}</span>
              <select
                className="model-mini"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={running}
              >
                {MODELS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <select
                className="model-mini"
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
