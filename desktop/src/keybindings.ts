export type CommandId =
  | "saveFile"
  | "quickOpen"
  | "projectSearch"
  | "newChat"
  | "openSettings"
  | "toggleSidebar"
  | "toggleWorkspace"
  | "toggleTerminal"
  | "sendMessage"
  | "newLine";

export type CommandCategory = "editor" | "chat" | "navigation" | "view";

export type Keystroke = {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

export type CommandDef = {
  id: CommandId;
  category: CommandCategory;
  defaultChord: string;
};

export const COMMANDS: CommandDef[] = [
  { id: "saveFile", category: "editor", defaultChord: "mod+s" },
  { id: "quickOpen", category: "navigation", defaultChord: "mod+p" },
  { id: "projectSearch", category: "navigation", defaultChord: "mod+shift+f" },
  { id: "newChat", category: "chat", defaultChord: "mod+n" },
  { id: "sendMessage", category: "chat", defaultChord: "enter" },
  { id: "newLine", category: "chat", defaultChord: "shift+enter" },
  { id: "openSettings", category: "navigation", defaultChord: "mod+," },
  { id: "toggleSidebar", category: "view", defaultChord: "mod+b" },
  { id: "toggleWorkspace", category: "view", defaultChord: "mod+shift+e" },
  { id: "toggleTerminal", category: "view", defaultChord: "mod+j" },
];

export function isMac() {
  if (typeof navigator === "undefined") return false;
  const platform = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function parseChord(raw: string | null | undefined): Keystroke | null {
  const text = String(raw || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!text) return null;
  const mac = isMac();
  const parts = text.split("+").filter(Boolean);
  if (!parts.length) return null;
  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const part of parts) {
    if (part === "mod" || part === "cmd" || part === "meta" || part === "command" || part === "⌘") {
      if (part === "mod") {
        if (mac) meta = true;
        else ctrl = true;
      } else {
        meta = true;
      }
      continue;
    }
    if (part === "ctrl" || part === "control" || part === "⌃") {
      ctrl = true;
      continue;
    }
    if (part === "alt" || part === "option" || part === "opt" || part === "⌥") {
      alt = true;
      continue;
    }
    if (part === "shift" || part === "⇧") {
      shift = true;
      continue;
    }
    if (part === "win" || part === "super") {
      meta = true;
      continue;
    }
    key = normalizeKeyName(part);
  }
  if (!key) return null;
  return { key, meta, ctrl, alt, shift };
}

export function serializeChord(stroke: Keystroke): string {
  const mac = isMac();
  const parts: string[] = [];
  if (stroke.meta && stroke.ctrl) {
    parts.push(mac ? "cmd" : "ctrl");
    parts.push(mac ? "ctrl" : "meta");
  } else if (stroke.meta) {
    parts.push(mac ? "mod" : "meta");
  } else if (stroke.ctrl) {
    parts.push(mac ? "ctrl" : "mod");
  }
  if (stroke.alt) parts.push("alt");
  if (stroke.shift) parts.push("shift");
  parts.push(stroke.key);
  return parts.join("+");
}

export function chordFromEvent(event: KeyboardEvent): Keystroke | null {
  const key = normalizeKeyName(event.key);
  if (!key || isModifierKey(event.key)) return null;
  return {
    key,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

export function isImeEvent(event: KeyboardEvent) {
  return Boolean(event.isComposing || event.keyCode === 229 || event.key === "Process");
}

export function chordsMatch(event: KeyboardEvent, chord: string | Keystroke | null | undefined) {
  if (isImeEvent(event)) return false;
  const want = typeof chord === "string" ? parseChord(chord) : chord;
  if (!want) return false;
  const got = chordFromEvent(event);
  if (!got) return false;
  return (
    got.key === want.key &&
    got.meta === want.meta &&
    got.ctrl === want.ctrl &&
    got.alt === want.alt &&
    got.shift === want.shift
  );
}

export function resolvedChord(id: CommandId, overrides?: Record<string, string> | null) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) return String(overrides[id] || "");
  return COMMANDS.find((item) => item.id === id)?.defaultChord || "";
}

export function resolvedBindings(overrides?: Record<string, string> | null) {
  const map = {} as Record<CommandId, string>;
  for (const item of COMMANDS) {
    map[item.id] = resolvedChord(item.id, overrides);
  }
  return map;
}

export function formatChord(raw: string | Keystroke | null | undefined) {
  const stroke = typeof raw === "string" ? parseChord(raw) : raw;
  if (!stroke) return "";
  const mac = isMac();
  const parts: string[] = [];
  if (mac) {
    if (stroke.ctrl) parts.push("⌃");
    if (stroke.alt) parts.push("⌥");
    if (stroke.shift) parts.push("⇧");
    if (stroke.meta) parts.push("⌘");
  } else {
    if (stroke.ctrl) parts.push("Ctrl");
    if (stroke.alt) parts.push("Alt");
    if (stroke.shift) parts.push("Shift");
    if (stroke.meta) parts.push("Win");
  }
  parts.push(displayKey(stroke.key, mac));
  return mac ? parts.join("") : parts.join("+");
}

export function chordTokens(raw: string | Keystroke | null | undefined) {
  const stroke = typeof raw === "string" ? parseChord(raw) : raw;
  if (!stroke) return [] as string[];
  const mac = isMac();
  const parts: string[] = [];
  if (mac) {
    if (stroke.ctrl) parts.push("⌃");
    if (stroke.alt) parts.push("⌥");
    if (stroke.shift) parts.push("⇧");
    if (stroke.meta) parts.push("⌘");
  } else {
    if (stroke.ctrl) parts.push("Ctrl");
    if (stroke.alt) parts.push("Alt");
    if (stroke.shift) parts.push("Shift");
    if (stroke.meta) parts.push("Win");
  }
  parts.push(displayKey(stroke.key, mac));
  return parts;
}

export function withShortcut(label: string, chord: string | Keystroke | null | undefined) {
  const hint = formatChord(chord);
  return hint ? `${label} ${hint}` : label;
}

export function conflictFor(chord: string, id: CommandId, overrides?: Record<string, string> | null) {
  if (!chord) return null;
  const map = resolvedBindings(overrides);
  for (const item of COMMANDS) {
    if (item.id === id) continue;
    if (sameChord(map[item.id], chord)) return item.id;
  }
  return null;
}

export function sameChord(left: string, right: string) {
  const a = parseChord(left);
  const b = parseChord(right);
  if (!a || !b) return false;
  return a.key === b.key && a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
}

export function isModifiedBinding(id: CommandId, overrides?: Record<string, string> | null) {
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, id)) return false;
  const def = COMMANDS.find((item) => item.id === id)?.defaultChord || "";
  return !sameChord(String(overrides[id] || ""), def);
}

type MonacoLike = {
  KeyMod: { CtrlCmd: number; WinCtrl: number; Shift: number; Alt: number };
  KeyCode: Record<string, number> & { KeyS: number; Enter: number; Escape: number; Comma: number; Tab: number };
};

export function toMonacoKeybinding(chord: string, monacoApi: MonacoLike) {
  const stroke = parseChord(chord);
  if (!stroke) return null;
  const mac = isMac();
  let mod = 0;
  if (mac) {
    if (stroke.meta) mod |= monacoApi.KeyMod.CtrlCmd;
    if (stroke.ctrl) mod |= monacoApi.KeyMod.WinCtrl;
  } else {
    if (stroke.ctrl) mod |= monacoApi.KeyMod.CtrlCmd;
    if (stroke.meta) mod |= monacoApi.KeyMod.WinCtrl;
  }
  if (stroke.shift) mod |= monacoApi.KeyMod.Shift;
  if (stroke.alt) mod |= monacoApi.KeyMod.Alt;
  const code = monacoKeyCode(stroke.key, monacoApi);
  if (code == null) return null;
  return mod | code;
}

function monacoKeyCode(key: string, monacoApi: MonacoLike) {
  if (key.length === 1 && key >= "a" && key <= "z") {
    const name = `Key${key.toUpperCase()}`;
    return monacoApi.KeyCode[name];
  }
  if (key.length === 1 && key >= "0" && key <= "9") {
    return monacoApi.KeyCode[`Digit${key}`];
  }
  const map: Record<string, string> = {
    enter: "Enter",
    tab: "Tab",
    escape: "Escape",
    space: "Space",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    "\\": "Backslash",
    "-": "Minus",
    "=": "Equal",
    "[": "BracketLeft",
    "]": "BracketRight",
    "`": "Backquote",
    ";": "Semicolon",
    "'": "Quote",
  };
  const named = map[key];
  return named ? monacoApi.KeyCode[named] : undefined;
}

function normalizeKeyName(value: string) {
  const key = String(value || "").toLowerCase();
  if (key === " " || key === "spacebar") return "space";
  if (key === "esc") return "escape";
  if (key === "return") return "enter";
  if (key === "arrowup") return "up";
  if (key === "arrowdown") return "down";
  if (key === "arrowleft") return "left";
  if (key === "arrowright") return "right";
  if (key.startsWith("arrow")) return key.slice(5);
  return key;
}

function isModifierKey(key: string) {
  return ["Meta", "Control", "Alt", "Shift", "Hyper", "OS"].includes(key);
}

function displayKey(key: string, mac: boolean) {
  if (key === "enter") return mac ? "⏎" : "Enter";
  if (key === "escape") return mac ? "Esc" : "Esc";
  if (key === "tab") return "Tab";
  if (key === "space") return mac ? "Space" : "Space";
  if (key === "up") return "↑";
  if (key === "down") return "↓";
  if (key === "left") return "←";
  if (key === "right") return "→";
  if (key === ",") return ",";
  if (key.length === 1) return key.toUpperCase();
  return key[0].toUpperCase() + key.slice(1);
}
