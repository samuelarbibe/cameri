import { ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { MergeRequestLink } from "@/components/merge-request-link";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import type { RunListItem } from "@/trpc";

type RunsTableProps = {
  runs: RunListItem[];
  isLoading: boolean;
  error: Error | null;
  emptyState: React.ReactNode;
  /**
   * Off on a page that is already scoped to one merge request, where every row
   * would repeat the same chip.
   */
  showMergeRequest?: boolean;
};

/**
 * The runs list, and nothing else.
 *
 * Filtering used to happen here, over whatever rows had already been fetched.
 * It does not any more: the list is capped, so searching inside it quietly
 * meant "search the most recent 25 runs". The owning route holds the filters in
 * the URL and passes the server's answer down.
 */
export function RunsTable({
  runs,
  isLoading,
  error,
  emptyState,
  showMergeRequest = true,
}: RunsTableProps) {
  const { projectSlug } = useParams();
  const columns = showMergeRequest ? 9 : 8;

  return (
    // `rounded-lg`, not `xl`: the floating sidebar panel uses `rounded-lg` too,
    // so the two raised surfaces share a corner radius.
    <div className="bg-card overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[120px]">Status</TableHead>
            <TableHead>Run</TableHead>
            {showMergeRequest ? <TableHead className="w-[90px]">MR</TableHead> : null}
            <TableHead className="hidden md:table-cell">Branch</TableHead>
            <TableHead className="hidden lg:table-cell">Commit</TableHead>
            <TableHead className="w-[100px] text-right">Shards</TableHead>
            <TableHead className="w-[90px] text-right">Failed</TableHead>
            <TableHead className="hidden w-[150px] sm:table-cell">Started</TableHead>
            <TableHead className="w-[48px]">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {error ? (
            <MessageRow columns={columns}>
              <p className="text-destructive text-sm font-medium">Could not load runs</p>
              <p className="text-muted-foreground mt-1 text-sm">{error.message}</p>
            </MessageRow>
          ) : isLoading ? (
            Array.from({ length: 5 }, (_, index) => (
              <SkeletonRow key={index} showMergeRequest={showMergeRequest} />
            ))
          ) : runs.length === 0 ? (
            <MessageRow columns={columns}>{emptyState}</MessageRow>
          ) : (
            runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                projectSlug={projectSlug}
                showMergeRequest={showMergeRequest}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function RunRow({
  run,
  projectSlug,
  showMergeRequest,
}: {
  run: RunListItem;
  projectSlug?: string;
  showMergeRequest: boolean;
}) {
  const complete = run.shardsCompleted >= run.expectedShards;

  return (
    <TableRow className="relative cursor-pointer">
      <TableCell>
        <RunStatusBadge status={run.status} />
      </TableCell>
      <TableCell className="max-w-[280px]">
        {/* A real link rather than a row `onClick`, stretched over the whole row
            with `after:inset-0`. Keeps middle-click, cmd-click and keyboard
            focus working, which a click handler on <tr> would not. */}
        <Link
          to={`/${projectSlug}/runs/${run.id}`}
          className="truncate font-mono text-xs after:absolute after:inset-0 hover:underline"
        >
          {run.runKey}
        </Link>
        <div className="text-muted-foreground truncate text-xs">
          {run.mrTitle ?? run.commitMessage ?? ""}
        </div>
      </TableCell>
      {showMergeRequest ? (
        <TableCell>
          <MergeRequestLink
            iid={run.mrIid}
            url={run.mrUrl}
            title={run.mrTitle}
            projectSlug={projectSlug}
          />
        </TableCell>
      ) : null}
      <TableCell className="text-muted-foreground hidden truncate md:table-cell">
        {run.branch ?? "—"}
      </TableCell>
      <TableCell className="text-muted-foreground hidden font-mono text-xs lg:table-cell">
        {run.commitSha ? run.commitSha.slice(0, 8) : "—"}
      </TableCell>
      <TableCell className={`text-right tabular-nums ${complete ? "" : "text-muted-foreground"}`}>
        {run.shardsCompleted}/{run.expectedShards}
      </TableCell>
      <TableCell
        className={`text-right tabular-nums ${run.failed > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`}
      >
        {run.failed}
      </TableCell>
      <TableCell
        className="text-muted-foreground hidden text-sm sm:table-cell"
        title={toDate(run.startedAt).toLocaleString()}
      >
        {relativeTime(run.startedAt)}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          {/* Above the stretched link, or the menu would open the run instead. */}
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative z-10 size-8"
              aria-label="Run actions"
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard.writeText(run.runKey);
                toast.success("Run key copied");
              }}
            >
              Copy run key
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!run.ciBuildUrl}
              onSelect={() => {
                if (run.ciBuildUrl) window.open(run.ciBuildUrl, "_blank", "noreferrer");
              }}
            >
              <ExternalLinkIcon className="size-4" />
              Open CI build
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!run.mrUrl}
              onSelect={() => {
                if (run.mrUrl) window.open(run.mrUrl, "_blank", "noreferrer");
              }}
            >
              <ExternalLinkIcon className="size-4" />
              Open merge request
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function MessageRow({ columns, children }: { columns: number; children: React.ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={columns} className="py-12 text-center">
        {children}
      </TableCell>
    </TableRow>
  );
}

function SkeletonRow({ showMergeRequest }: { showMergeRequest: boolean }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell>
        <Skeleton className="h-5 w-16" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-48" />
      </TableCell>
      {showMergeRequest ? (
        <TableCell>
          <Skeleton className="h-4 w-10" />
        </TableCell>
      ) : null}
      <TableCell className="hidden md:table-cell">
        <Skeleton className="h-4 w-20" />
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <Skeleton className="h-4 w-14" />
      </TableCell>
      <TableCell>
        <Skeleton className="ml-auto h-4 w-8" />
      </TableCell>
      <TableCell>
        <Skeleton className="ml-auto h-4 w-6" />
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <Skeleton className="h-4 w-16" />
      </TableCell>
      <TableCell />
    </TableRow>
  );
}
