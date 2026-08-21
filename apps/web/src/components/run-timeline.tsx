import {
  TimelineContext,
  useItem,
  useRow,
  useTimelineContext,
  type ItemDefinition,
  type OnRangeChanged,
  type Range,
  type Span,
  type UsePanStrategy,
} from "dnd-timeline";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatClock, formatDuration, toTime } from "@/lib/dates";
import { STATUS_FILL } from "@/lib/status-colors";
import type { RunAttempt, RunDetail } from "@/trpc";

const SIDEBAR_WIDTH = 152;
/** Width of the worker-label column inside the sidebar. */
const WORKER_LABEL_WIDTH = 34;
const LANE_HEIGHT = 26;
/** Breathing room either side of a finished run so the first and last bars aren't flush. */
const PAD_RATIO = 0.02;

/**
 * A live run is scaled to a fixed window rather than to itself.
 *
 * Fitting the range to "now" means the whole chart creeps left on every tick and
 * nothing holds still long enough to read. Instead the window is a whole number
 * of 30-minute steps anchored at the run start, and it only grows once the run
 * reaches the halfway mark of the current one — so there is always at least
 * fifteen minutes of room ahead of the now-line, and a jump happens at most
 * every fifteen minutes instead of four times a second.
 *
 * The payoff is that a finished bar, once drawn, stays exactly where it is. The
 * only things that move are the in-flight bars and the playhead they chase.
 */
const LIVE_STEP_MS = 30 * 60_000;

/**
 * A fixed inset rather than a proportional one: a percentage of a window that
 * doubles would nudge every bar sideways at each growth step, which is the
 * shuffling this whole scheme exists to avoid.
 */
const LIVE_PAD_MS = 15_000;

function liveWindowEnd(start: number, at: number): number {
  const steps = 1 + Math.floor(Math.max(at - start, 0) / (LIVE_STEP_MS / 2));
  return start + steps * LIVE_STEP_MS;
}

/**
 * Pan and zoom off the wheel.
 *
 * The stock `useWheelStrategy` ignores every wheel event that does not have
 * ⌘/Ctrl held, which leaves a zoomed-in timeline with no way to move sideways.
 * This maps the gestures people already have from maps and Gantt charts:
 *
 *   horizontal wheel or Shift + wheel  → pan
 *   ⌘/Ctrl + wheel                     → zoom about the cursor
 *   plain vertical wheel               → not touched, so the page still scrolls
 *
 * That last case matters: swallowing it would turn the chart into a scroll trap
 * for anyone reading down the page.
 */
const usePanStrategy: UsePanStrategy = (timelineBag, onPanEnd) => {
  useLayoutEffect(() => {
    const element = timelineBag.timelineRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      const zooming = event.ctrlKey || event.metaKey;
      // A trackpad reports a sideways swipe as deltaX; a wheel mouse with Shift
      // held reports it as deltaY. Both mean the same thing here.
      const panX = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX;
      if (!zooming && panX === 0) return;

      event.preventDefault();
      onPanEnd({
        clientX: event.clientX,
        clientY: event.clientY,
        deltaX: zooming ? 0 : panX,
        deltaY: zooming ? event.deltaY : 0,
      });
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [onPanEnd, timelineBag.timelineRef]);
};

/**
 * How often the now-line and the in-flight bars advance.
 *
 * Fast enough that a growing bar looks continuous rather than stepped, slow
 * enough that it is nowhere near a frame budget. It only runs while something is
 * actually in flight, so a finished run costs nothing.
 */
const TICK_MS = 250;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Re-read immediately: the interval's first tick is a whole period away, and
    // the mounted value may be stale if the run only just went live.
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  return now;
}

type TimelineItem = ItemDefinition & { attempt: RunAttempt };

/**
 * Where a bar actually ends.
 *
 * A running attempt has no duration — it has not finished, so there is nothing
 * to measure — and is instead drawn from its start to the current time. Every
 * tick widens it by exactly as much as the clock moved, which is what makes it
 * track the now-line until a terminal status replaces it.
 *
 * Computed here at render rather than baked into `buildLanes`, so a tick costs a
 * few arithmetic ops on the visible bars instead of rebuilding every lane.
 */
function spanOf(item: TimelineItem, now: number): Span {
  if (item.attempt.status !== "running") return item.span;
  return { start: item.span.start, end: Math.max(now, item.span.start + 1) };
}

type WorkerLane = { slot: number; items: TimelineItem[] };
type ShardLane = { id: string; shardIndex: number; workers: WorkerLane[] };

type RunTimelineProps = {
  detail: RunDetail;
  window: { start: number; end: number };
  onSelectAttempt: (attempt: RunAttempt) => void;
  selectedTestRef?: string;
};

/**
 * One row per shard, one subrow per worker inside it, one bar per attempt placed
 * at the time it ran and coloured by status. This is the view that answers "why
 * did a 40-second suite take four minutes" — idle workers, a straggler tail, or
 * one shard doing all the work are obvious here and invisible in a list.
 *
 * Subrows are keyed on `parallelIndex`, which is numbered from zero *within each
 * shard*, so worker 0 means a different machine in every row. That is why the
 * grouping is shard-first rather than a flat list of workers.
 *
 * Built on dnd-timeline for the range/pan/zoom machinery. Items are `disabled`
 * because nothing here is editable: a test ran when it ran.
 */
export function RunTimeline({
  detail,
  window,
  onSelectAttempt,
  selectedTestRef,
}: RunTimelineProps) {
  // The run poll is on a 5s cycle, so `window.end` lags reality on a live run.
  // The clock is the authority for where "now" is between polls.
  const live = detail.run.completedAt === null;
  const now = useNow(live);

  // Both inputs are snapped to the step grid, so `end` only takes a new value at
  // a growth step — which is what keeps `initial` referentially stable across
  // the ticks in between. When the run finishes the view snaps to the run's real
  // extent, and the whole thing stops moving.
  const end = live
    ? Math.max(liveWindowEnd(window.start, now), liveWindowEnd(window.start, window.end))
    : window.end;
  const padding = live ? LIVE_PAD_MS : (end - window.start) * PAD_RATIO;

  const initial = useMemo<Range>(
    () => ({ start: window.start - padding, end: end + padding }),
    [window.start, end, padding],
  );

  // Two-state range rather than one. While `override` is null the view *is*
  // `initial`, so on a live run it widens with the clock and the now-line stays
  // on screen by construction. The first pan or zoom pins it, because a range
  // that kept sliding out from under someone reading it would be unusable.
  const [override, setOverride] = useState<Range | null>(null);
  const range = override ?? initial;

  // Read through a ref so the callback can stay stable across the clock ticks.
  // dnd-timeline keys its wheel listener off this function's identity, and
  // re-binding it four times a second is churn for nothing.
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const onRangeChanged = useCallback<OnRangeChanged>(
    (update) => setOverride((prev) => update(prev ?? initialRef.current)),
    [],
  );

  const lanes = useMemo(() => buildLanes(detail), [detail]);

  if (detail.attempts.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        No attempts were recorded for this run.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <Legend live={live} />
        <span className="ml-auto hidden sm:inline">
          Shift + scroll to pan · ⌘/Ctrl + scroll to zoom
        </span>
        <Button variant="outline" size="sm" onClick={() => setOverride(null)} disabled={!override}>
          {/* Same button, two truthful labels: on a live run letting go of the
              range also hands the view back to the clock. */}
          {live ? "Follow live" : "Reset zoom"}
        </Button>
      </div>

      <div className="bg-card overflow-hidden rounded-lg border p-3">
        <TimelineContext
          range={range}
          onRangeChanged={onRangeChanged}
          onResizeEnd={() => {}}
          usePanStrategy={usePanStrategy}
          sidebarWidth={SIDEBAR_WIDTH}
        >
          <TimelineBody
            lanes={lanes}
            now={now}
            live={live}
            onSelectAttempt={onSelectAttempt}
            selectedTestRef={selectedTestRef}
          />
        </TimelineContext>
      </div>
    </div>
  );
}

/**
 * Worker subrows are derived from the attempts rather than declared anywhere:
 * how many slots a shard actually used is only knowable from what ran on them.
 * A shard that reported nothing still gets one empty subrow so a dead machine
 * shows up as a gap instead of vanishing from the chart.
 */
function buildLanes(detail: RunDetail): ShardLane[] {
  const byShard = new Map<string, Map<number, TimelineItem[]>>();
  for (const shard of detail.shards) byShard.set(shard.id, new Map());

  for (const attempt of detail.attempts) {
    const workers = byShard.get(attempt.shardId) ?? new Map<number, TimelineItem[]>();
    byShard.set(attempt.shardId, workers);
    const start = toTime(attempt.startedAt);
    const item: TimelineItem = {
      id: attempt.id,
      rowId: attempt.shardId,
      disabled: true,
      // A zero-length span collapses to nothing, so instant tests get one
      // millisecond of width and a CSS `min-width` keeps them clickable.
      span: { start, end: start + Math.max(attempt.durationMs, 1) },
      attempt,
    };
    const lane = workers.get(attempt.parallelIndex);
    if (lane) lane.push(item);
    else workers.set(attempt.parallelIndex, [item]);
  }

  const shardIndexById = new Map(detail.shards.map((shard) => [shard.id, shard.shardIndex]));

  return [...byShard.entries()]
    .map(([id, workers]) => ({
      id,
      shardIndex: shardIndexById.get(id) ?? 0,
      workers:
        workers.size === 0
          ? [{ slot: 0, items: [] }]
          : [...workers.entries()]
              .map(([slot, items]) => ({ slot, items }))
              .sort((a, b) => a.slot - b.slot),
    }))
    .sort((a, b) => a.shardIndex - b.shardIndex);
}

function TimelineBody({
  lanes,
  now,
  live,
  onSelectAttempt,
  selectedTestRef,
}: {
  lanes: ShardLane[];
  now: number;
  live: boolean;
  onSelectAttempt: (attempt: RunAttempt) => void;
  selectedTestRef?: string;
}) {
  const { setTimelineRef, style, range, valueToPixels } = useTimelineContext();

  return (
    <div ref={setTimelineRef} style={style} className="select-none">
      <TimeAxis range={range} />
      {live ? <NowLine now={now} range={range} /> : null}
      {lanes.map((lane) => (
        <ShardRow
          key={lane.id}
          lane={lane}
          range={range}
          now={now}
          valueToPixels={valueToPixels}
          onSelectAttempt={onSelectAttempt}
          selectedTestRef={selectedTestRef}
        />
      ))}
    </div>
  );
}

/**
 * The playhead every running bar is growing towards.
 *
 * Positioned in `calc` off the container's own width rather than through
 * `valueToPixels`, for the same reason the axis ticks are: no measured width
 * means it cannot drift out of step with the bars after a resize. The sidebar is
 * subtracted first because the chart area starts where the labels end.
 */
function NowLine({ now, range }: { now: number; range: Range }) {
  const fraction = (now - range.start) / (range.end - range.start);
  if (fraction < 0 || fraction > 1) return null;

  return (
    <div
      aria-hidden
      // `pointer-events-none` so it never steals a click from the bar beneath it.
      className="pointer-events-none absolute inset-y-0 z-10 w-px bg-sky-500/70"
      style={{ left: `calc(${SIDEBAR_WIDTH}px + (100% - ${SIDEBAR_WIDTH}px) * ${fraction})` }}
    />
  );
}

/**
 * Ticks are placed as a percentage of the visible range rather than through
 * `valueToPixels`, so the axis needs no measured width and stays correct through
 * a resize without a re-render.
 */
function TimeAxis({ range }: { range: Range }) {
  const { ticks, step } = useMemo(() => niceTicks(range), [range]);
  const span = range.end - range.start;

  return (
    <div className="flex" style={{ paddingLeft: SIDEBAR_WIDTH }}>
      <div className="relative h-6 flex-1">
        {ticks.map((tick) => (
          <div
            key={tick}
            className="text-muted-foreground absolute top-0 -translate-x-1/2 text-[10px] tabular-nums"
            style={{ left: `${((tick - range.start) / span) * 100}%` }}
          >
            {formatClock(tick, step < 1000)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Round intervals only — 100ms, 1s, 30s, 1m … — so labels land on readable
 * times. The sub-second steps matter once someone zooms into a single test.
 */
const TICK_STEPS = [
  100, 250, 500, 1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000,
];

function niceTicks(range: Range, target = 6): { ticks: number[]; step: number } {
  const span = range.end - range.start;
  const step = TICK_STEPS.find((candidate) => span / candidate <= target) ?? 3_600_000;
  const first = Math.ceil(range.start / step) * step;
  const ticks: number[] = [];
  for (let tick = first; tick < range.end; tick += step) ticks.push(tick);
  return { ticks, step };
}

function ShardRow({
  lane,
  range,
  now,
  valueToPixels,
  onSelectAttempt,
  selectedTestRef,
}: {
  lane: ShardLane;
  range: Range;
  now: number;
  valueToPixels: (value: number) => number;
  onSelectAttempt: (attempt: RunAttempt) => void;
  selectedTestRef?: string;
}) {
  const { setNodeRef, rowWrapperStyle, rowStyle, rowSidebarStyle } = useRow({ id: lane.id });

  return (
    <div style={rowWrapperStyle} className="border-t py-1.5 first:border-t-0">
      {/* Two columns: the shard name centred against the whole row, then one
          worker label per subrow. Same height and gap as the subrows opposite,
          which is what keeps the two sides lined up. */}
      <div style={rowSidebarStyle} className="items-stretch pr-2">
        <div className="flex flex-1 items-center">
          <span className="truncate text-xs font-medium">Shard {lane.shardIndex}</span>
        </div>
        <div
          className="text-muted-foreground flex flex-col gap-0.5 text-[10px]"
          style={{ width: WORKER_LABEL_WIDTH }}
        >
          {lane.workers.map((worker) => (
            <span
              key={worker.slot}
              className="flex items-center tabular-nums"
              style={{ height: LANE_HEIGHT }}
              title={`Worker ${worker.slot} · ${worker.items.length} attempts`}
            >
              W{worker.slot}
            </span>
          ))}
        </div>
      </div>
      <div ref={setNodeRef} style={rowStyle} className="gap-0.5">
        {lane.workers.map((worker) => (
          <div key={worker.slot} className="relative" style={{ height: LANE_HEIGHT }}>
            {worker.items
              // Resolved before the filter, not inside the bar: a running
              // attempt's stored span is a single millisecond wide, so filtering
              // on it would hide an in-flight bar that started off-screen and has
              // since grown well into view.
              .map((item) => ({ item, span: spanOf(item, now) }))
              // Off-screen bars are clipped by the timeline anyway; skipping them
              // keeps a few thousand attempts from becoming a few thousand nodes.
              .filter(({ span }) => span.end > range.start && span.start < range.end)
              .map(({ item, span }) => (
                <AttemptBar
                  key={item.id}
                  item={item}
                  span={span}
                  valueToPixels={valueToPixels}
                  onSelect={onSelectAttempt}
                  dimmed={
                    selectedTestRef !== undefined && item.attempt.testRef !== selectedTestRef
                  }
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Below this the title is a couple of clipped letters, which reads as noise. */
const LABEL_MIN_WIDTH = 44;

function AttemptBar({
  item,
  span,
  valueToPixels,
  onSelect,
  dimmed,
}: {
  item: TimelineItem;
  /** The drawn span — the stored one for a finished attempt, `start → now` for a running one. */
  span: Span;
  valueToPixels: (value: number) => number;
  onSelect: (attempt: RunAttempt) => void;
  dimmed: boolean;
}) {
  // `attributes` is deliberately dropped. dnd-kit puts `role="button"` and
  // `aria-disabled="true"` on the wrapper for drag affordance, which here would
  // nest a real button inside a disabled one — unclickable to a screen reader
  // and to Playwright. Only the positioning styles are wanted.
  const { setNodeRef, itemStyle, itemContentStyle } = useItem({
    id: item.id,
    span,
    disabled: true,
  });
  const { attempt } = item;
  const running = attempt.status === "running";
  const elapsed = span.end - span.start;

  return (
    <div
      ref={setNodeRef}
      style={{
        ...itemStyle,
        // Each tick moves a running bar's edge by a fraction of a pixel, and
        // stepping straight to it reads as a stutter. Interpolating over exactly
        // one tick, linearly, turns the sequence into one continuous slide —
        // ease would make each step visibly start and stop.
        //
        // Width only: `left` also lives in `itemStyle` and animating that would
        // make a pan or a zoom lag behind the cursor.
        ...(running ? { transition: `width ${TICK_MS}ms linear` } : {}),
      }}
      className="min-w-[3px] py-[3px]"
    >
      <div style={itemContentStyle}>
        {/* `h-full` + `items-center` rather than a line-height: the bar's height
            comes from the lane, so centring the label against the box is the
            only thing that keeps it off the edges at any size. */}
        <button
          type="button"
          onClick={() => onSelect(attempt)}
          title={[
            attempt.title,
            attempt.file,
            `${attempt.status}${attempt.retry > 0 ? ` (retry ${attempt.retry})` : ""}`,
            // A running attempt's stored duration is zero, so the honest number
            // is how long it has been going, measured off the same clock the bar
            // is drawn against.
            running ? `${formatDuration(elapsed)} so far` : formatDuration(attempt.durationMs),
          ].join("\n")}
          // `motion-safe`, because a bar that never stops moving is exactly what
          // someone who turned animation off was turning off.
          className={`focus-visible:ring-ring flex h-full w-full cursor-pointer items-center overflow-hidden rounded-sm px-1.5 text-left transition-opacity focus-visible:ring-2 focus-visible:outline-none ${STATUS_FILL[attempt.status]} ${dimmed ? "opacity-30" : ""} ${running ? "motion-safe:animate-live" : ""}`}
        >
          {valueToPixels(elapsed) >= LABEL_MIN_WIDTH ? (
            // `truncate`, so a bar too narrow for the whole title ends in an
            // ellipsis instead of a word chopped mid-letter.
            <span className="truncate text-[10px] leading-none font-medium text-white/95">
              {attempt.title}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

const LEGEND = [
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["timedOut", "Timed out"],
  ["skipped", "Skipped"],
] as const;

/** `running` only earns a swatch on a run that actually has some. */
function Legend({ live }: { live: boolean }) {
  const entries = live ? [...LEGEND, ["running", "Running"] as const] : LEGEND;

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {entries.map(([status, label]) => (
        <span key={status} className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${STATUS_FILL[status].split(" ")[0]}`} />
          {label}
        </span>
      ))}
    </span>
  );
}
