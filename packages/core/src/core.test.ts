import assert from "node:assert/strict";
import { test } from "node:test";
import { flakeRate, isFlakyWithinRun } from "./flake.ts";
import { errorSignature, normalizeErrorMessage } from "./signature.ts";
import { aggregateStats, deriveRunStatus } from "./stats.ts";

test("a fail-then-pass retry chain is flaky", () => {
  assert.equal(
    isFlakyWithinRun([
      { testId: "t1", retry: 0, status: "failed" },
      { testId: "t1", retry: 1, status: "passed" },
    ]),
    true,
  );
});

test("a test that never recovers is not flaky, it is failed", () => {
  assert.equal(
    isFlakyWithinRun([
      { testId: "t1", retry: 0, status: "failed" },
      { testId: "t1", retry: 1, status: "failed" },
    ]),
    false,
  );
});

test("a first-try pass is not flaky", () => {
  assert.equal(isFlakyWithinRun([{ testId: "t1", retry: 0, status: "passed" }]), false);
});

test("flakeRate counts verdict flips across runs", () => {
  assert.equal(flakeRate(["passed", "failed", "passed", "failed"]), 1);
  assert.equal(flakeRate(["passed", "passed", "passed"]), 0);
  assert.equal(flakeRate(["passed"]), 0);
});

test("stats count tests rather than attempts", () => {
  const stats = aggregateStats([
    { testId: "a", retry: 0, status: "failed", durationMs: 100 },
    { testId: "a", retry: 1, status: "passed", durationMs: 90 },
    { testId: "b", retry: 0, status: "passed", durationMs: 10 },
    { testId: "c", retry: 0, status: "failed", durationMs: 50 },
    { testId: "d", retry: 0, status: "skipped", durationMs: 0 },
  ]);

  assert.equal(stats.total, 4);
  assert.equal(stats.flaky, 1);
  assert.equal(stats.passed, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.durationMs, 250);
});

test("an in-flight test is counted but not judged", () => {
  const stats = aggregateStats([
    { testId: "a", retry: 0, status: "passed", durationMs: 10 },
    // Still going: the start marker, with no result behind it yet.
    { testId: "b", retry: 0, status: "running", durationMs: 0 },
    // Failed once and is now retrying, which is not the same as having failed.
    { testId: "c", retry: 0, status: "failed", durationMs: 20 },
    { testId: "c", retry: 1, status: "running", durationMs: 0 },
  ]);

  assert.equal(stats.total, 3);
  assert.equal(stats.passed, 1);
  assert.equal(stats.failed, 0);
  assert.equal(stats.flaky, 0);
  assert.equal(stats.skipped, 0);
});

test("a run with tests still in flight is not green", () => {
  const stats = aggregateStats([{ testId: "a", retry: 0, status: "running", durationMs: 0 }]);
  // Nothing has failed, but no shard has signed off either, so it is still going.
  assert.equal(
    deriveRunStatus(stats, { allShardsReported: false, anyShardAbandoned: false }),
    "running",
  );
});

test("a run stays running until every shard reports", () => {
  const stats = aggregateStats([{ testId: "a", retry: 0, status: "passed", durationMs: 1 }]);
  assert.equal(
    deriveRunStatus(stats, { allShardsReported: false, anyShardAbandoned: false }),
    "running",
  );
  assert.equal(
    deriveRunStatus(stats, { allShardsReported: true, anyShardAbandoned: false }),
    "passed",
  );
  assert.equal(
    deriveRunStatus(stats, { allShardsReported: true, anyShardAbandoned: true }),
    "timedOut",
  );
});

test("error normalization collapses volatile detail", () => {
  const a = normalizeErrorMessage("Timed out 5000ms waiting for locator('#id-42')");
  const b = normalizeErrorMessage("Timed out 3000ms waiting for locator('#id-91')");
  assert.equal(a, b);
});

test("same message from different call sites gets different signatures", () => {
  const one = errorSignature({
    message: "expected true",
    stack: "at Object.<anonymous> (/repo/tests/login.spec.ts:10:5)",
  });
  const two = errorSignature({
    message: "expected true",
    stack: "at Object.<anonymous> (/repo/tests/cart.spec.ts:10:5)",
  });
  assert.notEqual(one, two);
});
