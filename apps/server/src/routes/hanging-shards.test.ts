/**
 * Runs left hanging by shards that never sign off.
 *
 * End to end against a real Postgres: shards talk to the ingest routes through
 * `createApp`, the dashboard reads through the tRPC router, and `Date` is
 * mocked, so "ten minutes later" takes milliseconds. There is no background
 * job to wait for: every check happens inside a ping, a sign-off or a read.
 *
 *   TEST_DATABASE_URL=postgres://…/cameri_test pnpm --filter @camerihq/server test
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import type { CreateRunResponse, ShardHeartbeatResponse } from "@camerihq/contract";
import { RECORD_KEY_HEADER } from "@camerihq/contract/constants";
import { projects, recordKeys } from "@camerihq/db";
import { eq } from "drizzle-orm";
import { createApp } from "../app.ts";
import { hashRecordKey } from "../auth.ts";
import { createContext, type AppContext } from "../context.ts";
import { loadEnv, type Env } from "../env.ts";
import { migrateToLatest } from "../migrations.ts";
import { appRouter } from "../trpc/router.ts";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Short, so the wait for missing shards fits in a few ticks. */
const STALE_MINUTES = 5;
/** The defaults: a shard is abandoned after 90 seconds without a ping. */
const PING_MS = 30_000;
const SILENCE_LIMIT_MS = 3 * PING_MS;

const EMPTY_STATS = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 };

describe(
  "hanging shards",
  { skip: TEST_DATABASE_URL ? false : "set TEST_DATABASE_URL to run" },
  () => {
    let env: Env;
    let context: AppContext;
    let server: ReturnType<typeof createApp>;
    let projectId: string;
    let recordKey: string;

    before(async () => {
      env = loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        RUN_STALE_MINUTES: String(STALE_MINUTES),
        SHARD_HEARTBEAT_INTERVAL_SECONDS: String(PING_MS / 1000),
        SHARD_HEARTBEAT_MAX_MISSES: "3",
      });
      await migrateToLatest(env);
      context = createContext(env);
      server = createApp(context);

      const [project] = await context.db
        .insert(projects)
        .values({ name: "hanging shards", slug: `hanging-shards-${randomUUID()}` })
        .returning({ id: projects.id });
      assert.ok(project);
      projectId = project.id;

      recordKey = `cam_test_${randomUUID()}`;
      await context.db
        .insert(recordKeys)
        .values({ projectId, name: "test", keyHash: hashRecordKey(recordKey) });
    });

    after(async () => {
      // Cascades to the record key, runs and shards.
      await context.db.delete(projects).where(eq(projects.id, projectId));
      await context.close();
    });

    // Only `Date` is faked: the pg pool runs on real timers, so the database
    // still answers in real time.
    beforeEach(() => {
      mock.timers.enable({ apis: ["Date"], now: Date.now() });
    });

    afterEach(() => {
      mock.timers.reset();
    });

    const elapse = (ms: number) => mock.timers.tick(ms);

    // --- a CI shard, as the reporter drives it -----------------------------------

    async function post(path: string, body: unknown): Promise<Response> {
      return server.request(`/api/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [RECORD_KEY_HEADER]: recordKey },
        body: JSON.stringify(body),
      });
    }

    async function openShard(
      runKey: string,
      shardIndex: number,
      expectedShards: number,
    ): Promise<CreateRunResponse> {
      const response = await post("/runs", { runKey, shardIndex, expectedShards });
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()) as CreateRunResponse;
    }

    async function ping(shard: CreateRunResponse): Promise<ShardHeartbeatResponse["shardStatus"]> {
      const response = await post("/shards/heartbeat", {
        runId: shard.runId,
        shardId: shard.shardId,
      });
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as ShardHeartbeatResponse).shardStatus;
    }

    async function completeShard(shard: CreateRunResponse): Promise<void> {
      const response = await post("/shards/complete", {
        runId: shard.runId,
        shardId: shard.shardId,
        stats: EMPTY_STATS,
      });
      assert.equal(response.status, 200, await response.clone().text());
    }

    // --- the dashboard -------------------------------------------------------------

    /** A dashboard read, which runs the health check on the way. */
    async function read(runId: string, app: AppContext = context) {
      const result = await appRouter.createCaller({ app }).runs.get({ runId });
      assert.ok(result, "run not found");
      return result;
    }

    async function runStatus(runId: string): Promise<string> {
      return (await read(runId)).run.status;
    }

    async function shardStatus(shard: CreateRunResponse): Promise<string | undefined> {
      const { shards } = await read(shard.runId);
      return shards.find((row) => row.id === shard.shardId)?.status;
    }

    const newRunKey = () => `hanging-${randomUUID()}`;

    // --- pings -----------------------------------------------------------------------

    it("hands the reporter its ping rate and answers its pings", async () => {
      const shard = await openShard(newRunKey(), 1, 1);
      assert.equal(shard.heartbeatIntervalMs, PING_MS);
      assert.equal(await ping(shard), "running");
    });

    it("never abandons a shard that keeps pinging, however long its test runs", async () => {
      const shard = await openShard(newRunKey(), 1, 1);

      // One test that runs for an hour, so no results at all, only pings.
      for (let i = 0; i < 120; i += 1) {
        elapse(PING_MS);
        assert.equal(await ping(shard), "running");
      }
      assert.equal(await runStatus(shard.runId), "running");

      await completeShard(shard);
      assert.equal(await runStatus(shard.runId), "passed");
    });

    // --- a shard goes silent ---------------------------------------------------------

    it("lets a live sibling abandon a silent shard, and closes the run when the rest finish", async () => {
      const runKey = newRunKey();
      const live = await openShard(runKey, 1, 2);
      const killed = await openShard(runKey, 2, 2);

      // Shard 2's runner is killed. Shard 1 keeps pinging, and notices.
      for (let i = 0; i < 4; i += 1) {
        elapse(PING_MS);
        await ping(live);
      }
      assert.equal(await shardStatus(killed), "abandoned");
      // Shard 1 is still running, so the run is too.
      assert.equal(await runStatus(live.runId), "running");

      await completeShard(live);
      assert.equal(await runStatus(live.runId), "timedOut");
      assert.equal(await shardStatus(live), "completed");
    });

    it("closes a run with nobody left to ping when it is read", async () => {
      const shard = await openShard(newRunKey(), 1, 1);

      elapse(SILENCE_LIMIT_MS - 1_000);
      assert.equal(await runStatus(shard.runId), "running");

      elapse(2_000);
      assert.equal(await runStatus(shard.runId), "timedOut");
      assert.equal(await shardStatus(shard), "abandoned");
    });

    it("keeps an abandoned shard abandoned, even when it turns out to be alive", async () => {
      const runKey = newRunKey();
      const live = await openShard(runKey, 1, 2);
      const partitioned = await openShard(runKey, 2, 2);

      // A network partition: shard 2 is alive, but no ping gets through.
      elapse(SILENCE_LIMIT_MS + PING_MS);
      await ping(live);
      assert.equal(await shardStatus(partitioned), "abandoned");

      // The partition heals. The server tells it to stop, and keeps the verdict.
      assert.equal(await ping(partitioned), "abandoned");
      await completeShard(partitioned);
      assert.equal(await shardStatus(partitioned), "abandoned");

      await completeShard(live);
      assert.equal(await runStatus(live.runId), "timedOut");
    });

    it("starts a rerun of an abandoned shard over, which reopens its run", async () => {
      const runKey = newRunKey();
      const first = await openShard(runKey, 1, 1);
      elapse(SILENCE_LIMIT_MS + 1_000);
      assert.equal(await runStatus(first.runId), "timedOut");

      // CI retries the job: a new instance of the same shard.
      const rerun = await openShard(runKey, 1, 1);
      assert.equal(rerun.shardId, first.shardId);
      assert.equal(await ping(rerun), "running");
      assert.equal(await runStatus(rerun.runId), "running");

      await completeShard(rerun);
      assert.equal(await runStatus(rerun.runId), "passed");
    });

    // --- shards that never join ------------------------------------------------------

    it("waits RUN_STALE_MINUTES for a shard that never joins, then times the run out", async () => {
      const shard = await openShard(newRunKey(), 1, 2);
      await completeShard(shard);
      assert.equal(await runStatus(shard.runId), "running");

      elapse((STALE_MINUTES - 1) * 60_000);
      assert.equal(await runStatus(shard.runId), "running");

      elapse(2 * 60_000);
      assert.equal(await runStatus(shard.runId), "timedOut");
    });

    it("lets a shard that waited in a CI queue join and finish the run", async () => {
      const runKey = newRunKey();
      const early = await openShard(runKey, 1, 2);
      await completeShard(early);

      // Shard 2's job waited for a runner, then started.
      elapse((STALE_MINUTES - 1) * 60_000);
      const late = await openShard(runKey, 2, 2);
      await ping(late);
      assert.equal(await runStatus(late.runId), "running");

      await completeShard(late);
      assert.equal(await runStatus(late.runId), "passed");
    });

    // --- the server itself -----------------------------------------------------------

    it("does not count server downtime as silence", async () => {
      const shard = await openShard(newRunKey(), 1, 1);

      // The server is down for five minutes, so none of the shard's pings land.
      elapse(5 * 60_000);
      const restarted = createContext(env);
      try {
        assert.equal((await read(shard.runId, restarted)).run.status, "running");

        // Back up, and the shard's pings land again.
        elapse(PING_MS);
        assert.equal(await ping(shard), "running");
        elapse(SILENCE_LIMIT_MS - 1_000);
        assert.equal((await read(shard.runId, restarted)).run.status, "running");
      } finally {
        await restarted.close();
      }
    });
  },
);
