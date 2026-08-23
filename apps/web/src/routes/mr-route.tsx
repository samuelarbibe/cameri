import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, GitBranchIcon, GitPullRequestArrowIcon } from "lucide-react";
import { useParams, useSearchParams } from "react-router";
import { RunStatusBadge } from "@/components/run-status-badge";
import { RunsTable } from "@/components/runs-table";
import { TestExplorer } from "@/components/test-explorer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { relativeTime, toDate } from "@/lib/dates";
import { useUrlPatch } from "@/lib/url-state";
import { trpc } from "@/trpc";

const TABS = ["runs", "tests"] as const;
type Tab = (typeof TABS)[number];

/**
 * One merge request: its pipelines, and the tests those pipelines ran.
 *
 * Two tabs because there are two questions — "did my last pipeline pass" and
 * "which test is failing on my branch" — and the second one needs every run
 * rolled together, which no single run page can do.
 */
export function MergeRequestRoute() {
  const { projectSlug = "", mrIid = "" } = useParams();
  const [params] = useSearchParams();
  const patch = useUrlPatch();

  const tabParam = params.get("tab");
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "runs";

  const mr = useQuery({
    queryKey: ["merge-request", projectSlug, mrIid],
    queryFn: () => trpc.mergeRequests.get.query({ projectSlug, iid: mrIid }),
    enabled: projectSlug !== "" && mrIid !== "",
    refetchInterval: 15_000,
  });

  const runs = useQuery({
    queryKey: ["runs", projectSlug, { mrIid }],
    queryFn: () => trpc.runs.list.query({ projectSlug, mrIid, limit: 100 }),
    enabled: projectSlug !== "" && mrIid !== "",
    refetchInterval: 5_000,
  });

  if (mr.isLoading) return <Skeleton className="h-96" />;

  if (!mr.data) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm font-medium">No runs for merge request !{mrIid}</p>
        <p className="text-muted-foreground mt-1 text-sm">
          Either nothing has reported in for it yet, or the link points at another project.
        </p>
      </div>
    );
  }

  const detail = mr.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitPullRequestArrowIcon className="text-muted-foreground size-4 shrink-0" />
              <h1 className="truncate text-lg font-semibold tracking-tight">
                {detail.title ?? `Merge request !${detail.iid}`}
              </h1>
              <RunStatusBadge status={detail.lastStatus} />
            </div>
            <p className="text-muted-foreground mt-1 text-sm tabular-nums">
              !{detail.iid} · {detail.runCount} run{detail.runCount === 1 ? "" : "s"}
              {detail.failedRuns > 0 ? `, ${detail.failedRuns} failed` : ""} · last{" "}
              {relativeTime(toDate(detail.lastRunAt))}
            </p>
          </div>
          {detail.url ? (
            <Button variant="outline" size="sm" className="ml-auto" asChild>
              <a href={detail.url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon className="size-4" />
                Open in GitLab
              </a>
            </Button>
          ) : null}
        </div>

        {detail.sourceBranch || detail.targetBranch ? (
          <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="font-mono text-xs">{detail.sourceBranch ?? "unknown"}</span>
            <span>→</span>
            <span className="font-mono text-xs">{detail.targetBranch ?? "unknown"}</span>
          </div>
        ) : null}
      </div>

      <Tabs value={tab} onValueChange={(next) => patch({ tab: next })}>
        <TabsList>
          <TabsTrigger value="runs">
            Runs
            <span className="text-muted-foreground ml-1 tabular-nums">{detail.runCount}</span>
          </TabsTrigger>
          <TabsTrigger value="tests">Tests</TabsTrigger>
        </TabsList>

        <TabsContent value="runs" className="mt-4">
          <RunsTable
            runs={runs.data ?? []}
            isLoading={runs.isLoading}
            error={runs.error}
            // The page is already one merge request, so the chip would be the
            // same value on every row.
            showMergeRequest={false}
            emptyState={
              <p className="text-muted-foreground text-sm">No runs recorded for this one.</p>
            }
          />
        </TabsContent>

        <TabsContent value="tests" className="mt-4">
          <TestExplorer projectSlug={projectSlug} mrIid={mrIid} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
