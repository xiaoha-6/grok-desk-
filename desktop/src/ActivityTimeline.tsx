import { useEffect, useState, type ReactNode } from "react";
import { fileLabel, lineDiff } from "./diff";
import { CategoryIcon, EventKindIcon, IconChevronRight } from "./icons";
import {
  categoryTitle,
  eventIconKind,
  groupRuns,
  statusLabel,
  visibleEvents,
  type ActivityCategory,
} from "./timeline";
import type { FileDiff, Lang, TimelineEvent } from "./types";

function CodeDiff({ diff, lang }: { diff: FileDiff; lang: Lang }) {
  const oldText = diff.oldText.length > 8000 ? `${diff.oldText.slice(0, 8000)}\n…` : diff.oldText;
  const newText = diff.newText.length > 8000 ? `${diff.newText.slice(0, 8000)}\n…` : diff.newText;
  const lines = lineDiff(oldText, newText);
  const path = fileLabel(diff.path);
  return (
    <div className="code-diff">
      {path ? <div className="diff-path">{path}</div> : null}
      <div className="diff-body">
        {lines.length ? (
          lines.map((line, index) => (
            <div key={`${line.kind}-${index}`} className={`diff-line ${line.kind}`}>
              <span className="diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
              <span className="diff-text">{line.text || " "}</span>
            </div>
          ))
        ) : (
          <div className="diff-line eq">
            <span className="diff-text">{lang === "en" ? "No changes" : "无改动"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

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

function EventRow({ event, lang, startOpen }: { event: TimelineEvent; lang: Lang; startOpen?: boolean }) {
  const hasDiff = Boolean(event.diffs?.length);
  const [open, setOpen] = useState(Boolean(startOpen && (hasDiff || event.kind === "edit" || event.status === "in_progress")));
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
        <span className="timeline-title">{event.title}</span>
        {status ? <span className={`timeline-status ${tone}`}>{status}</span> : null}
      </Disclosure>
      {open ? (
        <div className="timeline-detail">
          {hasDiff
            ? event.diffs!.map((diff, index) => <CodeDiff key={`${diff.path || "diff"}-${index}`} diff={diff} lang={lang} />)
            : null}
          {!hasDiff && event.input ? (
            <div className="timeline-block">
              <div className="timeline-kicker">{lang === "en" ? "Input" : "输入"}</div>
              <pre>{clip(event.input)}</pre>
            </div>
          ) : null}
          {event.output && !hasDiff ? (
            event.kind === "thought" ? (
              <pre className="thought-md">{clip(event.output, 4000)}</pre>
            ) : (
              <div className="timeline-block">
                <div className="timeline-kicker">
                  {event.kind === "plan" ? (lang === "en" ? "Plan" : "内容") : lang === "en" ? "Result" : "结果"}
                </div>
                <pre>{clip(event.output)}</pre>
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
  const [open, setOpen] = useState(false);
  const shown = streaming ? events.slice(-8) : events.slice(-4);
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
              {lang === "en" ? `${hidden} earlier steps folded` : `已折叠 ${hidden} 个早期步骤`}
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

export function ActivityTimeline({
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
        <span>{lang === "en" ? "Process" : "过程"}</span>
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
}
