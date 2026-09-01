import type { Lang } from "./i18n";

export type { Lang };

export type RuntimeStatus = {
  installed: boolean;
  path: string | null;
  version: string | null;
  grokHome: string;
  configPath: string;
  configExists: boolean;
  homeDir: string;
  os: string;
  installerUrl: string;
  credentialsReady: boolean;
};

export type RelayImport = {
  endpoint: string;
  apiKey: string;
  model: string;
  name: string;
};

export type ImportResult = {
  configPath: string;
  backupPath: string | null;
  model: string;
  endpoint: string;
};

export type SessionInfo = {
  sessionId: string;
  model: string;
  cwd: string;
};

export type DiffLine = {
  kind: "eq" | "del" | "add" | "collapse";
  text: string;
};

export type TokenSpan = {
  kind: "eq" | "del" | "add";
  text: string;
};

export type AnnotatedDiffLine = {
  kind: "eq" | "del" | "add" | "collapse";
  text: string;
  oldNo?: number;
  newNo?: number;
  tokens?: TokenSpan[];
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

export type GrepHit = {
  path: string;
  line: number;
  text: string;
};

export type ProjectRules = {
  path: string;
  content: string;
};

export type GitFile = {
  path: string;
  status: string;
  staged?: boolean;
};

export type GitRemote = {
  name: string;
  url: string;
};

export type GitStatus = {
  available: boolean;
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  files: GitFile[];
  remotes?: GitRemote[];
  message: string;
};

export type GitCommit = {
  hash: string;
  short: string;
  parents: string[];
  subject: string;
  author: string;
  relTime: string;
  refs: string;
};

export type GitReview = {
  base: string;
  files: string[];
  diff: string;
};

export type GithubRepo = {
  name: string;
  url: string;
};

export type GithubIdentity = {
  login: string;
  name: string;
  source: string;
  repos: GithubRepo[];
};

export type SnapshotFile = {
  path: string;
  content: string | null;
};

export type FileDiff = {
  path?: string;
  oldText: string;
  newText: string;
};

export type TimelineEvent = {
  id: string;
  kind: string;
  title: string;
  status?: string;
  input?: string;
  output?: string;
  diffs?: FileDiff[];
};

export type RelayQuota = {
  configured: boolean;
  name: string;
  endpoint: string;
  remaining?: number | null;
  used?: number | null;
  total?: number | null;
  unit?: string | null;
  planName?: string | null;
  error?: string | null;
  errorKind?: string | null;
};

export type RelayUsageDay = {
  date: string;
  requests: number;
  tokens: number;
};

export type RelayUsageModel = {
  model: string;
  requests: number;
  tokens: number;
};

export type RelayUsage = {
  configured: boolean;
  totalTokens?: number | null;
  todayTokens?: number | null;
  todayRequests?: number | null;
  days: RelayUsageDay[];
  models: RelayUsageModel[];
  error?: string | null;
};

export type CatalogModel = {
  id: string;
  name: string;
  contextWindow?: number | null;
};

export type ModelCatalog = {
  models: CatalogModel[];
  source: string;
  endpoint?: string | null;
};

export type PromptAttachment = {
  mimeType?: string;
  data?: string;
  name?: string;
};

export type MessageMedia = {
  id: string;
  type: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
  at?: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  thought: string;
  events: TimelineEvent[];
  media: MessageMedia[];
  streaming: boolean;
  error?: string;
  /** Waiting to be sent after the current turn. Always shown in the transcript. */
  queued?: boolean;
  /** Inserted by this app. History/session merges must never drop these bubbles. */
  local?: boolean;
  /** User stopped this turn. Keep whatever streamed so far and show a stopped marker. */
  stopped?: boolean;
  conversationId?: string;
};

export type SshTarget = {
  host: string;
  port: number;
  user: string;
  remotePath: string;
  identityFile?: string | null;
  auth: "key" | "password" | string;
  password?: string | null;
  alias?: string | null;
};

export type SshConfigHost = {
  alias: string;
  host: string;
  port: number;
  user: string;
  identityFile?: string | null;
  remotePath: string;
};

export type SshProbe = {
  ok: boolean;
  os: string;
  remotePath: string;
  grokInstalled: boolean;
  grokPath?: string | null;
  home: string;
  shell: string;
  message: string;
  entries?: WorkspaceEntry[];
  grokSetup?: boolean;
  configSynced?: boolean;
};

export type ProjectRecord = {
  id: string;
  name: string;
  cwd: string;
  ssh?: SshTarget | null;
  createdAt: number;
  updatedAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  cwd: string;
  projectId?: string;
  accountId?: string;
  grokSessionId?: string;
  sessionDir?: string;
  ssh?: SshTarget | null;
  messages: ChatMessage[];
  updatedAt: number;
  archivedAt?: number;
  historyHasMore?: boolean;
  historySkip?: number;
  bridgeKind?: string;
  bridgeTarget?: string;
};

export type LocalSessionSummary = {
  id: string;
  grokSessionId: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
};

export type LocalSessionHistory = {
  sessionId: string;
  sessionDir?: string;
  messages: { role: string; text: string; events?: TimelineEvent[] }[];
  usedTokens?: number | null;
  totalTokens?: number | null;
  compactionCount?: number | null;
  hasMore?: boolean;
};

export type QuotaSnapshot = {
  weeklyUsedPercent?: number;
  weeklyRemainingPercent?: number;
  monthlyLimit?: number;
  monthlyUsed?: number;
  monthlyRemaining?: number;
  periodEnd?: string;
  checkedAt?: number;
  error?: string;
};

export type AccountRecord = {
  id: string;
  name: string;
  homePath: string;
  enabled: boolean;
  createdAt: number;
  quota?: QuotaSnapshot | null;
  loggedIn: boolean;
};

export type AccountState = {
  accounts: AccountRecord[];
  routingMode: string;
  preferredAccountId?: string | null;
};

export type SkillRecord = {
  id: string;
  name: string;
  displayName?: string | null;
  description: string;
  shortDescription?: string | null;
  path: string;
  scope: string;
  enabled: boolean;
  userInvocable: boolean;
  whenToUse?: string | null;
  argumentHint?: string | null;
  author?: string | null;
  compatibility?: string | null;
  content: string;
};

export type ContextUsage = {
  usedTokens: number;
  totalTokens: number;
  compactionCount: number;
};

export type AcpUpdate = {
  method: string;
  params: Record<string, unknown>;
  autoAllowed?: boolean;
  conversationId?: string;
};

export type AcpTurnDone = {
  ok: boolean;
  error?: string;
  conversationId?: string;
};

export type AcpReconnect = {
  attempt: number;
  maxAttempts: number;
  error?: string;
  conversationId?: string;
};

export type PermissionOption = {
  id: string;
  name: string;
  kind: string;
};

export type PendingPermission = {
  id: string;
  title: string;
  command?: string;
  options: PermissionOption[];
  conversationId?: string;
};

export type AgentQuestionOption = {
  id?: string;
  label: string;
  description: string;
  preview?: string;
};

export type AgentQuestion = {
  id?: string;
  question: string;
  options: AgentQuestionOption[];
  multiSelect: boolean;
};

export type PendingQuestion = {
  id: string;
  questions: AgentQuestion[];
  planMode: boolean;
  conversationId?: string;
  permissionOptions?: PermissionOption[];
};

export type PendingPlan = {
  id: string;
  content: string;
  conversationId?: string;
};

export type AppSettings = {
  permissionMode: string;
  reasoningEffort: string;
  contextWindowTokens: number;
  autoCompactThresholdPercent: number;
  enableMemory: boolean;
  enableWebSearch: boolean;
  enableSubagents: boolean;
  maxTurns: number;
  extraArguments: string;
  routingMode: string;
  preferredAccountId?: string | null;
  keybindings?: Record<string, string>;
  gitAutoCommit?: boolean;
  gitAutoPush?: boolean;
  gitAutoCommitMessage?: string;
};

export type BridgeKind = string;

export type BridgeDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type BridgeGroupPolicy = "open" | "allowlist" | "disabled";

export type BridgeChannel = {
  enabled: boolean;
  dmPolicy: BridgeDmPolicy;
  allowFrom: string;
  groupPolicy: BridgeGroupPolicy;
  requireMention: boolean;
  mirrorOutbound: boolean;
  acceptInbound: boolean;
  defaultTarget: string;
  token: string;
  appId: string;
  appSecret: string;
  domain: string;
  connectionMode: "websocket" | "webhook";
  verificationToken: string;
  encryptKey: string;
  webhookUrl: string;
};

export type BridgesConfig = {
  enabled: boolean;
  channels: Record<string, BridgeChannel>;
};

export type BridgeChannelStatus = {
  id: BridgeKind;
  enabled: boolean;
  running: boolean;
  error?: string;
};

export type BridgesStatus = {
  enabled: boolean;
  running: boolean;
  webhook: string;
  channels: BridgeChannelStatus[];
  pairings: BridgePairing[];
};

export type BridgeInbound = {
  kind: BridgeKind;
  sender: string;
  target: string;
  text: string;
};

export type BridgePairing = {
  kind: BridgeKind;
  sender: string;
  target: string;
  code: string;
  preview: string;
  createdAt: number;
};

export type BridgeMedia = {
  uri?: string;
  data?: string;
  mimeType?: string;
  name?: string;
};

export function defaultBridgeChannel(): BridgeChannel {
  return {
    enabled: false,
    dmPolicy: "pairing",
    allowFrom: "",
    groupPolicy: "allowlist",
    requireMention: true,
    mirrorOutbound: true,
    acceptInbound: true,
    defaultTarget: "",
    token: "",
    appId: "",
    appSecret: "",
    domain: "",
    connectionMode: "websocket",
    verificationToken: "",
    encryptKey: "",
    webhookUrl: "",
  };
}

export function defaultBridgesConfig(): BridgesConfig {
  return { enabled: false, channels: {} };
}

export type Theme = "system" | "light" | "dark";
export type View = "chat" | "settings";
export type SettingsPage =
  | "general"
  | "runtime"
  | "relay"
  | "usage"
  | "ssh"
  | "agent"
  | "compatibility"
  | "keyboard"
  | "skills"
  | "bridges"
  | "accounts"
  | "archived";

export const MODELS = [
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-build-0.1",
  "grok-composer-2.5-fast",
  "grok-4.20-multi-agent-0309",
];

export function canonicalModelId(id: string): string {
  const trimmed = String(id || "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  for (const prefix of ["grok/", "xai/", "x-ai/", "x-ai:"]) {
    if (lower.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      if (rest) return rest;
    }
  }
  return trimmed;
}

export function fallbackCatalog(): CatalogModel[] {
  return MODELS.map((id) => ({ id, name: id }));
}

export function mergeModelOptions(catalog: CatalogModel[] | undefined, current: string): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  const add = (item: CatalogModel) => {
    const raw = String(item?.id || "").trim();
    const id = canonicalModelId(raw);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rawName = String(item.name || raw).trim() || id;
    out.push({
      id,
      name: rawName === raw ? id : rawName,
      contextWindow: item.contextWindow,
    });
  };
  (catalog || []).forEach(add);
  if (current.trim()) add({ id: current.trim(), name: current.trim() });
  if (!out.length) fallbackCatalog().forEach(add);
  return out;
}

export const EFFORTS = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
];

export const PERMISSION_MODES = [
  {
    id: "bypassPermissions",
    short: "Agent",
    labelZh: "完全访问",
    labelHant: "完全存取",
    labelEn: "Agent",
    hintZh: "跳过确认，直接干活",
    hintHant: "略過確認，直接動手",
    hintEn: "Skip confirmations and just work",
  },
  {
    id: "plan",
    short: "Plan",
    labelZh: "规划模式",
    labelHant: "規劃模式",
    labelEn: "Plan",
    hintZh: "先出计划，你确认后再动手",
    hintHant: "先出計畫，你確認後再動手",
    hintEn: "Draft a plan first, then wait for approval",
  },
  {
    id: "default",
    short: "Ask",
    labelZh: "每次确认",
    labelHant: "每次確認",
    labelEn: "Ask",
    hintZh: "改文件或跑命令前都先问你",
    hintHant: "改檔案或跑命令前都先問你",
    hintEn: "Ask before file edits and shell commands",
  },
  {
    id: "auto",
    short: "Auto",
    labelZh: "自动执行",
    labelHant: "自動執行",
    labelEn: "Auto",
    hintZh: "工具调用自动执行，少打断",
    hintHant: "工具呼叫自動執行，少打斷",
    hintEn: "Run tools automatically with fewer prompts",
  },
  {
    id: "acceptEdits",
    short: "Edit",
    labelZh: "自动接受编辑",
    labelHant: "自動接受編輯",
    labelEn: "Edit",
    hintZh: "文件修改自动通过，其它操作仍会确认",
    hintHant: "檔案修改自動通過，其它操作仍會確認",
    hintEn: "Auto-approve file edits; still confirm other actions",
  },
];

export function normalizePermissionMode(mode: string | undefined | null): string {
  const value = String(mode || "").trim();
  if (!value) return "default";
  if (value === "ask" || value === "askAlways" || value === "confirm") return "default";
  if (value === "approve" || value === "accept") return "acceptEdits";
  return value;
}

export function permissionModeShort(mode: string | undefined | null) {
  const id = normalizePermissionMode(mode);
  const item = PERMISSION_MODES.find((entry) => entry.id === id) || PERMISSION_MODES[0];
  return item.short;
}

export function permissionModeLabel(mode: string | undefined | null, lang: Lang) {
  const id = normalizePermissionMode(mode);
  const item = PERMISSION_MODES.find((entry) => entry.id === id) || PERMISSION_MODES[0];
  if (lang === "en") return item.labelEn;
  if (lang === "zh-Hant") return item.labelHant;
  return item.labelZh;
}

export function permissionModeHint(mode: string | undefined | null, lang: Lang) {
  const id = normalizePermissionMode(mode);
  const item = PERMISSION_MODES.find((entry) => entry.id === id) || PERMISSION_MODES[0];
  if (lang === "en") return item.hintEn;
  if (lang === "zh-Hant") return item.hintHant;
  return item.hintZh;
}

export function defaultSettings(): AppSettings {
  return {
    permissionMode: "default",
    reasoningEffort: "high",
    contextWindowTokens: 500000,
    autoCompactThresholdPercent: 85,
    enableMemory: false,
    enableWebSearch: true,
    enableSubagents: true,
    maxTurns: 50,
    extraArguments: "",
    routingMode: "quota",
    preferredAccountId: null,
    keybindings: {},
    gitAutoCommit: false,
    gitAutoPush: false,
    gitAutoCommitMessage: "xiaoha: {title}",
  };
}
