/**
 * Wire contract for the Cameri ingest API.
 *
 * Everything here is consumed by three places at once — the reporter running in
 * someone else's CI, the CLI, and the server — so treat it as a public API:
 * additive changes only, and bump `INGEST_API_VERSION` when that stops being true.
 */
import { z } from "zod";
import {
  ATTACHMENT_KINDS,
  PLAN_STRATEGIES,
  RUN_STATUSES,
  SHARD_STATUSES,
  TEST_STATUSES,
} from "./constants.ts";

export * from "./constants.ts";
export * from "./ci.ts";

export const testStatusSchema = z.enum(TEST_STATUSES);
export type TestStatus = z.infer<typeof testStatusSchema>;

export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const shardStatusSchema = z.enum(SHARD_STATUSES);
export type ShardStatus = z.infer<typeof shardStatusSchema>;

export const attachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const planStrategySchema = z.enum(PLAN_STRATEGIES);
export type PlanStrategy = z.infer<typeof planStrategySchema>;

export const gitContextSchema = z.object({
  branch: z.string().nullish(),
  commitSha: z.string().nullish(),
  commitMessage: z.string().nullish(),
  author: z.string().nullish(),
  remoteUrl: z.string().nullish(),
});
export type GitContext = z.infer<typeof gitContextSchema>;

export const ciContextSchema = z.object({
  provider: z.string().nullish(),
  buildId: z.string().nullish(),
  buildUrl: z.string().nullish(),
  jobName: z.string().nullish(),
  attempt: z.number().int().nonnegative().default(1),
});
export type CiContext = z.infer<typeof ciContextSchema>;

/**
 * Where to post a status comment, when the build is a merge/pull request.
 *
 * Coordinates only — never a credential. The reporter runs on someone else's CI
 * and says *which* merge request this run belongs to; the server holds the token
 * and does the posting, because it is the only party that knows what the other
 * shards are doing.
 */
export const mergeRequestContextSchema = z.object({
  /** `gitlab` today. Absent means "this build is not a merge request". */
  provider: z.string().nullish(),
  /** Numeric id or url-encoded path — whichever the provider's API accepts. */
  projectId: z.string().nullish(),
  /** GitLab's `iid`; the number humans see, scoped to the project. */
  iid: z.string().nullish(),
  /**
   * The merge request's own title, as CI reported it.
   *
   * Carried on the run rather than fetched, so the merge request list reads
   * correctly on a deployment with no GitLab token configured at all. It is a
   * snapshot: retitling the merge request does not rewrite past runs, which is
   * the honest thing for a record of what the pipeline saw.
   */
  title: z.string().nullish(),
  /** What the merge request is being merged *into* — `main`, usually. */
  targetBranch: z.string().nullish(),
  /** Instance root, so a self-hosted GitLab is reachable. */
  serverUrl: z.string().nullish(),
  webUrl: z.string().nullish(),
});
export type MergeRequestContext = z.infer<typeof mergeRequestContextSchema>;

/**
 * Asks for this shard's slice of the suite, before a single test has run.
 *
 * Called by the CLI, not the reporter — by the time a reporter exists Playwright
 * has already decided what to run, and the whole point is to decide it first.
 * Every shard sends the same `runKey` and the same `specs`; the first one
 * through computes the split and the rest read back the identical answer, which
 * is what stops n machines from each inventing their own division of the suite.
 */
export const planShardsRequestSchema = z
  .object({
    runKey: z.string().min(1).max(200),
    /** 1-based, matching `--shard=i/n` and `shards.shardIndex`. */
    shardIndex: z.number().int().positive(),
    expectedShards: z.number().int().positive(),
    /**
     * Every spec file this build would run, relative to Playwright's `rootDir`.
     *
     * Discovered rather than declared: the CLI gets these from `--list` on the
     * user's own command, so any `--grep` or `--project` they passed has already
     * narrowed the list, and the plan covers exactly what would have run.
     */
    specs: z.array(z.string().min(1)).min(1).max(20_000),
  })
  // `9/3` is not a shard, and answering it would mean inventing a slice.
  .refine((body) => body.shardIndex <= body.expectedShards, {
    message: "shardIndex must not exceed expectedShards",
    path: ["shardIndex"],
  });

export type PlanShardsRequest = z.infer<typeof planShardsRequestSchema>;

export const planShardsResponseSchema = z.object({
  shardIndex: z.number().int().positive(),
  /** What this shard should run. Empty is legal: more shards than spec files. */
  specs: z.array(z.string()),
  /** Shards the stored plan covers, which is what the *first* caller claimed. */
  shardCount: z.number().int().positive(),
  totalSpecs: z.number().int().nonnegative(),
  /** Predicted wall time for this shard. Zero under the `even` strategy. */
  estimatedMs: z.number().nonnegative(),
  strategy: planStrategySchema,
  /**
   * False when this shard's spec list is not the one the plan was built from —
   * shards on different commits, or a flaky test-discovery step. The assignment
   * is still returned, because a shard inventing its own split would be worse.
   */
  specsMatch: z.boolean(),
  /** True when this call computed the plan rather than reading one back. */
  isNewPlan: z.boolean(),
});
export type PlanShardsResponse = z.infer<typeof planShardsResponseSchema>;

/**
 * Opens (or joins) a run. Every shard calls this; the first one through creates
 * the run row and the rest attach to it via `runKey`, which is why the server
 * has to treat this as an upsert rather than an insert.
 */
export const createRunRequestSchema = z.object({
  runKey: z.string().min(1).max(200),
  expectedShards: z.number().int().positive().default(1),
  // 1-based, not 0-based, despite the name: this mirrors Playwright's
  // `config.shard.current`, which runs 1..total. An unsharded run is shard 1/1.
  shardIndex: z.number().int().positive().default(1),
  playwrightVersion: z.string().nullish(),
  git: gitContextSchema.default({}),
  ci: ciContextSchema.default({ attempt: 1 }),
  mr: mergeRequestContextSchema.default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const createRunResponseSchema = z.object({
  runId: z.string(),
  shardId: z.string(),
  projectId: z.string(),
  /** False when another shard got here first — useful for logging only. */
  isNewRun: z.boolean(),
});
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

export const sourceLocationSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

export const testErrorSchema = z.object({
  message: z.string(),
  stack: z.string().nullish(),
  snippet: z.string().nullish(),
  location: sourceLocationSchema.nullish(),
});
export type TestError = z.infer<typeof testErrorSchema>;

/**
 * Attachment *metadata* only. Bytes never travel through the ingest API — the
 * server hands back presigned URLs and the reporter uploads straight to storage.
 */
export const attachmentSchema = z.object({
  /**
   * Reporter-generated id, echoed back in the upload targets. Without it the
   * reporter cannot tell which presigned URL belongs to which local file.
   */
  clientRef: z.string(),
  name: z.string(),
  kind: attachmentKindSchema.default("other"),
  contentType: z.string().default("application/octet-stream"),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().nullish(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const annotationSchema = z.object({
  type: z.string(),
  description: z.string().nullish(),
});
export type Annotation = z.infer<typeof annotationSchema>;

/**
 * One entry from Playwright's step tree.
 *
 * Flattened with a `depth` rather than sent as a nested tree: the UI re-indents
 * from the number, the JSON stays a plain array whatever the nesting, and a
 * deeply chained `test.step` cannot produce a payload that is expensive to parse.
 *
 * Steps are what turn a log view into a trace — "what was it doing when it hung"
 * is answered by the last step that started and never finished, which stdout
 * alone will not tell you.
 */
export const testStepSchema = z.object({
  title: z.string(),
  /** Playwright's own bucket: `test.step`, `expect`, `pw:api`, `hook`, `fixture`. */
  category: z.string(),
  depth: z.number().int().nonnegative().default(0),
  startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative().default(0),
  /** First line of the step's error, when it has one. Full text stays on the attempt. */
  error: z.string().nullish(),
});
export type TestStep = z.infer<typeof testStepSchema>;

/** One attempt at one test. A retried test produces several of these. */
export const testAttemptSchema = z.object({
  /** Playwright's stable test id — the identity we join on across runs. */
  testId: z.string(),
  title: z.string(),
  titlePath: z.array(z.string()).default([]),
  file: z.string(),
  location: sourceLocationSchema.nullish(),
  projectName: z.string().default(""),
  status: testStatusSchema,
  expectedStatus: testStatusSchema.default("passed"),
  retry: z.number().int().nonnegative().default(0),
  durationMs: z.number().nonnegative().default(0),
  startedAt: z.iso.datetime(),
  /**
   * Which parallel slot ran this attempt, 0-based and scoped to the shard.
   * `parallelIndex` is the stable one — it stays within 0..workers-1 for the
   * whole run — so it is what the timeline draws a lane per. `workerIndex`
   * keeps counting up every time a worker dies and is replaced, which makes it
   * the right value for diagnosing crashes and the wrong one for a lane.
   */
  parallelIndex: z.number().int().nonnegative().default(0),
  workerIndex: z.number().int().nonnegative().default(0),
  errors: z.array(testErrorSchema).default([]),
  annotations: z.array(annotationSchema).default([]),
  tags: z.array(z.string()).default([]),
  stdout: z.string().nullish(),
  stderr: z.string().nullish(),
  steps: z.array(testStepSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
});
export type TestAttempt = z.infer<typeof testAttemptSchema>;

/** Results are streamed in batches so a long run shows up live in the UI. */
export const reportResultsRequestSchema = z.object({
  runId: z.string(),
  shardId: z.string(),
  results: z.array(testAttemptSchema).min(1),
});
export type ReportResultsRequest = z.infer<typeof reportResultsRequestSchema>;

export const uploadTargetSchema = z.object({
  attachmentId: z.string(),
  clientRef: z.string(),
  /** Presigned PUT the reporter writes the bytes to. */
  uploadUrl: z.string(),
  method: z.literal("PUT").default("PUT"),
  headers: z.record(z.string(), z.string()).default({}),
});
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const reportResultsResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  uploads: z.array(uploadTargetSchema).default([]),
});
export type ReportResultsResponse = z.infer<typeof reportResultsResponseSchema>;

export const runStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type RunStats = z.infer<typeof runStatsSchema>;

export const completeShardRequestSchema = z.object({
  runId: z.string(),
  shardId: z.string(),
  status: shardStatusSchema.default("completed"),
  stats: runStatsSchema,
});
export type CompleteShardRequest = z.infer<typeof completeShardRequestSchema>;

export const completeShardResponseSchema = z.object({
  runStatus: runStatusSchema,
  /** True once every expected shard has checked in. */
  runComplete: z.boolean(),
  shardsCompleted: z.number().int().nonnegative(),
  expectedShards: z.number().int().nonnegative(),
});
export type CompleteShardResponse = z.infer<typeof completeShardResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
