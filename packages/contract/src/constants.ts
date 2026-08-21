/**
 * Wire constants with no zod import, so the reporter can bundle them without
 * dragging a validation library into someone else's CI install.
 */

export const INGEST_API_VERSION = "v1";

/** Header the reporter and CLI send their project record key in. */
export const RECORD_KEY_HEADER = "x-cameri-key";
/** Header carrying the reporter version, so the server can spot stale clients. */
export const CLIENT_VERSION_HEADER = "x-cameri-client";

export const TEST_STATUSES = [
  /**
   * Reported at `onTestBegin` and replaced by a terminal status when the test
   * finishes. It is the only non-final value here, and the only one whose
   * `durationMs` means nothing — the attempt is still accruing time.
   */
  "running",
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
] as const;

export const RUN_STATUSES = [
  "running",
  "passed",
  "failed",
  "timedOut",
  "cancelled",
] as const;

export const SHARD_STATUSES = ["running", "completed", "failed", "abandoned"] as const;

export const ATTACHMENT_KINDS = ["trace", "screenshot", "video", "log", "other"] as const;
