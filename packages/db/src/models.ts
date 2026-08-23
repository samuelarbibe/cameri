/**
 * Read models, generated from the Drizzle tables.
 *
 * These are the shapes the dashboard sees. Because they are derived rather than
 * hand-written, a column rename is a type error in the UI instead of a runtime
 * surprise — and there is nothing to keep in sync by hand.
 *
 * Note the deliberate asymmetry with `@cameri/contract`:
 *
 *   ingest wire DTOs  →  hand-written in @cameri/contract  (public, versioned)
 *   read models       →  generated from the schema here    (internal, free to move)
 *
 * The ingest DTOs are not generated on purpose. They are a published API
 * consumed by reporters that may be months out of date, so they must not shift
 * every time a column does. The two shapes also genuinely differ: the wire sends
 * one nested attempt with its errors and attachments inline, while storage
 * normalizes that across three tables.
 */
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import {
  attachments,
  integrations,
  projects,
  recordKeys,
  runs,
  shards,
  testAttempts,
  tests,
} from "./schema.ts";

export const projectSelectSchema = createSelectSchema(projects);
export const runSelectSchema = createSelectSchema(runs);
export const shardSelectSchema = createSelectSchema(shards);
export const testSelectSchema = createSelectSchema(tests);
export const testAttemptSelectSchema = createSelectSchema(testAttempts);
export const attachmentSelectSchema = createSelectSchema(attachments);
export const integrationSelectSchema = createSelectSchema(integrations);

export const projectInsertSchema = createInsertSchema(projects);
export const runInsertSchema = createInsertSchema(runs);
export const shardInsertSchema = createInsertSchema(shards);
export const testInsertSchema = createInsertSchema(tests);
export const testAttemptInsertSchema = createInsertSchema(testAttempts);
export const attachmentInsertSchema = createInsertSchema(attachments);
export const recordKeyInsertSchema = createInsertSchema(recordKeys);

export type ProjectModel = typeof projects.$inferSelect;
export type RunModel = typeof runs.$inferSelect;
export type ShardModel = typeof shards.$inferSelect;
export type TestModel = typeof tests.$inferSelect;
export type TestAttemptModel = typeof testAttempts.$inferSelect;
export type AttachmentModel = typeof attachments.$inferSelect;
export type IntegrationModel = typeof integrations.$inferSelect;

export type NewProject = typeof projects.$inferInsert;
export type NewRun = typeof runs.$inferInsert;
export type NewShard = typeof shards.$inferInsert;
export type NewTest = typeof tests.$inferInsert;
export type NewTestAttempt = typeof testAttempts.$inferInsert;
export type NewAttachment = typeof attachments.$inferInsert;
export type NewRecordKey = typeof recordKeys.$inferInsert;
export type NewIntegration = typeof integrations.$inferInsert;

/** Run plus the derived fields the run list needs, without a second round trip. */
export interface RunSummary extends RunModel {
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    durationMs: number;
  };
  shardsCompleted: number;
}
