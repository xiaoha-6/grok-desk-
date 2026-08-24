<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
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

const zh = {
  title: "GrokDesk",
  subtitle: "检测官方 Grok Build，并把小哈中转站写进 Grok 配置。",
  runtime: "Grok Build",
  installed: "已安装",
  missing: "未安装",
  install: "从官方安装",
  installing: "正在安装…",
  redetect: "重新检测",
  launch: "打开 Grok",
  official: "官方安装说明",
  path: "路径",
  home: "数据目录",
  relay: "小哈中转站",
  relayHint: "像 CC Switch 一样，把 API 地址和密钥直接写入 ~/.grok/config.toml。",
  endpoint: "API 地址",
  apiKey: "API Key",
  model: "默认模型",
  name: "显示名称",
  import: "写入 Grok 配置",
  importing: "正在写入…",
  pendingTitle: "从网页导入配置",
  pendingBody: "小哈密钥页发来了一条导入请求。确认后会备份现有 config.toml，再写入中转站配置。",
  apply: "确认导入",
  cancel: "取消",
  backup: "已备份原配置",
  windowsHint: "Windows 官方安装命令：irm https://x.ai/cli/install.ps1 | iex",
  unixHint: "macOS / Linux 官方安装命令：curl -fsSL https://x.ai/cli/install.sh | bash",
  afterImport: "导入完成后，在终端运行 grok inspect，再用 /model 选择 grok-4.5。",
};

const en = {
  title: "GrokDesk",
  subtitle: "Detect official Grok Build, then write the Xiaoha relay into Grok’s config.",
  runtime: "Grok Build",
  installed: "Installed",
  missing: "Not installed",
  install: "Install from official",
  installing: "Installing…",
  redetect: "Recheck",
  launch: "Open Grok",
  official: "Official install docs",
  path: "Path",
  home: "Data directory",
  relay: "Xiaoha relay",
  relayHint: "Like CC Switch: write the API base URL and key into ~/.grok/config.toml.",
  endpoint: "API base URL",
  apiKey: "API key",
  model: "Default model",
  name: "Display name",
  import: "Write Grok config",
  importing: "Writing…",
  pendingTitle: "Import from website",
  pendingBody: "The Xiaoha keys page sent an import request. Confirming backs up config.toml, then writes the relay.",
  apply: "Import",
  cancel: "Cancel",
  backup: "Previous config backed up",
  windowsHint: "Windows official install: irm https://x.ai/cli/install.ps1 | iex",
  unixHint: "macOS / Linux official install: curl -fsSL https://x.ai/cli/install.sh | bash",
  afterImport: "After import, run grok inspect, then /model grok-4.5.",
};

const lang = ref<"zh" | "en">("zh");
const t = computed(() => (lang.value === "en" ? en : zh));

const status = ref<RuntimeStatus | null>(null);
const statusError = ref("");
const installing = ref(false);
const installLog = ref("");
const installError = ref("");
const importing = ref(false);
const importMessage = ref("");
const importError = ref("");
const pending = ref<RelayImport | null>(null);

const form = reactive<RelayImport>({
  endpoint: "https://api.xiaohaweb.com/v1",
  apiKey: "",
  model: "grok-4.5",
  name: "小哈AI",
});

const osLabel = computed(() => {
  const os = status.value?.os;
  if (os === "windows") return "Windows";
  if (os === "macos") return "macOS";
  if (os === "linux") return "Linux";
  return os || "";
});

async function refresh() {
  statusError.value = "";
  try {
    status.value = await invoke<RuntimeStatus>("get_runtime_status");
  } catch (error) {
    statusError.value = String(error);
  }
}

async function installOfficial() {
  if (installing.value) return;
  installing.value = true;
  installError.value = "";
  installLog.value = t.value.installing + "\n";
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

async function launch() {
  try {
    await invoke("open_grok");
  } catch (error) {
    installError.value = String(error);
  }
}

async function applyImport(payload: RelayImport) {
  importing.value = true;
  importError.value = "";
  importMessage.value = "";
  try {
    const result = await invoke<ImportResult>("import_relay", { payload });
    form.endpoint = result.endpoint;
    form.model = result.model;
    const backup = result.backupPath
      ? `\n${t.value.backup}: ${result.backupPath}`
      : "";
    importMessage.value =
      (lang.value === "en"
        ? `Wrote ${result.configPath}`
        : `已写入 ${result.configPath}`) + backup;
    pending.value = null;
    await refresh();
  } catch (error) {
    importError.value = String(error);
  } finally {
    importing.value = false;
  }
}

function fillPending(payload: RelayImport) {
  pending.value = payload;
  form.endpoint = payload.endpoint;
  form.apiKey = payload.apiKey;
  form.model = payload.model || "grok-4.5";
  form.name = payload.name || "小哈AI";
}

onMounted(async () => {
  await refresh();
  const stops: UnlistenFn[] = [];
  stops.push(
    await listen<string>("install-log", (event) => {
      installLog.value += event.payload + "\n";
    })
  );
  stops.push(
    await listen<RelayImport>("relay-import", (event) => {
      fillPending(event.payload);
    })
  );
  stops.push(
    await listen<string>("relay-import-error", (event) => {
      importError.value = event.payload;
    })
  );
  onUnmounted(() => {
    stops.forEach((stop) => stop());
  });
});
</script>

<template>
  <div class="shell">
    <header class="top">
      <div>
        <p class="kicker">{{ osLabel }} · Grok Build</p>
        <h1>{{ t.title }}</h1>
        <p class="sub">{{ t.subtitle }}</p>
      </div>
      <button class="ghost" type="button" @click="lang = lang === 'zh' ? 'en' : 'zh'">
        {{ lang === "zh" ? "EN" : "中文" }}
      </button>
    </header>

    <section class="grid">
      <article class="card">
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
            <dt>{{ t.home }}</dt>
            <dd>{{ status?.grokHome || "—" }}</dd>
          </div>
        </dl>
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
          <button v-else class="primary" type="button" @click="launch">{{ t.launch }}</button>
          <button class="ghost" type="button" :disabled="installing" @click="refresh">
            {{ t.redetect }}
          </button>
          <button
            class="ghost"
            type="button"
            @click="openUrl('https://docs.x.ai/build/overview')"
          >
            {{ t.official }}
          </button>
        </div>
      </article>

      <article class="card">
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
        <p class="hint">{{ t.afterImport }}</p>
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
    </section>

    <div v-if="pending" class="overlay">
      <div class="modal">
        <h3>{{ t.pendingTitle }}</h3>
        <p>{{ t.pendingBody }}</p>
        <dl class="meta">
          <div>
            <dt>{{ t.endpoint }}</dt>
            <dd>{{ pending.endpoint }}</dd>
          </div>
          <div>
            <dt>{{ t.model }}</dt>
            <dd>{{ pending.model }}</dd>
          </div>
          <div>
            <dt>{{ t.name }}</dt>
            <dd>{{ pending.name }}</dd>
          </div>
        </dl>
        <div class="actions">
          <button class="primary" type="button" :disabled="importing" @click="applyImport(pending)">
            {{ t.apply }}
          </button>
          <button class="ghost" type="button" @click="pending = null">{{ t.cancel }}</button>
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
html, body, #app { margin: 0; min-height: 100%; background: #111214; }
button, input { font: inherit; }
.shell { padding: 28px 32px 40px; max-width: 1120px; margin: 0 auto; }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 28px; }
.kicker { margin: 0 0 6px; color: #a1a1aa; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { margin: 0; font-size: 28px; letter-spacing: -0.03em; }
.sub { margin: 8px 0 0; color: #a1a1aa; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.card {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 18px;
  padding: 20px;
  min-height: 420px;
}
.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
h2, h3 { margin: 0; font-size: 18px; }
.pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; }
.pill.ok { background: #052e16; color: #86efac; }
.pill.warn { background: #3f1d0f; color: #fdba74; }
.meta { display: grid; gap: 10px; margin: 0 0 14px; }
.meta dt { color: #a1a1aa; font-size: 12px; }
.meta dd { margin: 2px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
.hint { color: #a1a1aa; font-size: 13px; line-height: 1.5; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #d4d4d8; margin-top: 12px; }
input {
  background: #09090b;
  border: 1px solid #3f3f46;
  color: #fafafa;
  border-radius: 10px;
  padding: 10px 12px;
}
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.primary, .ghost {
  border-radius: 10px;
  padding: 9px 14px;
  cursor: pointer;
}
.primary { background: #f4f4f5; color: #111; border: 0; }
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
  .grid, .row { grid-template-columns: 1fr; }
  .card { min-height: 0; }
}
</style>
