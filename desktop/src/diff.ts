import type { DiffLine, FileDiff } from "./types";

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
      result.push({ kind: "eq", text: `… ${run.length - 4} unchanged` });
      result.push(...run.slice(-2));
    }
    i = j;
  }
  return result;
}

export function fileLabel(path?: string) {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}
