import {
  ATTACHMENT_KINDS,
  RUN_STATUSES,
  SHARD_STATUSES,
  TEST_STATUSES,
  type RunStats,
  type TestStep,
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
export const integrationProviderEnum = pgEnum("integration_provider", ["gitlab"]);

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
 * Outbound credentials, one row per (project, provider).
 *
 * The token is stored encrypted rather than hashed, because unlike a record key
 * the server has to *use* it — it authenticates cameri to GitLab. That is a real
 * difference in exposure and it is why `tokenHint` exists: the UI can show
 * `glpat-…a1b2` to confirm which token is configured without ever decrypting.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    /** Instance root, so self-hosted GitLab works. Falls back to the run's own. */
    baseUrl: text("base_url"),
    /** AES-256-GCM, keyed by CAMERI_ENCRYPTION_KEY. Never leaves the server. */
    tokenCipher: text("token_cipher").notNull(),
    /** Last few characters of the plaintext, for recognition only. */
    tokenHint: text("token_hint").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    /** Why the last sync failed, surfaced in settings so it is not silent. */
    lastError: text("last_error"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("integrations_project_provider_idx").on(t.projectId, t.provider)],
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

    /**
     * The merge request this build belongs to, when it is one, plus the id of
     * the note cameri keeps updated on it.
     *
     * `mrNoteId` is the whole reason these live on the run rather than being
     * re-derived: it is the difference between one comment that evolves as the
     * suite progresses and a fresh comment on every batch of results.
     */
    mrProvider: text("mr_provider"),
    mrProjectId: text("mr_project_id"),
    mrIid: text("mr_iid"),
    /**
     * Title and target branch as CI reported them at the time of the run.
     *
     * Snapshots, deliberately: the merge request list has to read correctly on a
     * deployment that has never been given a GitLab token, and a retitled merge
     * request should not rewrite what past pipelines saw.
     */
    mrTitle: text("mr_title"),
    mrTargetBranch: text("mr_target_branch"),
    /**
     * Instance root as CI reported it. Kept rather than derived from `mrUrl`,
     * because a GitLab served under a subpath has an API root that no amount of
     * parsing the merge request URL will recover.
     */
    mrServerUrl: text("mr_server_url"),
    mrUrl: text("mr_url"),
    mrNoteId: text("mr_note_id"),
    mrSyncedAt: timestamp("mr_synced_at", { withTimezone: true }),

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
    // Partial: most rows on a typical project are branch pipelines with no merge
    // request at all, and neither the list nor the filter ever wants those.
    index("runs_mr_idx")
      .on(t.projectId, t.mrIid, t.createdAt.desc())
      .where(sql`${t.mrIid} is not null`),
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
    /** Flattened step tree; see `testStepSchema` for why it is not nested. */
    steps: jsonb("steps").$type<TestStep[]>().notNull().default([]),

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
  integrations: many(integrations),
}));

export const integrationsRelations = relations(integrations, ({ one }) => ({
  project: one(projects, { fields: [integrations.projectId], references: [projects.id] }),
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
export type IntegrationRow = typeof integrations.$inferSelect;
