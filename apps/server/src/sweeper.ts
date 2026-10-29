import { runs, shards } from "@camerihq/db";
import { and, inArray, isNull, lt } from "drizzle-orm";
import type { AppContext } from "./context.ts";

/** How often to look for dead runs. Cheap: it reads a partial index. */
const SWEEP_INTERVAL_MS = 60_000;

export interface StaleRunSweeper {
  stop: () => void;
}

/**
 * Closes runs whose shards went quiet, so a build never sits at `running`
 * forever.
 *
 * A run only completes when its last expected shard signs off, and plenty of
 * things stop that from happening: a runner killed mid-suite, a shard that
 * reported to a different run because it could not see the CI build id, a job
 * cancelled before Playwright started. `staleAt` is pushed forward on every
 * sign of life, so anything still past it has had `RUN_STALE_MINUTES` of
 * silence and is presumed dead.
 *
 * Safe to run on every replica at once: the update is conditional on the run
 * still being open, so a second sweeper finds nothing left to do.
 */
export function startStaleRunSweeper(app: AppContext): StaleRunSweeper {
  const sweep = async (): Promise<void> => {
    const now = new Date();

    const swept = await app.db
      .update(runs)
      .set({ status: "timedOut", completedAt: now })
      .where(and(isNull(runs.completedAt), lt(runs.staleAt, now)))
      .returning({ id: runs.id });
    if (swept.length === 0) return;

    const ids = swept.map((run) => run.id);

    // The shards that never signed off are the reason the run is dead; say so,
    // rather than leaving them `running` under a run that is not.
    await app.db
      .update(shards)
      .set({ status: "abandoned" })
      .where(and(inArray(shards.runId, ids), isNull(shards.completedAt)));

    for (const id of ids) app.mrComments.schedule(id, { final: true });
    console.log(`[cameri] swept ${ids.length} stale run(s) to timedOut`);
  };

  const tick = () => {
    sweep().catch((error: unknown) => {
      // Never fatal: the next tick tries again, and ingest does not depend on it.
      console.warn(
        `[cameri] stale run sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  // Once at boot, so runs that died while the server was down close promptly.
  tick();
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
