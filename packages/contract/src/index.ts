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
