import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { FilterBar, type FilterSelectProps } from "@/components/filter-bar";
import { TEST_TABS, TestDetailSheet, type TestTab } from "@/components/test-detail-sheet";
import { TestsTable } from "@/components/tests-table";
import { Button } from "@/components/ui/button";
import { useDebouncedInput, useUrlPatch } from "@/lib/url-state";
import { trpc, type ExplorerRow } from "@/trpc";

const WINDOWS = [7, 30, 90] as const;

/**
 * The test list plus its detail sheet, over whatever slice of runs it is given.
 *
 * Used whole by the Test Explorer and by a merge request's Tests tab. All of
 * its view state — window, search, filters, which test is open and which tab of
 * it — lives in the query string, so "the flaky ones on !412 over 90 days" is a
 * link rather than a set of instructions.
 */
export function TestExplorer({
  projectSlug,
  /** Fixes the scope to one merge request and hides the filter for it. */
  mrIid,
  showFilters = false,
}: {
  projectSlug: string;
  mrIid?: string | undefined;
  showFilters?: boolean;
}) {
  const [params] = useSearchParams();
  const patch = useUrlPatch();

  const days = Number(params.get("days")) || 30;
  const search = params.get("q") ?? "";
  const branch = params.get("branch");
  const scope = mrIid ?? params.get("mr") ?? undefined;

  const [draft, setDraft] = useDebouncedInput(search, (value) => patch({ q: value || null }));

  const query = useQuery({
    queryKey: ["explorer", projectSlug, days, search, branch, scope],
    queryFn: () =>
      trpc.tests.explorer.query({
        projectSlug,
        days,
        ...(search ? { search } : {}),
        ...(branch ? { branch } : {}),
        ...(scope ? { mrIid: scope } : {}),
      }),
    enabled: projectSlug !== "",
    placeholderData: (previous) => previous,
  });

  const filterOptions = useQuery({
    queryKey: ["run-filters", projectSlug],
    queryFn: () => trpc.runs.filters.query({ projectSlug }),
    enabled: projectSlug !== "" && showFilters,
    staleTime: 60_000,
  });

  const openTestRef = params.get("test") ?? undefined;
  const open = query.data?.find((row) => row.testRef === openTestRef) ?? null;

  const testTabParam = params.get("testTab");
  const testTab: TestTab = TEST_TABS.includes(testTabParam as TestTab)
    ? (testTabParam as TestTab)
    : // History, not Attempts: the explorer's whole reason to exist is the
      // cross-run trend, and the attempt list is the supporting detail.
      "history";

  const selects: FilterSelectProps[] = showFilters
    ? [
        {
          label: "Branch",
          value: branch,
          anyLabel: "All branches",
          onChange: (value) => patch({ branch: value }),
          options: (filterOptions.data?.branches ?? []).map((row) => ({
            value: row.branch,
            label: row.branch,
          })),
          emptyLabel: "No branches recorded",
        },
        {
          label: "MR",
          value: params.get("mr"),
          anyLabel: "All pipelines",
          onChange: (value) => patch({ mr: value }),
          options: (filterOptions.data?.mergeRequests ?? []).map((row) => ({
            value: row.iid,
            label: `!${row.iid}`,
            ...(row.title ? { hint: row.title } : {}),
          })),
          emptyLabel: "No merge requests recorded",
        },
      ]
    : [];

  const active = Boolean(search || branch || params.get("mr"));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterBar
          search={draft}
          onSearchChange={setDraft}
          searchPlaceholder="Filter by test name or file"
          filters={selects}
          onClear={active ? () => patch({ q: null, branch: null, mr: null }) : undefined}
        >
          <div className="flex items-center gap-1">
            {WINDOWS.map((window) => (
              <Button
                key={window}
                size="sm"
                variant={window === days ? "secondary" : "ghost"}
                className="h-8 px-2.5 text-xs"
                onClick={() => patch({ days: String(window) })}
              >
                {window}d
              </Button>
            ))}
          </div>
        </FilterBar>
      </div>

      <TestsTable
        rows={query.data ?? []}
        isLoading={query.isLoading}
        selectedTestRef={openTestRef}
        // Opening a test pushes, so Back closes the sheet.
        onOpen={(row) => patch({ test: row.testRef, attempt: null }, { replace: false })}
        emptyState={
          search
            ? `No tests match “${search}” in the last ${days} days.`
            : `No tests have run in the last ${days} days.`
        }
      />

      <ExplorerSheet
        row={open}
        projectSlug={projectSlug}
        days={days}
        tab={testTab}
        focusAttemptId={params.get("attempt") ?? undefined}
        onTabChange={(next) => patch({ testTab: next })}
        onFocusAttempt={(attemptId) => patch({ attempt: attemptId })}
        onClose={() => patch({ test: null, attempt: null, testTab: null }, { replace: false })}
      />
    </div>
  );
}

/**
 * The shared detail sheet, fed from the explorer's row plus the test's recent
 * attempts across every run.
 *
 * The attempts are fetched here rather than folded into the explorer query: the
 * list is one row per test and this is one test's worth of history, so asking
 * for it up front would multiply the page's payload by fifty to serve a panel
 * that is usually closed.
 */
function ExplorerSheet({
  row,
  projectSlug,
  days,
  ...sheet
}: {
  row: ExplorerRow | null;
  projectSlug: string;
  days: number;
  tab: TestTab;
  focusAttemptId: string | undefined;
  onTabChange: (tab: TestTab) => void;
  onFocusAttempt: (attemptId: string) => void;
  onClose: () => void;
}) {
  const history = useQuery({
    queryKey: ["test-attempts", row?.testRef],
    queryFn: () => trpc.tests.history.query({ testRef: row?.testRef ?? "", limit: 25 }),
    enabled: row !== null,
  });

  // Newest first, as the server returns it: in the explorer "the interesting
  // attempt" is the most recent one, not the last retry of some old run.
  const attempts = (history.data ?? []).map((attempt) => ({
    id: attempt.attemptId,
    status: attempt.status,
    retry: attempt.retry,
    durationMs: attempt.durationMs,
    startedAt: attempt.startedAt,
    errorMessage: attempt.errorMessage,
    hasTrace: attempt.hasTrace,
    run: {
      id: attempt.runId,
      key: attempt.runKey,
      branch: attempt.branch,
    },
  }));

  const failureRate = row && row.executions > 0 ? (row.failed / row.executions) * 100 : 0;

  return (
    <TestDetailSheet
      test={
        row
          ? {
              testRef: row.testRef,
              title: row.title,
              titlePath: row.titlePath,
              file: row.file,
              projectName: row.projectName,
            }
          : null
      }
      attempts={attempts}
      attemptsLoading={history.isLoading}
      attemptsLabel="Recent runs"
      defaultAttemptId={attempts[0]?.id}
      projectSlug={projectSlug}
      stats={
        row
          ? [
              { label: `Executions (${days}d)`, value: String(row.executions) },
              { label: "Failure rate", value: `${failureRate.toFixed(failureRate < 10 ? 1 : 0)}%` },
              { label: "Flaky", value: String(row.flaky) },
            ]
          : []
      }
      {...sheet}
    />
  );
}
