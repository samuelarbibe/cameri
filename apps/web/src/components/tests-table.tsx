import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDuration, relativeTime, toDate } from "@/lib/dates";
import type { ExplorerRow } from "@/trpc";

/**
 * One row per test with its aggregate health, ranked worst first.
 *
 * Shared by the Test Explorer and a merge request's Tests tab — the same
 * question ("which of these is costing us time"), asked of a different slice of
 * runs.
 */
export function TestsTable({
  rows,
  isLoading,
  selectedTestRef,
  onOpen,
  emptyState,
}: {
  rows: ExplorerRow[];
  isLoading: boolean;
  selectedTestRef?: string | undefined;
  onOpen: (row: ExplorerRow) => void;
  emptyState: React.ReactNode;
}) {
  if (isLoading) return <Skeleton className="h-96" />;
  if (rows.length === 0) {
    return <div className="text-muted-foreground py-16 text-center text-sm">{emptyState}</div>;
  }

  return (
    <div className="bg-card overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {/* The test name takes everything the numbers do not: `w-full`
                claims the slack, `max-w-0` is what lets `truncate` work at
                all inside a table cell. */}
            <TableHead className="w-full max-w-0">Test</TableHead>
            <TableHead className="text-right whitespace-nowrap">Executions</TableHead>
            <TableHead className="text-right whitespace-nowrap">Failure rate</TableHead>
            <TableHead className="text-right whitespace-nowrap">Flaky rate</TableHead>
            <TableHead className="text-right whitespace-nowrap">Avg duration</TableHead>
            <TableHead className="text-right whitespace-nowrap">Last run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TestRow
              key={row.testRef}
              row={row}
              selected={row.testRef === selectedTestRef}
              onOpen={() => onOpen(row)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TestRow({
  row,
  selected,
  onOpen,
}: {
  row: ExplorerRow;
  selected: boolean;
  onOpen: () => void;
}) {
  const failureRate = row.executions === 0 ? 0 : row.failed / row.executions;
  const flakyRate = row.executions === 0 ? 0 : row.flaky / row.executions;

  return (
    <TableRow
      className={`hover:bg-accent/50 cursor-pointer ${selected ? "bg-accent" : ""}`}
      onClick={onOpen}
    >
      <TableCell className="w-full max-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{row.title}</span>
          {row.quarantined ? (
            <Badge variant="outline" className="shrink-0">
              Quarantined
            </Badge>
          ) : null}
        </div>
        <span className="text-muted-foreground block truncate font-mono text-xs">
          {row.file}
          {row.projectName ? ` · ${row.projectName}` : ""}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums whitespace-nowrap">{row.executions}</TableCell>
      <TableCell className="text-right">
        <Rate value={failureRate} tone="failed" />
      </TableCell>
      <TableCell className="text-right">
        <Rate value={flakyRate} tone="flaky" />
      </TableCell>
      <TableCell className="text-muted-foreground text-right tabular-nums">
        {formatDuration(row.avgDurationMs)}
      </TableCell>
      <TableCell className="text-muted-foreground text-right text-xs">
        {relativeTime(toDate(row.lastRunAt))}
      </TableCell>
    </TableRow>
  );
}

/** A percentage that stays grey until it is worth reacting to. */
function Rate({ value, tone }: { value: number; tone: "failed" | "flaky" }) {
  const percent = value * 100;
  const hot = percent >= 1;
  const colour = !hot
    ? "text-muted-foreground"
    : tone === "failed"
      ? "text-red-600 dark:text-red-400"
      : "text-amber-600 dark:text-amber-400";

  return (
    <span className={`tabular-nums ${colour} ${hot ? "font-medium" : ""}`}>
      {percent === 0 ? "—" : `${percent.toFixed(percent < 10 ? 1 : 0)}%`}
    </span>
  );
}
