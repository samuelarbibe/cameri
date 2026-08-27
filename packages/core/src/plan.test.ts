import assert from "node:assert/strict";
import { test } from "node:test";
import { matchDurations, planShards, specDigest } from "./plan.ts";

const durations = (entries: Record<string, number>) => new Map(Object.entries(entries));

test("the long spec is balanced against several short ones", () => {
  const plan = planShards(
    ["slow.spec.ts", "a.spec.ts", "b.spec.ts", "c.spec.ts"],
    durations({ "slow.spec.ts": 300, "a.spec.ts": 100, "b.spec.ts": 100, "c.spec.ts": 100 }),
    2,
  );

  assert.deepEqual(plan.assignments[0], ["slow.spec.ts"]);
  assert.deepEqual(plan.assignments[1], ["a.spec.ts", "b.spec.ts", "c.spec.ts"]);
  assert.deepEqual(plan.estimatedMs, [300, 300]);
  assert.equal(plan.strategy, "history");
});

test("a contiguous split would be the unbalanced one", () => {
  // What --shard=i/2 does with the same input: two files each, and one shard
  // carrying the slow one on top of a normal file.
  const plan = planShards(
    ["a.spec.ts", "b.spec.ts", "c.spec.ts", "slow.spec.ts"],
    durations({ "a.spec.ts": 100, "b.spec.ts": 100, "c.spec.ts": 100, "slow.spec.ts": 900 }),
    2,
  );

  const [first = 0, second = 0] = plan.estimatedMs;
  assert.equal(Math.max(first, second), 900);
  // The point of the exercise: 900 against 300, not 1000 against 200.
  assert.equal(Math.min(first, second), 300);
});

test("every spec is assigned exactly once", () => {
  const specs = Array.from({ length: 37 }, (_, i) => `spec-${i}.ts`);
  const plan = planShards(specs, durations({ "spec-0.ts": 1_000 }), 5);

  const assigned = plan.assignments.flat();
  assert.equal(assigned.length, 37);
  assert.deepEqual([...assigned].sort(), [...specs].sort());
});

test("no shard is left empty when there are specs to go round", () => {
  const plan = planShards(["a.ts", "b.ts", "c.ts", "d.ts"], durations({ "a.ts": 50 }), 4);
  for (const list of plan.assignments) assert.equal(list.length, 1);
});

test("a spec with no history is weighted at the median, not treated as free", () => {
  const plan = planShards(
    ["slow.spec.ts", "quick.spec.ts", "new.spec.ts"],
    durations({ "slow.spec.ts": 500, "quick.spec.ts": 100 }),
    2,
  );

  // 500 + 100 + a median of 300 for the file nobody has ever run. Weighted at
  // zero it would total 600, and every new file added in one commit would pile
  // onto whichever shard happened to be cheapest at that moment.
  const total = plan.estimatedMs.reduce((sum, ms) => sum + ms, 0);
  assert.equal(total, 900);
});

test("with no history at all the split is by count, and says so", () => {
  const plan = planShards(["a.ts", "b.ts", "c.ts"], new Map(), 2);
  assert.equal(plan.strategy, "even");
  assert.equal(plan.assignments.flat().length, 3);
});

test("the same input always produces the same plan", () => {
  const specs = ["e.ts", "a.ts", "d.ts", "b.ts", "c.ts"];
  const weights = durations({ "a.ts": 10, "b.ts": 10, "c.ts": 10, "d.ts": 10, "e.ts": 10 });

  const first = planShards(specs, weights, 3);
  // Arrival order must not change the answer: shards call this independently.
  const second = planShards([...specs].reverse(), weights, 3);
  assert.deepEqual(first.assignments, second.assignments);
});

test("history recorded as an absolute CI path matches a relative spec", () => {
  const matched = matchDurations(
    ["tests/checkout.spec.ts"],
    durations({ "/builds/acme/app/tests/checkout.spec.ts": 4_200 }),
  );
  assert.equal(matched.get("tests/checkout.spec.ts"), 4_200);
});

test("a partial path segment is not a match", () => {
  // `tests/out.spec.ts` is a suffix of `.../checkout.spec.ts` as a string, but
  // not as a path, and charging one file's history to another would be wrong.
  const matched = matchDurations(
    ["tests/out.spec.ts"],
    durations({ "/builds/acme/tests/checkout.spec.ts": 4_200 }),
  );
  assert.equal(matched.size, 0);
});

test("an ambiguous match takes the slower reading", () => {
  const matched = matchDurations(
    ["a.spec.ts"],
    durations({ "/one/a.spec.ts": 100, "/two/a.spec.ts": 900 }),
  );
  assert.equal(matched.get("a.spec.ts"), 900);
});

test("windows separators match a posix history", () => {
  const matched = matchDurations(
    ["tests\\login.spec.ts"],
    durations({ "/builds/app/tests/login.spec.ts": 50 }),
  );
  assert.equal(matched.get("tests\\login.spec.ts"), 50);
});

test("the digest ignores order but not contents", () => {
  assert.equal(specDigest(["a.ts", "b.ts"]), specDigest(["b.ts", "a.ts"]));
  assert.notEqual(specDigest(["a.ts", "b.ts"]), specDigest(["a.ts", "c.ts"]));
  // Two shards that expressed the same path differently still agree.
  assert.equal(specDigest(["./a.ts"]), specDigest(["a.ts"]));
});
