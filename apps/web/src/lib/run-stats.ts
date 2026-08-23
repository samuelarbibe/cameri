import { toTime } from "@/lib/dates";
import type { RunAttempt, RunDetail } from "@/trpc";

/**
 * Attempts are the raw unit on the wire — a test that failed twice and then
 * passed is three rows. Everything a human wants to read is per *test*, so the
 * whole detail page is built on the grouping below rather than on attempts.
 *
 * `running` is the one outcome that is not a verdict: the reporter writes a
 * placeholder row when a test starts and the server overwrites it when the real
 * result lands. It has to be modelled explicitly, because the alternative is a
 * live test silently reading as green.
 */
export type TestOutcome = "passed" | "failed" | "flaky" | "skipped" | "running";

export type TestGroup = {
  testRef: string;
  title: string;
  titlePath: string[];
  file: string;
  projectName: string;
  outcome: TestOutcome;
  /** Ordered by retry, so `attempts[0]` is the first try and the last is final. */
  attempts: RunAttempt[];
  final: RunAttempt;
  /** Summed across retries: the time this test actually cost the run. */
  durationMs: number;
};

export type FileGroup = {
  file: string;
  tests: TestGroup[];
  counts: OutcomeCounts;
  durationMs: number;
};

export type OutcomeCounts = Record<TestOutcome, number> & { total: number };

const FAILING = new Set(["failed", "timedOut", "interrupted"]);

/** True for the statuses the dashboard treats as red, everywhere. */
export function isFailure(status: RunAttempt["status"]): boolean {
  return FAILING.has(status);
}

function outcomeOf(final: RunAttempt, chain: RunAttempt[]): TestOutcome {
  // Checked first: a test that failed and is now retrying is in flight, not
  // failed, and showing it red would be a verdict the run has not reached.
  if (final.status === "running") return "running";
  if (isFailure(final.status)) return "failed";
  if (final.status === "skipped") return "skipped";
  // The server marks the whole retry chain once it knows how it ended. The
  // retry check is a backstop for chains written by an older reporter.
  const recovered = chain.some((attempt) => attempt.isFlaky) || chain.length > 1;
  return recovered ? "flaky" : "passed";
}

export function groupByTest(attempts: RunAttempt[]): TestGroup[] {
  // A non-empty tuple, not a plain array: it lets `ordered[0]` below be a
  // guaranteed hit under `noUncheckedIndexedAccess` without a cast.
  const byTest = new Map<string, [RunAttempt, ...RunAttempt[]]>();
  for (const attempt of attempts) {
    const existing = byTest.get(attempt.testRef);
    if (existing) existing.push(attempt);
    else byTest.set(attempt.testRef, [attempt]);
  }

  return [...byTest.values()].map((group) => {
    const ordered = group;
    ordered.sort((a, b) => a.retry - b.retry);
    const final = ordered.at(-1) ?? ordered[0];
    return {
      testRef: final.testRef,
      title: final.title,
      titlePath: final.titlePath,
      file: final.file,
      projectName: final.projectName,
      outcome: outcomeOf(final, ordered),
      attempts: ordered,
      final,
      durationMs: ordered.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    };
  });
}

/**
 * The `describe` blocks a test sits under, and nothing else.
 *
 * Playwright's `titlePath` is the whole chain — root, project, file, describes,
 * title — and the first three are already on screen as their own fields. Slicing
 * blindly reprints them, so this anchors on the file and takes what follows.
 */
export function suitePath(test: { titlePath: string[]; file: string }): string {
  const fileAt = test.titlePath.lastIndexOf(test.file);
  // No file in the chain (a hand-written payload, or a future Playwright): fall
  // back to dropping the leading root/project pair rather than showing nothing.
  const start = fileAt === -1 ? 2 : fileAt + 1;
  return test.titlePath.slice(start, -1).join(" › ");
}

export function countOutcomes(tests: TestGroup[]): OutcomeCounts {
  const counts: OutcomeCounts = {
    total: tests.length,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    running: 0,
  };
  for (const test of tests) counts[test.outcome] += 1;
  return counts;
}

export function groupByFile(tests: TestGroup[]): FileGroup[] {
  const byFile = new Map<string, TestGroup[]>();
  for (const test of tests) {
    const existing = byFile.get(test.file);
    if (existing) existing.push(test);
    else byFile.set(test.file, [test]);
  }

  return [...byFile.entries()]
    .map(([file, group]) => ({
      file,
      tests: group.sort((a, b) => a.title.localeCompare(b.title)),
      counts: countOutcomes(group),
      durationMs: group.reduce((sum, test) => sum + test.durationMs, 0),
    }))
    // Broken files first — that is what someone opening a failed run came for.
    .sort((a, b) => b.counts.failed - a.counts.failed || a.file.localeCompare(b.file));
}

/**
 * Wall-clock window the run occupied. Sharding means this is much shorter than
 * the summed test time, and it is what the timeline is scaled against.
 *
 * `completedAt` is null while a run is still going, so the end falls back to the
 * furthest point any attempt reached.
 */
export function runWindow(detail: RunDetail): { start: number; end: number } {
  const start = Math.min(
    toTime(detail.run.startedAt),
    ...detail.attempts.map((attempt) => toTime(attempt.startedAt)),
  );
  const attemptEnd = detail.attempts.reduce(
    (max, attempt) => Math.max(max, toTime(attempt.startedAt) + attempt.durationMs),
    start,
  );
  const end = detail.run.completedAt
    ? Math.max(toTime(detail.run.completedAt), attemptEnd)
    : Math.max(attemptEnd, Date.now());
  // A run with a single instant attempt would otherwise have a zero-width range,
  // which divides by zero when the timeline maps values to pixels.
  return { start, end: end > start ? end : start + 1000 };
}
