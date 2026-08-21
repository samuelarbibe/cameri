import { projects, runs, shards, testAttempts, tests } from "@cameri/db";
import { and, countDistinct, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "./trpc.ts";

/**
 * Dashboard API.
 *
 * Nothing here declares an output type: the row shapes come straight from the
 * Drizzle selects, tRPC infers them, and the React client picks them up. A
 * column rename shows up as a type error in the UI rather than as a silent
 * `undefined` at runtime.
 */
export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),

  projects: router({
    list: publicProcedure.query(({ ctx }) =>
      ctx.app.db.select().from(projects).orderBy(projects.name),
    ),
  }),

  runs: router({
    list: publicProcedure
      .input(
        z.object({
          projectSlug: z.string(),
          branch: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        const { db } = ctx.app;
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.slug, input.projectSlug))
          .limit(1);
        if (!project) return [];

        // Both counts are correlated subqueries and must be built with the query
        // builder, not a raw `sql` template: interpolating a column into `sql`
        // emits a *bare* name, so `${shards.runId} = ${runs.id}` renders as
        // `"run_id" = "id"` and silently resolves both sides against the inner
        // table. That returns 0 forever instead of erroring.
        return db
          .select({
            ...selectRunColumns,
            shardsCompleted: db.$count(
              shards,
              and(eq(shards.runId, runs.id), isNotNull(shards.completedAt)),
            ),
            failed: sql<number>`(${db
              .select({ n: countDistinct(testAttempts.testRef) })
              .from(testAttempts)
              .where(
                and(
                  eq(testAttempts.runId, runs.id),
                  inArray(testAttempts.status, ["failed", "timedOut"]),
                ),
              )})`.mapWith(Number),
          })
          .from(runs)
          .where(
            input.branch
              ? and(eq(runs.projectId, project.id), eq(runs.branch, input.branch))
              : eq(runs.projectId, project.id),
          )
          .orderBy(desc(runs.createdAt))
          .limit(input.limit);
      }),

    get: publicProcedure.input(z.object({ runId: z.uuid() })).query(async ({ ctx, input }) => {
      const { db } = ctx.app;
      const [run] = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (!run) return null;

      const shardRows = await db
        .select()
        .from(shards)
        .where(eq(shards.runId, run.id))
        .orderBy(shards.shardIndex);

      // What the run timeline is drawn from: a row per shard, a subrow per
      // `parallelIndex` within it, and a bar per attempt placed by `startedAt`.
      // `testRef` is what groups a retry chain back into a single logical test.
      const attempts = await db
        .select({
          id: testAttempts.id,
          testRef: testAttempts.testRef,
          shardId: testAttempts.shardId,
          status: testAttempts.status,
          expectedStatus: testAttempts.expectedStatus,
          retry: testAttempts.retry,
          durationMs: testAttempts.durationMs,
          startedAt: testAttempts.startedAt,
          parallelIndex: testAttempts.parallelIndex,
          workerIndex: testAttempts.workerIndex,
          isFlaky: testAttempts.isFlaky,
          errorMessage: testAttempts.errorMessage,
          errorSignature: testAttempts.errorSignature,
          title: tests.title,
          titlePath: tests.titlePath,
          file: tests.file,
          projectName: tests.projectName,
        })
        .from(testAttempts)
        .innerJoin(tests, eq(testAttempts.testRef, tests.id))
        .where(eq(testAttempts.runId, run.id))
        .orderBy(tests.file, tests.title, testAttempts.retry);

      return { run, shards: shardRows, attempts };
    }),
  }),

  tests: router({
    /** Run-over-run history for one test — the basis of the flake view. */
    history: publicProcedure
      .input(z.object({ testRef: z.uuid(), limit: z.number().int().min(1).max(200).default(50) }))
      .query(({ ctx, input }) =>
        ctx.app.db
          .select({
            attemptId: testAttempts.id,
            runId: testAttempts.runId,
            status: testAttempts.status,
            retry: testAttempts.retry,
            durationMs: testAttempts.durationMs,
            isFlaky: testAttempts.isFlaky,
            createdAt: testAttempts.createdAt,
            branch: runs.branch,
            commitSha: runs.commitSha,
          })
          .from(testAttempts)
          .innerJoin(runs, eq(testAttempts.runId, runs.id))
          .where(eq(testAttempts.testRef, input.testRef))
          .orderBy(desc(testAttempts.createdAt))
          .limit(input.limit),
      ),

    /** Failures grouped by error signature — "these 40 failures are one bug". */
    clusters: publicProcedure
      .input(z.object({ runId: z.uuid() }))
      .query(({ ctx, input }) =>
        ctx.app.db
          .select({
            signature: testAttempts.errorSignature,
            count: sql<number>`count(*)`.mapWith(Number),
            sample: sql<string>`min(${testAttempts.errorMessage})`,
          })
          .from(testAttempts)
          .where(
            and(eq(testAttempts.runId, input.runId), isNotNull(testAttempts.errorSignature)),
          )
          .groupBy(testAttempts.errorSignature)
          .orderBy(desc(sql`count(*)`)),
      ),
  }),
});

const selectRunColumns = {
  id: runs.id,
  runKey: runs.runKey,
  status: runs.status,
  branch: runs.branch,
  commitSha: runs.commitSha,
  commitMessage: runs.commitMessage,
  author: runs.author,
  ciBuildUrl: runs.ciBuildUrl,
  expectedShards: runs.expectedShards,
  startedAt: runs.startedAt,
  completedAt: runs.completedAt,
  createdAt: runs.createdAt,
};

export type AppRouter = typeof appRouter;
