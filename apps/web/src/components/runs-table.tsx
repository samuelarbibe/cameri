import { ExternalLinkIcon, MoreHorizontalIcon, SearchIcon } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
};

function matches(run: RunListItem, needle: string): boolean {
  return [run.runKey, run.branch, run.commitSha, run.author].some((field) =>
    field?.toLowerCase().includes(needle),
  );
}

export function RunsTable({ runs, isLoading, error, emptyState }: RunsTableProps) {
  const { projectSlug } = useParams();
  const [params, setParams] = useSearchParams();
  // In the URL rather than in state so a filtered list is a shareable link.
  // Typing replaces the entry it just wrote, or every keystroke would need its
  // own press of the Back button to undo.
  const query = params.get("q") ?? "";
  const setQuery = (next: string) => {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (next === "") updated.delete("q");
        else updated.set("q", next);
        return updated;
      },
      { replace: true },
    );
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === "" ? runs : runs.filter((run) => matches(run, needle));
  }, [runs, query]);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Runs</h1>
          <p className="text-muted-foreground text-sm">
            {isLoading ? "Loading…" : `${filtered.length} of ${runs.length}`}
          </p>
        </div>
        <div className="relative ml-auto w-full sm:w-64">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search runs, branches, commits…"
            aria-label="Search runs"
            className="pl-8"
          />
        </div>
      </div>

      {/* `rounded-lg`, not `xl`: the floating sidebar panel uses `rounded-lg`
          too, so the two raised surfaces share a corner radius. */}
      <div className="bg-card overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead>Run</TableHead>
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
              <MessageRow>
                <p className="text-destructive text-sm font-medium">Could not load runs</p>
                <p className="text-muted-foreground mt-1 text-sm">{error.message}</p>
              </MessageRow>
            ) : isLoading ? (
              Array.from({ length: 5 }, (_, index) => <SkeletonRow key={index} />)
            ) : runs.length === 0 ? (
              <MessageRow>{emptyState}</MessageRow>
            ) : filtered.length === 0 ? (
              <MessageRow>
                <p className="text-muted-foreground text-sm">No runs match “{query}”.</p>
              </MessageRow>
            ) : (
              filtered.map((run) => <RunRow key={run.id} run={run} projectSlug={projectSlug} />)
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RunRow({ run, projectSlug }: { run: RunListItem; projectSlug?: string }) {
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
        {run.commitMessage ? (
          <div className="text-muted-foreground truncate text-xs">{run.commitMessage}</div>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground hidden truncate md:table-cell">
        {run.branch ?? "—"}
      </TableCell>
      <TableCell className="text-muted-foreground hidden font-mono text-xs lg:table-cell">
        {run.commitSha ? run.commitSha.slice(0, 8) : "—"}
      </TableCell>
      <TableCell
        className={`text-right tabular-nums ${complete ? "" : "text-muted-foreground"}`}
      >
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
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function MessageRow({ children }: { children: React.ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={8} className="py-12 text-center">
        {children}
      </TableCell>
    </TableRow>
  );
}

function SkeletonRow() {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell>
        <Skeleton className="h-5 w-16" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-48" />
      </TableCell>
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
