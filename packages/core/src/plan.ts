import { createHash } from "node:crypto";
import type { PlanStrategy } from "@camerihq/contract";

/**
 * Splitting spec files across shards, weighted by how long they took last time.
 *
 * Playwright's own `--shard=i/n` cuts the list into n contiguous blocks, which
 * is only balanced if every spec costs the same. It never does: one file with a
 * twenty-minute login journey and forty files of unit-ish assertions produce a
 * build whose length is the length of whichever shard drew the long file, with
 * the rest sitting idle. Everything here exists to make that split by *time*
 * instead of by count.
 *
 * Deliberately pure. The server holds the history and persists the result; this
 * module only decides, so the decision can be tested without a database.
 */

export interface ShardPlan {
  /** `assignments[i]` is the spec list for shard `i + 1`. Never sparse. */
  assignments: string[][];
  /** Predicted wall time per shard, same indexing. Zero under `even`. */
  estimatedMs: number[];
  strategy: PlanStrategy;
}

/**
 * Longest-processing-time-first: sort by cost descending, and give each spec to
 * whichever shard is currently cheapest.
 *
 * A greedy pass rather than an exact partition, because exact is NP-hard and
 * LPT lands within 4/3 of optimal — far inside the noise of a CI runner. What
 * matters more is that it is *deterministic*: shards call this at different
 * moments and the tie-breaks below make the answer independent of arrival
 * order, so the plan can be recomputed and still agree with itself.
 */
export function planShards(
  specs: readonly string[],
  durationsMs: ReadonlyMap<string, number>,
  shardCount: number,
): ShardPlan {
  const assignments: string[][] = Array.from({ length: shardCount }, () => []);
  const estimatedMs: number[] = Array.from({ length: shardCount }, () => 0);

  const unique = [...new Set(specs)];
  const known = unique.map((spec) => durationsMs.get(spec)).filter((ms) => ms !== undefined);

  // Nothing has ever run here — no history to be weighted by, so say so rather
  // than pretending an unweighted split is a balanced one.
  if (known.length === 0) {
    const ordered = [...unique].sort(compareSpecs);
    for (const [i, spec] of ordered.entries()) {
      assignments[i % shardCount]?.push(spec);
    }
    return { assignments, estimatedMs, strategy: "even" };
  }

  // A brand new spec has no history and would otherwise weigh nothing, so LPT
  // would place it last and pile every new file onto one shard. The median of
  // what is known is the least wrong guess available.
  const fallback = median(known);

  const weighted = unique
    .map((spec) => ({ spec, weight: durationsMs.get(spec) ?? fallback }))
    .sort((a, b) => b.weight - a.weight || compareSpecs(a.spec, b.spec));

  for (const { spec, weight } of weighted) {
    let target = 0;
    for (let i = 1; i < shardCount; i += 1) {
      // Strictly less than, so equal loads go to the lowest index — the tie-break
      // that keeps two servers computing the same plan from the same input.
      if ((estimatedMs[i] as number) < (estimatedMs[target] as number)) target = i;
    }
    assignments[target]?.push(spec);
    estimatedMs[target] = (estimatedMs[target] as number) + weight;
  }

  // Within a shard the order is cosmetic — Playwright decides what runs when —
  // but a stable one makes two plans diffable by eye.
  for (const list of assignments) list.sort(compareSpecs);

  return { assignments, estimatedMs: estimatedMs.map(Math.round), strategy: "history" };
}

/**
 * Lines up recorded durations, keyed by whatever path the CI machine reported,
 * against the relative paths a client is asking about.
 *
 * These two never match on the nose. Playwright hands the reporter
 * `test.location.file`, an absolute path on the runner — `/builds/acme/app/
 * tests/checkout.spec.ts` — while `--list` talks in paths relative to `rootDir`
 * — `tests/checkout.spec.ts`. Matching on the suffix is what bridges them, and
 * it survives the thing that would otherwise wreck this history: a checkout
 * directory that changes between builds.
 */
export function matchDurations(
  specs: readonly string[],
  history: ReadonlyMap<string, number>,
): Map<string, number> {
  // Bucketed by file name so each spec is only suffix-tested against the
  // handful of history entries that could possibly match it.
  const byBasename = new Map<string, Array<{ path: string; ms: number }>>();
  for (const [rawPath, ms] of history) {
    const path = normalizePath(rawPath);
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const bucket = byBasename.get(basename);
    if (bucket) bucket.push({ path, ms });
    else byBasename.set(basename, [{ path, ms }]);
  }

  const matched = new Map<string, number>();
  for (const spec of specs) {
    const path = normalizePath(spec);
    const candidates = byBasename.get(path.slice(path.lastIndexOf("/") + 1));
    if (!candidates) continue;

    let best: number | undefined;
    for (const candidate of candidates) {
      if (candidate.path !== path && !candidate.path.endsWith(`/${path}`)) continue;
      // Two checkouts of the same file under different roots, or a repo with
      // `a/util.spec.ts` and `b/a/util.spec.ts`. Both are ambiguous; the slower
      // reading is the safe one, since underestimating is what leaves a shard
      // running long after the others have finished.
      best = best === undefined ? candidate.ms : Math.max(best, candidate.ms);
    }
    if (best !== undefined) matched.set(spec, best);
  }

  return matched;
}

/**
 * Fingerprint of a spec list, so a shard can be told its list is not the one
 * the plan was built from.
 *
 * Order-insensitive: `--list` is deterministic in practice, but two shards
 * disagreeing about ordering is not a disagreement worth failing over. Two
 * shards disagreeing about *contents* is.
 */
export function specDigest(specs: readonly string[]): string {
  const canonical = [...new Set(specs.map(normalizePath))].sort(compareSpecs).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Plain codepoint order, so the sort does not shift with the runner's locale. */
function compareSpecs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
