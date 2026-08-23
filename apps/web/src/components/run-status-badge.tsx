import { Badge } from "@/components/ui/badge";
import type { RunListItem } from "@/trpc";

/** Taken off the row rather than imported, so web keeps a single API dep. */
export type RunStatus = RunListItem["status"];

/**
 * Status colours are hard-coded rather than driven by the theme tokens: pass and
 * fail have to mean the same thing in both modes, and the palette only carries
 * one semantic colour (`destructive`). The `dark:` variants keep them legible on
 * the dark background.
 */
const STYLES: Record<RunStatus, string> = {
  running:
    "border-transparent bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300",
  passed:
    "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  failed:
    "border-transparent bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  timedOut:
    "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  cancelled:
    "border-transparent bg-neutral-200 text-neutral-700 dark:bg-neutral-500/20 dark:text-neutral-300",
};

/**
 * Exported for the status filter, which needs both the labels and the order.
 * Declared as a full `Record` so adding a run status to the contract breaks the
 * build here rather than silently dropping an option out of the menu.
 */
export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
  cancelled: "Cancelled",
};

const LABELS = RUN_STATUS_LABELS;

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant="outline" className={STYLES[status]}>
      {status === "running" ? (
        <span className="mr-1 size-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {LABELS[status]}
    </Badge>
  );
}
