import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router";
import { RunFiles } from "@/components/run-files";
import { RunSummary } from "@/components/run-summary";
import { RunTimeline } from "@/components/run-timeline";
import { TestDetailSheet } from "@/components/test-detail-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { countOutcomes, groupByFile, groupByTest, runWindow } from "@/lib/run-stats";
import { trpc } from "@/trpc";

const TABS = ["files", "timeline"] as const;
type Tab = (typeof TABS)[number];

/**
 * Everything about this page is addressable, so all of its view state lives in
 * the query string rather than in component state:
 *
 *   /:project/runs/:runId?tab=timeline&test=<testRef>&attempt=<attemptId>
 *
 * That makes "look at this failure" a link someone can paste into a review, and
 * it also means the browser Back button closes the detail sheet.
 */
export function RunRoute() {
  const { runId = "" } = useParams();
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
        test={(selectedTestRef ? derived.byTestRef.get(selectedTestRef) : null) ?? null}
        focusAttemptId={focusAttemptId}
        shards={detail.shards}
        onClose={() => patchParams({ test: null, attempt: null }, false)}
      />
    </div>
  );
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
