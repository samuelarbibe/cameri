import { formatDuration } from "@/lib/dates";
import { OUTCOME_FILL, OUTCOME_LABEL } from "@/lib/status-colors";
import type { TestOutcome } from "@/lib/run-stats";
import type { DailyHistoryRow } from "@/trpc";

/**
 * A day per bar, outcomes stacked inside it.
 *
 * Hand-drawn with flex boxes rather than a charting library: the whole chart is
 * "N columns, each a stack of four proportional blocks", and pulling in a
 * charting runtime to express that would cost more bundle than the rest of the
 * page put together.
 */

/** Bottom-up: the good news forms the base and failures sit on top, where the eye goes. */
const STACK: Exclude<TestOutcome, "running">[] = ["passed", "skipped", "flaky", "failed"];

export type HistoryDay = {
  /** `YYYY-MM-DD`, in UTC, matching the server's bucket. */
  key: string;
  date: Date;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  total: number;
};

/**
 * Turns sparse server rows into one entry per day.
 *
 * The server only returns days that have data, which would otherwise draw a
 * misleading chart: three bars side by side look like three consecutive days
 * even when they are three weeks apart. Filling the gaps here — rather than in
 * SQL with a `generate_series` — keeps the window definition in one place.
 */
export function fillDays(rows: DailyHistoryRow[], days: number): HistoryDay[] {
  // The bucket arrives as `2026-08-19 00:00:00` — already truncated to a UTC
  // day, but with no zone on it, so `new Date(…)` would read it as local time
  // and shift every bar by a day for anyone not on UTC. The first ten
  // characters are the key we want; taking them avoids the round trip.
  const byKey = new Map(rows.map((row) => [String(row.day).slice(0, 10), row]));
  const out: HistoryDay[] = [];

  // Anchored on today in UTC, counting backwards, so the last bar is always
  // "today" however many days the caller asked for.
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today - offset * 86_400_000);
    const key = dayKey(date);
    const row = byKey.get(key);
    const passed = row?.passed ?? 0;
    const failed = row?.failed ?? 0;
    const flaky = row?.flaky ?? 0;
    const skipped = row?.skipped ?? 0;
    out.push({
      key,
      date,
      passed,
      failed,
      flaky,
      skipped,
      durationMs: row?.durationMs ?? 0,
      total: passed + failed + flaky + skipped,
    });
  }

  return out;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function TestHistoryChart({ days }: { days: HistoryDay[] }) {
  // One scale for the whole chart: a per-bar scale would make a day with one
  // run look as busy as a day with fifty.
  const peak = Math.max(1, ...days.map((day) => day.total));
  const withData = days.filter((day) => day.total > 0);

  if (withData.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        No runs of this test in the selected window.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-40 items-end gap-[2px]">
        {days.map((day) => (
          <DayBar key={day.key} day={day} peak={peak} />
        ))}
      </div>

      <div className="text-muted-foreground flex justify-between text-[11px] tabular-nums">
        <span>{formatDay(days[0]?.date)}</span>
        <span>{formatDay(days.at(-1)?.date)}</span>
      </div>

      <Legend days={withData} />
    </div>
  );
}

function DayBar({ day, peak }: { day: HistoryDay; peak: number }) {
  const height = day.total === 0 ? 0 : Math.max(4, (day.total / peak) * 100);

  const title = [
    day.date.toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" }),
    day.total === 0
      ? "no runs"
      : STACK.filter((outcome) => day[outcome] > 0)
          .map((outcome) => `${day[outcome]} ${OUTCOME_LABEL[outcome].toLowerCase()}`)
          .join(", "),
    day.durationMs > 0 ? `avg ${formatDuration(day.durationMs)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    // `justify-end` so the stack grows from the baseline up, and the empty
    // remainder of the track stays clickable for the tooltip.
    <div
      className="hover:bg-accent/40 flex h-full flex-1 cursor-default flex-col justify-end rounded-sm transition-colors"
      title={title}
    >
      <div
        className="flex w-full flex-col-reverse overflow-hidden rounded-sm"
        style={{ height: `${height}%` }}
      >
        {STACK.map((outcome) =>
          day[outcome] > 0 ? (
            <div
              key={outcome}
              className={OUTCOME_FILL[outcome]}
              style={{ flexGrow: day[outcome] }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function Legend({ days }: { days: HistoryDay[] }) {
  const totals = STACK.map((outcome) => ({
    outcome,
    count: days.reduce((sum, day) => sum + day[outcome], 0),
  })).filter((entry) => entry.count > 0);

  const runs = totals.reduce((sum, entry) => sum + entry.count, 0);
  const failures = totals
    .filter((entry) => entry.outcome === "failed" || entry.outcome === "flaky")
    .reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {totals.map((entry) => (
        <span key={entry.outcome} className="text-muted-foreground flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${OUTCOME_FILL[entry.outcome]}`} />
          {OUTCOME_LABEL[entry.outcome]}
          <span className="text-foreground tabular-nums">{entry.count}</span>
        </span>
      ))}
      {runs > 0 ? (
        <span className="text-muted-foreground ml-auto tabular-nums">
          {((failures / runs) * 100).toFixed(1)}% unhealthy over {runs} runs
        </span>
      ) : null}
    </div>
  );
}

function formatDay(date: Date | undefined): string {
  if (!date) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
