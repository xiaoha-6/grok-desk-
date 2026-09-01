import { memo, type KeyboardEvent, type MutableRefObject } from "react";
import { ActivityTimeline, InlineCommands, InlineEdits, InlineExplore, InlineThought } from "./ActivityTimeline";
import {
  ChatMessageMedia,
  imageGenFailure,
  isImageGenBusy,
  isShowableImage,
  wantsImageGen,
} from "./ChatImage";
import { AgentStatus, SubagentSwarm, agentOrbForMessage, isUpstreamReconnecting } from "./components/thinking-orbs/ThinkingOrbs";
import type { Copy, Lang } from "./i18n";
import { isImeEvent } from "./keybindings";
import { isSubagentEvent, statusLabel } from "./timeline";
import type { ChatMessage } from "./types";

export type TranscriptRowActions = {
  imeRef: MutableRefObject<{ composing: boolean; until: number }>;
  saveEditedMessage: () => void;
  cancelEdit: () => void;
  setEditingDraft: (value: string) => void;
  regenerate: () => void;
  restoreTurn: (userId: string) => void;
  startEditingMessage: (message: ChatMessage) => void;
  sendRedraw: (message: ChatMessage, prevUser: ChatMessage, retryFailed: boolean) => void;
  revealCommandInTerminal: () => void;
};

function assistantLivePhase(
  message: ChatMessage,
  running: boolean,
): "reconnecting" | "thinking" | "working" | null {
  if (message.role !== "assistant" || !message.streaming || message.stopped || !running) return null;
  if (isUpstreamReconnecting(message.events)) return "reconnecting";
  const hasOutput =
    Boolean(message.text) ||
    message.media.length > 0 ||
    message.events.some((event) => event.kind !== "thought" && event.id !== "upstream-reconnect");
  return hasOutput ? "working" : "thinking";
}

function isImeBlocked(
  event: { nativeEvent?: globalThis.KeyboardEvent } & { isComposing?: boolean; keyCode?: number; key?: string },
  imeRef: TranscriptRowActions["imeRef"],
) {
  const native = event.nativeEvent || (event as globalThis.KeyboardEvent);
  if (isImeEvent(native)) return true;
  if (imeRef.current.composing) return true;
  if (Date.now() < imeRef.current.until) return true;
  return false;
}

export const TranscriptRow = memo(function TranscriptRow({
  message,
  prevUser,
  copy,
  lang,
  running,
  editing,
  editingDraft,
  canRestore,
  restoreUserId,
  sessionDir,
  isLatestAssistant,
  actionsRef,
}: {
  message: ChatMessage;
  prevUser?: ChatMessage;
  copy: Copy;
  lang: Lang;
  running: boolean;
  editing: boolean;
  editingDraft: string;
  canRestore: boolean;
  restoreUserId?: string;
  sessionDir?: string;
  isLatestAssistant: boolean;
  actionsRef: MutableRefObject<TranscriptRowActions>;
}) {
  const livePhase = assistantLivePhase(message, running);
  const askedImage = wantsImageGen(prevUser?.text || "");
  const imageBusy = isImageGenBusy(message, prevUser?.text || "");
  const expectImage = imageBusy && !(message.media || []).some(isShowableImage);
  const reconnecting = livePhase === "reconnecting";
  const activity = agentOrbForMessage(message, copy, { imageBusy, reconnecting });
  const hasSubagents = message.events.some(isSubagentEvent);
  const hasThought = Boolean(message.thought) || message.events.some((event) => event.kind === "thought" && event.output);
  const showReconnectBar = reconnecting && !hasThought;
  const showThinkingBar = livePhase === "thinking" && !hasThought;
  const showWorkingBar = livePhase === "working" && !imageBusy && !hasSubagents;
  const canRedraw = message.role === "assistant" && Boolean(prevUser) && askedImage && !running;
  const imageFail = askedImage ? imageGenFailure(message) : "";
  const actions = actionsRef;

  return (
    <article className={`row ${message.role}`}>
      <div className={message.role === "user" ? "bubble user" : "bubble assistant"}>
        {message.role === "user" && editing ? (
          <div className="user-edit">
            <textarea
              className="user-edit-input"
              value={editingDraft}
              autoFocus
              rows={Math.min(8, Math.max(2, editingDraft.split("\n").length))}
              onChange={(event) => actions.current.setEditingDraft(event.target.value)}
              onCompositionStart={() => {
                actions.current.imeRef.current = { composing: true, until: 0 };
              }}
              onCompositionEnd={() => {
                actions.current.imeRef.current = { composing: false, until: Date.now() + 120 };
              }}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (isImeBlocked(event, actions.current.imeRef)) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  actions.current.saveEditedMessage();
                }
                if (event.key === "Escape") actions.current.cancelEdit();
              }}
            />
            <div className="user-edit-actions">
              <button className="ghost compact" type="button" onClick={() => actions.current.cancelEdit()}>
                {copy.cancelEdit}
              </button>
              <button className="primary compact" type="button" onClick={() => actions.current.saveEditedMessage()}>
                {copy.saveEdit}
              </button>
            </div>
          </div>
        ) : null}
        {message.role === "assistant" && (hasThought || message.events.length) ? (
          <>
            <InlineThought
              thought={message.thought}
              events={message.events}
              lang={lang}
              streaming={Boolean(message.streaming)}
              reconnecting={reconnecting}
            />
            {message.events.length ? (
              <>
                <InlineExplore events={message.events} lang={lang} streaming={Boolean(message.streaming)} />
                <InlineEdits events={message.events} lang={lang} />
                <InlineCommands
                  events={message.events}
                  lang={lang}
                  onOpenTerminal={() => actions.current.revealCommandInTerminal()}
                />
                <SubagentSwarm
                  events={message.events}
                  copy={copy}
                  statusLabel={(status) => statusLabel(status, lang)}
                />
                <ActivityTimeline
                  events={message.events}
                  lang={lang}
                  defaultOpen={message.streaming || Boolean(message.stopped)}
                />
              </>
            ) : null}
          </>
        ) : null}
        {showReconnectBar ? (
          <AgentStatus className="thinking-bar" state="connecting" label={copy.reconnectingUpstream} />
        ) : showThinkingBar ? (
          <AgentStatus className="thinking-bar" state="solving" label={copy.thinkingNow} />
        ) : null}
        {editing ? null : (
          <ChatMessageMedia
            message={message}
            copy={copy}
            expectImage={expectImage}
            allowImageUi={askedImage}
            sessionDir={sessionDir}
            onRedraw={
              canRedraw && prevUser
                ? () =>
                    actions.current.sendRedraw(
                      message,
                      prevUser,
                      isLatestAssistant && Boolean(imageFail || message.error),
                    )
                : undefined
            }
          />
        )}
        {showWorkingBar ? <AgentStatus className="working" state={activity.state} label={activity.label} /> : null}
        {message.role === "assistant" && message.stopped && !message.streaming ? (
          <div className="stopped-note">
            <strong>{copy.stopped}</strong>
            <span>{copy.stoppedHint}</span>
          </div>
        ) : null}
        {message.error && !imageFail ? (
          <div className="fail">
            <div className="fail-title">{copy.failed}</div>
            <pre>{message.error}</pre>
            <button className="ghost compact" type="button" onClick={() => actions.current.regenerate()}>
              {copy.regenerate}
            </button>
          </div>
        ) : null}
        {canRestore && restoreUserId ? (
          <div className="user-actions">
            <button
              className="ghost compact nowrap"
              type="button"
              title={copy.restoreTurnHint}
              onClick={() => actions.current.restoreTurn(restoreUserId)}
            >
              {copy.restoreTurn}
            </button>
          </div>
        ) : null}
        {message.role === "user" && !editing ? (
          <div className="user-actions">
            {message.queued ? <span className="queued-pill">{copy.queuedToSend}</span> : null}
            <button className="ghost compact nowrap" type="button" onClick={() => actions.current.startEditingMessage(message)}>
              {copy.editMessage}
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
});
