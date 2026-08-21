import type { RunAttempt } from "@/trpc";
import type { TestOutcome } from "@/lib/run-stats";

/**
 * Pass/fail has to read the same in both themes, and the palette only carries
 * one semantic colour (`destructive`), so these are literal hues with a `dark:`
 * variant each. Defined once here because the badge, the file tree and the
 * timeline bars all have to agree on what green means.
 */
export const OUTCOME_BADGE: Record<TestOutcome, string> = {
  passed:
    "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  failed: "border-transparent bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  flaky: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  skipped:
    "border-transparent bg-neutral-200 text-neutral-700 dark:bg-neutral-500/20 dark:text-neutral-300",
  // Blue, because it is the one state that carries no judgement — reusing any
  // of the verdict hues would make an in-flight test look decided.
  running: "border-transparent bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
};

export const OUTCOME_LABEL: Record<TestOutcome, string> = {
  passed: "Passed",
  failed: "Failed",
  flaky: "Flaky",
  skipped: "Skipped",
  running: "Running",
};

/** Solid fills, for the timeline bars and the pass-rate meter. */
export const OUTCOME_FILL: Record<TestOutcome, string> = {
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  flaky: "bg-amber-500",
  skipped: "bg-neutral-400 dark:bg-neutral-600",
  running: "bg-sky-500",
};

/** Timeline bars are per attempt, so they key off the raw wire status. */
export const STATUS_FILL: Record<RunAttempt["status"], string> = {
  passed: "bg-emerald-500/80 hover:bg-emerald-500",
  failed: "bg-red-500/80 hover:bg-red-500",
  timedOut: "bg-amber-500/80 hover:bg-amber-500",
  skipped: "bg-neutral-400/60 hover:bg-neutral-400 dark:bg-neutral-600/60",
  interrupted: "bg-violet-500/80 hover:bg-violet-500",
  running: "bg-sky-500/80 hover:bg-sky-500",
};
