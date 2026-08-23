import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { AttemptLogs } from "@/components/attempt-logs";
import { TestHistoryChart, fillDays } from "@/components/test-history-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatClock, formatDuration, relativeTime, toTime } from "@/lib/dates";
import { suitePath, type TestOutcome } from "@/lib/run-stats";
import { attemptTraceUrl } from "@/lib/trace";
import { OUTCOME_BADGE, OUTCOME_LABEL, STATUS_FILL } from "@/lib/status-colors";
import { trpc, type RunAttempt } from "@/trpc";

export const TEST_TABS = ["attempts", "logs", "history"] as const;
export type TestTab = (typeof TEST_TABS)[number];

/** Windows the history chart offers. 30 is the default: long enough to show a trend. */
const HISTORY_WINDOWS = [7, 30, 90] as const;

/** Identity of the test, wherever the caller found it. */
export type SheetTest = {
  testRef: string;
  title: string;
  titlePath: string[];
  file: string;
  projectName?: string;
  /** Only a run knows this — across runs a test has no single outcome. */
  outcome?: TestOutcome | undefined;
};

/**
 * One attempt, normalised.
 *
 * The two callers hold different rows — a run's attempts carry shard and worker
 * placement, the explorer's carry which run they came from — so both sets of
 * context are optional and each card renders whichever it was given.
 */
export type SheetAttempt = {
  id: string;
  status: RunAttempt["status"];
  retry: number;
  durationMs: number;
  startedAt: string | Date;
  errorMessage?: string | null;
  /** Whether there is a trace to open. The URL is derived from the id. */
  hasTrace?: boolean | undefined;
  /** Placement within one run. */
  shardIndex?: number | undefined;
  parallelIndex?: number | undefined;
  workerIndex?: number | undefined;
  /** Which run this came from. Omitted when the whole sheet is inside one. */
  run?: { id: string; key: string; branch: string | null } | undefined;
};

type TestDetailSheetProps = {
  test: SheetTest | null;
  /** Ordered oldest-first for a run, newest-first across runs. */
  attempts: SheetAttempt[];
  attemptsLoading?: boolean;
  /** "Attempts" inside a run; "Recent runs" in the explorer. */
  attemptsLabel?: string;
  /** Key/value pairs above the attempt list — whatever the caller has to hand. */
  stats?: { label: string; value: string }[];
  /** Which attempt to highlight, and whose logs the Logs tab shows. */
  focusAttemptId?: string | undefined;
  /**
   * Which attempt to fall back to when nothing is focused. The caller decides,
   * because "the interesting one" is the last retry inside a run and the most
   * recent execution in the explorer — opposite ends of the list.
   */
  defaultAttemptId?: string | undefined;
  /** Link target for the project, so cross-run attempts can jump to their run. */
  projectSlug?: string | undefined;
  tab: TestTab;
  onTabChange: (tab: TestTab) => void;
  onFocusAttempt: (attemptId: string) => void;
  onClose: () => void;
};

/**
 * Detail panel for one test.
 *
 * Three tabs, split by *what question you are asking* rather than by where the
 * data comes from: what happened (Attempts), what the test printed while it
 * happened (Logs), and whether this is normal for this test (History).
 *
 * The same panel serves the run pages and the Test Explorer. Only the attempt
 * list differs — a run's retries, or the last N attempts across every run — and
 * that is a prop, because a second sheet with the same three tabs would drift
 * from this one within a week.
 */
export function TestDetailSheet({
  test,
  attempts,
  attemptsLoading = false,
  attemptsLabel = "Attempts",
  stats,
  focusAttemptId,
  defaultAttemptId,
  projectSlug,
  tab,
  onTabChange,
  onFocusAttempt,
  onClose,
}: TestDetailSheetProps) {
  const suite = test ? suitePath(test) : "";

  // Logs are per attempt, so the tab needs one even when the sheet was opened
  // from a list that only knows the test.
  const shownAttemptId = focusAttemptId ?? defaultAttemptId;

  return (
    <Sheet open={test !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        {test ? (
          <>
            <SheetHeader className="gap-2 border-b">
              <div className="flex items-start gap-2">
                {test.outcome ? (
                  <Badge
                    variant="outline"
                    className={`mt-0.5 shrink-0 ${OUTCOME_BADGE[test.outcome]}`}
                  >
                    {OUTCOME_LABEL[test.outcome]}
                  </Badge>
                ) : null}
                <SheetTitle className="text-base leading-snug">{test.title}</SheetTitle>
              </div>
              <SheetDescription className="font-mono text-xs">
                {test.file}
                {suite ? ` › ${suite}` : ""}
              </SheetDescription>
            </SheetHeader>

            <Tabs
              value={tab}
              onValueChange={(next) => onTabChange(next as TestTab)}
              className="flex min-h-0 flex-1 flex-col gap-0"
            >
              <div className="border-b px-4 py-2">
                <TabsList>
                  <TabsTrigger value="attempts">
                    {attemptsLabel}
                    <span className="text-muted-foreground ml-1 tabular-nums">
                      {attempts.length}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                </TabsList>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <TabsContent value="attempts" className="m-0">
                  {stats && stats.length > 0 ? (
                    <dl className="grid grid-cols-3 gap-4 border-b px-4 py-4 text-sm">
                      {stats.map((stat) => (
                        <Field key={stat.label} label={stat.label} value={stat.value} />
                      ))}
                    </dl>
                  ) : null}
                  <div className="flex flex-col gap-2 px-4 py-4">
                    {attemptsLoading ? (
                      <Skeleton className="h-24 w-full" />
                    ) : attempts.length === 0 ? (
                      <p className="text-muted-foreground py-8 text-center text-sm">
                        No attempts recorded.
                      </p>
                    ) : (
                      attempts.map((attempt) => (
                        <AttemptCard
                          key={attempt.id}
                          attempt={attempt}
                          projectSlug={projectSlug}
                          focused={attempt.id === shownAttemptId}
                          onShowLogs={() => {
                            onFocusAttempt(attempt.id);
                            onTabChange("logs");
                          }}
                        />
                      ))
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="logs" className="m-0">
                  <LogsTab
                    attempts={attempts}
                    attemptId={shownAttemptId}
                    onSelectAttempt={onFocusAttempt}
                  />
                </TabsContent>

                <TabsContent value="history" className="m-0">
                  <HistoryTab testRef={test.testRef} />
                </TabsContent>
              </div>
            </Tabs>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Logs for one attempt, with a picker when there is more than one.
 *
 * The picker exists because on a flaky test the interesting logs are almost
 * never on the attempt that decided the outcome — they are on the one that
 * failed first.
 */
function LogsTab({
  attempts,
  attemptId,
  onSelectAttempt,
}: {
  attempts: SheetAttempt[];
  attemptId: string | undefined;
  onSelectAttempt: (attemptId: string) => void;
}) {
  const query = useQuery({
    queryKey: ["attempt", attemptId],
    queryFn: () => trpc.tests.attempt.query({ attemptId: attemptId ?? "" }),
    enabled: attemptId !== undefined,
    // A finished attempt is immutable; a running one gains output as it goes.
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3_000 : false),
  });

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {attempts.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground mr-1 text-xs">Attempt</span>
          {attempts.map((attempt) => (
            <Button
              key={attempt.id}
              size="sm"
              variant={attempt.id === attemptId ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={() => onSelectAttempt(attempt.id)}
            >
              <span
                className={`mr-1.5 size-2 rounded-full ${STATUS_FILL[attempt.status].split(" ")[0]}`}
              />
              {attemptLabel(attempt)}
            </Button>
          ))}
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : query.data ? (
        <AttemptLogs detail={query.data} />
      ) : (
        <p className="text-muted-foreground py-8 text-center text-sm">
          No output recorded for this attempt.
        </p>
      )}
    </div>
  );
}

/** Day-by-day outcome distribution for this test, across every run. */
function HistoryTab({ testRef }: { testRef: string }) {
  const [days, setDays] = useState<number>(30);

  // Re-anchor on the test, not just on the window: switching tests inside the
  // same sheet should not carry the previous test's chosen range onto a chart
  // that may have far less data.
  useEffect(() => setDays(30), [testRef]);

  const query = useQuery({
    queryKey: ["test-history", testRef, days],
    queryFn: () => trpc.tests.dailyHistory.query({ testRef, days }),
  });

  const filled = useMemo(() => fillDays(query.data ?? [], days), [query.data, days]);

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center gap-1.5">
        {HISTORY_WINDOWS.map((window) => (
          <Button
            key={window}
            size="sm"
            variant={window === days ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setDays(window)}
          >
            {window}d
          </Button>
        ))}
      </div>

      {query.isLoading ? <Skeleton className="h-40 w-full" /> : <TestHistoryChart days={filled} />}
    </div>
  );
}

function attemptLabel(attempt: SheetAttempt): string {
  return attempt.retry === 0 ? "First run" : `Retry ${attempt.retry}`;
}

function AttemptCard({
  attempt,
  projectSlug,
  focused,
  onShowLogs,
}: {
  attempt: SheetAttempt;
  projectSlug: string | undefined;
  focused: boolean;
  onShowLogs: () => void;
}) {
  return (
    <div
      // Focus is a tint and a coloured edge rather than a ring: the ring drew a
      // second grey rectangle just inside the border, which read as a rendering
      // glitch rather than as "this is the one you are looking at".
      className={`rounded-lg border p-3 transition-colors ${
        focused ? "border-primary/40 bg-primary/[0.04]" : "hover:bg-muted/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`size-2 shrink-0 rounded-full ${STATUS_FILL[attempt.status].split(" ")[0]}`}
        />
        <span className="text-sm font-medium">{attemptLabel(attempt)}</span>
        <span className="text-muted-foreground text-xs">{attempt.status}</span>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {formatDuration(attempt.durationMs)}
        </span>
      </div>

      {attempt.run ? (
        // Explorer mode: which run this came from is the context that matters,
        // and it is the one thing the sheet cannot get you back to otherwise.
        <p className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
          {projectSlug ? (
            <Link
              to={`/${projectSlug}/runs/${attempt.run.id}`}
              className="font-mono hover:underline"
            >
              {attempt.run.key}
            </Link>
          ) : (
            <span className="font-mono">{attempt.run.key}</span>
          )}
          {attempt.run.branch ? <span>· {attempt.run.branch}</span> : null}
          <span>· {relativeTime(attempt.startedAt)}</span>
        </p>
      ) : (
        <p className="text-muted-foreground mt-1.5 text-xs tabular-nums">
          {attempt.shardIndex !== undefined ? `Shard ${attempt.shardIndex} · ` : ""}
          worker {attempt.parallelIndex}
          {/* Only worth showing when it disagrees with the slot — that means a
              worker died and Playwright started a replacement. */}
          {attempt.workerIndex !== attempt.parallelIndex
            ? ` (worker index ${attempt.workerIndex})`
            : ""}{" "}
          · started {formatClock(toTime(attempt.startedAt), true)}
        </p>
      )}

      {attempt.errorMessage ? (
        <pre className="text-destructive bg-destructive/5 mt-2 max-h-56 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
          {attempt.errorMessage}
        </pre>
      ) : null}
      {/* Pulled out to the card's padding edge, so the actions line up with the
          text above them instead of sitting a button's worth of padding in. */}
      <div className="-mx-2 mt-2 flex flex-wrap items-center gap-0.5">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onShowLogs}>
          View logs
        </Button>
        {attempt.hasTrace ? (
          // Straight to the viewer, rather than by way of the Logs tab's
          // attachment list: on a failure the trace is the first thing worth
          // opening, and it was three clicks and a scroll down.
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" asChild>
            <a href={attemptTraceUrl(attempt.id)} target="_blank" rel="noreferrer">
              <ExternalLinkIcon className="size-3" />
              Open trace
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}
