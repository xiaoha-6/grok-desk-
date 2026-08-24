import { useState, type ReactNode } from "react";
import { CategoryIcon, EventKindIcon, IconChevronRight } from "./icons";
import {
  categoryTitle,
  eventIconKind,
  groupRuns,
  statusLabel,
  visibleEvents,
  type ActivityCategory,
} from "./timeline";
import type { Lang, TimelineEvent } from "./types";

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

function EventRow({ event, lang }: { event: TimelineEvent; lang: Lang }) {
  const [open, setOpen] = useState(false);
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
          {event.input ? (
            <div className="timeline-block">
              <div className="timeline-kicker">{lang === "en" ? "Input" : "输入"}</div>
              <pre>{event.input}</pre>
            </div>
          ) : null}
          {event.output ? (
            event.kind === "thought" ? (
              <pre className="thought-md">{event.output}</pre>
            ) : (
              <div className="timeline-block">
                <div className="timeline-kicker">
                  {event.kind === "plan" ? (lang === "en" ? "Plan" : "内容") : lang === "en" ? "Result" : "结果"}
                </div>
                <pre>{event.output}</pre>
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
}: {
  category: ActivityCategory;
  events: TimelineEvent[];
  lang: Lang;
}) {
  const [open, setOpen] = useState(true);
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
          {events.map((event) => (
            <EventRow key={event.id} event={event} lang={lang} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ActivityTimeline({
  events,
  lang,
  defaultOpen = true,
}: {
  events: TimelineEvent[];
  lang: Lang;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
            <CategoryGroup key={run.id} category={run.category} events={run.events} lang={lang} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
