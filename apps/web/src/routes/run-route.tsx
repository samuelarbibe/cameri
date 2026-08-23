import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router";
import { RunFiles } from "@/components/run-files";
import { RunSummary } from "@/components/run-summary";
import { RunTimeline } from "@/components/run-timeline";
import { TEST_TABS, TestDetailSheet, type TestTab } from "@/components/test-detail-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDuration } from "@/lib/dates";
import {
  countOutcomes,
  groupByFile,
  groupByTest,
  runWindow,
  type TestGroup,
} from "@/lib/run-stats";
import { trpc } from "@/trpc";

const TABS = ["files", "timeline"] as const;
type Tab = (typeof TABS)[number];

/**
 * Everything about this page is addressable, so all of its view state lives in
 * the query string rather than in component state:
 *
 *   /:project/runs/:runId?tab=timeline&test=<testRef>&attempt=<attemptId>&testTab=logs
 *
 * That makes "look at this failure" a link someone can paste into a review, and
 * it also means the browser Back button closes the detail sheet.
 */
export function RunRoute() {
  const { projectSlug, runId = "" } = useParams();
  const [params, setParams] = useSearchParams();

  const query = useQuery({
    // Shared with ShellLayout, which reads the run key for the breadcrumb.
    queryKey: ["run", runId],
    queryFn: () => trpc.runs.get.query({ runId }),
    // A finished run never changes, so only poll while it is still going.
    refetchInterval: (q) => (q.state.data?.run.completedAt ? false : 5_000),
  });

  const detail = query.data;

  const tabParam = params.get("tab");
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "files";
  // Only ids are read back out — the `TestGroup` is looked up fresh on every
  // render, so a poll that replaces the data can't pin a stale object open.
  const selectedTestRef = params.get("test") ?? undefined;
  const focusAttemptId = params.get("attempt") ?? undefined;
  const testTabParam = params.get("testTab");
  const testTab: TestTab = TEST_TABS.includes(testTabParam as TestTab)
    ? (testTabParam as TestTab)
    : "attempts";

  /** Patches the query string in place; a null value drops the key. */
  const patchParams = (patch: Record<string, string | null>, replace: boolean) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace },
    );
  };

  // A tab is a view toggle, not a destination, so it replaces rather than
  // stacking a history entry. Selecting a test pushes, so Back closes the sheet.
  const selectTest = (testRef: string, attemptId?: string) =>
    patchParams({ test: testRef, attempt: attemptId ?? null }, false);

  const derived = useMemo(() => {
    if (!detail) return null;
    const tests = groupByTest(detail.attempts);
    return {
      counts: countOutcomes(tests),
      files: groupByFile(tests),
      window: runWindow(detail),
      byTestRef: new Map(tests.map((test) => [test.testRef, test])),
      shardIndexById: new Map(detail.shards.map((shard) => [shard.id, shard.shardIndex])),
    };
  }, [detail]);

  if (query.error) {
    return (
      <div className="py-12 text-center">
        <p className="text-destructive text-sm font-medium">Could not load run</p>
        <p className="text-muted-foreground mt-1 text-sm">{query.error.message}</p>
      </div>
    );
  }

  if (query.isLoading || !detail || !derived) {
    return query.isLoading ? <RunSkeleton /> : <NotFound />;
  }

  return (
    <div className="flex flex-col gap-6">
      <RunSummary detail={detail} counts={derived.counts} window={derived.window} />

      <Tabs value={tab} onValueChange={(next) => patchParams({ tab: next }, true)}>
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>
        <TabsContent value="files" className="mt-4">
          <RunFiles
            files={derived.files}
            onSelectTest={(test) => selectTest(test.testRef)}
            selectedTestRef={selectedTestRef}
          />
        </TabsContent>
        <TabsContent value="timeline" className="mt-4">
          <RunTimeline
            detail={detail}
            window={derived.window}
            // From the timeline we know which bar was clicked, so the sheet can
            // highlight that attempt rather than just the test it belongs to.
            onSelectAttempt={(attempt) => selectTest(attempt.testRef, attempt.id)}
            selectedTestRef={selectedTestRef}
          />
        </TabsContent>
      </Tabs>

      <TestDetailSheet
        {...runSheetProps(
          (selectedTestRef ? derived.byTestRef.get(selectedTestRef) : undefined) ?? null,
          derived.shardIndexById,
        )}
        focusAttemptId={focusAttemptId}
        projectSlug={projectSlug}
        tab={testTab}
        // Both replace: moving around inside an open sheet is a view change, and
        // Back should close the sheet rather than walk its tabs in reverse.
        onTabChange={(next) => patchParams({ testTab: next }, true)}
        onFocusAttempt={(attemptId) => patchParams({ attempt: attemptId }, true)}
        onClose={() => patchParams({ test: null, attempt: null, testTab: null }, false)}
      />
    </div>
  );
}

/**
 * A run's `TestGroup` as the detail sheet wants it.
 *
 * The sheet is shared with the Test Explorer, which has attempts from many runs
 * and no shards at all, so the run-shaped fields are flattened here rather than
 * the sheet knowing about either caller's row type.
 */
function runSheetProps(test: TestGroup | null, shardIndexById: Map<string, number>) {
  if (!test) return { test: null, attempts: [] };

  return {
    test: {
      testRef: test.testRef,
      title: test.title,
      titlePath: test.titlePath,
      file: test.file,
      projectName: test.projectName,
      outcome: test.outcome,
    },
    // Ordered by retry, so the last one is the attempt that decided the outcome
    // — and the one the Logs tab should open on.
    attempts: test.attempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      retry: attempt.retry,
      durationMs: attempt.durationMs,
      startedAt: attempt.startedAt,
      errorMessage: attempt.errorMessage,
      hasTrace: attempt.hasTrace,
      shardIndex: shardIndexById.get(attempt.shardId),
      parallelIndex: attempt.parallelIndex,
      workerIndex: attempt.workerIndex,
    })),
    defaultAttemptId: test.final.id,
    stats: [
      { label: "Project", value: test.projectName || "—" },
      { label: "Attempts", value: String(test.attempts.length) },
      { label: "Total time", value: formatDuration(test.durationMs) },
    ],
  };
}

function NotFound() {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium">Run not found</p>
      <p className="text-muted-foreground mt-1 text-sm">
        It may have been deleted, or the link points at another server.
      </p>
    </div>
  );
}

function RunSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-72" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-[86px]" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
