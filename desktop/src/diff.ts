import type { AnnotatedDiffLine, DiffLine, FileDiff, TokenSpan } from "./types";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function pushDiff(list: FileDiff[], raw: Record<string, unknown>) {
  const oldText = asString(raw.oldText ?? raw.old_text ?? raw.old_string ?? raw.oldString);
  const newText = asString(raw.newText ?? raw.new_text ?? raw.new_string ?? raw.newString);
  const path = asString(raw.path ?? raw.filePath ?? raw.file_path ?? raw.file);
  if (!oldText && !newText) return;
  list.push({ path: path || undefined, oldText, newText });
}

function visit(value: unknown, list: FileDiff[]) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, list);
    return;
  }
  const rec = asRecord(value);
  if (!rec) return;
  const type = asString(rec.type).toLowerCase();
  if (
    type === "diff" ||
    rec.oldText != null ||
    rec.newText != null ||
    rec.old_string != null ||
    rec.new_string != null ||
    rec.oldString != null
  ) {
    pushDiff(list, rec);
  }
  if (rec.content) visit(rec.content, list);
  if (rec.diff) visit(rec.diff, list);
}

export function extractFileDiffs(update: Record<string, unknown>): FileDiff[] {
  const found: FileDiff[] = [];
  visit(update.content, found);
  if (!found.length) {
    visit(update.rawInput ?? update.raw_input ?? update.input, found);
  }
  if (!found.length) visit(update, found);
  return found;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (!a.length && !b.length) return [];
  if (!a.length) return b.map((text) => ({ kind: "add" as const, text }));
  if (!b.length) return a.map((text) => ({ kind: "del" as const, text }));
  if (oldText === newText) return a.map((text) => ({ kind: "eq" as const, text }));
  if (a.length * b.length > 250_000) {
    return [
      ...a.slice(0, 36).map((text) => ({ kind: "del" as const, text })),
      ...(a.length > 36 ? [{ kind: "eq" as const, text: `… ${a.length - 36} lines` }] : []),
      ...b.slice(0, 36).map((text) => ({ kind: "add" as const, text })),
      ...(b.length > 36 ? [{ kind: "eq" as const, text: `… ${b.length - 36} lines` }] : []),
    ];
  }
  return collapseEquals(lcsDiff(a, b));
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      lines.push({ kind: "eq", text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      lines.push({ kind: "add", text: b[j - 1] });
      j -= 1;
    } else {
      lines.push({ kind: "del", text: a[i - 1] });
      i -= 1;
    }
  }
  lines.reverse();
  return lines;
}

function collapseEquals(lines: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "eq") {
      result.push(lines[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === "eq") j += 1;
    const run = lines.slice(i, j);
    if (run.length <= 6) result.push(...run);
    else {
      result.push(...run.slice(0, 2));
      result.push({ kind: "collapse", text: String(run.length - 4) });
      result.push(...run.slice(-2));
    }
    i = j;
  }
  return result;
}

function joinLines(lines: string[], original: string) {
  if (!lines.length) return original.endsWith("\n") ? "\n" : "";
  const body = lines.join("\n");
  if (original.endsWith("\n") && !body.endsWith("\n")) return `${body}\n`;
  return body;
}

export type DiffHunk = {
  id: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

export function diffHunks(oldText: string, newText: string): DiffHunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (!a.length && !b.length) return [];
  const lines = a.length * b.length > 250_000
    ? [
        ...a.map((text) => ({ kind: "del" as const, text })),
        ...b.map((text) => ({ kind: "add" as const, text })),
      ]
    : lcsDiff(a, b);
  const hunks: DiffHunk[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let i = 0;
  let id = 0;
  while (i < lines.length) {
    if (lines[i].kind === "eq") {
      oldIndex += 1;
      newIndex += 1;
      i += 1;
      continue;
    }
    const hunk: DiffHunk = { id, oldStart: oldIndex, oldCount: 0, newStart: newIndex, newCount: 0 };
    id += 1;
    while (i < lines.length && lines[i].kind !== "eq") {
      if (lines[i].kind === "del") {
        hunk.oldCount += 1;
        oldIndex += 1;
      } else {
        hunk.newCount += 1;
        newIndex += 1;
      }
      i += 1;
    }
    hunks.push(hunk);
  }
  return hunks;
}

export function applyHunk(
  oldText: string,
  newText: string,
  hunk: DiffHunk,
  action: "accept" | "reject",
): { oldText: string; newText: string } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (action === "accept") {
    const nextOld = [
      ...oldLines.slice(0, hunk.oldStart),
      ...newLines.slice(hunk.newStart, hunk.newStart + hunk.newCount),
      ...oldLines.slice(hunk.oldStart + hunk.oldCount),
    ];
    return { oldText: joinLines(nextOld, oldText), newText };
  }
  const nextNew = [
    ...newLines.slice(0, hunk.newStart),
    ...oldLines.slice(hunk.oldStart, hunk.oldStart + hunk.oldCount),
    ...newLines.slice(hunk.newStart + hunk.newCount),
  ];
  return { oldText, newText: joinLines(nextNew, newText) };
}

export function fileLabel(path?: string) {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function diffStats(oldText: string, newText: string) {
  let added = 0;
  let removed = 0;
  for (const line of lineDiff(oldText, newText)) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

function tokenize(text: string): string[] {
  return text.split(/(\s+|[^A-Za-z0-9_\u4e00-\u9fff]+)/).filter(Boolean);
}

export function tokenDiff(oldText: string, newText: string): { oldTokens: TokenSpan[]; newTokens: TokenSpan[] } {
  if (oldText === newText) {
    return {
      oldTokens: oldText ? [{ kind: "eq", text: oldText }] : [],
      newTokens: newText ? [{ kind: "eq", text: newText }] : [],
    };
  }
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (!a.length || !b.length || a.length * b.length > 20_000) {
    return {
      oldTokens: oldText ? [{ kind: "del", text: oldText }] : [],
      newTokens: newText ? [{ kind: "add", text: newText }] : [],
    };
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const oldTokens: TokenSpan[] = [];
  const newTokens: TokenSpan[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      oldTokens.push({ kind: "eq", text: a[i - 1] });
      newTokens.push({ kind: "eq", text: b[j - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      newTokens.push({ kind: "add", text: b[j - 1] });
      j -= 1;
    } else {
      oldTokens.push({ kind: "del", text: a[i - 1] });
      i -= 1;
    }
  }
  oldTokens.reverse();
  newTokens.reverse();
  return { oldTokens, newTokens };
}

export function annotateDiff(oldText: string, newText: string): AnnotatedDiffLine[] {
  const lines = lineDiff(oldText, newText);
  const result: AnnotatedDiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "collapse") {
      result.push({ kind: "collapse", text: line.text });
      i += 1;
      continue;
    }
    if (line.kind === "eq") {
      result.push({ kind: "eq", text: line.text, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") {
      dels.push(lines[i]);
      i += 1;
    }
    while (i < lines.length && lines[i].kind === "add") {
      adds.push(lines[i]);
      i += 1;
    }
    const paired = Math.min(dels.length, adds.length);
    for (let k = 0; k < paired; k += 1) {
      const tokens = tokenDiff(dels[k].text, adds[k].text);
      result.push({ kind: "del", text: dels[k].text, oldNo: oldNo++, tokens: tokens.oldTokens });
      result.push({ kind: "add", text: adds[k].text, newNo: newNo++, tokens: tokens.newTokens });
    }
    for (let k = paired; k < dels.length; k += 1) {
      result.push({ kind: "del", text: dels[k].text, oldNo: oldNo++ });
    }
    for (let k = paired; k < adds.length; k += 1) {
      result.push({ kind: "add", text: adds[k].text, newNo: newNo++ });
    }
  }
  return result;
}
