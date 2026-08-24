import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

type RuntimeStatus = {
  installed: boolean;
  path: string | null;
  version: string | null;
  grokHome: string;
  configPath: string;
  configExists: boolean;
  homeDir: string;
  os: string;
  installerUrl: string;
};

type RelayImport = {
  endpoint: string;
  apiKey: string;
  model: string;
  name: string;
};

type ImportResult = {
  configPath: string;
  backupPath: string | null;
  model: string;
  endpoint: string;
};

type SessionInfo = {
  sessionId: string;
  model: string;
  cwd: string;
};

type TimelineEvent = {
  id: string;
  kind: string;
  title: string;
  status?: string;
  detail?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  thought: string;
  events: TimelineEvent[];
  streaming: boolean;
  error?: string;
};

type Conversation = {
  id: string;
  title: string;
  cwd: string;
  grokSessionId?: string;
  messages: ChatMessage[];
  updatedAt: number;
};

type AcpUpdate = {
  method: string;
  params: Record<string, unknown>;
  autoAllowed?: boolean;
};

type AcpTurnDone = {
  ok: boolean;
  error?: string;
};

type Lang = "zh" | "en";
type Theme = "system" | "light" | "dark";
type View = "chat" | "settings";
type SettingsPage = "general" | "runtime" | "relay";

type Copy = typeof zh;

const STORAGE_KEY = "grokdesk.workspace.v2";
const LEGACY_KEY = "grokdesk.workspace.v1";
const MODELS = [
  "grok-4.5",
  "grok-4.3",
  "grok-build-0.1",
  "grok-composer-2.5-fast",
  "grok-4.20-multi-agent-0309",
];

const zh = {
  brand: "GrokDesk",
  newChat: "新对话",
  projects: "项目",
  home: "主目录",
  settings: "设置",
  back: "返回 GrokDesk",
  localCli: "本机 Grok CLI",
  emptyTitle: "今天想构建什么？",
  emptyHint: "选择一个工作目录，然后把任务交给 Grok",
  composer: "描述任务，或让 Grok 修改代码…",
  sendHint: "Return 发送，⇧ Return 换行",
  ready: "就绪",
  connecting: "正在连接 Grok Agent",
  running: "Grok 正在处理",
  thinking: "思考过程",
  thinkingNow: "正在思考…",
  working: "Grok 正在工作",
  runtime: "Grok Runtime",
  general: "通用",
  relay: "中转站",
  appearance: "外观",
  appearanceDetail: "选择应用的显示模式",
  language: "语言",
  languageDetail: "切换 GrokDesk 界面语言",
  followSystem: "跟随系统",
  light: "浅色",
  dark: "深色",
  installed: "已安装",
  missing: "未安装",
  install: "从官方安装",
  installing: "正在安装…",
  redetect: "重新检测",
  official: "官方安装说明",
  path: "路径",
  dataDir: "数据目录",
  version: "版本",
  relayHint:
    "像 CC Switch 一样，把 API 地址和密钥直接写入 ~/.grok/config.toml。写入后回到这个桌面对话，不会打开 CLI。",
  endpoint: "API 地址",
  apiKey: "API Key",
  model: "默认模型",
  modelDetail: "新对话使用的 Grok 模型",
  name: "显示名称",
  import: "写入 Grok 配置",
  importing: "正在写入…",
  backup: "已备份原配置",
  needRuntime: "需要安装 Grok Build",
  needRuntimeBody:
    "GrokDesk 需要本地 Grok Build Runtime 才能运行 Agent。是否使用 xAI 官方安装器安装最新版？",
  later: "稍后",
  installLatest: "安装最新版",
  windowsHint: "Windows 官方安装命令：irm https://x.ai/cli/install.ps1 | iex",
  unixHint: "macOS / Linux 官方安装命令：curl -fsSL https://x.ai/cli/install.sh | bash",
  workspace: "工作目录",
  workspaceDetail: "当前对话使用的本地目录",
  wrote: "已写入",
  imported: "配置已写入，可以开始对话",
  hideSidebar: "隐藏侧栏",
  showSidebar: "显示侧栏",
  deleteChat: "删除对话",
  chooseFolder: "选择文件夹",
  searchSettings: "搜索设置…",
  failed: "运行失败",
  regenerate: "重新生成",
};

const en: Copy = {
  brand: "GrokDesk",
  newChat: "New chat",
  projects: "Projects",
  home: "Home",
  settings: "Settings",
  back: "Back to GrokDesk",
  localCli: "Local Grok CLI",
  emptyTitle: "What do you want to build today?",
  emptyHint: "Pick a workspace, then hand the task to Grok",
  composer: "Describe a task, or let Grok edit code…",
  sendHint: "Return to send, ⇧ Return for a newline",
  ready: "Ready",
  connecting: "Connecting Grok Agent",
  running: "Grok is working",
  thinking: "Thinking",
  thinkingNow: "Thinking…",
  working: "Grok is working",
  runtime: "Grok Runtime",
  general: "General",
  relay: "Relay",
  appearance: "Appearance",
  appearanceDetail: "Choose how GrokDesk looks",
  language: "Language",
  languageDetail: "Switch the GrokDesk interface language",
  followSystem: "System",
  light: "Light",
  dark: "Dark",
  installed: "Installed",
  missing: "Missing",
  install: "Install from official",
  installing: "Installing…",
  redetect: "Recheck",
  official: "Official install docs",
  path: "Path",
  dataDir: "Data directory",
  version: "Version",
  relayHint:
    "Like CC Switch: write the API base URL and key into ~/.grok/config.toml. After import, this desktop chat opens — not the CLI.",
  endpoint: "API base URL",
  apiKey: "API key",
  model: "Default model",
  modelDetail: "Model used for new conversations",
  name: "Display name",
  import: "Write Grok config",
  importing: "Writing…",
  backup: "Previous config backed up",
  needRuntime: "Grok Build is required",
  needRuntimeBody:
    "GrokDesk needs the local Grok Build runtime to run the agent. Install the latest official build?",
  later: "Later",
  installLatest: "Install latest",
  windowsHint: "Windows official install: irm https://x.ai/cli/install.ps1 | iex",
  unixHint: "macOS / Linux official install: curl -fsSL https://x.ai/cli/install.sh | bash",
  workspace: "Workspace",
  workspaceDetail: "Local directory used by the current chat",
  wrote: "Wrote",
  imported: "Config written. You can start chatting.",
  hideSidebar: "Hide sidebar",
  showSidebar: "Show sidebar",
  deleteChat: "Delete chat",
  chooseFolder: "Choose folder",
  searchSettings: "Search settings…",
  failed: "Run failed",
  regenerate: "Regenerate",
};

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
  const text = String(raw || "").trim() || "ACP 请求失败";
  if (
    /上游/.test(text) ||
    /upstream (?:service )?(?:temporarily )?unavailable/i.test(text)
  ) {
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

type PersistShape = {
  lang?: Lang;
  theme?: Theme;
  model?: string;
  cwd?: string;
  selectedId?: string | null;
  conversations?: Conversation[];
  form?: Partial<RelayImport>;
  sidebarWidth?: number;
};

function loadPersist(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistShape;
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
  const [settingsQuery, setSettingsQuery] = useState("");
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(
    Math.min(400, Math.max(220, saved.sidebarWidth || 280)),
  );
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
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const items = (saved.conversations || []).map((item) => ({
      ...item,
      messages: (item.messages || []).map((message) => ({ ...message, streaming: false })),
    }));
    return items;
  });
  const [selectedId, setSelectedId] = useState<string | null>(saved.selectedId || null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const t = lang === "en" ? en : zh;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const followRef = useRef(true);
  const lastImportRef = useRef("");
  const conversationsRef = useRef(conversations);
  const selectedIdRef = useRef(selectedId);
  const runningRef = useRef(running);
  const modelRef = useRef(model);
  const cwdRef = useRef(cwd);
  const statusRef = useRef(status);
  const tRef = useRef(t);
  conversationsRef.current = conversations;
  selectedIdRef.current = selectedId;
  runningRef.current = running;
  modelRef.current = model;
  cwdRef.current = cwd;
  statusRef.current = status;
  tRef.current = t;

  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const runtimeOk = Boolean(status?.installed);
  const homeDir = status?.homeDir || "";
  const projectName = workspaceLabel(selected?.cwd || cwd, homeDir, t.home);
  const canSend = prompt.trim().length > 0 && !installing && !running;

  const projects = useMemo(() => {
    const groups = new Map<string, Conversation[]>();
    for (const item of conversations) {
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

  useEffect(() => {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.documentElement.dataset.theme = theme;
  }, [lang, theme]);

  useEffect(() => {
    const payload = {
      lang,
      theme,
      model,
      cwd,
      selectedId,
      conversations,
      sidebarWidth,
      form: { ...form, apiKey: "" },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [lang, theme, model, cwd, selectedId, conversations, sidebarWidth, form]);

  const ensureConversation = useCallback(
    (list: Conversation[], id: string | null, path: string) => {
      if (list.length === 0) {
        const created: Conversation = {
          id: uid(),
          title: tRef.current.newChat,
          cwd: path,
          messages: [],
          updatedAt: Date.now(),
        };
        return { list: [created], id: created.id };
      }
      if (!id || !list.some((item) => item.id === id)) {
        return { list, id: list[0].id };
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

  const finishTurn = useCallback((error?: string) => {
    const err = error ? friendlyError(error) : undefined;
    setConversations((list) =>
      list.map((item) => {
        if (item.id !== selectedIdRef.current) return item;
        return {
          ...item,
          messages: item.messages.map((message) =>
            message.streaming
              ? { ...message, streaming: false, error: err || message.error }
              : message,
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
      const update =
        (params.update as Record<string, unknown> | undefined) ||
        (params.sessionUpdate ? params : undefined);

      setConversations((list) => {
        const currentId = selectedIdRef.current;
        return list.map((conversation) => {
          if (conversation.id !== currentId) return conversation;
          const messages = [...conversation.messages];
          let assistant: ChatMessage | undefined;
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === "assistant" && messages[i].streaming) {
              assistant = { ...messages[i] };
              messages[i] = assistant;
              break;
            }
          }
          if (!update) {
            if (payload.method === "session/request_permission" && payload.autoAllowed && assistant) {
              assistant.events = [
                ...assistant.events,
                {
                  id: `permission-${Date.now()}`,
                  kind: "permission",
                  title: lang === "en" ? "Allowed automatically" : "已自动允许操作",
                  status: "approved",
                },
              ];
            }
            return { ...conversation, messages };
          }
          if (!assistant) return conversation;
          const type = String(update.sessionUpdate || "unknown");
          if (type === "agent_message_chunk") {
            const content = (update.content as Record<string, unknown> | undefined) || {};
            assistant.text += String(content.text ?? update.text ?? "");
          } else if (type === "agent_thought_chunk") {
            const content = (update.content as Record<string, unknown> | undefined) || {};
            assistant.thought += String(content.text ?? update.text ?? "");
          } else if (type === "tool_call" || type === "tool_call_update") {
            const id = String(update.toolCallId || update.tool_call_id || uid());
            const event: TimelineEvent = {
              id: `tool-${id}`,
              kind: String(update.kind || "tool"),
              title: String(update.title || update.name || (lang === "en" ? "Tool" : "工具调用")),
              status: String(update.status || "pending"),
            };
            const index = assistant.events.findIndex((item) => item.id === event.id);
            if (index >= 0) assistant.events[index] = { ...assistant.events[index], ...event };
            else assistant.events = [...assistant.events, event];
          } else if (type === "plan") {
            const entries = (update.entries as Array<Record<string, unknown>> | undefined) || [];
            const event: TimelineEvent = {
              id: "plan",
              kind: "plan",
              title: lang === "en" ? "Plan" : "执行计划",
              detail: entries
                .map((entry) => `[${entry.status || "pending"}] ${entry.content || entry.text || ""}`)
                .join("\n"),
            };
            const index = assistant.events.findIndex((item) => item.id === "plan");
            if (index >= 0) assistant.events[index] = event;
            else assistant.events = [...assistant.events, event];
          } else if (type === "session_summary_generated") {
            const title = String(update.sessionSummary || update.session_summary || "");
            if (title) {
              return { ...conversation, messages, title, updatedAt: Date.now() };
            }
          }
          return { ...conversation, messages, updatedAt: Date.now() };
        });
      });
      scrollToBottom();
    },
    [lang, scrollToBottom],
  );
  const handleAcpUpdateRef = useRef(handleAcpUpdate);
  handleAcpUpdateRef.current = handleAcpUpdate;
  const finishTurnRef = useRef(finishTurn);
  finishTurnRef.current = finishTurn;

  const refresh = useCallback(async () => {
    setStatusError("");
    try {
      const next = await invoke<RuntimeStatus>("get_runtime_status");
      setStatus(next);
      setCwd((value) => value || next.homeDir);
      setConversations((list) =>
        list.map((item) => (item.cwd ? item : { ...item, cwd: next.homeDir })),
      );
      return next;
    } catch (error) {
      setStatusError(String(error));
      return null;
    }
  }, []);

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
      const path = cwdRef.current || runtime?.homeDir || "";
      const ensured = ensureConversation(conversationsRef.current, selectedIdRef.current, path);
      setConversations(ensured.list);
      setSelectedId(ensured.id);
      setStatusText(runtime?.installed ? tRef.current.ready : tRef.current.needRuntime);
      if (runtime && !runtime.installed) setShowInstallPrompt(true);

      await add(
        listen<string>("install-log", (event) => {
          setInstallLog((log) => `${log}${event.payload}\n`);
        }),
      );
      await add(
        listen<RelayImport>("relay-import", (event) => {
          void consumeDeeplinkRef.current(event.payload);
        }),
      );
      await add(
        listen<string>("relay-import-error", (event) => {
          setImportError(event.payload);
          setView("settings");
          setSettingsPage("relay");
        }),
      );
      await add(
        listen<AcpUpdate>("acp-update", (event) => {
          handleAcpUpdateRef.current(event.payload);
        }),
      );
      await add(
        listen<string>("acp-diagnostic", (event) => {
          if (/error|fail|502|503|unavailable|denied/i.test(event.payload || "")) {
            setStatusText(event.payload);
          }
        }),
      );
      await add(
        listen<AcpTurnDone>("acp-turn-done", (event) => {
          finishTurnRef.current(event.payload.ok ? undefined : event.payload.error);
        }),
      );
      await add(
        listen("acp-exit", () => {
          if (runningRef.current) finishTurnRef.current("Grok Agent 已退出");
        }),
      );

      try {
        const queued = await invoke<RelayImport | null>("take_pending_import");
        if (queued) await consumeDeeplinkRef.current(queued);
      } catch {
        // no queued deeplink
      }
    })();

    return () => {
      alive = false;
      stops.forEach((stop) => stop());
      void invoke("stop_session");
    };
    // Boot once. Handlers stay current through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        const blank = conversationsRef.current.find((item) => item.messages.length === 0);
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

  function newConversation() {
    const blank = conversations.find((item) => item.messages.length === 0);
    if (blank) {
      setSelectedId(blank.id);
      setView("chat");
      return;
    }
    const created: Conversation = {
      id: uid(),
      title: t.newChat,
      cwd: cwd || homeDir,
      messages: [],
      updatedAt: Date.now(),
    };
    setConversations((list) => [created, ...list]);
    setSelectedId(created.id);
    setView("chat");
    setPrompt("");
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
      list.map((item) =>
        item.id === selectedId && item.messages.length === 0 ? { ...item, cwd: trimmed } : item,
      ),
    );
  }

  async function sendText(text: string) {
    const conversation = conversationsRef.current.find((item) => item.id === selectedIdRef.current);
    if (!text.trim() || !conversation || runningRef.current) return;
    if (!status?.installed) {
      setShowInstallPrompt(true);
      return;
    }

    setPrompt("");
    if (composerRef.current) {
      composerRef.current.style.height = "30px";
    }
    setRunning(true);
    setStatusText(t.connecting);
    followRef.current = true;

    const title =
      conversation.title === zh.newChat || conversation.title === en.newChat
        ? text.trim().slice(0, 28)
        : conversation.title;
    const user: ChatMessage = {
      id: uid(),
      role: "user",
      text: text.trim(),
      thought: "",
      events: [],
      streaming: false,
    };
    const assistant: ChatMessage = {
      id: uid(),
      role: "assistant",
      text: "",
      thought: "",
      events: [],
      streaming: true,
    };
    setConversations((list) =>
      list.map((item) =>
        item.id === conversation.id
          ? {
              ...item,
              title,
              messages: [...item.messages, user, assistant],
              updatedAt: Date.now(),
            }
          : item,
      ),
    );
    requestAnimationFrame(() => scrollToBottom(true));

    try {
      const session = await invoke<SessionInfo>("ensure_session", {
        model: modelRef.current,
        cwd: conversation.cwd || cwdRef.current,
        existingSessionId: conversation.grokSessionId ?? null,
      });
      setConversations((list) =>
        list.map((item) =>
          item.id === conversation.id
            ? { ...item, grokSessionId: session.sessionId, cwd: session.cwd }
            : item,
        ),
      );
      setStatusText(t.running);
      await invoke("send_prompt", { text: text.trim() });
    } catch (error) {
      finishTurn(String(error));
    }
  }

  async function send() {
    await sendText(prompt);
  }

  async function stopTurn() {
    try {
      await invoke("cancel_turn");
    } catch {
      // ignore
    }
    finishTurn();
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
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") messages.pop();
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

  const osLabel =
    status?.os === "windows" ? "Windows" : status?.os === "macos" ? "macOS" : status?.os === "linux" ? "Linux" : "";

  const settingsItems: Array<{ id: SettingsPage; title: string; icon: ReactNode }> = [
    { id: "general", title: t.general, icon: <IconGear /> },
    { id: "runtime", title: t.runtime, icon: <IconTerminal /> },
    { id: "relay", title: t.relay, icon: <IconRelay /> },
  ];
  const visibleSettings = settingsItems.filter((item) =>
    item.title.toLowerCase().includes(settingsQuery.trim().toLowerCase()),
  );

  if (view === "settings") {
    return (
      <div className="app settings-app">
        <aside className="sidebar settings-nav" style={{ width: sidebarWidth }}>
          <button className="back-row" type="button" onClick={() => setView("chat")}>
            <IconChevronLeft />
            <span>{t.back}</span>
          </button>
          <input
            className="settings-search"
            value={settingsQuery}
            placeholder={t.searchSettings}
            onChange={(event) => setSettingsQuery(event.target.value)}
          />
          <div className="section-label">{t.settings}</div>
          {visibleSettings.map((item) => (
            <button
              key={item.id}
              className={settingsPage === item.id ? "nav-item on" : "nav-item"}
              type="button"
              onClick={() => setSettingsPage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.title}
            </button>
          ))}
        </aside>
        <div className="resize" onPointerDown={beginResize} />
        <main className="settings-main">
          <div className="settings-canvas">
            <h1>
              {settingsPage === "general" ? t.general : settingsPage === "runtime" ? t.runtime : t.relay}
            </h1>
            {settingsPage === "general" && (
              <>
                <section className="group">
                  <SettingsRow title={t.appearance} detail={t.appearanceDetail}>
                    <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
                      <option value="system">{t.followSystem}</option>
                      <option value="light">{t.light}</option>
                      <option value="dark">{t.dark}</option>
                    </select>
                  </SettingsRow>
                  <SettingsRow title={t.language} detail={t.languageDetail}>
                    <select value={lang} onChange={(event) => setLang(event.target.value as Lang)}>
                      <option value="zh">简体中文</option>
                      <option value="en">English</option>
                    </select>
                  </SettingsRow>
                </section>
                <section className="group">
                  <SettingsRow title={t.model} detail={t.modelDetail}>
                    <select value={model} onChange={(event) => setModel(event.target.value)}>
                      {MODELS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                  <SettingsRow title={t.workspace} detail={t.workspaceDetail}>
                    <input
                      value={cwd}
                      spellCheck={false}
                      onChange={(event) => applyCwd(event.target.value)}
                    />
                  </SettingsRow>
                </section>
              </>
            )}
            {settingsPage === "runtime" && (
              <>
                <section className="group">
                  <SettingsRow
                    title="Grok Build"
                    detail={status?.installed ? t.installed : t.missing}
                  >
                    <span className={status?.installed ? "pill ok" : "pill warn"}>
                      {status?.installed ? t.installed : t.missing}
                    </span>
                  </SettingsRow>
                  <SettingsRow title={t.path} detail={status?.path || "—"} />
                  <SettingsRow title={t.version} detail={status?.version || "—"} />
                  <SettingsRow title={t.dataDir} detail={status?.grokHome || "—"} />
                </section>
                <p className="hint left">{status?.os === "windows" ? t.windowsHint : t.unixHint}</p>
                {installLog ? <pre className="log">{installLog}</pre> : null}
                {installError || statusError ? (
                  <p className="error">{installError || statusError}</p>
                ) : null}
                <div className="actions">
                  {!status?.installed ? (
                    <button className="primary" type="button" disabled={installing} onClick={() => void installOfficial()}>
                      {installing ? t.installing : t.install}
                    </button>
                  ) : null}
                  <button className="ghost" type="button" disabled={installing} onClick={() => void refresh()}>
                    {t.redetect}
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => void openUrl("https://docs.x.ai/docs/overview")}
                  >
                    {t.official}
                  </button>
                </div>
              </>
            )}
            {settingsPage === "relay" && (
              <>
                <p className="lede">{t.relayHint}</p>
                <section className="group stacked">
                  <label>
                    {t.endpoint}
                    <input
                      value={form.endpoint}
                      spellCheck={false}
                      placeholder="https://api.xiaohaweb.com/v1"
                      onChange={(event) => setForm({ ...form, endpoint: event.target.value })}
                    />
                  </label>
                  <label>
                    {t.apiKey}
                    <input
                      type="password"
                      value={form.apiKey}
                      spellCheck={false}
                      placeholder="sk-..."
                      onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                    />
                  </label>
                  <div className="two">
                    <label>
                      {t.model}
                      <input
                        value={form.model}
                        spellCheck={false}
                        onChange={(event) => setForm({ ...form, model: event.target.value })}
                      />
                    </label>
                    <label>
                      {t.name}
                      <input
                        value={form.name}
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                      />
                    </label>
                  </div>
                </section>
                {importMessage ? <p className="ok-text">{importMessage}</p> : null}
                {importError ? <p className="error">{importError}</p> : null}
                <div className="actions">
                  <button
                    className="primary"
                    type="button"
                    disabled={importing || !form.endpoint || !form.apiKey}
                    onClick={() => void applyImport(form)}
                  >
                    {importing ? t.importing : t.import}
                  </button>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      {showSidebar ? (
        <>
          <aside className="sidebar" style={{ width: sidebarWidth }}>
            <div className="brand-row">
              <img className="brand-mark" src="/app-icon.png" alt="" />
              <div className="brand-name">{t.brand}</div>
              <button
                className="icon-btn"
                type="button"
                title={t.hideSidebar}
                onClick={() => setShowSidebar(false)}
              >
                <IconSidebar />
              </button>
              <button className="icon-btn" type="button" title={t.newChat} onClick={newConversation}>
                <IconCompose />
              </button>
            </div>

            <button className="new-chat" type="button" onClick={newConversation}>
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
                      onClick={() =>
                        setCollapsed((current) => ({
                          ...current,
                          [project.path]: !current[project.path],
                        }))
                      }
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

            <div className="sidebar-foot">
              <div className="account">
                <span className={runtimeOk ? "dot on" : "dot"} />
                <div>
                  <div className="account-model">{model}</div>
                  <div className="account-name">{t.localCli}</div>
                </div>
              </div>
              <button className="icon-btn" type="button" title={t.settings} onClick={() => setView("settings")}>
                <IconGear />
              </button>
            </div>
          </aside>
          <div className="resize" onPointerDown={beginResize} />
        </>
      ) : null}

      <main className="main">
        <header className="chat-header">
          <div className="crumb">
            {!showSidebar ? (
              <button
                className="icon-btn"
                type="button"
                title={t.showSidebar}
                onClick={() => setShowSidebar(true)}
              >
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
          {running ? (
            <div className="live">
              <span className="spinner" />
              {statusText || t.running}
            </div>
          ) : osLabel ? (
            <div className="live quiet">{osLabel}</div>
          ) : null}
        </header>

        <section
          ref={transcriptRef}
          className="transcript"
          onScroll={onTranscriptScroll}
        >
          {!selected?.messages.length ? (
            <div className="empty">
              <div className="spark">
                <IconSpark />
              </div>
              <h1>{t.emptyTitle}</h1>
              <p>{projectName || t.emptyHint}</p>
            </div>
          ) : (
            <div className="messages">
              {selected.messages.map((message) => (
                <article key={message.id} className={`row ${message.role}`}>
                  <div className={message.role === "user" ? "bubble user" : "bubble assistant"}>
                    {message.thought ? (
                      <details className="thought" open={message.streaming && !message.text}>
                        <summary>{t.thinking}</summary>
                        <pre>{message.thought}</pre>
                      </details>
                    ) : null}
                    {message.events.length ? (
                      <div className="events">
                        {message.events.map((event) => (
                          <div key={event.id} className="event">
                            <span>{event.title}</span>
                            {event.status ? <span className="event-status">{event.status}</span> : null}
                            {event.detail ? <pre>{event.detail}</pre> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {message.text || message.streaming ? (
                      <MessageBody
                        text={
                          message.text || (message.streaming ? t.thinkingNow : "")
                        }
                        streaming={message.streaming && Boolean(message.text)}
                      />
                    ) : null}
                    {message.streaming && !message.text ? (
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
              <span className="hint inline">{t.sendHint}</span>
              {running ? (
                <button className="send stop" type="button" title="Stop" onClick={() => void stopTurn()}>
                  <IconStop />
                </button>
              ) : (
                <button
                  className="send"
                  type="button"
                  disabled={!canSend}
                  title={t.sendHint}
                  onClick={() => void send()}
                >
                  <IconArrowUp />
                </button>
              )}
            </div>
          </div>
        </footer>
      </main>

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
    </div>
  );
}

function SettingsRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="row-title">{title}</div>
        {detail ? <div className="row-detail">{detail}</div> : null}
      </div>
      {children ? <div className="row-control">{children}</div> : null}
    </div>
  );
}

function MessageBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = splitBlocks(text);
  return (
    <div className={streaming ? "md streaming" : "md"}>
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre key={index} className="md-code">
              <code>{block.text}</code>
            </pre>
          );
        }
        const lines = block.text.split("\n");
        const listed = lines.every((line) => !line.trim() || line.trim().startsWith("- ") || line.trim().startsWith("* "));
        if (listed && lines.some((line) => line.trim().startsWith("- ") || line.trim().startsWith("* "))) {
          return (
            <ul key={index} className="md-list">
              {lines
                .filter((line) => line.trim())
                .map((line, lineIndex) => (
                  <li key={lineIndex}>{renderInline(line.replace(/^\s*[-*]\s+/, ""))}</li>
                ))}
            </ul>
          );
        }
        return (
          <p key={index} className="md-p">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

function splitBlocks(text: string) {
  const chunks = text.split(/```/);
  return chunks.map((chunk, index) => {
    if (index % 2 === 1) {
      const next = chunk.replace(/^[^\n]*\n/, "");
      return { type: "code" as const, text: next.replace(/\n$/, "") };
    }
    return { type: "text" as const, text: chunk };
  }).filter((block) => block.text.length > 0);
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

function IconSidebar() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M9 4.5v15" />
    </svg>
  );
}
function IconCompose() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M4 20h4l10.2-10.2a2 2 0 0 0 0-2.8L16 5a2 2 0 0 0-2.8 0L3 15.2V20z" />
      <path d="M12.5 6.5l5 5" />
    </svg>
  );
}
function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3.5 8.5h6l2 2H20.5v8.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z" />
      <path d="M3.5 8.5V6.8A1.8 1.8 0 0 1 5.3 5h4.1l2 2" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3V21M4.8 7.2l1.9 1.1M17.3 15.7l1.9 1.1M4.8 16.8l1.9-1.1M17.3 8.3l1.9-1.1M3.5 12H5.7M18.3 12H21" />
    </svg>
  );
}
function IconTerminal() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M7 10l3 2-3 2M12 14h5" />
    </svg>
  );
}
function IconRelay() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M7 7h8a4 4 0 1 1 0 8h-1" />
      <path d="M17 17H9a4 4 0 1 1 0-8h1" />
      <path d="M15 5l2 2-2 2M9 15l-2 2 2 2" />
    </svg>
  );
}
function IconSpark() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3l1.4 6.1L20 10.5 13.4 12.9 12 21l-1.4-8.1L4 10.5l6.6-1.4z" />
    </svg>
  );
}
function IconChevronRight() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
function IconChevronLeft() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function IconChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function IconArrowUp() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" />
    </svg>
  );
}
function IconStop() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
      <rect x="7" y="7" width="10" height="10" rx="1.4" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
