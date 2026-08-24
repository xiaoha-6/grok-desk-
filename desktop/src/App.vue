<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
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

const STORAGE_KEY = "grokdesk.workspace.v1";
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
  localCli: "本机 Grok CLI",
  emptyTitle: "今天想构建什么？",
  emptyHint: "选择一个工作目录，然后把任务交给 Grok",
  composer: "描述任务，或让 Grok 修改代码…",
  sendHint: "return 发送，⇧ return 换行",
  ready: "就绪",
  connecting: "正在连接 Grok Agent",
  running: "Grok 正在处理",
  connected: "Agent 已连接",
  thinking: "思考",
  runtime: "Grok Build",
  installed: "已安装",
  missing: "未安装",
  install: "从官方安装",
  installing: "正在安装…",
  redetect: "重新检测",
  official: "官方安装说明",
  path: "路径",
  dataDir: "数据目录",
  relay: "小哈中转站",
  relayHint: "像 CC Switch 一样，把 API 地址和密钥直接写入 ~/.grok/config.toml。写入后会回到这个桌面对话，而不是打开 CLI。",
  endpoint: "API 地址",
  apiKey: "API Key",
  model: "默认模型",
  name: "显示名称",
  import: "写入 Grok 配置",
  importing: "正在写入…",
  backup: "已备份原配置",
  back: "返回对话",
  needRuntime: "需要安装 Grok Build",
  needRuntimeBody: "GrokDesk 需要本地 Grok Build Runtime 才能运行 Agent。是否使用 xAI 官方安装器安装最新版？",
  later: "稍后",
  installLatest: "安装最新版",
  windowsHint: "Windows 官方安装命令：irm https://x.ai/cli/install.ps1 | iex",
  unixHint: "macOS / Linux 官方安装命令：curl -fsSL https://x.ai/cli/install.sh | bash",
  workspace: "工作目录",
  wrote: "已写入",
  imported: "配置已写入，可以开始对话",
};

const en = {
  brand: "GrokDesk",
  newChat: "New chat",
  projects: "Projects",
  home: "Home",
  settings: "Settings",
  localCli: "Local Grok CLI",
  emptyTitle: "What do you want to build today?",
  emptyHint: "Pick a workspace, then hand the task to Grok",
  composer: "Describe a task, or let Grok edit code…",
  sendHint: "return to send, ⇧ return for a newline",
  ready: "Ready",
  connecting: "Connecting Grok Agent",
  running: "Grok is working",
  connected: "Agent connected",
  thinking: "Thinking",
  runtime: "Grok Build",
  installed: "Installed",
  missing: "Missing",
  install: "Install from official",
  installing: "Installing…",
  redetect: "Recheck",
  official: "Official install docs",
  path: "Path",
  dataDir: "Data directory",
  relay: "Xiaoha relay",
  relayHint: "Like CC Switch: write the API base URL and key into ~/.grok/config.toml. After import, this desktop chat opens — not the CLI.",
  endpoint: "API base URL",
  apiKey: "API key",
  model: "Default model",
  name: "Display name",
  import: "Write Grok config",
  importing: "Writing…",
  backup: "Previous config backed up",
  back: "Back to chat",
  needRuntime: "Grok Build is required",
  needRuntimeBody: "GrokDesk needs the local Grok Build runtime to run the agent. Install the latest official build?",
  later: "Later",
  installLatest: "Install latest",
  windowsHint: "Windows official install: irm https://x.ai/cli/install.ps1 | iex",
  unixHint: "macOS / Linux official install: curl -fsSL https://x.ai/cli/install.sh | bash",
  workspace: "Workspace",
  wrote: "Wrote",
  imported: "Config written. You can start chatting.",
};

const lang = ref<"zh" | "en">("zh");
const t = computed(() => (lang.value === "en" ? en : zh));
const view = ref<"chat" | "settings">("chat");
const settingsTab = ref<"runtime" | "relay">("runtime");

const status = ref<RuntimeStatus | null>(null);
const statusError = ref("");
const installing = ref(false);
const installLog = ref("");
const installError = ref("");
const importing = ref(false);
const importMessage = ref("");
const importError = ref("");
const showInstallPrompt = ref(false);
const prompt = ref("");
const running = ref(false);
const statusText = ref("");
const composerEl = ref<HTMLTextAreaElement | null>(null);
const transcriptEl = ref<HTMLElement | null>(null);

const form = reactive<RelayImport>({
  endpoint: "https://api.xiaohaweb.com/v1",
  apiKey: "",
  model: "grok-4.5",
  name: "小哈AI",
});

const model = ref("grok-4.5");
const cwd = ref("");
const conversations = ref<Conversation[]>([]);
const selectedId = ref<string | null>(null);
let lastImportSig = "";

const selected = computed(
  () => conversations.value.find((item) => item.id === selectedId.value) ?? null,
);
const projectName = computed(() => workspaceLabel(selected.value?.cwd || cwd.value));
const canSend = computed(() => prompt.value.trim().length > 0 && !installing.value);
const osLabel = computed(() => {
  const os = status.value?.os;
  if (os === "windows") return "Windows";
  if (os === "macos") return "macOS";
  if (os === "linux") return "Linux";
  return os || "";
});
const runtimeOk = computed(() => Boolean(status.value?.installed));

function uid() {
  return crypto.randomUUID();
}

function workspaceLabel(path: string) {
  if (!path) return t.value.home;
  const home = status.value?.homeDir;
  const normalized = path.replace(/[\\/]+$/, "");
  if (home && normalized.replace(/\\/g, "/") === home.replace(/\\/g, "/")) {
    return t.value.home;
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || t.value.home;
}

function createConversation(path?: string): Conversation {
  return {
    id: uid(),
    title: t.value.newChat,
    cwd: path || cwd.value || status.value?.homeDir || "",
    messages: [],
    updatedAt: Date.now(),
  };
}

function ensureConversation() {
  if (conversations.value.length === 0) {
    const created = createConversation();
    conversations.value = [created];
    selectedId.value = created.id;
  } else if (!selected.value) {
    selectedId.value = conversations.value[0].id;
  }
}

function persist() {
  const payload = {
    lang: lang.value,
    model: model.value,
    cwd: cwd.value,
    selectedId: selectedId.value,
    conversations: conversations.value,
    form: { ...form, apiKey: "" },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      lang?: "zh" | "en";
      model?: string;
      cwd?: string;
      selectedId?: string | null;
      conversations?: Conversation[];
      form?: Partial<RelayImport>;
    };
    if (parsed.lang) lang.value = parsed.lang;
    if (parsed.model) model.value = parsed.model;
    if (parsed.cwd) cwd.value = parsed.cwd;
    if (parsed.form) {
      form.endpoint = parsed.form.endpoint || form.endpoint;
      form.model = parsed.form.model || form.model;
      form.name = parsed.form.name || form.name;
    }
    if (parsed.conversations?.length) {
      conversations.value = parsed.conversations.map((item) => ({
        ...item,
        messages: item.messages.map((message) => ({ ...message, streaming: false })),
      }));
      selectedId.value =
        parsed.selectedId && conversations.value.some((item) => item.id === parsed.selectedId)
          ? parsed.selectedId
          : conversations.value[0].id;
    }
  } catch {
    // ignore corrupt workspace state
  }
}

function newConversation() {
  const blank = conversations.value.find((item) => item.messages.length === 0);
  if (blank) {
    selectedId.value = blank.id;
    view.value = "chat";
    return;
  }
  const created = createConversation();
  conversations.value.unshift(created);
  selectedId.value = created.id;
  view.value = "chat";
  persist();
}

function selectConversation(id: string) {
  selectedId.value = id;
  view.value = "chat";
  persist();
}

function deleteConversation(id: string) {
  conversations.value = conversations.value.filter((item) => item.id !== id);
  if (selectedId.value === id) {
    selectedId.value = conversations.value[0]?.id ?? null;
  }
  ensureConversation();
  persist();
}

async function refresh() {
  statusError.value = "";
  try {
    status.value = await invoke<RuntimeStatus>("get_runtime_status");
    if (!cwd.value) cwd.value = status.value.homeDir;
    conversations.value.forEach((item) => {
      if (!item.cwd) item.cwd = status.value?.homeDir || item.cwd;
    });
    if (form.model) model.value = form.model;
  } catch (error) {
    statusError.value = String(error);
  }
}

async function installOfficial() {
  if (installing.value) return;
  installing.value = true;
  installError.value = "";
  installLog.value = t.value.installing + "\n";
  showInstallPrompt.value = false;
  view.value = "settings";
  settingsTab.value = "runtime";
  try {
    const path = await invoke<string>("install_runtime");
    installLog.value += (lang.value === "en" ? "Installed: " : "安装完成：") + path + "\n";
    await refresh();
  } catch (error) {
    installError.value = String(error);
    installLog.value += String(error) + "\n";
  } finally {
    installing.value = false;
  }
}

function importSig(payload: RelayImport) {
  return `${payload.endpoint}\n${payload.apiKey}\n${payload.model}\n${payload.name}`;
}

function fillForm(payload: RelayImport) {
  form.endpoint = payload.endpoint;
  form.apiKey = payload.apiKey;
  form.model = payload.model || "grok-4.5";
  form.name = payload.name || "小哈AI";
  model.value = form.model;
}

async function applyImport(payload: RelayImport) {
  importing.value = true;
  importError.value = "";
  importMessage.value = "";
  try {
    const result = await invoke<ImportResult>("import_relay", { payload });
    form.endpoint = result.endpoint;
    form.model = result.model;
    model.value = result.model;
    const backup = result.backupPath ? `\n${t.value.backup}: ${result.backupPath}` : "";
    importMessage.value = `${t.value.wrote} ${result.configPath}${backup}\n${t.value.imported}`;
    await refresh();
    view.value = "chat";
    statusText.value = t.value.imported;
    if (status.value?.installed) {
      await reconnectAgent();
    }
  } catch (error) {
    importError.value = String(error);
    view.value = "settings";
    settingsTab.value = "relay";
  } finally {
    importing.value = false;
  }
}

async function consumeDeeplink(payload: RelayImport) {
  const sig = importSig(payload);
  if (sig === lastImportSig) return;
  lastImportSig = sig;
  fillForm(payload);
  try {
    await invoke("take_pending_import");
  } catch {
    // ignore missing pending slot
  }
  await applyImport(payload);
}

async function reconnectAgent() {
  try {
    await invoke("stop_session");
  } catch {
    // no live session
  }
}

function currentAssistant(): ChatMessage | null {
  const conversation = selected.value;
  if (!conversation) return null;
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const message = conversation.messages[i];
    if (message.role === "assistant" && message.streaming) return message;
  }
  return null;
}

function upsertEvent(event: TimelineEvent) {
  const assistant = currentAssistant();
  if (!assistant) return;
  const index = assistant.events.findIndex((item) => item.id === event.id);
  if (index >= 0) assistant.events[index] = event;
  else assistant.events.push(event);
}

function handleAcpUpdate(payload: AcpUpdate) {
  const params = payload.params || {};
  const update =
    (params.update as Record<string, unknown> | undefined) ||
    (params.sessionUpdate ? params : undefined);
  if (!update) {
    if (payload.method === "session/request_permission" && payload.autoAllowed) {
      upsertEvent({
        id: `permission-${Date.now()}`,
        kind: "permission",
        title: "已自动允许操作",
        status: "approved",
      });
    }
    return;
  }
  const type = String(update.sessionUpdate || "unknown");
  const assistant = currentAssistant();
  if (!assistant) return;

  if (type === "agent_message_chunk") {
    const content = (update.content as Record<string, unknown> | undefined) || {};
    assistant.text += String(content.text ?? update.text ?? "");
  } else if (type === "agent_thought_chunk") {
    const content = (update.content as Record<string, unknown> | undefined) || {};
    assistant.thought += String(content.text ?? update.text ?? "");
  } else if (type === "tool_call" || type === "tool_call_update") {
    const id = String(update.toolCallId || update.tool_call_id || uid());
    upsertEvent({
      id: `tool-${id}`,
      kind: String(update.kind || "tool"),
      title: String(update.title || update.name || "工具调用"),
      status: String(update.status || "pending"),
    });
  } else if (type === "plan") {
    const entries = (update.entries as Array<Record<string, unknown>> | undefined) || [];
    upsertEvent({
      id: "plan",
      kind: "plan",
      title: "执行计划",
      detail: entries
        .map((entry) => `[${entry.status || "pending"}] ${entry.content || entry.text || ""}`)
        .join("\n"),
    });
  } else if (type === "session_summary_generated") {
    const conversation = selected.value;
    const title = String(update.sessionSummary || update.session_summary || "");
    if (conversation && title) conversation.title = title;
  }
  persist();
  void scrollToBottom();
}

function finishTurn(error?: string) {
  const assistant = currentAssistant();
  if (assistant) {
    assistant.streaming = false;
    if (error) assistant.error = error;
  }
  running.value = false;
  statusText.value = error || t.value.ready;
  persist();
}

async function scrollToBottom() {
  await nextTick();
  const el = transcriptEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function send() {
  const text = prompt.value.trim();
  const conversation = selected.value;
  if (!text || !conversation || running.value) return;
  if (!status.value?.installed) {
    showInstallPrompt.value = true;
    return;
  }

  prompt.value = "";
  running.value = true;
  statusText.value = t.value.connecting;
  if (conversation.title === zh.newChat || conversation.title === en.newChat) {
    conversation.title = text.slice(0, 28);
  }
  conversation.messages.push({
    id: uid(),
    role: "user",
    text,
    thought: "",
    events: [],
    streaming: false,
  });
  conversation.messages.push({
    id: uid(),
    role: "assistant",
    text: "",
    thought: "",
    events: [],
    streaming: true,
  });
  conversation.updatedAt = Date.now();
  persist();
  void scrollToBottom();

  try {
    const session = await invoke<SessionInfo>("ensure_session", {
      model: model.value,
      cwd: conversation.cwd || cwd.value,
      existingSessionId: conversation.grokSessionId ?? null,
    });
    conversation.grokSessionId = session.sessionId;
    conversation.cwd = session.cwd;
    statusText.value = t.value.running;
    await invoke("send_prompt", { text });
  } catch (error) {
    finishTurn(String(error));
  }
}

async function stopTurn() {
  try {
    await invoke("cancel_turn");
  } catch {
    // ignore
  }
  finishTurn();
}

function onComposerKey(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}

watch(cwd, (value) => {
  const conversation = selected.value;
  if (conversation && conversation.messages.length === 0) {
    conversation.cwd = value;
  }
});

watch([conversations, selectedId, model, cwd, lang], persist, { deep: true });

const stops: UnlistenFn[] = [];
onUnmounted(() => {
  stops.forEach((stop) => stop());
  void invoke("stop_session");
});

onMounted(async () => {
  restore();
  await refresh();
  ensureConversation();
  if (cwd.value) {
    conversations.value.forEach((item) => {
      if (!item.cwd) item.cwd = cwd.value;
    });
  }
  statusText.value = runtimeOk.value ? t.value.ready : t.value.needRuntime;
  if (!runtimeOk.value) showInstallPrompt.value = true;

  stops.push(
    await listen<string>("install-log", (event) => {
      installLog.value += event.payload + "\n";
    }),
  );
  stops.push(
    await listen<RelayImport>("relay-import", (event) => {
      void consumeDeeplink(event.payload);
    }),
  );
  stops.push(
    await listen<string>("relay-import-error", (event) => {
      importError.value = event.payload;
      view.value = "settings";
      settingsTab.value = "relay";
    }),
  );
  stops.push(
    await listen<AcpUpdate>("acp-update", (event) => {
      handleAcpUpdate(event.payload);
    }),
  );
  stops.push(
    await listen<string>("acp-diagnostic", (event) => {
      if (event.payload) statusText.value = event.payload;
    }),
  );
  stops.push(
    await listen<AcpTurnDone>("acp-turn-done", (event) => {
      finishTurn(event.payload.ok ? undefined : event.payload.error);
    }),
  );
  stops.push(
    await listen("acp-exit", () => {
      if (running.value) finishTurn("Grok Agent 已退出");
    }),
  );

  try {
    const queued = await invoke<RelayImport | null>("take_pending_import");
    if (queued) await consumeDeeplink(queued);
  } catch {
    // no queued deeplink
  }
});
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path
              fill="currentColor"
              d="M3 3h7.4L12 7.2 13.6 3H21l-6.2 9L21 21h-7.4L12 16.8 10.4 21H3l6.2-9z"
            />
          </svg>
        </div>
        <div class="brand-name">{{ t.brand }}</div>
        <button class="icon-btn" type="button" :title="t.newChat" @click="newConversation">
          ✎
        </button>
      </div>

      <button class="new-chat" type="button" @click="newConversation">
        <span>✎</span>
        {{ t.newChat }}
      </button>

      <div class="section-label">{{ t.projects }}</div>
      <div class="session-list">
        <button
          v-for="item in conversations"
          :key="item.id"
          class="session"
          :class="{ active: item.id === selectedId }"
          type="button"
          @click="selectConversation(item.id)"
        >
          <span class="session-title">{{ item.title }}</span>
          <span class="session-delete" title="删除" @click.stop="deleteConversation(item.id)">×</span>
        </button>
      </div>

      <div class="sidebar-foot">
        <div class="account">
          <span class="dot" :class="runtimeOk ? 'on' : 'off'" />
          <div>
            <div class="account-model">{{ model }}</div>
            <div class="account-name">{{ t.localCli }}</div>
          </div>
        </div>
        <button class="icon-btn" type="button" :title="t.settings" @click="view = 'settings'">
          ⚙
        </button>
      </div>
    </aside>

    <main v-if="view === 'chat'" class="main">
      <header class="chat-header">
        <div class="crumb">
          <span class="folder">📁</span>
          <span>{{ projectName }}</span>
          <span class="sep">›</span>
          <span class="muted">{{ selected?.title || t.newChat }}</span>
        </div>
        <div v-if="running" class="live">
          <span class="spinner" />
          {{ statusText || t.running }}
        </div>
      </header>

      <section ref="transcriptEl" class="transcript">
        <div v-if="!selected?.messages.length" class="empty">
          <div class="spark">✦</div>
          <h1>{{ t.emptyTitle }}</h1>
          <p>{{ projectName || t.emptyHint }}</p>
        </div>
        <div v-else class="messages">
          <article
            v-for="message in selected?.messages"
            :key="message.id"
            class="bubble"
            :class="message.role"
          >
            <div v-if="message.thought" class="thought">
              <div class="thought-label">{{ t.thinking }}</div>
              <pre>{{ message.thought }}</pre>
            </div>
            <div v-if="message.events.length" class="events">
              <div v-for="event in message.events" :key="event.id" class="event">
                <span class="event-title">{{ event.title }}</span>
                <span v-if="event.status" class="event-status">{{ event.status }}</span>
              </div>
            </div>
            <pre v-if="message.text" class="body">{{ message.text }}</pre>
            <p v-if="message.error" class="error">{{ message.error }}</p>
          </article>
        </div>
      </section>

      <footer class="composer-wrap">
        <div class="composer">
          <textarea
            ref="composerEl"
            v-model="prompt"
            rows="1"
            :placeholder="t.composer"
            @keydown="onComposerKey"
          />
          <div class="composer-bar">
            <button class="chip" type="button" disabled>+</button>
            <button class="chip" type="button" disabled>Auto</button>
            <span class="grow" />
            <button
              v-if="running"
              class="send stop"
              type="button"
              title="停止"
              @click="stopTurn"
            >
              ■
            </button>
            <button
              v-else
              class="send"
              type="button"
              :disabled="!canSend"
              :title="t.sendHint"
              @click="send"
            >
              ↑
            </button>
          </div>
        </div>
        <p class="hint">{{ t.sendHint }}</p>
      </footer>
    </main>

    <main v-else class="settings">
      <header class="settings-top">
        <div>
          <p class="kicker">{{ osLabel }} · Grok Build</p>
          <h1>{{ t.settings }}</h1>
        </div>
        <div class="settings-actions">
          <button class="ghost" type="button" @click="lang = lang === 'zh' ? 'en' : 'zh'">
            {{ lang === "zh" ? "EN" : "中文" }}
          </button>
          <button class="primary" type="button" @click="view = 'chat'">{{ t.back }}</button>
        </div>
      </header>

      <div class="tabs">
        <button type="button" :class="{ on: settingsTab === 'runtime' }" @click="settingsTab = 'runtime'">
          {{ t.runtime }}
        </button>
        <button type="button" :class="{ on: settingsTab === 'relay' }" @click="settingsTab = 'relay'">
          {{ t.relay }}
        </button>
      </div>

      <article v-if="settingsTab === 'runtime'" class="card">
        <div class="card-head">
          <h2>{{ t.runtime }}</h2>
          <span class="pill" :class="status?.installed ? 'ok' : 'warn'">
            {{ status?.installed ? t.installed : t.missing }}
          </span>
        </div>
        <dl class="meta">
          <div>
            <dt>{{ t.path }}</dt>
            <dd>{{ status?.path || "—" }}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{{ status?.version || "—" }}</dd>
          </div>
          <div>
            <dt>{{ t.dataDir }}</dt>
            <dd>{{ status?.grokHome || "—" }}</dd>
          </div>
          <div>
            <dt>{{ t.workspace }}</dt>
            <dd>
              <input v-model="cwd" spellcheck="false" />
            </dd>
          </div>
        </dl>
        <label>
          {{ t.model }}
          <select v-model="model">
            <option v-for="item in MODELS" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <p class="hint">{{ status?.os === "windows" ? t.windowsHint : t.unixHint }}</p>
        <pre v-if="installLog" class="log">{{ installLog }}</pre>
        <p v-if="installError || statusError" class="error">{{ installError || statusError }}</p>
        <div class="actions">
          <button
            v-if="!status?.installed"
            class="primary"
            type="button"
            :disabled="installing"
            @click="installOfficial"
          >
            {{ installing ? t.installing : t.install }}
          </button>
          <button class="ghost" type="button" :disabled="installing" @click="refresh">
            {{ t.redetect }}
          </button>
          <button class="ghost" type="button" @click="openUrl('https://docs.x.ai/build/overview')">
            {{ t.official }}
          </button>
        </div>
      </article>

      <article v-else class="card">
        <div class="card-head">
          <h2>{{ t.relay }}</h2>
        </div>
        <p class="hint">{{ t.relayHint }}</p>
        <label>
          {{ t.endpoint }}
          <input v-model="form.endpoint" spellcheck="false" placeholder="https://api.xiaohaweb.com/v1" />
        </label>
        <label>
          {{ t.apiKey }}
          <input v-model="form.apiKey" type="password" spellcheck="false" placeholder="sk-..." />
        </label>
        <div class="row">
          <label>
            {{ t.model }}
            <input v-model="form.model" spellcheck="false" />
          </label>
          <label>
            {{ t.name }}
            <input v-model="form.name" />
          </label>
        </div>
        <p v-if="importMessage" class="ok-text">{{ importMessage }}</p>
        <p v-if="importError" class="error">{{ importError }}</p>
        <div class="actions">
          <button
            class="primary"
            type="button"
            :disabled="importing || !form.endpoint || !form.apiKey"
            @click="applyImport({ ...form })"
          >
            {{ importing ? t.importing : t.import }}
          </button>
        </div>
      </article>
    </main>

    <div v-if="showInstallPrompt && !status?.installed" class="overlay">
      <div class="modal">
        <h3>{{ t.needRuntime }}</h3>
        <p>{{ t.needRuntimeBody }}</p>
        <div class="actions">
          <button class="primary" type="button" :disabled="installing" @click="installOfficial">
            {{ t.installLatest }}
          </button>
          <button class="ghost" type="button" @click="showInstallPrompt = false">{{ t.later }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
:root {
  color-scheme: dark;
  font-family: "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif;
  background: #111214;
  color: #f4f4f5;
}
* { box-sizing: border-box; }
html, body, #app { margin: 0; height: 100%; background: #111214; }
button, input, textarea, select { font: inherit; }
.app {
  height: 100%;
  display: grid;
  grid-template-columns: 268px 1fr;
}
.sidebar {
  background: #1c1c1e;
  border-right: 1px solid #2a2a2d;
  display: flex;
  flex-direction: column;
  padding: 16px 12px 12px;
}
.brand-row, .sidebar-foot, .chat-header, .settings-top, .card-head, .composer-bar, .account {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand-row { padding: 4px 6px 12px; }
.brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: #111;
  color: #f4f4f5;
}
.brand-name { font-weight: 650; letter-spacing: -0.02em; flex: 1; }
.icon-btn, .chip, .send, .new-chat, .session, .ghost, .primary, .tabs button {
  border: 0;
  cursor: pointer;
}
.icon-btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: transparent;
  color: #a1a1aa;
}
.icon-btn:hover { background: #2a2a2d; color: #fff; }
.new-chat {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: transparent;
  color: #ececef;
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 14px;
}
.new-chat:hover, .session:hover { background: #2a2a2d; }
.section-label {
  color: #71717a;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.06em;
  padding: 0 10px 8px;
}
.session-list { flex: 1; overflow: auto; }
.session {
  width: 100%;
  display: flex;
  align-items: center;
  background: transparent;
  color: #d4d4d8;
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 2px;
}
.session.active { background: rgba(255,255,255,.08); color: #fff; }
.session-title { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-delete { color: #71717a; padding: 0 4px; display: none; }
.session:hover .session-delete { display: inline; }
.sidebar-foot {
  border-top: 1px solid #2a2a2d;
  padding-top: 10px;
  justify-content: space-between;
}
.account { min-width: 0; }
.account-model { font-size: 13px; }
.account-name { font-size: 12px; color: #a1a1aa; }
.dot {
  width: 8px;
  height: 8px;
  border-radius: 99px;
  background: #52525b;
  flex-shrink: 0;
}
.dot.on { background: #22c55e; }
.dot.off { background: #f59e0b; }
.main, .settings {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #111214;
}
.chat-header, .settings-top {
  height: 52px;
  padding: 0 18px;
  justify-content: space-between;
  border-bottom: 1px solid #232326;
}
.crumb { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.sep, .muted { color: #71717a; }
.live { display: flex; align-items: center; gap: 8px; color: #a1a1aa; font-size: 12px; }
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #3f3f46;
  border-top-color: #e4e4e7;
  border-radius: 99px;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.transcript { flex: 1; overflow: auto; }
.empty {
  height: 100%;
  display: grid;
  place-content: center;
  text-align: center;
  gap: 8px;
}
.spark { font-size: 28px; color: #a1a1aa; }
.empty h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -0.03em; }
.empty p { margin: 0; color: #a1a1aa; }
.messages { max-width: 780px; margin: 0 auto; padding: 24px 20px 12px; display: grid; gap: 18px; }
.bubble pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  line-height: 1.55;
}
.bubble.user {
  background: #1c1c1e;
  border: 1px solid #2a2a2d;
  border-radius: 16px;
  padding: 12px 14px;
}
.thought {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 10px;
  color: #a1a1aa;
  font-size: 12px;
}
.thought-label { font-size: 11px; margin-bottom: 6px; color: #71717a; }
.events { display: grid; gap: 6px; margin-bottom: 10px; }
.event {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 12px;
  color: #d4d4d8;
}
.event-status { color: #a1a1aa; }
.composer-wrap { padding: 8px 20px 16px; }
.composer {
  max-width: 780px;
  margin: 0 auto;
  background: #1c1c1e;
  border: 1px solid #2e2e32;
  border-radius: 18px;
  padding: 10px 12px 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,.18);
}
.composer textarea {
  width: 100%;
  resize: none;
  min-height: 44px;
  max-height: 180px;
  background: transparent;
  color: #fafafa;
  border: 0;
  outline: none;
}
.chip {
  background: #2a2a2d;
  color: #d4d4d8;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
}
.send {
  width: 28px;
  height: 28px;
  border-radius: 99px;
  background: #f4f4f5;
  color: #111;
}
.send:disabled { background: #3f3f46; color: #71717a; cursor: not-allowed; }
.send.stop { background: #f4f4f5; font-size: 10px; }
.grow { flex: 1; }
.hint { color: #71717a; font-size: 12px; text-align: center; margin: 8px 0 0; }
.settings { padding: 22px 28px 32px; overflow: auto; }
.kicker { margin: 0 0 4px; color: #a1a1aa; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
.settings h1 { margin: 0; font-size: 24px; }
.settings-actions, .actions, .tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs { margin: 18px 0; }
.tabs button {
  background: #18181b;
  color: #a1a1aa;
  border: 1px solid #27272a;
  border-radius: 999px;
  padding: 7px 12px;
}
.tabs button.on { color: #fff; border-color: #52525b; }
.card {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 18px;
  padding: 20px;
  max-width: 720px;
}
h2, h3 { margin: 0; font-size: 18px; }
.pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; }
.pill.ok { background: #052e16; color: #86efac; }
.pill.warn { background: #3f1d0f; color: #fdba74; }
.meta { display: grid; gap: 10px; margin: 0 0 14px; }
.meta dt { color: #a1a1aa; font-size: 12px; }
.meta dd { margin: 2px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #d4d4d8; margin-top: 12px; }
input, select {
  background: #09090b;
  border: 1px solid #3f3f46;
  color: #fafafa;
  border-radius: 10px;
  padding: 10px 12px;
}
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.actions { margin-top: 16px; }
.primary, .ghost { border-radius: 10px; padding: 9px 14px; }
.primary { background: #f4f4f5; color: #111; }
.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.ghost { background: transparent; color: #e4e4e7; border: 1px solid #3f3f46; }
.log {
  background: #09090b;
  border: 1px solid #27272a;
  border-radius: 10px;
  padding: 10px;
  max-height: 140px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
}
.error { color: #fca5a5; font-size: 13px; }
.ok-text { color: #86efac; font-size: 13px; white-space: pre-wrap; }
.overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.55);
  display: grid; place-items: center; padding: 24px;
}
.modal {
  width: min(520px, 100%);
  background: #18181b;
  border: 1px solid #3f3f46;
  border-radius: 16px;
  padding: 22px;
}
@media (max-width: 860px) {
  .app { grid-template-columns: 1fr; }
  .sidebar { display: none; }
  .row { grid-template-columns: 1fr; }
}
</style>
