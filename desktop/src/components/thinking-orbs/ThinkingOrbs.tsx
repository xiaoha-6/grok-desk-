import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { TextShimmer } from "../prompt-kit/text-shimmer";
import type { Copy } from "../../i18n";
import { categoryFor, isCommandEvent, isEditEvent, isImageGenEvent } from "../../timeline";
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

export function agentOrbForMessage(
  message: ChatMessage,
  copy: Copy,
  opts?: { imageBusy?: boolean; connecting?: boolean },
): { state: OrbState; label: string } {
  if (opts?.connecting) return { state: "connecting", label: copy.connecting };
  if (opts?.imageBusy) return { state: "shaping", label: copy.generatingImage };

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
