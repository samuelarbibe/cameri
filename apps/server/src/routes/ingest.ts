import { Readable } from "node:stream";
import {
  completeShardRequestSchema,
  createRunRequestSchema,
  reportResultsRequestSchema,
  type CompleteShardResponse,
  type CreateRunResponse,
  type ReportResultsResponse,
  type RunStats,
  type UploadTarget,
} from "@camerihq/contract";
import { deriveRunStatus, errorSignature, isFlakyWithinRun, mergeStats } from "@camerihq/core";
import {
  attachments,
  runs,
  shards,
  testAttempts,
  tests,
  type NewAttachment,
  type NewTestAttempt,
} from "@camerihq/db";
import { and, desc, eq, getTableColumns, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { recordKeyAuth } from "../auth.ts";
import type { AppContext } from "../context.ts";

const EMPTY_STATS: RunStats = {
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  flaky: 0,
  durationMs: 0,
};

export function ingestRoutes(app: AppContext) {
  const router = new Hono();
  const { db, storage, env } = app;

  router.get("/health", (c) => c.json({ ok: true }));

  router.use("/runs", recordKeyAuth(app));
  router.use("/results", recordKeyAuth(app));
  router.use("/shards/*", recordKeyAuth(app));

  /**
   * Open or join a run.
   *
   * Every shard of a build calls this concurrently with the same `runKey`, so
   * it has to be an upsert: the (project, run_key) unique index elects one
   * winner and the losers read the winner's row back out of RETURNING.
   */
  router.post("/runs", async (c) => {
    const body = createRunRequestSchema.parse(await c.req.json());
    const { projectId } = c.get("project");

    const staleAt = new Date(Date.now() + env.RUN_STALE_MINUTES * 60_000);

    const [run] = await db
      .insert(runs)
      .values({
        projectId,
        runKey: body.runKey,
        expectedShards: body.expectedShards,
        playwrightVersion: body.playwrightVersion ?? null,
        branch: body.git.branch ?? null,
        commitSha: body.git.commitSha ?? null,
        commitMessage: body.git.commitMessage ?? null,
        author: body.git.author ?? null,
        remoteUrl: body.git.remoteUrl ?? null,
        ciProvider: body.ci.provider ?? null,
        ciBuildId: body.ci.buildId ?? null,
        ciBuildUrl: body.ci.buildUrl ?? null,
        ciJobName: body.ci.jobName ?? null,
        ciAttempt: body.ci.attempt,
        mrProvider: body.mr.provider ?? null,
        mrProjectId: body.mr.projectId ?? null,
        mrIid: body.mr.iid ?? null,
        mrTitle: body.mr.title ?? null,
        mrTargetBranch: body.mr.targetBranch ?? null,
        mrServerUrl: body.mr.serverUrl ?? null,
        mrUrl: body.mr.webUrl ?? null,
        metadata: body.metadata,
        staleAt,
      })
      .onConflictDoUpdate({
        target: [runs.projectId, runs.runKey],
        // Shards can disagree about the total (a rerun of one shard passes 1).
        // Trust the largest claim rather than the last writer.
        set: {
          expectedShards: sql`greatest(${runs.expectedShards}, excluded.expected_shards)`,
          staleAt,
          // Every shard of a merge request pipeline reports the same
          // coordinates, so any of them will do — but a shard from an older
          // reporter sends nulls, and those must not erase what a newer one
          // already established.
          mrProvider: sql`coalesce(excluded.mr_provider, ${runs.mrProvider})`,
          mrProjectId: sql`coalesce(excluded.mr_project_id, ${runs.mrProjectId})`,
          mrIid: sql`coalesce(excluded.mr_iid, ${runs.mrIid})`,
          mrTitle: sql`coalesce(excluded.mr_title, ${runs.mrTitle})`,
          mrTargetBranch: sql`coalesce(excluded.mr_target_branch, ${runs.mrTargetBranch})`,
          mrServerUrl: sql`coalesce(excluded.mr_server_url, ${runs.mrServerUrl})`,
          mrUrl: sql`coalesce(excluded.mr_url, ${runs.mrUrl})`,
        },
      })
      // `xmax = 0` is true only for a freshly inserted row, which is the
      // cheapest way to tell "I created this" from "I joined it".
      .returning({ ...getTableColumns(runs), inserted: sql<boolean>`(xmax = 0)` });

    if (!run) throw new HTTPException(500, { message: "could not open run" });

    const [shard] = await db
      .insert(shards)
      .values({ runId: run.id, shardIndex: body.shardIndex })
      .onConflictDoUpdate({
        target: [shards.runId, shards.shardIndex],
        set: { lastSeenAt: new Date(), status: "running" },
      })
      .returning();

    if (!shard) throw new HTTPException(500, { message: "could not open shard" });

    // Posts the "running" comment as soon as the first shard opens the run, so
    // a reviewer sees that tests started rather than nothing until they finish.
    app.mrComments.schedule(run.id);

    const response: CreateRunResponse = {
      runId: run.id,
      shardId: shard.id,
      projectId,
      isNewRun: run.inserted,
    };
    return c.json(response, 201);
  });

  /** Streamed batches of attempts. Called many times per shard. */
  router.post("/results", async (c) => {
    const body = reportResultsRequestSchema.parse(await c.req.json());
    const { projectId } = c.get("project");

    await assertShardBelongsToProject(db, projectId, body.runId, body.shardId);

    const uploads: UploadTarget[] = [];

    await db.transaction(async (tx) => {
      for (const attempt of body.results) {
        // Upsert the test identity first — this is what run-over-run history
        // and flake rate hang off.
        const [testRow] = await tx
          .insert(tests)
          .values({
            projectId,
            testId: attempt.testId,
            title: attempt.title,
            titlePath: attempt.titlePath,
            file: attempt.file,
            projectName: attempt.projectName,
          })
          .onConflictDoUpdate({
            target: [tests.projectId, tests.testId],
            set: { lastSeenAt: new Date(), title: attempt.title, file: attempt.file },
          })
          .returning({ id: tests.id });

        if (!testRow) continue;

        const firstError = attempt.errors[0];
        const row: NewTestAttempt = {
          runId: body.runId,
          shardId: body.shardId,
          testRef: testRow.id,
          projectId,
          status: attempt.status,
          expectedStatus: attempt.expectedStatus,
          retry: attempt.retry,
          durationMs: Math.round(attempt.durationMs),
          startedAt: new Date(attempt.startedAt),
          parallelIndex: attempt.parallelIndex,
          workerIndex: attempt.workerIndex,
          errorMessage: firstError?.message ?? null,
          errorStack: firstError?.stack ?? null,
          errorSnippet: firstError?.snippet ?? null,
          errorSignature: firstError ? errorSignature(firstError) : null,
          annotations: attempt.annotations,
          tags: attempt.tags,
          stdout: attempt.stdout ?? null,
          stderr: attempt.stderr ?? null,
          steps: attempt.steps,
        };

        const [inserted] = await tx
          .insert(testAttempts)
          .values(row)
          .onConflictDoUpdate({
            target: [testAttempts.runId, testAttempts.testRef, testAttempts.retry],
            set: row,
            // The only row worth overwriting is the `running` placeholder the
            // reporter wrote at test start. Anything else is a shard retrying
            // an upload it already made, and must not double-count — with no
            // rows updated, `returning` is empty and the loop skips on.
            setWhere: eq(testAttempts.status, "running"),
          })
          .returning({ id: testAttempts.id });

        if (!inserted) continue;

        // A start marker carries no result yet, so there is nothing to cluster
        // or to judge a retry chain on.
        if (attempt.status === "running") continue;

        // Re-derive flakiness for this test's whole retry chain in this run.
        await markFlakeChain(tx, body.runId, testRow.id);

        for (const attachment of attempt.attachments) {
          const key = storage.keyFor(body.runId, inserted.id, attachment.name);
          const attachmentRow: NewAttachment = {
            attemptId: inserted.id,
            name: attachment.name,
            kind: attachment.kind,
            contentType: attachment.contentType,
            sizeBytes: attachment.sizeBytes,
            sha256: attachment.sha256 ?? null,
            storageKey: key,
          };
          const [savedAttachment] = await tx
            .insert(attachments)
            .values(attachmentRow)
            .returning({ id: attachments.id });
          if (!savedAttachment) continue;

          const presigned = await storage.presignUpload(key, attachment.contentType);
          uploads.push({
            attachmentId: savedAttachment.id,
            clientRef: attachment.clientRef,
            uploadUrl: presigned.uploadUrl,
            method: "PUT",
            headers: presigned.headers,
          });
        }
      }

      await tx
        .update(shards)
        .set({ lastSeenAt: new Date() })
        .where(eq(shards.id, body.shardId));
    });

    // Rate-limited inside the sync, so a chatty shard cannot turn every batch
    // into a GitLab request.
    app.mrComments.schedule(body.runId);

    const response: ReportResultsResponse = { accepted: body.results.length, uploads };
    return c.json(response);
  });

  /**
   * A shard signs off. The last one through closes the run — which is the whole
   * reason the server tracks `expectedShards` rather than trusting any single
   * machine to know when the build is finished.
   */
  router.post("/shards/complete", async (c) => {
    const body = completeShardRequestSchema.parse(await c.req.json());
    const { projectId } = c.get("project");

    await assertShardBelongsToProject(db, projectId, body.runId, body.shardId);

    const result = await db.transaction(async (tx) => {
      await tx
        .update(shards)
        .set({ status: body.status, stats: body.stats, completedAt: new Date() })
        .where(eq(shards.id, body.shardId));

      // Lock the run row so two shards finishing at once cannot both decide
      // they were last and race on the final status write.
      const [run] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, body.runId))
        .for("update")
        .limit(1);
      if (!run) throw new HTTPException(404, { message: "run not found" });

      const shardRows = await tx.select().from(shards).where(eq(shards.runId, body.runId));
      const completed = shardRows.filter((s) => s.completedAt !== null);
      const allShardsReported = completed.length >= run.expectedShards;
      const anyShardAbandoned = shardRows.some((s) => s.status === "abandoned");

      const stats = mergeStats(completed.map((s) => s.stats ?? EMPTY_STATS));
      const status = deriveRunStatus(stats, { allShardsReported, anyShardAbandoned });

      await tx
        .update(runs)
        .set({
          status,
          completedAt: status === "running" ? null : new Date(),
        })
        .where(eq(runs.id, body.runId));

      return {
        runStatus: status,
        runComplete: status !== "running",
        shardsCompleted: completed.length,
        expectedShards: run.expectedShards,
      } satisfies CompleteShardResponse;
    });

    // `final` on the last shard: the verdict is worth an immediate edit, and
    // there is nothing after it to coalesce with.
    app.mrComments.schedule(body.runId, { final: result.runComplete });

    return c.json(result);
  });

  /**
   * Local storage sink. The s3 driver presigns straight at the bucket, so this
   * route only exists for development.
   */
  router.put("/blobs/*", async (c) => {
    if (!storage.write) throw new HTTPException(404, { message: "no local blob sink" });

    const key = blobKey(c.req.path);

    // The signature *is* the authorisation on this route. It is not behind the
    // record-key middleware, because the reporter uploads with whatever headers
    // the presigned target told it to send — the same shape as writing to S3.
    if (!storage.verifyUpload?.(key, c.req.query())) {
      throw new HTTPException(403, { message: "upload URL is invalid or expired" });
    }

    if (!c.req.raw.body) throw new HTTPException(400, { message: "empty body" });

    await storage.write(key, Readable.fromWeb(c.req.raw.body as never));

    const size = (await storage.size?.(key)) ?? 0;
    await db
      .update(attachments)
      .set({ uploadedAt: new Date(), sizeBytes: size })
      .where(eq(attachments.storageKey, key));

    return c.json({ ok: true, key, size });
  });

  /**
   * Serves attachment bytes back, for downloads and for the Playwright trace
   * viewer.
   *
   * The viewer at `trace.playwright.dev` is a static site that fetches the trace
   * in the browser, from Playwright's origin — so this has to answer a
   * cross-origin GET, preflight included, or the viewer shows nothing but a
   * network error. `*` is the right value here and not a shortcut: the response
   * carries no credentials and the endpoint is already unauthenticated, so
   * naming an origin would restrict nobody while breaking every other viewer.
   */
  router.on(["GET", "HEAD", "OPTIONS"], "/blobs/*", async (c) => {
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-headers", "range, content-type");
    c.header("access-control-expose-headers", "content-length, content-range");

    if (c.req.method === "OPTIONS") return c.body(null, 204);
    if (!storage.read) throw new HTTPException(404, { message: "no local blob source" });

    const key = blobKey(c.req.path);
    const [row] = await db
      .select({ name: attachments.name, contentType: attachments.contentType })
      .from(attachments)
      .where(and(eq(attachments.storageKey, key), isNotNull(attachments.uploadedAt)))
      .limit(1);

    if (!row) throw new HTTPException(404, { message: "unknown blob" });

    const size = (await storage.size?.(key)) ?? 0;
    c.header("content-type", row.contentType);
    c.header("content-length", String(size));
    // Traces are content-addressed by run and attempt id, so they never change
    // under a key. Long cache, and the viewer stops refetching on every reload.
    c.header("cache-control", "public, max-age=31536000, immutable");
    // `inline` would let a stored .html attachment run script on this origin.
    c.header("content-disposition", `attachment; filename="${row.name.replace(/["\\]/g, "")}"`);

    if (c.req.method === "HEAD") return c.body(null, 200);
    return c.body(Readable.toWeb(await storage.read(key)) as ReadableStream);
  });

  /**
   * Stable URL for "the trace of this attempt", redirecting to the bytes.
   *
   * The indirection buys two things. The run payload can say *whether* an
   * attempt has a trace without carrying a URL for every attempt in the run,
   * and the link keeps working: on the s3 driver `downloadUrl` presigns, so a
   * viewer link built from it would be dead within the hour — including the
   * ones people paste into a merge request.
   */
  router.on(["GET", "OPTIONS"], "/attempts/:attemptId/trace", async (c) => {
    // Same reasoning as `/blobs/*`: the viewer fetches this from Playwright's
    // origin, and every hop of a redirect chain has to pass the CORS check.
    c.header("access-control-allow-origin", "*");
    if (c.req.method === "OPTIONS") return c.body(null, 204);

    const attemptId = c.req.param("attemptId");
    // Postgres raises on a malformed uuid, which would surface as a 500.
    if (!UUID.test(attemptId)) throw new HTTPException(400, { message: "bad attempt id" });

    const [row] = await db
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(
        and(
          eq(attachments.attemptId, attemptId),
          eq(attachments.kind, "trace"),
          isNotNull(attachments.uploadedAt),
        ),
      )
      // Playwright writes one trace per attempt, but a fixture can attach more.
      // Newest wins, which is the one that saw the failure.
      .orderBy(desc(attachments.createdAt))
      .limit(1);

    if (!row) throw new HTTPException(404, { message: "no trace for this attempt" });

    // Found, but somewhere else now — `cache-control` is deliberately absent so
    // a moved blob is not pinned in a proxy.
    return c.redirect(await storage.downloadUrl(row.storageKey), 302);
  });

  return router;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extracts and validates the storage key out of a `/blobs/...` request path. */
function blobKey(path: string): string {
  const key = decodeURI(path.replace(/^\/api\/v1\/blobs\//, ""));
  if (!key || key.includes("..")) throw new HTTPException(400, { message: "bad blob key" });
  return key;
}

/**
 * Stops a valid key for project A being used to write into project B's run.
 * Cheap, and the only thing standing between tenants on a shared deployment.
 */
async function assertShardBelongsToProject(
  db: AppContext["db"],
  projectId: string,
  runId: string,
  shardId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: shards.id })
    .from(shards)
    .innerJoin(runs, eq(shards.runId, runs.id))
    .where(and(eq(shards.id, shardId), eq(shards.runId, runId), eq(runs.projectId, projectId)))
    .limit(1);

  if (!row) throw new HTTPException(404, { message: "unknown run or shard" });
}

/**
 * Recomputes `is_flaky` across every attempt of one test in one run. Called per
 * insert because a retry can arrive long after the attempt it redeems.
 */
async function markFlakeChain(
  tx: Parameters<Parameters<AppContext["db"]["transaction"]>[0]>[0],
  runId: string,
  testRef: string,
): Promise<void> {
  const chain = await tx
    .select({
      id: testAttempts.id,
      retry: testAttempts.retry,
      status: testAttempts.status,
    })
    .from(testAttempts)
    .where(and(eq(testAttempts.runId, runId), eq(testAttempts.testRef, testRef)));

  const flaky = isFlakyWithinRun(chain.map((a) => ({ testId: testRef, ...a })));
  if (!flaky) return;

  await tx
    .update(testAttempts)
    .set({ isFlaky: true })
    .where(and(eq(testAttempts.runId, runId), eq(testAttempts.testRef, testRef)));
}
