import { runStatusSchema, type RunStatus } from "@camerihq/contract";
import { attachments, integrations, projects, runs, shards, testAttempts, tests } from "@camerihq/db";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { createCipher, tokenHint } from "../crypto.ts";
import { GitLabClient } from "../integrations/gitlab.ts";
import {
  assertReachableIntegrationUrl,
  BlockedIntegrationUrlError,
  parseAllowedHosts,
} from "../integrations/url-guard.ts";
import { adminProcedure, isAdmin, publicProcedure, router } from "./trpc.ts";

/**
 * Dashboard API.
 *
 * Nothing here declares an output type: the row shapes come straight from the
 * Drizzle selects, tRPC infers them, and the React client picks them up. A
 * column rename shows up as a type error in the UI rather than as a silent
 * `undefined` at runtime.
 */
/**
 * `test_attempts` under a second name, so the failed-count subquery can ask
 * "did any other attempt at this test pass?" without both sides of the
 * comparison resolving against the same table.
 */
const recoveredAttempts = alias(testAttempts, "recovered_attempts");

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),

  /**
   * Whether this caller may change anything, and whether anyone can.
   *
   * Public on purpose: it reveals only that the server has a lock fitted, which
   * the settings page has to know before it can offer the keyhole.
   */
  admin: router({
    status: publicProcedure.query(({ ctx }) => ({
      configured: Boolean(ctx.app.env.CAMERI_ADMIN_TOKEN),
      unlocked: isAdmin(ctx),
    })),
  }),

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
          status: runStatusSchema.optional(),
          /**
           * Merge request iid. `"none"` is a real choice, not a missing filter:
           * "show me the branch pipelines" is a question people ask.
           */
          mrIid: z.string().optional(),
          search: z.string().optional(),
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
                  // Tests that went green on a retry are flaky, not failed.
                  // Counting them here put a red number next to runs the badge
                  // called passed, which reads as a bug in the dashboard rather
                  // than as information about the suite.
                  notExists(
                    db
                      .select({ n: sql`1` })
                      .from(recoveredAttempts)
                      .where(
                        and(
                          eq(recoveredAttempts.runId, runs.id),
                          eq(recoveredAttempts.testRef, testAttempts.testRef),
                          eq(recoveredAttempts.status, "passed"),
                        ),
                      ),
                  ),
                ),
              )})`.mapWith(Number),
          })
          .from(runs)
          .where(and(eq(runs.projectId, project.id), ...runFilters(input)))
          .orderBy(desc(runs.createdAt))
          .limit(input.limit);
      }),

    /**
     * What the filter dropdowns on the runs page can offer.
     *
     * Derived from the runs that exist rather than from a fixed list, so the
     * menus never offer a branch that has nothing behind it. Bounded to recent
     * history: a year-old branch in the dropdown is clutter, and the query has
     * to stay cheap enough to run alongside the list on every page load.
     */
    filters: publicProcedure
      .input(z.object({ projectSlug: z.string(), days: z.number().int().min(1).max(365).default(90) }))
      .query(async ({ ctx, input }) => {
        const { db } = ctx.app;
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.slug, input.projectSlug))
          .limit(1);
        if (!project) return { branches: [], mergeRequests: [] };

        const since = new Date(Date.now() - input.days * 86_400_000);
        const scope = and(eq(runs.projectId, project.id), gte(runs.createdAt, since));

        const [branchRows, mrRows] = await Promise.all([
          db
            .select({ branch: runs.branch, lastRunAt: sql<string>`max(${runs.createdAt})` })
            .from(runs)
            .where(and(scope, isNotNull(runs.branch)))
            .groupBy(runs.branch)
            .orderBy(desc(sql`max(${runs.createdAt})`))
            .limit(100),
          db
            .select({
              iid: runs.mrIid,
              title: sql<string | null>`max(${runs.mrTitle})`,
              lastRunAt: sql<string>`max(${runs.createdAt})`,
            })
            .from(runs)
            .where(and(scope, isNotNull(runs.mrIid)))
            .groupBy(runs.mrIid)
            .orderBy(desc(sql`max(${runs.createdAt})`))
            .limit(100),
        ]);

        return {
          // `branch` is non-null by the `where`, but Drizzle types it from the
          // column, so narrow it here rather than making every caller do it.
          branches: branchRows.map((row) => ({ ...row, branch: row.branch ?? "" })),
          mergeRequests: mrRows.map((row) => ({ ...row, iid: row.iid ?? "" })),
        };
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

      const traced = await attemptsWithTrace(
        db,
        attempts.map((attempt) => attempt.id),
      );

      return {
        run,
        shards: shardRows,
        attempts: attempts.map((attempt) => ({ ...attempt, hasTrace: traced.has(attempt.id) })),
      };
    }),
  }),

  /**
   * Merge requests, reconstructed from the runs that named one.
   *
   * There is no merge request table, and deliberately so: cameri never polls
   * GitLab for a list of open merge requests, it only knows the ones a pipeline
   * told it about. Grouping the runs is therefore not a shortcut around a
   * missing table — it *is* the complete set of merge requests cameri has ever
   * seen, and it stays correct on a deployment with no GitLab token at all.
   */
  mergeRequests: router({
    list: publicProcedure
      .input(
        z.object({
          projectSlug: z.string(),
          search: z.string().optional(),
          days: z.number().int().min(1).max(365).default(90),
          limit: z.number().int().min(1).max(200).default(50),
        }),
      )
      .query(async ({ ctx, input }) => {
        const project = await findProject(ctx.app.db, input.projectSlug);
        if (!project) return [];

        const like = input.search ? `%${input.search}%` : null;
        return mergeRequestQuery(ctx.app.db, project.id, {
          since: new Date(Date.now() - input.days * 86_400_000),
          extra: like
            ? sql`(${runs.mrIid} ilike ${like} or ${runs.mrTitle} ilike ${like} or ${runs.branch} ilike ${like})`
            : undefined,
        }).limit(input.limit);
      }),

    get: publicProcedure
      .input(z.object({ projectSlug: z.string(), iid: z.string() }))
      .query(async ({ ctx, input }) => {
        const project = await findProject(ctx.app.db, input.projectSlug);
        if (!project) return null;

        // No `since` here: opening a merge request by iid is an explicit ask for
        // that one, and it should not vanish because it is older than the list's
        // window.
        const [row] = await mergeRequestQuery(ctx.app.db, project.id, {
          extra: eq(runs.mrIid, input.iid),
        }).limit(1);
        return row ?? null;
      }),
  }),

  tests: router({
    /** Run-over-run history for one test — the basis of the flake view. */
    history: publicProcedure
      .input(z.object({ testRef: z.uuid(), limit: z.number().int().min(1).max(200).default(50) }))
      .query(async ({ ctx, input }) => {
        const rows = await ctx.app.db
          .select({
            attemptId: testAttempts.id,
            runId: testAttempts.runId,
            status: testAttempts.status,
            retry: testAttempts.retry,
            durationMs: testAttempts.durationMs,
            startedAt: testAttempts.startedAt,
            isFlaky: testAttempts.isFlaky,
            errorMessage: testAttempts.errorMessage,
            createdAt: testAttempts.createdAt,
            // Enough run context to label each attempt in the explorer's sheet,
            // where the attempts on screen come from different runs.
            runKey: runs.runKey,
            branch: runs.branch,
            commitSha: runs.commitSha,
            mrIid: runs.mrIid,
          })
          .from(testAttempts)
          .innerJoin(runs, eq(testAttempts.runId, runs.id))
          .where(eq(testAttempts.testRef, input.testRef))
          .orderBy(desc(testAttempts.createdAt))
          .limit(input.limit);

        const traced = await attemptsWithTrace(
          ctx.app.db,
          rows.map((row) => row.attemptId),
        );

        return rows.map((row) => ({ ...row, hasTrace: traced.has(row.attemptId) }));
      }),

    /**
     * Everything about one attempt that the run payload deliberately leaves out.
     *
     * `runs.get` returns every attempt in a run, so putting logs on it would
     * mean shipping megabytes of stdout to draw a timeline. These columns are
     * fetched one attempt at a time, when someone actually opens one.
     */
    attempt: publicProcedure
      .input(z.object({ attemptId: z.uuid() }))
      .query(async ({ ctx, input }) => {
        const { db } = ctx.app;

        const [attempt] = await db
          .select({
            id: testAttempts.id,
            status: testAttempts.status,
            retry: testAttempts.retry,
            durationMs: testAttempts.durationMs,
            startedAt: testAttempts.startedAt,
            stdout: testAttempts.stdout,
            stderr: testAttempts.stderr,
            steps: testAttempts.steps,
            errorMessage: testAttempts.errorMessage,
            errorStack: testAttempts.errorStack,
            errorSnippet: testAttempts.errorSnippet,
            annotations: testAttempts.annotations,
            tags: testAttempts.tags,
          })
          .from(testAttempts)
          .where(eq(testAttempts.id, input.attemptId))
          .limit(1);

        if (!attempt) return null;

        const files = await db
          .select({
            id: attachments.id,
            name: attachments.name,
            kind: attachments.kind,
            contentType: attachments.contentType,
            sizeBytes: attachments.sizeBytes,
            uploadedAt: attachments.uploadedAt,
            storageKey: attachments.storageKey,
          })
          .from(attachments)
          .where(eq(attachments.attemptId, input.attemptId))
          .orderBy(asc(attachments.name));

        return {
          ...attempt,
          attachments: await Promise.all(
            files.map(async ({ storageKey, ...file }) => ({
              ...file,
              // Null until the bytes land. The reporter registers an attachment
              // before it uploads it, so a link handed out too early is a 404 —
              // and on a trace that is a broken viewer tab rather than a
              // visibly missing file.
              url: file.uploadedAt ? await ctx.app.storage.downloadUrl(storageKey) : null,
            })),
          ),
        };
      }),

    /**
     * One row per day, with the outcome split inside it — the shape a stacked
     * bar chart wants, computed in Postgres rather than by shipping every
     * attempt of the last quarter to the browser.
     *
     * Days with no runs are absent rather than zero: the client fills the gaps,
     * because only the client knows the reader's timezone well enough to say
     * which days those are.
     */
    dailyHistory: publicProcedure
      .input(
        z.object({
          testRef: z.uuid(),
          days: z.number().int().min(1).max(365).default(30),
          branch: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) => {
        const since = new Date(Date.now() - input.days * 86_400_000);
        // Truncated in UTC. A team spread across timezones will disagree about
        // where a day boundary falls whatever we pick; UTC at least makes the
        // buckets identical for everyone looking at the same chart.
        const day = sql<string>`date_trunc('day', ${testAttempts.createdAt} at time zone 'utc')`;

        return ctx.app.db
          .select({
            day,
            // Counted per *test per run*, not per attempt: a test retried three
            // times is one data point, and the flake flag is what says so.
            // Hence `count(distinct run_id)` throughout — a plain `count(*)`
            // counts the retries, which both triples a hard failure's bar and
            // makes every flake show up as a failure as well as a flake, since
            // only the final green attempt carries `is_flaky`.
            passed: sql<number>`count(distinct ${testAttempts.runId}) filter (where ${testAttempts.status} = 'passed' and not ${testAttempts.isFlaky})`.mapWith(
              Number,
            ),
            // Runs where this test failed, less the runs where it came back on
            // a retry: a flaky run has failed attempts too, and it is already
            // counted in `flaky`. Subtraction rather than a correlated
            // "…and no passing attempt" subquery, which would be the same
            // answer for several times the plan.
            failed: sql<number>`
              count(distinct ${testAttempts.runId}) filter (where ${testAttempts.status} in ('failed', 'timedOut', 'interrupted'))
              - count(distinct ${testAttempts.runId}) filter (where ${testAttempts.isFlaky})
            `.mapWith(Number),
            flaky: sql<number>`count(distinct ${testAttempts.runId}) filter (where ${testAttempts.isFlaky})`.mapWith(
              Number,
            ),
            skipped: sql<number>`count(distinct ${testAttempts.runId}) filter (where ${testAttempts.status} = 'skipped')`.mapWith(
              Number,
            ),
            durationMs: sql<number>`coalesce(round(avg(${testAttempts.durationMs}) filter (where ${testAttempts.status} <> 'skipped')), 0)`.mapWith(
              Number,
            ),
          })
          .from(testAttempts)
          .innerJoin(runs, eq(testAttempts.runId, runs.id))
          .where(
            and(
              eq(testAttempts.testRef, input.testRef),
              gte(testAttempts.createdAt, since),
              // A start marker is not an outcome and would inflate every bar.
              sql`${testAttempts.status} <> 'running'`,
              input.branch ? eq(runs.branch, input.branch) : undefined,
            ),
          )
          .groupBy(day)
          .orderBy(asc(day));
      }),

    /**
     * The test explorer: one row per test with its aggregate health.
     *
     * Ordered by failure rate rather than by name, because the reason to open
     * this list is to find the tests that are costing the team time.
     */
    explorer: publicProcedure
      .input(
        z.object({
          projectSlug: z.string(),
          days: z.number().int().min(1).max(365).default(30),
          search: z.string().optional(),
          /** Narrows to the tests that ran in one merge request's pipelines. */
          mrIid: z.string().optional(),
          branch: z.string().optional(),
          limit: z.number().int().min(1).max(500).default(100),
        }),
      )
      .query(async ({ ctx, input }) => {
        const { db } = ctx.app;
        const project = await findProject(db, input.projectSlug);
        if (!project) return [];

        const since = new Date(Date.now() - input.days * 86_400_000);
        const executions = sql<number>`count(*)`;
        const failed = sql<number>`count(*) filter (where ${testAttempts.status} in ('failed', 'timedOut', 'interrupted'))`;

        return db
          .select({
            testRef: tests.id,
            title: tests.title,
            // Carried so the detail sheet can print the same `file › describe`
            // line the run pages do, without a second lookup per test.
            titlePath: tests.titlePath,
            file: tests.file,
            projectName: tests.projectName,
            quarantined: tests.quarantined,
            executions: executions.mapWith(Number),
            failed: failed.mapWith(Number),
            flaky: sql<number>`count(*) filter (where ${testAttempts.isFlaky})`.mapWith(Number),
            avgDurationMs: sql<number>`coalesce(round(avg(${testAttempts.durationMs})), 0)`.mapWith(
              Number,
            ),
            lastRunAt: sql<string>`max(${testAttempts.createdAt})`,
          })
          .from(tests)
          // Inner join: a test with no attempt in the window has nothing to say
          // about its health, and a page of zero-row tests is noise.
          .innerJoin(
            testAttempts,
            and(
              eq(testAttempts.testRef, tests.id),
              gte(testAttempts.createdAt, since),
              sql`${testAttempts.status} <> 'running'`,
            ),
          )
          .where(
            and(
              eq(tests.projectId, project.id),
              input.search
                ? sql`(${tests.title} ilike ${`%${input.search}%`} or ${tests.file} ilike ${`%${input.search}%`})`
                : undefined,
              // A semi-join rather than a join onto `runs`: the run's columns are
              // not wanted in the output, and this way the unfiltered explorer —
              // the common case — does not pay for the join at all.
              input.mrIid || input.branch
                ? inArray(
                    testAttempts.runId,
                    db
                      .select({ id: runs.id })
                      .from(runs)
                      .where(
                        and(
                          eq(runs.projectId, project.id),
                          input.mrIid ? eq(runs.mrIid, input.mrIid) : undefined,
                          input.branch ? eq(runs.branch, input.branch) : undefined,
                        ),
                      ),
                  )
                : undefined,
            ),
          )
          .groupBy(
            tests.id,
            tests.title,
            tests.titlePath,
            tests.file,
            tests.projectName,
            tests.quarantined,
          )
          .orderBy(desc(sql`(${failed})::numeric / nullif(${executions}, 0)`), desc(executions))
          .limit(input.limit);
      }),

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

  /**
   * Outbound credentials.
   *
   * The token is write-only across this boundary: it goes in on `save` and
   * never comes back out. Everything the settings page shows about a configured
   * integration comes from `tokenHint`, `lastUsedAt` and `lastError`.
   */
  integrations: router({
    list: publicProcedure
      .input(z.object({ projectSlug: z.string() }))
      .query(async ({ ctx, input }) => {
        const project = await requireProject(ctx.app.db, input.projectSlug);
        return ctx.app.db
          .select({
            id: integrations.id,
            provider: integrations.provider,
            baseUrl: integrations.baseUrl,
            tokenHint: integrations.tokenHint,
            enabled: integrations.enabled,
            lastError: integrations.lastError,
            lastUsedAt: integrations.lastUsedAt,
            updatedAt: integrations.updatedAt,
          })
          .from(integrations)
          .where(eq(integrations.projectId, project.id));
      }),

    save: adminProcedure
      .input(
        z.object({
          projectSlug: z.string(),
          provider: z.literal("gitlab"),
          baseUrl: z.url(),
          token: z.string().min(8),
          enabled: z.boolean().default(true),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { db, encryptionKey, env } = ctx.app;
        const project = await requireProject(db, input.projectSlug);

        // Before anything connects: this URL decides where the server points
        // itself, and it arrived in a request body.
        try {
          await assertReachableIntegrationUrl(
            input.baseUrl,
            parseAllowedHosts(env.CAMERI_INTEGRATION_HOSTS),
          );
        } catch (error) {
          if (!(error instanceof BlockedIntegrationUrlError)) throw error;
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }

        // Fail before storing, not after: a token that cannot reach GitLab is
        // worth rejecting at the point someone can still fix the typo.
        try {
          await new GitLabClient({ baseUrl: input.baseUrl, token: input.token }).currentUser();
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Could not authenticate against GitLab: ${describe(error)}`,
          });
        }

        const cipher = createCipher(encryptionKey);
        const row = {
          projectId: project.id,
          provider: input.provider,
          baseUrl: input.baseUrl,
          tokenCipher: cipher.encrypt(input.token),
          tokenHint: tokenHint(input.token),
          enabled: input.enabled,
          lastError: null,
          updatedAt: new Date(),
        };

        await db
          .insert(integrations)
          .values(row)
          .onConflictDoUpdate({
            target: [integrations.projectId, integrations.provider],
            set: row,
          });

        return { ok: true };
      }),

    remove: adminProcedure
      .input(z.object({ projectSlug: z.string(), provider: z.literal("gitlab") }))
      .mutation(async ({ ctx, input }) => {
        const project = await requireProject(ctx.app.db, input.projectSlug);
        await ctx.app.db
          .delete(integrations)
          .where(
            and(
              eq(integrations.projectId, project.id),
              eq(integrations.provider, input.provider),
            ),
          );
        return { ok: true };
      }),

    /** Whether the server can store a credential at all. Drives the settings copy. */
    canStoreSecrets: publicProcedure.query(({ ctx }) => ctx.app.encryptionKey !== null),
  }),
});

/**
 * Resolves a slug to a project or refuses.
 *
 * Integration routes take a slug rather than a project id so their URLs match
 * the rest of the app, which means every one of them has to do this lookup —
 * and has to 404 rather than write against a project that does not exist.
 */
async function requireProject(db: AppContext["db"], slug: string): Promise<{ id: string }> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `no project "${slug}"` });
  return project;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Which of these attempts have a trace someone could open.
 *
 * One extra query rather than an `exists` in the select list: a correlated
 * subquery there is evaluated once per row, and `runs.get` returns every
 * attempt in the run — thousands of them, on a large suite, re-polled while it
 * is still running. This is a single semi-join instead.
 */
async function attemptsWithTrace(
  db: AppContext["db"],
  attemptIds: string[],
): Promise<Set<string>> {
  if (attemptIds.length === 0) return new Set();

  const rows = await db
    .select({ attemptId: attachments.attemptId })
    .from(attachments)
    .where(
      and(
        inArray(attachments.attemptId, attemptIds),
        eq(attachments.kind, "trace"),
        // Registered but not yet uploaded is a 404 in the viewer, which reads
        // as cameri being broken rather than as the shard still working.
        isNotNull(attachments.uploadedAt),
      ),
    );

  return new Set(rows.map((row) => row.attemptId));
}

/** Like `requireProject`, but for read paths where "no project" is just an empty page. */
async function findProject(
  db: AppContext["db"],
  slug: string,
): Promise<{ id: string } | undefined> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return project;
}

/**
 * One row per merge request, aggregated from its runs.
 *
 * The "latest" columns use `(array_agg(x order by created_at desc))[1]` rather
 * than a window function or a lateral join: it collapses to a single grouped
 * scan, and unlike `max()` it works for text whose ordering means nothing —
 * `max(status)` would cheerfully return `timedOut` over `running`.
 */
function mergeRequestQuery(
  db: AppContext["db"],
  projectId: string,
  options: { since?: Date; extra?: SQL },
) {
  const latest = <T>(column: AnyColumn) =>
    sql<T>`(array_agg(${column} order by ${runs.createdAt} desc))[1]`;

  return db
    .select({
      iid: sql<string>`${runs.mrIid}`,
      title: latest<string | null>(runs.mrTitle),
      targetBranch: latest<string | null>(runs.mrTargetBranch),
      /** The merge request's own branch — the source side, from the run's git context. */
      sourceBranch: latest<string | null>(runs.branch),
      url: latest<string | null>(runs.mrUrl),
      lastRunId: latest<string>(runs.id),
      lastStatus: latest<RunStatus>(runs.status),
      lastRunAt: sql<string>`max(${runs.createdAt})`,
      firstRunAt: sql<string>`min(${runs.createdAt})`,
      runCount: sql<number>`count(*)`.mapWith(Number),
      failedRuns: sql<number>`count(*) filter (where ${runs.status} in ('failed', 'timedOut'))`.mapWith(
        Number,
      ),
      runningRuns: sql<number>`count(*) filter (where ${runs.status} = 'running')`.mapWith(Number),
    })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        isNotNull(runs.mrIid),
        options.since ? gte(runs.createdAt, options.since) : undefined,
        options.extra,
      ),
    )
    .groupBy(runs.mrIid)
    .orderBy(desc(sql`max(${runs.createdAt})`));
}

/** Sentinel for "runs that belong to no merge request" in the `mrIid` filter. */
export const NO_MERGE_REQUEST = "none";

type RunFilterInput = {
  branch?: string | undefined;
  status?: RunStatus | undefined;
  mrIid?: string | undefined;
  search?: string | undefined;
};

/**
 * The runs-page filters as SQL, shared by the runs list and the merge request
 * drill-down so the two cannot drift apart.
 *
 * Every filter is applied server-side rather than in the table component: the
 * list is capped at `limit` rows, so filtering after the fact would search
 * inside the most recent 25 runs and quietly miss everything older.
 */
function runFilters(input: RunFilterInput): SQL[] {
  const clauses: SQL[] = [];
  if (input.branch) clauses.push(eq(runs.branch, input.branch));
  if (input.status) clauses.push(eq(runs.status, input.status));
  if (input.mrIid) {
    clauses.push(
      input.mrIid === NO_MERGE_REQUEST ? isNull(runs.mrIid) : eq(runs.mrIid, input.mrIid),
    );
  }
  if (input.search) {
    const like = `%${input.search}%`;
    clauses.push(
      sql`(${runs.runKey} ilike ${like} or ${runs.branch} ilike ${like} or ${runs.commitSha} ilike ${like} or ${runs.commitMessage} ilike ${like} or ${runs.author} ilike ${like} or ${runs.mrTitle} ilike ${like})`,
    );
  }
  return clauses;
}

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
  // Enough to render the merge request chip on a run without a second query.
  // `mrIid` is the one the UI links by; `mrUrl` is where the chip points.
  mrIid: runs.mrIid,
  mrTitle: runs.mrTitle,
  mrTargetBranch: runs.mrTargetBranch,
  mrUrl: runs.mrUrl,
  startedAt: runs.startedAt,
  completedAt: runs.completedAt,
  createdAt: runs.createdAt,
};

export type AppRouter = typeof appRouter;
