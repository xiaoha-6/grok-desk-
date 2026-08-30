import { memo, useEffect, useState, type ReactNode } from "react";
import { CodeDiffView } from "./CodeDiffView";
import { CategoryIcon, EventKindIcon, IconChevronRight } from "./icons";
import {
  categoryTitle,
  commandTitle,
  editTitle,
  eventFilePath,
  eventIconKind,
  eventProgress,
  exploreTitle,
  groupRuns,
  isCommandEvent,
  isEditEvent,
  isExploreEvent,
  isReadEvent,
  isThoughtEvent,
  isOpaqueJson,
  readableToolText,
  statusLabel,
  thoughtTiming,
  visibleEvents,
  type ActivityCategory,
} from "./timeline";
import type { Lang, TimelineEvent } from "./types";
import { fill, t as translate } from "./i18n";
import { isImageProbeEvent } from "./ChatImage";
import { fileBadge } from "./fileIcons";
function Disclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button className="timeline-toggle" type="button" onClick={onToggle}>
      <span className={open ? "chevron open" : "chevron"}>
        <IconChevronRight />
      </span>
      {children}
    </button>
  );
}
function clip(text: string, max = 1600) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}
function askFromEvent(event: TimelineEvent) {
  const raw = String(event.input || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { questions?: Array<{ question?: string; options?: Array<{ label?: string; description?: string }> }> };
    return (parsed.questions || [])
      .map((question) => ({
        question: String(question.question || ""),
        options: (question.options || [])
          .map((option) => ({ label: String(option.label || ""), description: String(option.description || "") }))
          .filter((option) => option.label),
      }))
      .filter((question) => question.question || question.options.length);
  } catch {
    return [];
  }
}
function EventRow({ event, lang, startOpen }: { event: TimelineEvent; lang: Lang; startOpen?: boolean }) {
  const copy = translate(lang);
  const hasDiff = Boolean(event.diffs?.length);
  const ask = askFromEvent(event);
  const [open, setOpen] = useState(Boolean(startOpen && (hasDiff || event.kind === "edit" || event.status === "in_progress" || ask.length > 0)));
  const status = event.status ? statusLabel(event.status, lang) : "";
  const tone =
    event.status && /fail|error/i.test(event.status)
      ? "bad"
      : event.status && /complete|success|approved/i.test(event.status)
        ? "ok"
        : "";
  return (
    <div className="timeline-event">
      <Disclosure open={open} onToggle={() => setOpen((value) => !value)}>
        <span className="timeline-ico">
          <EventKindIcon kind={eventIconKind(event)} />
        </span>
        <span className="timeline-title">{isEditEvent(event) ? editTitle(event) : event.title}</span>
        {status ? <span className={`timeline-status ${tone}`}>{status}</span> : null}
      </Disclosure>
      {open ? (
        <div className="timeline-detail">
          {hasDiff
            ? event.diffs!.map((diff, index) => <CodeDiffView key={`${diff.path || "diff"}-${index}`} diff={diff} lang={lang} />)
            : null}
          {!hasDiff && ask.length ? (
            <div className="ask-preview">
              {ask.map((question) => (
                <div key={question.question} className="ask-preview-q">
                  <strong>{question.question}</strong>
                  <ul>
                    {question.options.map((option) => (
                      <li key={option.label}>
                        {option.label}
                        {option.description ? <em>{option.description}</em> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
          {!hasDiff && !ask.length && readableToolText(event.input) && !isOpaqueJson(event.input) ? (
            <div className="timeline-block">
              <div className="timeline-kicker">{copy.input}</div>
              <pre>{clip(readableToolText(event.input))}</pre>
            </div>
          ) : null}
          {event.output && !hasDiff && !ask.length && !isOpaqueJson(event.output) ? (
            event.kind === "thought" ? (
              <pre className="thought-md">{clip(event.output, 4000)}</pre>
            ) : (
              <div className="timeline-block">
                <div className="timeline-kicker">
                  {event.kind === "plan" ? copy.content : copy.result}
                </div>
                <pre>{clip(readableToolText(event.output) || event.output)}</pre>
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
function CategoryGroup({
  category,
  events,
  lang,
  streaming,
}: {
  category: ActivityCategory;
  events: TimelineEvent[];
  lang: Lang;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(category === "commands" || category === "files" || Boolean(streaming && category !== "other"));
  const shown = events.slice(0, 30);
  const hidden = events.length - shown.length;
  return (
    <div className="timeline-run">
      <Disclosure open={open} onToggle={() => setOpen((value) => !value)}>
        <span className="timeline-ico">
          <CategoryIcon category={category} />
        </span>
        <span>{categoryTitle(category, lang)}</span>
        <span className="timeline-count">{events.length}</span>
      </Disclosure>
      {open ? (
        <div className="timeline-children">
          {hidden > 0 ? (
            <div className="timeline-folded">
              {fill(translate(lang).foldedSteps, { n: hidden })}
            </div>
          ) : null}
          {shown.map((event) => (
            <EventRow key={event.id} event={event} lang={lang} startOpen={streaming} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const InlineThought = memo(function InlineThought({
  thought,
  events,
  lang,
  streaming,
}: {
  thought?: string;
  events: TimelineEvent[];
  lang: Lang;
  streaming?: boolean;
}) {
  const copy = translate(lang);
  const event = events.find(isThoughtEvent);
  const text = String(thought || event?.output || "").trim();
  if (!text) return null;
  const seconds = thoughtTiming(event);
  const heading =
    streaming && !seconds
      ? copy.thinkingNow
      : seconds
        ? fill(copy.thoughtFor, { n: seconds })
        : copy.thinking;
  const shown = streaming && text.length > 3500 ? `…\n${text.slice(-3500)}` : clip(text, 6000);
  return (
    <div className={`inline-thought${streaming ? " live" : ""}`}>
      <div className="inline-thought-head">{heading}</div>
      <pre className="inline-thought-body">{shown}</pre>
    </div>
  );
});

export const InlineExplore = memo(function InlineExplore({
  events,
  lang,
  streaming,
}: {
  events: TimelineEvent[];
  lang: Lang;
  streaming?: boolean;
}) {
  const copy = translate(lang);
  const items = events.filter(isExploreEvent);
  if (!items.length) return null;
  const exploring = items.some((event) => /in_progress|running|pending/i.test(event.status || ""));
  const files = items.filter(isReadEvent).length;
  const searches = items.length - files;
  const heading = exploring
    ? copy.exploring
    : files && searches
      ? fill(copy.exploredSummary, { files, searches })
      : files
        ? fill(copy.exploredFiles, { n: files })
        : fill(copy.exploredSearches, { n: searches });
  return (
    <div className="inline-explore">
      <div className="inline-explore-head">{heading}</div>
      <div className="inline-explore-list">
        {items.map((event) => (
          <ExploreRow key={event.id} event={event} />
        ))}
        {streaming && !exploring ? <div className="inline-explore-next">{copy.planningNext}</div> : null}
      </div>
    </div>
  );
});

function ExploreRow({ event }: { event: TimelineEvent }) {
  const snippet = readableToolText(event.output);
  const [open, setOpen] = useState(false);
  const running = /in_progress|running|pending/i.test(event.status || "");
  const label = exploreTitle(event);
  const body = (
    <>
      <span className="timeline-ico">
        <EventKindIcon kind={isReadEvent(event) ? "file" : "search"} />
      </span>
      <span className="inline-explore-title">{label}</span>
      {running ? <span className="inline-explore-dot" /> : null}
    </>
  );
  if (!snippet) {
    return <div className={`inline-explore-row${running ? " run" : ""}`}>{body}</div>;
  }
  return (
    <div className={`inline-explore-item${open ? " open" : ""}`}>
      <button className={`inline-explore-row${running ? " run" : ""}`} type="button" onClick={() => setOpen((value) => !value)}>
        {body}
      </button>
      {open ? <pre className="inline-explore-snippet">{clip(snippet, 4000)}</pre> : null}
    </div>
  );
}

export const InlineCommands = memo(function InlineCommands({
  events,
  lang,
  onOpenTerminal,
}: {
  events: TimelineEvent[];
  lang: Lang;
  onOpenTerminal?: () => void;
}) {
  const copy = translate(lang);
  const commands = events.filter((event) => isCommandEvent(event) && !isImageProbeEvent(event));
  if (!commands.length) return null;
  return (
    <div className="inline-commands">
      {commands.map((event) => {
        const running = /in_progress|running|pending/i.test(event.status || "");
        const failed = /fail|error/i.test(event.status || "");
        const done = /complete|success/i.test(event.status || "");
        const progress = eventProgress(event);
        const command = readableToolText(event.input) || event.title;
        const output = readableToolText(event.output);
        return (
          <div key={event.id} className={`inline-term${failed ? " bad" : done ? " ok" : running ? " run" : ""}`}>
            <div className="inline-term-bar">
              <span className="inline-term-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <strong>{running ? copy.cmdWindow : commandTitle(event, lang)}</strong>
              {event.status ? (
                <span className={`timeline-status ${failed ? "bad" : done ? "ok" : ""}`}>
                  {statusLabel(event.status, lang)}
                </span>
              ) : null}
              {onOpenTerminal ? (
                <button className="ghost compact nowrap inline-term-open" type="button" onClick={onOpenTerminal}>
                  {copy.openInTerminal}
                </button>
              ) : null}
            </div>
            <div className="inline-term-screen">
              <div className="inline-term-prompt">$ {command}</div>
              <pre>
                {output || (running ? copy.cmdRunning : "")}
                {running ? <span className="inline-term-cursor" /> : null}
              </pre>
            </div>
            <div className="tool-progress" aria-hidden>
              <span style={{ width: `${progress}%` }} className={running ? "pulse" : ""} />
            </div>
          </div>
        );
      })}
    </div>
  );
});

export const InlineEdits = memo(function InlineEdits({
  events,
  lang,
}: {
  events: TimelineEvent[];
  lang: Lang;
}) {
  const copy = translate(lang);
  const edits = events.filter((event) => isEditEvent(event) && (event.diffs?.length || event.input || event.output));
  if (!edits.length) return null;
  return (
    <div className="inline-edits">
      {edits.map((event) => {
        const path = event.diffs?.find((item) => item.path)?.path || eventFilePath(event);
        const name = path.split(/[\\/]/).filter(Boolean).pop() || editTitle(event);
        return (
          <div key={event.id} className="inline-edit">
            <div className="inline-edit-head">
              <span className="inline-edit-kicker">{copy.wroteCode}</span>
              {path ? <em className="inline-edit-badge">{fileBadge(path)}</em> : null}
              <span className="inline-edit-title">{name}</span>
              {event.status ? (
                <span className={`timeline-status ${/fail|error/i.test(event.status) ? "bad" : /complete|success/i.test(event.status) ? "ok" : ""}`}>
                  {statusLabel(event.status, lang)}
                </span>
              ) : null}
            </div>
            {event.diffs?.length
              ? event.diffs.map((diff, index) => (
                  <CodeDiffView key={`${event.id}-${diff.path || "diff"}-${index}`} diff={diff} lang={lang} />
                ))
              : event.input || event.output ? (
                <pre className="inline-edit-body">{clip(event.input || event.output || "", 6000)}</pre>
              ) : null}
          </div>
        );
      })}
    </div>
  );
});

export const ActivityTimeline = memo(function ActivityTimeline({
  events,
  lang,
  defaultOpen = false,
}: {
  events: TimelineEvent[];
  lang: Lang;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const visible = visibleEvents(events);
  const runs = groupRuns(events);
  if (!visible.length) return null;
  return (
    <div className="timeline">
      <Disclosure open={open} onToggle={() => setOpen((value) => !value)}>
        <span className="timeline-ico">
          <CategoryIcon category="reasoning" />
        </span>
        <span>{translate(lang).process}</span>
        <span className="timeline-count">{visible.length}</span>
      </Disclosure>
      {open ? (
        <div className="timeline-children">
          {runs.map((run) => (
            <CategoryGroup
              key={run.id}
              category={run.category}
              events={run.events}
              lang={lang}
              streaming={defaultOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
});
