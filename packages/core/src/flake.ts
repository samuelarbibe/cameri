import type { TestAttempt, TestStatus } from "@camerihq/contract";

/** The subset of an attempt the flake rules actually need. */
export interface AttemptLike {
  testId: string;
  retry: number;
  status: TestStatus;
}

/**
 * Within a single run, a test is flaky when it failed at least once and then
 * passed on a later retry — same code, same commit, different outcome.
 */
export function isFlakyWithinRun(attempts: readonly AttemptLike[]): boolean {
  if (attempts.length < 2) return false;
  const ordered = [...attempts].sort((a, b) => a.retry - b.retry);
  const final = ordered[ordered.length - 1];
  if (final?.status !== "passed") return false;
  return ordered.slice(0, -1).some((a) => a.status === "failed" || a.status === "timedOut");
}

/** Groups attempts by test so each test's retry chain can be judged on its own. */
export function groupByTest<T extends { testId: string }>(
  attempts: readonly T[],
): Map<string, T[]> {
  const byTest = new Map<string, T[]>();
  for (const attempt of attempts) {
    const bucket = byTest.get(attempt.testId);
    if (bucket) bucket.push(attempt);
    else byTest.set(attempt.testId, [attempt]);
  }
  return byTest;
}

export function flakyTestIds(attempts: readonly AttemptLike[]): string[] {
  const flaky: string[] = [];
  for (const [testId, group] of groupByTest(attempts)) {
    if (isFlakyWithinRun(group)) flaky.push(testId);
  }
  return flaky;
}

/**
 * Share of runs in which a test changed verdict without the code changing.
 * Feed this the *final* status per run, oldest first; returns 0..1.
 */
export function flakeRate(finalStatuses: readonly TestStatus[]): number {
  const meaningful = finalStatuses.filter((s) => s !== "skipped");
  if (meaningful.length < 2) return 0;
  let flips = 0;
  for (let i = 1; i < meaningful.length; i += 1) {
    if (meaningful[i] !== meaningful[i - 1]) flips += 1;
  }
  return flips / (meaningful.length - 1);
}

/** Narrowing helper so callers can pass whole attempts without mapping first. */
export function toAttemptLike(attempt: TestAttempt): AttemptLike {
  return { testId: attempt.testId, retry: attempt.retry, status: attempt.status };
}
