import { useMemo, useState } from "react";
import { fill, type Copy } from "./i18n";
import type { Lang, RelayUsage, RelayUsageDay } from "./types";

type Granularity = "day" | "week";

export function RelayUsagePanel({
  usage,
  loading,
  copy,
  lang,
  onRefresh,
}: {
  usage: RelayUsage | null;
  loading: boolean;
  copy: Copy;
  lang: Lang;
  onRefresh: () => void;
}) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const days = useMemo(() => fillDayRange(usage?.days || []), [usage]);
  const metrics = useMemo(() => computeMetrics(days, usage?.totalTokens), [days, usage]);
  const columns = useMemo(() => buildWeekColumns(days, lang), [days, lang]);
  const maxTokens = useMemo(() => scaleMax(days.map((day) => day.tokens)), [days]);
  const maxWeek = useMemo(() => scaleMax(columns.map((column) => column.tokens)), [columns]);
  const modelMax = Math.max(1, ...(usage?.models || []).map((item) => item.tokens));

  if (!usage?.configured) {
    return (
      <>
        <p className="lede">{copy.usageHint}</p>
        <section className="group stacked">
          <p className="hint left">{copy.usageNeedRelay}</p>
        </section>
      </>
    );
  }

  return (
    <>
      <p className="lede">
        {copy.usageHint}
        {usage.todayTokens != null || usage.todayRequests != null ? (
          <>
            <br />
            {fill(copy.usageToday, {
              tokens: compactCount(usage.todayTokens || 0),
              requests: String(usage.todayRequests || 0),
            })}
          </>
        ) : null}
      </p>
      <section className="usage-metrics">
        <UsageMetric value={compactCount(metrics.totalTokens)} label={copy.usageTotalTokens} />
        <UsageMetric value={compactCount(metrics.dailyPeak)} label={copy.usageDailyPeak} />
        <UsageMetric value={fill(copy.usageDays, { n: metrics.currentStreak })} label={copy.usageCurrentStreak} />
        <UsageMetric value={fill(copy.usageDays, { n: metrics.longestStreak })} label={copy.usageLongestStreak} />
        <UsageMetric value={compactCount(metrics.monthRequests)} label={copy.usageMonthRequests} />
      </section>
      <section className="group stacked usage-activity">
        <div className="usage-activity-head">
          <strong>{copy.usageActivity}</strong>
          <div className="usage-activity-tools">
            <div className="usage-granularity">
              <button className={granularity === "day" ? "on" : ""} type="button" onClick={() => setGranularity("day")}>
                {copy.usageDaily}
              </button>
              <button className={granularity === "week" ? "on" : ""} type="button" onClick={() => setGranularity("week")}>
                {copy.usageWeekly}
              </button>
            </div>
            <button className="ghost compact" type="button" disabled={loading} onClick={onRefresh}>
              {loading ? copy.refreshing : copy.usageRefresh}
            </button>
          </div>
        </div>
        {days.some((day) => day.requests || day.tokens) ? (
          <div className={`usage-heatmap${granularity === "week" ? " weekly" : ""}`} aria-label={copy.usageActivity}>
            {granularity === "day" ? (
              <div className="usage-heatmap-dows" aria-hidden>
                {[...copy.usageDow].map((label, index) =>
                  index % 2 === 1 ? <span key={`${label}-${index}`}>{label}</span> : <span key={`${label}-${index}`} />,
                )}
              </div>
            ) : null}
            <div className="usage-heatmap-body">
              <div className="usage-heatmap-months">
                {columns.map((column) => (
                  <span key={`m-${column.start}`}>{column.monthLabel}</span>
                ))}
              </div>
              {granularity === "day" ? (
                <div className="usage-heatmap-grid">
                  {columns.map((column) => (
                    <div key={column.start} className="usage-heatmap-col">
                      {column.days.map((day) => (
                        <i
                          key={day.date}
                          className={`usage-cell lv${heatmapLevel(day.tokens, maxTokens)}`}
                          title={fill(copy.usageCellHint, {
                            date: day.date,
                            tokens: compactCount(day.tokens),
                            requests: String(day.requests),
                          })}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="usage-week-bars">
                  {columns.map((column) => (
                    <i
                      key={`w-${column.start}`}
                      className={`usage-week-bar lv${heatmapLevel(column.tokens, maxWeek)}`}
                      style={{ height: `${Math.max(8, Math.round((column.tokens / maxWeek) * 72))}px` }}
                      title={fill(copy.usageCellHint, {
                        date: column.start,
                        tokens: compactCount(column.tokens),
                        requests: String(column.requests),
                      })}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="hint left">{copy.usageEmpty}</p>
        )}
      </section>
      {usage.models.length ? (
        <section className="group">
          <div className="settings-row">
            <div className="row-title">{copy.usageModels}</div>
          </div>
          {usage.models.map((item) => (
            <div key={item.model} className="settings-row usage-model">
              <div>
                <div className="row-title">{item.model}</div>
                <div className="usage-model-bar" aria-hidden>
                  <i style={{ width: `${Math.max(4, Math.round((item.tokens / modelMax) * 100))}%` }} />
                </div>
                <div className="row-detail">{compactCount(item.tokens)} Token</div>
              </div>
              <span className="pill">{fill(copy.usageRequests, { n: compactCount(item.requests) })}</span>
            </div>
          ))}
        </section>
      ) : null}
      {usage.error ? <p className="error">{usage.error}</p> : null}
    </>
  );
}

function UsageMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="usage-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function compactCount(value: number) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1_000_000_000) return `${trimNum(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trimNum(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimNum(n / 1_000)}K`;
  return String(Math.round(n));
}

function trimNum(value: number) {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(year, month - 1, day + days);
  return toDateKey(next);
}

function sundayOf(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - date.getDay());
  return toDateKey(date);
}

function fillDayRange(raw: RelayUsageDay[]) {
  const map = new Map(raw.map((item) => [item.date.slice(0, 10), item]));
  const today = toDateKey(new Date());
  const firstActive = [...map.values()]
    .filter((item) => item.requests || item.tokens)
    .sort((left, right) => left.date.localeCompare(right.date))[0]?.date;
  const keepStart = sundayOf(shiftKey(today, -8 * 7 + 1));
  const oldest = sundayOf(shiftKey(today, -13 * 7 + 1));
  let start = firstActive ? sundayOf(firstActive) : keepStart;
  if (start > keepStart) start = keepStart;
  if (start < oldest) start = oldest;
  const days: RelayUsageDay[] = [];
  for (let key = start; key <= today; key = shiftKey(key, 1)) {
    const found = map.get(key);
    days.push({ date: key, requests: found?.requests || 0, tokens: found?.tokens || 0 });
  }
  return days;
}

function computeMetrics(days: RelayUsageDay[], totalFallback?: number | null) {
  const today = toDateKey(new Date());
  const monthPrefix = today.slice(0, 7);
  let longest = 0;
  let run = 0;
  for (const day of days) {
    if (day.requests > 0) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  const byDate = new Map(days.map((day) => [day.date, day]));
  let current = 0;
  for (let key = today; ; key = shiftKey(key, -1)) {
    const day = byDate.get(key);
    if (!day || day.requests <= 0) break;
    current += 1;
    if (current > 400) break;
  }
  return {
    totalTokens: totalFallback || days.reduce((sum, day) => sum + day.tokens, 0),
    dailyPeak: days.reduce((max, day) => Math.max(max, day.tokens), 0),
    currentStreak: current,
    longestStreak: longest,
    monthRequests: days.filter((day) => day.date.startsWith(monthPrefix)).reduce((sum, day) => sum + day.requests, 0),
  };
}

function monthTitle(monthKey: string, lang: Lang) {
  const month = Number(monthKey.slice(5));
  if (lang === "en") {
    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] || "";
  }
  return `${month}月`;
}

function buildWeekColumns(days: RelayUsageDay[], lang: Lang) {
  const columns: Array<{ start: string; days: RelayUsageDay[]; tokens: number; requests: number; monthLabel: string }> = [];
  let previousMonth = "";
  for (let index = 0; index < days.length; index += 7) {
    const slice = days.slice(index, index + 7);
    if (!slice.length) continue;
    const monthKey = slice.find((day) => day.date.endsWith("-01"))?.date.slice(0, 7) || slice[0].date.slice(0, 7);
    const monthLabel = monthKey !== previousMonth ? monthTitle(monthKey, lang) : "";
    previousMonth = monthKey;
    columns.push({
      start: slice[0].date,
      days: slice,
      tokens: slice.reduce((sum, day) => sum + day.tokens, 0),
      requests: slice.reduce((sum, day) => sum + day.requests, 0),
      monthLabel,
    });
  }
  return columns;
}

function scaleMax(values: number[]) {
  const positive = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (!positive.length) return 1;
  return Math.max(positive[Math.floor((positive.length - 1) * 0.9)], positive[0]);
}

function heatmapLevel(value: number, max: number) {
  if (value <= 0 || max <= 0) return 0;
  if (value >= max * 0.75) return 4;
  if (value >= max * 0.5) return 3;
  if (value >= max * 0.25) return 2;
  return 1;
}
