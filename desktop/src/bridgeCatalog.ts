import type { BridgeChannel, BridgeKind, BridgesConfig, Lang } from "./types";
import { defaultBridgeChannel } from "./types";

export type BridgeField = "token" | "app" | "webhook" | "target" | "domain" | "from" | "verify" | "encrypt";

export type BridgeMeta = {
  id: BridgeKind;
  group: "core" | "work" | "more";
  fields: BridgeField[];
  name: { zh: string; hant: string; en: string };
  hint: { zh: string; hant: string; en: string };
  targetHint: { zh: string; hant: string; en: string };
};

export const BRIDGE_CATALOG: BridgeMeta[] = [
  {
    id: "telegram",
    group: "core",
    fields: ["token", "target"],
    name: { zh: "Telegram", hant: "Telegram", en: "Telegram" },
    hint: { zh: "BotFather 的 Token + chat_id。入站用 getUpdates 轮询。", hant: "BotFather 的 Token + chat_id。入站用 getUpdates 輪詢。", en: "BotFather token + chat_id. Inbound polls getUpdates." },
    targetHint: { zh: "chat_id，例如 123456789 或 -100…", hant: "chat_id，例如 123456789 或 -100…", en: "chat_id, e.g. 123456789 or -100…" },
  },
  {
    id: "discord",
    group: "core",
    fields: ["token", "target", "webhook"],
    name: { zh: "Discord", hant: "Discord", en: "Discord" },
    hint: { zh: "Bot Token + 频道 ID，或只用 Webhook。入站轮询该频道。", hant: "Bot Token + 頻道 ID，或只用 Webhook。入站輪詢該頻道。", en: "Bot token + channel ID, or a webhook. Inbound polls the channel." },
    targetHint: { zh: "频道 Channel ID", hant: "頻道 Channel ID", en: "Channel ID" },
  },
  {
    id: "slack",
    group: "core",
    fields: ["token", "target", "webhook"],
    name: { zh: "Slack", hant: "Slack", en: "Slack" },
    hint: { zh: "xoxb Bot Token + 频道 ID，或 Incoming Webhook。", hant: "xoxb Bot Token + 頻道 ID，或 Incoming Webhook。", en: "xoxb bot token + channel ID, or an incoming webhook." },
    targetHint: { zh: "频道 ID，例如 C01234567", hant: "頻道 ID，例如 C01234567", en: "Channel ID, e.g. C01234567" },
  },
  {
    id: "whatsapp",
    group: "core",
    fields: ["token", "app", "target", "verify"],
    name: { zh: "WhatsApp", hant: "WhatsApp", en: "WhatsApp" },
    hint: { zh: "Cloud API：Access Token + Phone Number ID + 对方号码。入站 webhook 要填 Verification Token，Meta 会 GET hub.challenge。", hant: "Cloud API：Access Token + Phone Number ID + 對方號碼。入站 webhook 要填 Verification Token，Meta 會 GET hub.challenge。", en: "Cloud API: access token, phone-number ID, destination. Inbound webhook needs a verification token for Meta's GET hub.challenge." },
    targetHint: { zh: "对方手机号，E.164，例如 +15551234567", hant: "對方手機號，E.164，例如 +15551234567", en: "Destination number in E.164, e.g. +15551234567" },
  },
  {
    id: "feishu",
    group: "core",
    fields: ["app", "domain", "target", "webhook", "verify", "encrypt"],
    name: { zh: "飞书", hant: "飛書", en: "Feishu" },
    hint: { zh: "默认走开放平台长连接，不用公网 URL。也可填自定义机器人 Webhook 只往外推。", hant: "預設走開放平台長連線，不用公網 URL。也可填自訂機器人 Webhook 只往外推。", en: "Default: open-platform long connection, no public URL. A custom-bot webhook is outbound-only." },
    targetHint: { zh: "chat_id（oc_…）或 open_id（ou_…）", hant: "chat_id（oc_…）或 open_id（ou_…）", en: "chat_id (oc_…) or open_id (ou_…)" },
  },
  {
    id: "qq",
    group: "core",
    fields: ["app", "target", "webhook"],
    name: { zh: "QQ 机器人", hant: "QQ 機器人", en: "QQ Bot" },
    hint: { zh: "QQ 开放平台 App ID / Secret。目标写成 user: 或 group:。", hant: "QQ 開放平台 App ID / Secret。目標寫成 user: 或 group:。", en: "QQ Open Platform App ID / Secret. Target as user: or group:." },
    targetHint: { zh: "group:群openid 或 user:用户openid", hant: "group:群openid 或 user:用戶openid", en: "group:openid or user:openid" },
  },
  {
    id: "wechat",
    group: "core",
    fields: ["webhook"],
    name: { zh: "微信", hant: "微信", en: "WeChat" },
    hint: { zh: "走企业微信 / 微信插件 Webhook。个人微信没有官方开放接口。", hant: "走企業微信 / 微信外掛 Webhook。個人微信沒有官方開放介面。", en: "Uses a WeCom / WeChat-plugin webhook. Personal WeChat has no official bot API." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "wecom",
    group: "core",
    fields: ["webhook"],
    name: { zh: "企业微信", hant: "企業微信", en: "WeCom" },
    hint: { zh: "群机器人 Webhook。和小龙虾 WeCom 插件同一条路。", hant: "群機器人 Webhook。和小龍蝦 WeCom 外掛同一條路。", en: "Group-robot webhook, same path as the OpenClaw WeCom plugin." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "dingtalk",
    group: "work",
    fields: ["webhook"],
    name: { zh: "钉钉", hant: "釘釘", en: "DingTalk" },
    hint: { zh: "自定义机器人 Webhook。", hant: "自訂機器人 Webhook。", en: "Custom robot webhook." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "line",
    group: "work",
    fields: ["token", "target"],
    name: { zh: "LINE", hant: "LINE", en: "LINE" },
    hint: { zh: "Messaging API Channel Access Token + 用户/群 ID。", hant: "Messaging API Channel Access Token + 用戶/群 ID。", en: "Messaging API channel access token + user/group ID." },
    targetHint: { zh: "userId 或 groupId", hant: "userId 或 groupId", en: "userId or groupId" },
  },
  {
    id: "zalo",
    group: "work",
    fields: ["token", "target", "webhook"],
    name: { zh: "Zalo", hant: "Zalo", en: "Zalo" },
    hint: { zh: "OA Access Token + 用户 ID，或 Webhook。", hant: "OA Access Token + 用戶 ID，或 Webhook。", en: "OA access token + user ID, or a webhook." },
    targetHint: { zh: "Zalo user_id", hant: "Zalo user_id", en: "Zalo user_id" },
  },
  {
    id: "googlechat",
    group: "work",
    fields: ["webhook"],
    name: { zh: "Google Chat", hant: "Google Chat", en: "Google Chat" },
    hint: { zh: "Spaces Incoming Webhook。", hant: "Spaces Incoming Webhook。", en: "Spaces incoming webhook." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "msteams",
    group: "work",
    fields: ["webhook"],
    name: { zh: "Microsoft Teams", hant: "Microsoft Teams", en: "Microsoft Teams" },
    hint: { zh: "Incoming Webhook 连接器地址。", hant: "Incoming Webhook 連接器地址。", en: "Incoming webhook connector URL." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "mattermost",
    group: "work",
    fields: ["webhook"],
    name: { zh: "Mattermost", hant: "Mattermost", en: "Mattermost" },
    hint: { zh: "Incoming Webhook。", hant: "Incoming Webhook。", en: "Incoming webhook." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "matrix",
    group: "more",
    fields: ["token", "domain", "target"],
    name: { zh: "Matrix", hant: "Matrix", en: "Matrix" },
    hint: { zh: "Homeserver + Access Token + Room ID。", hant: "Homeserver + Access Token + Room ID。", en: "Homeserver + access token + room ID." },
    targetHint: { zh: "房间 !room:server", hant: "房間 !room:server", en: "Room !room:server" },
  },
  {
    id: "sms",
    group: "more",
    fields: ["app", "token", "from", "target"],
    name: { zh: "SMS (Twilio)", hant: "SMS (Twilio)", en: "SMS (Twilio)" },
    hint: { zh: "Account SID + Auth Token + 发送号码 + 接收号码。", hant: "Account SID + Auth Token + 發送號碼 + 接收號碼。", en: "Account SID, auth token, from number, and to number." },
    targetHint: { zh: "接收号码", hant: "接收號碼", en: "Destination number" },
  },
  {
    id: "synology",
    group: "more",
    fields: ["webhook"],
    name: { zh: "Synology Chat", hant: "Synology Chat", en: "Synology Chat" },
    hint: { zh: "DSM Chat Incoming Webhook。", hant: "DSM Chat Incoming Webhook。", en: "DSM Chat incoming webhook." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "signal",
    group: "more",
    fields: ["webhook", "target"],
    name: { zh: "Signal", hant: "Signal", en: "Signal" },
    hint: { zh: "本机不跑扫码登录。先自己起 signal-cli HTTP 桥，把入口填到 Webhook，再用「检测桥」。", hant: "本機不跑掃碼登入。先自己起 signal-cli HTTP 橋，把入口填到 Webhook，再用「檢測橋」。", en: "No QR login here. Run a local signal-cli HTTP bridge, paste it as Webhook, then Probe." },
    targetHint: { zh: "对方号码", hant: "對方號碼", en: "Peer number" },
  },
  {
    id: "imessage",
    group: "more",
    fields: ["webhook", "target"],
    name: { zh: "iMessage", hant: "iMessage", en: "iMessage" },
    hint: { zh: "本机不跑 iMessage 登录。先自己起 imsg / HTTP 桥，把入口填到 Webhook，再用「检测桥」。", hant: "本機不跑 iMessage 登入。先自己起 imsg / HTTP 橋，把入口填到 Webhook，再用「檢測橋」。", en: "No iMessage login here. Run a local imsg / HTTP bridge, paste it as Webhook, then Probe." },
    targetHint: { zh: "对方号码或 iCloud 账号", hant: "對方號碼或 iCloud 帳號", en: "Peer number or iCloud account" },
  },
  {
    id: "irc",
    group: "more",
    fields: ["webhook", "target"],
    name: { zh: "IRC", hant: "IRC", en: "IRC" },
    hint: { zh: "经 HTTP 桥接到 IRC bouncer / 网关。", hant: "經 HTTP 橋接到 IRC bouncer / 閘道。", en: "HTTP bridge into an IRC bouncer / gateway." },
    targetHint: { zh: "频道，例如 #openclaw", hant: "頻道，例如 #openclaw", en: "Channel, e.g. #openclaw" },
  },
  {
    id: "nostr",
    group: "more",
    fields: ["webhook", "target"],
    name: { zh: "Nostr", hant: "Nostr", en: "Nostr" },
    hint: { zh: "经 HTTP 桥发送 NIP-04 私信。", hant: "經 HTTP 橋發送 NIP-04 私信。", en: "HTTP bridge for NIP-04 DMs." },
    targetHint: { zh: "对方公钥", hant: "對方公鑰", en: "Peer pubkey" },
  },
  {
    id: "nextcloud",
    group: "work",
    fields: ["webhook"],
    name: { zh: "Nextcloud Talk", hant: "Nextcloud Talk", en: "Nextcloud Talk" },
    hint: { zh: "Talk Incoming Webhook / Webhook 机器人。", hant: "Talk Incoming Webhook / Webhook 機器人。", en: "Talk incoming webhook / webhook bot." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "twitch",
    group: "more",
    fields: ["token", "target", "webhook"],
    name: { zh: "Twitch", hant: "Twitch", en: "Twitch" },
    hint: { zh: "填 HTTP 桥 Webhook，或 Bot Token + 频道名由桥转发。本机不跑 Twitch IRC。", hant: "填 HTTP 橋 Webhook，或 Bot Token + 頻道名由橋轉發。本機不跑 Twitch IRC。", en: "Use an HTTP bridge webhook, or token + channel for the bridge. No local Twitch IRC." },
    targetHint: { zh: "频道名，例如 #mychannel", hant: "頻道名，例如 #mychannel", en: "Channel name, e.g. #mychannel" },
  },
  {
    id: "tlon",
    group: "more",
    fields: ["webhook", "target"],
    name: { zh: "Tlon / Urbit", hant: "Tlon / Urbit", en: "Tlon / Urbit" },
    hint: { zh: "经 HTTP 桥接到 Urbit / Tlon。", hant: "經 HTTP 橋接到 Urbit / Tlon。", en: "HTTP bridge into Urbit / Tlon." },
    targetHint: { zh: "ship / 频道", hant: "ship / 頻道", en: "ship / channel" },
  },
  {
    id: "yuanbao",
    group: "more",
    fields: ["webhook"],
    name: { zh: "元宝", hant: "元寶", en: "Yuanbao" },
    hint: { zh: "外部元宝插件的 HTTP 入口。", hant: "外部元寶外掛的 HTTP 入口。", en: "HTTP endpoint from the external Yuanbao plugin." },
    targetHint: { zh: "可选", hant: "可選", en: "Optional" },
  },
  {
    id: "buzz",
    group: "more",
    fields: ["webhook", "target"],
    name: { zh: "Buzz", hant: "Buzz", en: "Buzz" },
    hint: { zh: "Buzz 房间的 HTTP 桥。", hant: "Buzz 房間的 HTTP 橋。", en: "HTTP bridge into a Buzz room." },
    targetHint: { zh: "房间 ID", hant: "房間 ID", en: "Room ID" },
  },
];

export function bridgeMeta(id: string) {
  return BRIDGE_CATALOG.find((item) => item.id === id);
}

export function bridgeLabel(id: string, lang: Lang) {
  const item = bridgeMeta(id);
  if (!item) return id;
  if (lang === "en") return item.name.en;
  if (lang === "zh-Hant") return item.name.hant;
  return item.name.zh;
}

export function defaultBridgesConfig(): BridgesConfig {
  const channels: Record<string, BridgeChannel> = {};
  for (const item of BRIDGE_CATALOG) {
    channels[item.id] = defaultBridgeChannel();
  }
  return { enabled: false, channels };
}

export function mergeBridgesConfig(raw?: Partial<BridgesConfig> & Record<string, unknown>): BridgesConfig {
  const next = defaultBridgesConfig();
  if (!raw || typeof raw !== "object") return next;
  next.enabled = Boolean(raw.enabled);
  const bag = (raw.channels && typeof raw.channels === "object" ? raw.channels : {}) as Record<string, Partial<BridgeChannel>>;
  for (const id of ["discord", "feishu", "qq", "wechat"] as const) {
    const legacy = raw[id];
    if (legacy && typeof legacy === "object") bag[id] = { ...bag[id], ...(legacy as Partial<BridgeChannel>) };
  }
  for (const [id, value] of Object.entries(bag)) {
    const channel = { ...defaultBridgeChannel(), ...(value || {}) };
    if (channel.dmPolicy === "allowlist" && !String(channel.allowFrom || "").trim()) {
      channel.dmPolicy = "pairing";
    }
    next.channels[id] = channel;
  }
  return next;
}

export function bridgeSessionMeta(id: string, conversation?: { bridgeKind?: string; bridgeTarget?: string } | null) {
  if (conversation?.bridgeKind) {
    return { kind: conversation.bridgeKind, target: conversation.bridgeTarget || "" };
  }
  if (!id.startsWith("bridge-") || id.startsWith("bridge-pending")) {
    return {};
  }
  const rest = id.slice("bridge-".length);
  const kind = BRIDGE_CATALOG.map((item) => item.id)
    .sort((left, right) => right.length - left.length)
    .find((item) => rest === item || rest.startsWith(`${item}-`));
  if (!kind) return {};
  return { kind, target: rest.slice(kind.length + (rest.length > kind.length ? 1 : 0)) };
}
