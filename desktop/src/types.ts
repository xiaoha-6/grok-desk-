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

export type TimelineEvent = {
  id: string;
  kind: string;
  title: string;
  status?: string;
  input?: string;
  output?: string;
};

export type MessageMedia = {
  id: string;
  type: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
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
};

export type Conversation = {
  id: string;
  title: string;
  cwd: string;
  accountId?: string;
  grokSessionId?: string;
  messages: ChatMessage[];
  updatedAt: number;
  archivedAt?: number;
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
};

export type AcpTurnDone = {
  ok: boolean;
  error?: string;
};

export type PermissionOption = {
  id: string;
  name: string;
  kind: string;
};

export type PendingPermission = {
  id: string;
  title: string;
  options: PermissionOption[];
};

export type AgentQuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AgentQuestion = {
  question: string;
  options: AgentQuestionOption[];
  multiSelect: boolean;
};

export type PendingQuestion = {
  id: string;
  questions: AgentQuestion[];
  planMode: boolean;
};

export type PendingPlan = {
  id: string;
  content: string;
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
};

export type Lang = "zh" | "en";
export type Theme = "system" | "light" | "dark";
export type View = "chat" | "settings";
export type SettingsPage =
  | "general"
  | "runtime"
  | "relay"
  | "agent"
  | "compatibility"
  | "skills"
  | "accounts"
  | "archived";

export const MODELS = [
  "grok-4.5",
  "grok-4.3",
  "grok-build-0.1",
  "grok-composer-2.5-fast",
  "grok-4.20-multi-agent-0309",
];

export const EFFORTS = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
];

export const PERMISSION_MODES = [
  { id: "default", labelZh: "确认操作", labelEn: "Ask each time" },
  { id: "acceptEdits", labelZh: "接受编辑", labelEn: "Accept edits" },
  { id: "auto", labelZh: "自动执行", labelEn: "Auto" },
  { id: "plan", labelZh: "规划模式", labelEn: "Plan" },
  { id: "bypassPermissions", labelZh: "完全访问", labelEn: "Full access" },
];

export function defaultSettings(): AppSettings {
  return {
    permissionMode: "default",
    reasoningEffort: "high",
    contextWindowTokens: 225000,
    autoCompactThresholdPercent: 85,
    enableMemory: false,
    enableWebSearch: true,
    enableSubagents: true,
    maxTurns: 50,
    extraArguments: "",
    routingMode: "quota",
    preferredAccountId: null,
  };
}
