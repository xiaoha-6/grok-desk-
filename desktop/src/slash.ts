import type { Copy } from "./i18n";
import type { SkillRecord } from "./types";

export type SlashKind = "mode" | "skills" | "skill";

export type SlashItem = {
  id: string;
  command: string;
  kind: SlashKind;
  title: string;
  hint: string;
  mode?: string;
  skill?: SkillRecord;
};

export type ParsedSlash = {
  kind: SlashKind;
  command: string;
  rest: string;
  mode?: string;
  skill?: SkillRecord;
};

export function builtinSlashItems(copy: Copy): SlashItem[] {
  return [
    { id: "ask", command: "ask", kind: "mode", title: copy.modeAsk, hint: copy.slashAskHint, mode: "default" },
    { id: "plan", command: "plan", kind: "mode", title: copy.modePlan, hint: copy.slashPlanHint, mode: "plan" },
    { id: "agent", command: "agent", kind: "mode", title: "Agent", hint: copy.slashAgentHint, mode: "bypassPermissions" },
    { id: "auto", command: "auto", kind: "mode", title: "Auto", hint: copy.slashAutoHint, mode: "auto" },
    { id: "edit", command: "edit", kind: "mode", title: "Edit", hint: copy.slashEditHint, mode: "acceptEdits" },
    { id: "skills", command: "skills", kind: "skills", title: copy.skills, hint: copy.slashSkillsHint },
  ];
}

export function skillSlashItems(skills: SkillRecord[]): SlashItem[] {
  return skills
    .filter((skill) => skill.enabled && skill.userInvocable !== false)
    .map((skill) => ({
      id: `skill:${skill.id}`,
      command: skill.name,
      kind: "skill" as const,
      title: skill.displayName || skill.name,
      hint: skill.shortDescription || skill.description || skill.whenToUse || "",
      skill,
    }));
}

export function allSlashItems(copy: Copy, skills: SkillRecord[]): SlashItem[] {
  return [...builtinSlashItems(copy), ...skillSlashItems(skills)];
}

export function slashQuery(text: string, cursor?: number) {
  const raw = text.slice(0, cursor ?? text.length);
  const before = raw.replace(/^[\s\u3000]+/, "").replace(/^／/, "/");
  if (!before.startsWith("/") || before.includes("\n") || /\s/.test(before)) return null;
  return { query: before.slice(1) };
}

export function filterSlashItems(items: SlashItem[], query: string, skillsOnly = false) {
  const list = skillsOnly ? items.filter((item) => item.kind === "skill") : items;
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((item) => {
    const hay = `${item.command} ${item.title} ${item.hint}`.toLowerCase();
    return item.command.toLowerCase().startsWith(q) || hay.includes(q);
  });
}

const MODE_ALIASES: Record<string, string> = {
  ask: "default",
  default: "default",
  plan: "plan",
  agent: "bypassPermissions",
  yolo: "bypassPermissions",
  bypass: "bypassPermissions",
  auto: "auto",
  edit: "acceptEdits",
  acceptedits: "acceptEdits",
};

export function parseSlashInput(text: string, skills: SkillRecord[]): ParsedSlash | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const rest = (match[2] || "").trim();
  if (command === "skills" || command === "skill") {
    return { kind: "skills", command, rest };
  }
  const mode = MODE_ALIASES[command];
  if (mode) return { kind: "mode", command, rest, mode };
  const skill = skills.find(
    (item) => item.enabled && item.userInvocable !== false && item.name.toLowerCase() === command,
  );
  if (skill) return { kind: "skill", command, rest, skill };
  return null;
}

export function wrapSkillPrompt(skill: SkillRecord, rest: string) {
  const body = (skill.content || "").trim().slice(0, 24_000);
  const task = rest.trim() || `Follow the "${skill.displayName || skill.name}" skill.`;
  return `<skill name="${skill.name}" path="${skill.path}">\n${body}\n</skill>\n\n${task}`;
}

export function skillSlashLabel(skill: SkillRecord) {
  return `/${skill.name}`;
}
