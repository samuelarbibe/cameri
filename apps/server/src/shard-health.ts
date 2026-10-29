import type { RunStats, RunStatus } from "@camerihq/contract";
import { deriveRunStatus, mergeStats } from "@camerihq/core";
import { runs, shards, type Run } from "@camerihq/db";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { AppContext } from "./context.ts";

type Tx = Parameters<Parameters<AppContext["db"]["transaction"]>[0]>[0];

const EMPTY_STATS: RunStats = {
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  flaky: 0,
  durationMs: 0,
};

export interface SettledRun {
  status: RunStatus;
  /** True when this call is the one that closed the run. */
  closedNow: boolean;
  shardsCompleted: number;
  expectedShards: number;
}

/**
 * Locks a run row for the rest of the transaction.
 *
 * Every transaction that touches a run's shards takes this lock first, so two
 * of them cannot deadlock over each other's shard rows. `skipLocked` is for
 * readers: if someone is already settling the run, there is nothing to add.
 */
export async function lockRun(
  tx: Tx,
  runId: string,
  { skipLocked = false } = {},
): Promise<Run | undefined> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update", skipLocked ? { skipLocked: true } : undefined)
    .limit(1);
  return run;
}

/**
 * Health check for one run. The caller must hold `lockRun`.
 *
 * There is no background job: this runs whenever a shard pings or signs off,
 * and whenever the run is read. Live shards check on their siblings, and a
 * reader checks on a run with nobody left to ping.
 *
 *  1. A running shard that has missed `SHARD_HEARTBEAT_MAX_MISSES` pings is
 *     abandoned. That is final: what happened on that machine is not rewritten,
 *     and only a rerun of the shard (a new `createRun`) starts it over.
 *  2. While any shard is still running, so is the run.
 *  3. Once none is, the run closes, unless fewer shards joined than expected.
 *     A CI job still waiting for a runner looks exactly like a cancelled one,
 *     so missing shards get `RUN_STALE_MINUTES` from the last time any shard
 *     was seen before the run is closed as `timedOut`.
 */
export async function settleRun(
  tx: Tx,
  app: Pick<AppContext, "env" | "bootedAt">,
  run: Run,
): Promise<SettledRun> {
  const { env, bootedAt } = app;
  const now = new Date();

  const silenceLimitMs =
    env.SHARD_HEARTBEAT_INTERVAL_SECONDS * 1000 * env.SHARD_HEARTBEAT_MAX_MISSES;
  const lastPingDue = new Date(now.getTime() - silenceLimitMs);

  // Nobody can ping a server that is down, so silence from before this process
  // started says nothing about a shard. Without this, the first check after an
  // outage would abandon every live shard.
  if (bootedAt < lastPingDue) {
    await tx
      .update(shards)
      .set({ status: "abandoned" })
      .where(
        and(
          eq(shards.runId, run.id),
          eq(shards.status, "running"),
          isNull(shards.completedAt),
          lt(shards.lastSeenAt, lastPingDue),
        ),
      );
  }

  const shardRows = await tx.select().from(shards).where(eq(shards.runId, run.id));
  const completed = shardRows.filter((shard) => shard.completedAt !== null);
  const anyRunning = shardRows.some(
    (shard) => shard.status === "running" && shard.completedAt === null,
  );

  let status: RunStatus;
  if (anyRunning) {
    status = "running";
  } else if (shardRows.length < run.expectedShards) {
    const lastSeen = Math.max(...shardRows.map((shard) => shard.lastSeenAt.getTime()));
    const waitUntil = lastSeen + env.RUN_STALE_MINUTES * 60_000;
    status = now.getTime() > waitUntil ? "timedOut" : "running";
  } else {
    status = deriveRunStatus(mergeStats(completed.map((shard) => shard.stats ?? EMPTY_STATS)), {
      allShardsReported: true,
      anyShardAbandoned: shardRows.some((shard) => shard.status === "abandoned"),
    });
  }

  // A run that stays closed keeps the time it first closed.
  const completedAt = status === "running" ? null : (run.completedAt ?? now);
  if (status !== run.status || completedAt !== run.completedAt) {
    await tx.update(runs).set({ status, completedAt }).where(eq(runs.id, run.id));
  }

  return {
    status,
    closedNow: run.completedAt === null && completedAt !== null,
    shardsCompleted: completed.length,
    expectedShards: run.expectedShards,
  };
}

/**
 * The health check on the read path, for runs with nobody left to ping: a
 * single-shard run whose runner was killed, or a build whose jobs were all
 * cancelled. Pass `runId` for one run, or `projectId` for every open run in it.
 *
 * Never fails the read: a check that errors is logged and the read goes on
 * with what is stored.
 */
export async function settleOpenRuns(
  app: AppContext,
  scope: { runId: string } | { projectId: string },
): Promise<void> {
  try {
    const open = await app.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          isNull(runs.completedAt),
          "runId" in scope ? eq(runs.id, scope.runId) : eq(runs.projectId, scope.projectId),
        ),
      );

    for (const { id } of open) {
      const settled = await app.db.transaction(async (tx) => {
        const run = await lockRun(tx, id, { skipLocked: true });
        return run ? settleRun(tx, app, run) : undefined;
      });
      if (settled?.closedNow) app.mrComments.schedule(id, { final: true });
    }
  } catch (error) {
    console.warn(
      `[cameri] run health check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
