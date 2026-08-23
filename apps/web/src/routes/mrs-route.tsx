import { useQuery } from "@tanstack/react-query";
import { GitPullRequestArrowIcon } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router";
import { FilterBar } from "@/components/filter-bar";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime, toDate } from "@/lib/dates";
import { useDebouncedInput, useUrlPatch } from "@/lib/url-state";
import { trpc, type MergeRequestRow } from "@/trpc";

/**
 * Every merge request cameri has seen a pipeline for, most recent first.
 *
 * This is the list rather than the run list because a merge request is what a
 * person is actually working on — a run is one attempt at proving it. Rolling
 * the runs up means "is my branch green" is one row instead of a scan down a
 * list of pipeline ids.
 */
export function MergeRequestsRoute() {
  const { projectSlug = "" } = useParams();
  const [params] = useSearchParams();
  const patch = useUrlPatch();

  const search = params.get("q") ?? "";
  const [draft, setDraft] = useDebouncedInput(search, (value) => patch({ q: value || null }));

  const query = useQuery({
    queryKey: ["merge-requests", projectSlug, search],
    queryFn: () =>
      trpc.mergeRequests.list.query({ projectSlug, ...(search ? { search } : {}) }),
    enabled: projectSlug !== "",
    // Live while any of them has a pipeline going.
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Merge Requests</h1>
        <p className="text-muted-foreground text-sm">
          {query.isLoading ? "Loading…" : `${query.data?.length ?? 0} with recorded runs`}
        </p>
      </div>

      <FilterBar
        search={draft}
        onSearchChange={setDraft}
        searchPlaceholder="Search by number, title or branch…"
        filters={[]}
        onClear={search ? () => patch({ q: null }) : undefined}
      />

      {query.isLoading ? (
        <Skeleton className="h-96" />
      ) : (query.data ?? []).length === 0 ? (
        <div className="text-muted-foreground py-16 text-center text-sm">
          {search ? (
            `No merge requests match “${search}”.`
          ) : (
            <>
              <p>No merge request pipelines recorded yet.</p>
              <p className="mt-1 text-xs">
                Runs land here once a <code className="font-mono">merge_request_event</code>{" "}
                pipeline reports in — a branch pipeline does not carry a merge request, even when
                one is open.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="bg-card overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[90px]">MR</TableHead>
                {/* `w-full max-w-0` is what lets the title truncate rather than
                    push the numbers off the right edge. */}
                <TableHead className="w-full max-w-0">Title</TableHead>
                <TableHead className="hidden lg:table-cell">Branch</TableHead>
                <TableHead className="w-[120px]">Last run</TableHead>
                <TableHead className="w-[80px] text-right">Runs</TableHead>
                <TableHead className="w-[80px] text-right">Failed</TableHead>
                <TableHead className="hidden w-[130px] sm:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((row) => (
                <MergeRequestRowView key={row.iid} row={row} projectSlug={projectSlug} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function MergeRequestRowView({
  row,
  projectSlug,
}: {
  row: MergeRequestRow;
  projectSlug: string;
}) {
  return (
    <TableRow className="relative cursor-pointer">
      <TableCell>
        <span className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums">
          <GitPullRequestArrowIcon className="size-3.5 shrink-0" />!{row.iid}
        </span>
      </TableCell>
      <TableCell className="w-full max-w-0">
        {/* Stretched over the row so the whole thing is one click target, while
            staying a real link for middle-click and keyboard focus. */}
        <Link
          to={`/${projectSlug}/mrs/${encodeURIComponent(row.iid)}`}
          className="block truncate text-sm after:absolute after:inset-0 hover:underline"
        >
          {row.title ?? `Merge request !${row.iid}`}
        </Link>
        {row.targetBranch ? (
          <span className="text-muted-foreground block truncate text-xs">
            into {row.targetBranch}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground hidden truncate font-mono text-xs lg:table-cell">
        {row.sourceBranch ?? "—"}
      </TableCell>
      <TableCell>
        <RunStatusBadge status={row.lastStatus} />
      </TableCell>
      <TableCell className="text-muted-foreground text-right tabular-nums">
        {row.runCount}
      </TableCell>
      <TableCell
        className={`text-right tabular-nums ${row.failedRuns > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`}
      >
        {row.failedRuns}
      </TableCell>
      <TableCell
        className="text-muted-foreground hidden text-xs sm:table-cell"
        title={toDate(row.lastRunAt).toLocaleString()}
      >
        {relativeTime(toDate(row.lastRunAt))}
      </TableCell>
    </TableRow>
  );
}
