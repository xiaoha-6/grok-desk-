import { useState } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { TextShimmer } from "../prompt-kit/text-shimmer";
import { IconChevronRight } from "../../icons";
import { fill, type Copy } from "../../i18n";
import {
  categoryFor,
  isCommandEvent,
  isEditEvent,
  isImageGenEvent,
  isSubagentEvent,
  isSubagentLifecycle,
} from "../../timeline";
import type { ChatMessage, TimelineEvent } from "../../types";

export { ThinkingOrb };
export type { OrbState };

function haystack(event: TimelineEvent) {
  return `${event.kind} ${event.title}`.toLowerCase();
}

function isLiveEvent(event: TimelineEvent) {
  const status = (event.status || "").toLowerCase();
  if (/complete|success|fail|error|cancel/.test(status)) return false;
  return !status || /progress|pending|run|start/.test(status);
}

function latestLiveTool(events: TimelineEvent[]) {
  return [...events].reverse().find((event) => event.kind !== "thought" && isLiveEvent(event));
}

function parseJson(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseSubagent(event: TimelineEvent) {
  const rec = parseJson(event.input) || parseJson(event.output) || {};
  const type = String(rec.subagent_type || rec.subagentType || rec.role || "general-purpose").toLowerCase();
  const steps = Array.isArray(rec.steps) ? rec.steps.map((item) => String(item)) : [];
  return {
    id: String(rec.subagent_id || rec.subagentId || rec.child_session_id || event.id),
    description: String(rec.description || event.title || "").trim(),
    type,
    prompt: String(rec.prompt || "").trim(),
    activity: String(rec.activity || "").trim(),
    model: String(rec.model || "").trim(),
    steps,
    turns: Number(rec.turns || 0),
    tools: Number(rec.tool_calls || rec.toolCalls || 0),
    durationMs: Number(rec.duration_ms || rec.durationMs || 0),
  };
}

export function subagentEvents(events: TimelineEvent[] = []) {
  const cards = new Map<string, TimelineEvent>();
  const remember = (key: string, event: TimelineEvent) => {
    const prev = cards.get(key);
    if (!prev) {
      cards.set(key, event);
      return;
    }
    const newer = /complete|success|fail|error/.test(event.status || "") ? event : prev;
    const older = newer === event ? prev : event;
    const nextInput = { ...parseJson(older.input), ...parseJson(newer.input), ...parseJson(event.output) };
    cards.set(key, {
      ...older,
      ...newer,
      id: key.startsWith("subagent-") ? key : newer.id,
      kind: "subagent",
      title: String(nextInput.description || newer.title || older.title),
      input: JSON.stringify(nextInput),
      output: newer.output || older.output,
    });
  };
  for (const event of events) {
    if (isSubagentEvent(event)) {
      const info = parseSubagent(event);
      remember(info.id.startsWith("subagent-") ? info.id : `subagent-${info.id}`, {
        ...event,
        kind: "subagent",
        title: info.description || event.title,
      });
      continue;
    }
    if (!isSubagentLifecycle(event)) continue;
    const rec = parseJson(event.output) || parseJson(event.input) || {};
    const id = String(rec.subagent_id || rec.subagentId || rec.child_session_id || "").trim();
    if (!id) continue;
    const status = /finished/.test(event.title.toLowerCase())
      ? String(rec.status || "completed")
      : String(rec.status || event.status || "in_progress");
    remember(`subagent-${id}`, {
      id: `subagent-${id}`,
      kind: "subagent",
      title: String(rec.description || event.title),
      status,
      input: JSON.stringify({
        subagent_id: id,
        description: rec.description,
        subagent_type: rec.subagent_type || rec.subagentType || rec.role,
        model: rec.model,
        activity: rec.activity || rec.message || rec.last_tool,
        steps: rec.activity || rec.message ? [String(rec.activity || rec.message)] : [],
        turns: rec.turns,
        tool_calls: rec.tool_calls || rec.toolCalls,
        duration_ms: rec.duration_ms || rec.durationMs,
      }),
      output: rec.output ? String(rec.output) : undefined,
    });
  }
  return [...cards.values()];
}

export function subagentTypeLabel(type: string, copy: Copy) {
  if (type.includes("explore")) return copy.subagentExplore;
  if (type.includes("plan")) return copy.subagentPlanType;
  return copy.subagentGeneral;
}

export function subagentOrbState(type: string, status?: string): OrbState {
  const value = (status || "").toLowerCase();
  if (/fail|error/.test(value)) return "connecting";
  if (/cancel/.test(value)) return "connecting";
  if (/complete|success/.test(value)) return "composing";
  if (type.includes("explore")) return "searching";
  if (type.includes("plan")) return "weaving";
  return "working";
}

export function agentOrbForMessage(
  message: ChatMessage,
  copy: Copy,
  opts?: { imageBusy?: boolean; connecting?: boolean },
): { state: OrbState; label: string } {
  if (opts?.connecting) return { state: "connecting", label: copy.connecting };
  if (opts?.imageBusy) return { state: "shaping", label: copy.generatingImage };

  const spawned = subagentEvents(message.events || []);
  const liveAgents = spawned.filter(isLiveEvent);
  if (liveAgents.length) {
    return {
      state: "weaving",
      label:
        liveAgents.length === spawned.length
          ? fill(copy.subagentsRunning, { n: liveAgents.length })
          : fill(copy.subagentsWorkingOf, { n: liveAgents.length, total: spawned.length }),
    };
  }

  const live = latestLiveTool(message.events || []);
  if (live) {
    const text = haystack(live);
    if (isImageGenEvent(live)) return { state: "shaping", label: copy.orbShaping };
    if (
      /search|web_search|browse|fetch|grep|glob|\bfind\b/.test(text) ||
      (categoryFor(live) === "files" && /read|list|search/.test(text))
    ) {
      return { state: "searching", label: copy.orbSearching };
    }
    if (live.kind === "plan" || text.includes("plan")) {
      return { state: "weaving", label: copy.orbPlanning };
    }
    if (isEditEvent(live) || /write|str_replace|apply_patch|applypatch/.test(text)) {
      return { state: "working", label: copy.orbEditing };
    }
    if (isCommandEvent(live)) return { state: "working", label: copy.working };
  }

  if (message.text) return { state: "composing", label: copy.orbComposing };
  return { state: "solving", label: copy.thinkingNow };
}

export function AgentStatus({
  state,
  label,
  className,
  size = 20,
  theme = "auto",
}: {
  state: OrbState;
  label: string;
  className?: string;
  size?: 20 | 64;
  theme?: "auto" | "dark" | "light";
}) {
  return (
    <div className={["agent-status", className].filter(Boolean).join(" ")}>
      <ThinkingOrb state={state} size={size} theme={theme} aria-hidden />
      <TextShimmer>{label}</TextShimmer>
    </div>
  );
}

function SubagentCard({
  event,
  copy,
  statusLabel,
  defaultOpen,
}: {
  event: TimelineEvent;
  copy: Copy;
  statusLabel: (status: string) => string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const info = parseSubagent(event);
  const failed = /fail|error/i.test(event.status || "");
  const done = /complete|success/i.test(event.status || "");
  const running = !failed && !done;
  const steps = info.steps.length
    ? info.steps.map((step) => (step === "spawned" ? copy.subagentStarted : step))
    : running
      ? [copy.subagentStarted]
      : [];
  const meta = [
    info.model,
    info.turns || info.tools
      ? fill(copy.subagentMeta, { turns: info.turns || 1, tools: info.tools || steps.length })
      : "",
    info.durationMs ? `${Math.max(1, Math.round(info.durationMs / 1000))}s` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`subagent-task${failed ? " bad" : done ? " ok" : " run"}`}>
      <button className="subagent-task-head" type="button" onClick={() => setOpen((value) => !value)}>
        <ThinkingOrb state={subagentOrbState(info.type, event.status)} size={20} />
        <span className="subagent-task-copy">
          <strong>{info.description || copy.subagentDefault}</strong>
          {running ? (
            <TextShimmer>{info.activity || copy.subagentWorking}</TextShimmer>
          ) : (
            <em>
              {subagentTypeLabel(info.type, copy)}
              {event.status ? ` · ${statusLabel(event.status)}` : ""}
              {meta ? ` · ${meta}` : ""}
            </em>
          )}
        </span>
        <span className="subagent-task-type">{subagentTypeLabel(info.type, copy)}</span>
        <span className={open ? "chevron open" : "chevron"}>
          <IconChevronRight />
        </span>
      </button>
      {open ? (
        <div className="subagent-task-body">
          {steps.map((step, index) => (
            <div key={`${event.id}-step-${index}`} className="subagent-step">
              <i />
              <span>{step}</span>
            </div>
          ))}
          {event.output ? (
            <div className="subagent-result">
              <div className="subagent-result-kicker">{copy.subagentSummary}</div>
              <pre>{event.output.length > 1800 ? `${event.output.slice(0, 1800)}\n…` : event.output}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SubagentSwarm({
  events,
  copy,
  statusLabel,
}: {
  events: TimelineEvent[];
  copy: Copy;
  statusLabel: (status: string) => string;
}) {
  const agents = subagentEvents(events);
  if (!agents.length) return null;
  const live = agents.filter(isLiveEvent);
  const title =
    live.length === 0
      ? fill(copy.subagentsDone, { n: agents.length })
      : live.length === agents.length
        ? fill(copy.subagentsRunning, { n: live.length })
        : fill(copy.subagentsWorkingOf, { n: live.length, total: agents.length });
  return (
    <div className={`subagent-swarm${live.length ? " live" : ""}`}>
      <div className="subagent-swarm-head">
        <div className="subagent-swarm-orbs" aria-hidden>
          {agents.slice(0, 5).map((event) => {
            const info = parseSubagent(event);
            return <ThinkingOrb key={event.id} state={subagentOrbState(info.type, event.status)} size={20} />;
          })}
        </div>
        <div className="subagent-swarm-copy">
          {live.length ? <TextShimmer>{title}</TextShimmer> : <strong>{title}</strong>}
          <span>{live.length ? copy.subagentsRunningHint : copy.subagentsDoneHint}</span>
        </div>
      </div>
      <div className="subagent-list">
        {agents.map((event) => (
          <SubagentCard
            key={event.id}
            event={event}
            copy={copy}
            statusLabel={statusLabel}
            defaultOpen={isLiveEvent(event) || agents.length <= 2}
          />
        ))}
      </div>
    </div>
  );
}
