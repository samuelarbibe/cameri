import type { RunStats, RunStatus, TestStatus } from "@cameri/contract";
import { groupByTest, isFlakyWithinRun, type AttemptLike } from "./flake.ts";

export interface DurationAttempt extends AttemptLike {
  durationMs: number;
}

/**
 * Rolls a shard's raw attempts up into the numbers shown on a run card.
 *
 * Counts *tests*, not attempts: a test that failed twice and then passed is one
 * flaky test, not two failures and a pass.
 */
export function aggregateStats(attempts: readonly DurationAttempt[]): RunStats {
  const stats: RunStats = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 0,
  };

  for (const attempt of attempts) {
    stats.durationMs += attempt.durationMs;
  }

  for (const [, group] of groupByTest(attempts)) {
    stats.total += 1;
    const ordered = [...group].sort((a, b) => a.retry - b.retry);
    const final = ordered[ordered.length - 1];
    if (!final) continue;

    // A test still in flight has no verdict, so it is counted in the total and
    // nowhere else. Without this it would fall through to `failed` and turn a
    // healthy live run red.
    if (final.status === "running") continue;
    if (isFlakyWithinRun(ordered)) stats.flaky += 1;
    else if (final.status === "passed") stats.passed += 1;
    else if (final.status === "skipped") stats.skipped += 1;
    else stats.failed += 1;
  }

  return stats;
}

export function mergeStats(all: readonly RunStats[]): RunStats {
  return all.reduce<RunStats>(
    (acc, s) => ({
      total: acc.total + s.total,
      passed: acc.passed + s.passed,
      failed: acc.failed + s.failed,
      skipped: acc.skipped + s.skipped,
      flaky: acc.flaky + s.flaky,
      durationMs: acc.durationMs + s.durationMs,
    }),
    { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 },
  );
}

/**
 * A run is only green when every shard reported and nothing failed. Flaky tests
 * do not fail the run — that is a policy the project settings will own later.
 */
export function deriveRunStatus(
  stats: RunStats,
  opts: { allShardsReported: boolean; anyShardAbandoned: boolean },
): RunStatus {
  if (opts.anyShardAbandoned) return "timedOut";
  if (!opts.allShardsReported) return "running";
  return stats.failed > 0 ? "failed" : "passed";
}

export function isFailure(status: TestStatus): boolean {
  return status === "failed" || status === "timedOut" || status === "interrupted";
}
