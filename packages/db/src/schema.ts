import {
  ATTACHMENT_KINDS,
  RUN_STATUSES,
  SHARD_STATUSES,
  TEST_STATUSES,
  type RunStats,
} from "@cameri/contract";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const testStatusEnum = pgEnum("test_status", [...TEST_STATUSES]);
export const runStatusEnum = pgEnum("run_status", [...RUN_STATUSES]);
export const shardStatusEnum = pgEnum("shard_status", [...SHARD_STATUSES]);
export const attachmentKindEnum = pgEnum("attachment_kind", [...ATTACHMENT_KINDS]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt,
});

/**
 * Ingest credentials. Only the sha256 of a key is ever stored — the plaintext is
 * shown once at creation and then unrecoverable, same as a GitHub PAT.
 */
export const recordKeys = pgTable(
  "record_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("record_keys_project_idx").on(t.projectId)],
);

/**
 * One logical test run, which may be spread over many CI machines.
 *
 * `runKey` is derived from the CI build id, so all shards of the same build
 * converge on one row — the (project, runKey) unique index is what makes the
 * "first shard creates it, the rest join it" upsert safe under concurrency.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runKey: text("run_key").notNull(),
    status: runStatusEnum("status").notNull().default("running"),
    expectedShards: integer("expected_shards").notNull().default(1),
    playwrightVersion: text("playwright_version"),

    branch: text("branch"),
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    author: text("author"),
    remoteUrl: text("remote_url"),

    ciProvider: text("ci_provider"),
    ciBuildId: text("ci_build_id"),
    ciBuildUrl: text("ci_build_url"),
    ciJobName: text("ci_job_name"),
    ciAttempt: integer("ci_attempt").notNull().default(1),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** After this, an unfinished run is presumed dead and swept to `timedOut`. */
    staleAt: timestamp("stale_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex("runs_project_run_key_idx").on(t.projectId, t.runKey),
    index("runs_project_created_idx").on(t.projectId, t.createdAt.desc()),
    index("runs_branch_idx").on(t.projectId, t.branch),
    index("runs_incomplete_idx")
      .on(t.staleAt)
      .where(sql`${t.completedAt} is null`),
  ],
);

export const shards = pgTable(
  "shards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    shardIndex: integer("shard_index").notNull(),
    status: shardStatusEnum("status").notNull().default("running"),
    stats: jsonb("stats").$type<RunStats>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Heartbeat, so a machine killed mid-run can be told apart from a slow one. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
  },
  (t) => [uniqueIndex("shards_run_index_idx").on(t.runId, t.shardIndex)],
);

/**
 * Stable identity of a test across runs — this is what test history, flake rate
 * and quarantine all hang off. Playwright's `testId` is stable as long as the
 * title and file do not change; a rename starts a new history, which is a
 * known and acceptable limitation.
 */
export const tests = pgTable(
  "tests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testId: text("test_id").notNull(),
    title: text("title").notNull(),
    titlePath: jsonb("title_path").$type<string[]>().notNull().default([]),
    file: text("file").notNull(),
    projectName: text("project_name").notNull().default(""),
    quarantined: boolean("quarantined").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
  },
  (t) => [
    uniqueIndex("tests_project_test_idx").on(t.projectId, t.testId),
    index("tests_project_file_idx").on(t.projectId, t.file),
  ],
);

export const testAttempts = pgTable(
  "test_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    shardId: uuid("shard_id")
      .notNull()
      .references(() => shards.id, { onDelete: "cascade" }),
    testRef: uuid("test_ref")
      .notNull()
      .references(() => tests.id, { onDelete: "cascade" }),
    /** Denormalized so history queries never have to join through `tests`. */
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    /** `running` until the test finishes; see TEST_STATUSES for what that means. */
    status: testStatusEnum("status").notNull(),
    expectedStatus: testStatusEnum("expected_status").notNull().default("passed"),
    retry: integer("retry").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Parallel slot within the shard — one timeline lane per distinct value. */
    parallelIndex: integer("parallel_index").notNull().default(0),
    /** Keeps climbing when a worker is replaced, so it can outgrow the slot count. */
    workerIndex: integer("worker_index").notNull().default(0),

    errorMessage: text("error_message"),
    errorStack: text("error_stack"),
    errorSnippet: text("error_snippet"),
    /** Cluster key from `@cameri/core`; groups "the same failure" together. */
    errorSignature: text("error_signature"),

    annotations: jsonb("annotations")
      .$type<Array<{ type: string; description?: string | null }>>()
      .notNull()
      .default([]),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    stdout: text("stdout"),
    stderr: text("stderr"),

    /** Set once the whole retry chain for this test in this run is known. */
    isFlaky: boolean("is_flaky").notNull().default(false),
    createdAt,
  },
  (t) => [
    index("attempts_run_idx").on(t.runId),
    index("attempts_test_history_idx").on(t.testRef, t.createdAt.desc()),
    index("attempts_signature_idx").on(t.projectId, t.errorSignature),
    uniqueIndex("attempts_run_test_retry_idx").on(t.runId, t.testRef, t.retry),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => testAttempts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: attachmentKindEnum("kind").notNull().default("other"),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    sha256: text("sha256"),
    /** Object storage key. Bytes never live in Postgres. */
    storageKey: text("storage_key").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("attachments_attempt_idx").on(t.attemptId)],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  runs: many(runs),
  tests: many(tests),
  recordKeys: many(recordKeys),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  project: one(projects, { fields: [runs.projectId], references: [projects.id] }),
  shards: many(shards),
  attempts: many(testAttempts),
}));

export const shardsRelations = relations(shards, ({ one, many }) => ({
  run: one(runs, { fields: [shards.runId], references: [runs.id] }),
  attempts: many(testAttempts),
}));

export const testsRelations = relations(tests, ({ one, many }) => ({
  project: one(projects, { fields: [tests.projectId], references: [projects.id] }),
  attempts: many(testAttempts),
}));

export const testAttemptsRelations = relations(testAttempts, ({ one, many }) => ({
  run: one(runs, { fields: [testAttempts.runId], references: [runs.id] }),
  shard: one(shards, { fields: [testAttempts.shardId], references: [shards.id] }),
  test: one(tests, { fields: [testAttempts.testRef], references: [tests.id] }),
  attachments: many(attachments),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  attempt: one(testAttempts, {
    fields: [attachments.attemptId],
    references: [testAttempts.id],
  }),
}));

export type Project = typeof projects.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Shard = typeof shards.$inferSelect;
export type Test = typeof tests.$inferSelect;
export type TestAttemptRow = typeof testAttempts.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
