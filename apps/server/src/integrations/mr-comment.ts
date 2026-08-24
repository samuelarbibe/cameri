import { integrations, projects, runs, shards, testAttempts, tests } from "@camerihq/db";
import { aggregateStats } from "@camerihq/core";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { createCipher } from "../crypto.ts";
import { GitLabClient } from "./gitlab.ts";

/**
 * Keeps one comment on a merge request in step with a run.
 *
 * The comment is written by the *server* rather than by the reporter, and that
 * is the whole design. A reporter only ever knows what its own shard did; the
 * server is the only party that knows the run as a whole, so it is the only one
 * that can answer "how is the build going" while the build is still going.
 *
 * Three properties matter here, in order:
 *
 *  1. Ingest must never wait on GitLab. Every entry point is fire-and-forget.
 *  2. One comment per run, edited in place. A comment per batch would bury the
 *     merge request under a hundred notes.
 *  3. GitLab must not be hammered. Updates coalesce onto a minimum interval,
 *     with the final state always delivered.
 */

/** Floor between two edits of the same note while a run is in progress. */
const MIN_INTERVAL_MS = 15_000;

/** How many failures to name before falling back to a count. */
const MAX_LISTED_FAILURES = 10;

type Entry = {
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  /** Something changed while a sync was running; go round again when it lands. */
  dirty: boolean;
  /** …and that something was the last shard, so the retry must not be delayed. */
  dirtyFinal: boolean;
  lastAt: number;
};

export interface MrCommentSync {
  /**
   * Requests an update. Returns immediately; the work happens on a timer.
   *
   * `final` skips the rate limit — the last word on a run is worth a round trip
   * straight away, and by definition there is no follow-up to coalesce with.
   */
  schedule: (runId: string, options?: { final?: boolean }) => void;
  /** Drains pending timers, so tests and shutdown do not leave work in the air. */
  close: () => Promise<void>;
}

export function createMrCommentSync(app: AppContext): MrCommentSync {
  const entries = new Map<string, Entry>();

  /**
   * Serializes per run *within this process*. A multi-instance deployment could
   * still have two servers decide to create the first note at the same moment
   * and end up with two comments; every later edit converges on one of them.
   * Worth fixing with an advisory lock if cameri ever runs more than one node.
   */
  function schedule(runId: string, options: { final?: boolean } = {}): void {
    sweep();

    const entry = entries.get(runId) ?? {
      inFlight: false,
      dirty: false,
      dirtyFinal: false,
      lastAt: 0,
    };
    entries.set(runId, entry);

    if (entry.inFlight) {
      entry.dirty = true;
      entry.dirtyFinal ||= options.final === true;
      return;
    }
    if (entry.timer) {
      // A timer is already pending. If this is the final update, pull it
      // forward rather than letting the run close on a stale comment.
      if (!options.final) return;
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }

    const wait = options.final ? 0 : Math.max(0, MIN_INTERVAL_MS - (Date.now() - entry.lastAt));
    entry.timer = setTimeout(() => void run(runId, entry), wait);
    entry.timer.unref?.();
  }

  /**
   * Forgets runs that are no longer holding anything back.
   *
   * An entry has to outlive its own sync, because `lastAt` is what enforces the
   * floor — dropping it the moment the sync lands would mean every update was
   * the first one and the rate limit never applied. So entries are retired
   * lazily, once they are old enough that keeping them would change nothing.
   */
  function sweep(): void {
    const cutoff = Date.now() - MIN_INTERVAL_MS;
    for (const [runId, entry] of entries) {
      if (!entry.inFlight && !entry.timer && entry.lastAt <= cutoff) entries.delete(runId);
    }
  }

  async function run(runId: string, entry: Entry): Promise<void> {
    entry.timer = undefined;
    entry.inFlight = true;
    entry.dirty = false;
    entry.dirtyFinal = false;
    try {
      await sync(app, runId);
    } catch (error) {
      // A dashboard integration must never take down ingest, and a merge
      // request comment is the least important thing cameri does.
      console.warn(`[cameri] merge request comment for run ${runId} failed: ${describe(error)}`);
      await recordFailure(app, runId, describe(error));
    } finally {
      entry.inFlight = false;
      entry.lastAt = Date.now();
      // The entry stays in the map either way: `sweep` retires it once its
      // `lastAt` is too old to hold anything back.
      if (entry.dirty) schedule(runId, { final: entry.dirtyFinal });
    }
  }

  return {
    schedule,
    async close() {
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      entries.clear();
    },
  };
}

/** One pass: read the run, render it, and write it to GitLab. */
async function sync(app: AppContext, runId: string): Promise<void> {
  const { db, env } = app;

  const [row] = await db
    .select({ run: runs, projectSlug: projects.slug, projectName: projects.name })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) return;
  const { run } = row;

  // Not a merge request pipeline. Nothing to comment on, and this is the common
  // case — most runs are branch or scheduled pipelines.
  if (run.mrProvider !== "gitlab" || !run.mrProjectId || !run.mrIid) return;

  const [integration] = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.projectId, run.projectId), eq(integrations.provider, "gitlab")),
    )
    .limit(1);

  if (!integration || !integration.enabled) return;

  const baseUrl = integration.baseUrl || run.mrServerUrl;
  if (!baseUrl) {
    throw new Error(
      "no GitLab base URL — set one on the integration, or run on a GitLab CI that reports CI_SERVER_URL",
    );
  }

  const token = createCipher(app.encryptionKey).decrypt(integration.tokenCipher);
  const client = new GitLabClient({ baseUrl, token });

  const body = await renderComment(app, {
    run,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    webUrl: env.WEB_URL,
  });

  // Re-read rather than trusting the row fetched above: another update for the
  // same run may have created the note between then and now.
  const [fresh] = await db
    .select({ mrNoteId: runs.mrNoteId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (fresh?.mrNoteId) {
    await client.updateNote(run.mrProjectId, run.mrIid, fresh.mrNoteId, body);
    await db
      .update(runs)
      .set({ mrSyncedAt: new Date() })
      .where(eq(runs.id, runId));
  } else {
    const noteId = await client.createNote(run.mrProjectId, run.mrIid, body);
    await db
      .update(runs)
      .set({ mrNoteId: noteId, mrSyncedAt: new Date() })
      .where(eq(runs.id, runId));
  }

  await db
    .update(integrations)
    .set({ lastUsedAt: new Date(), lastError: null })
    .where(eq(integrations.id, integration.id));
}

interface RenderContext {
  run: typeof runs.$inferSelect;
  projectSlug: string;
  projectName: string;
  webUrl: string;
}

/**
 * The comment body.
 *
 * Markdown, because that is what GitLab renders, and deliberately compact: this
 * sits in a review thread where a reviewer is trying to read a diff, so it earns
 * its space by answering "can I merge this" and then getting out of the way.
 */
export async function renderComment(app: AppContext, ctx: RenderContext): Promise<string> {
  const { db } = app;
  const { run } = ctx;

  const attempts = await db
    .select({
      testId: testAttempts.testRef,
      retry: testAttempts.retry,
      status: testAttempts.status,
      durationMs: testAttempts.durationMs,
    })
    .from(testAttempts)
    .where(eq(testAttempts.runId, run.id));

  const stats = aggregateStats(attempts);
  // `aggregateStats` counts an in-flight test in the total and in no verdict
  // bucket, which is exactly right — the remainder is what is still going.
  const running = Math.max(
    0,
    stats.total - stats.passed - stats.failed - stats.flaky - stats.skipped,
  );

  const shardRows = await db
    .select({ completedAt: shards.completedAt })
    .from(shards)
    .where(eq(shards.runId, run.id));
  const shardsDone = shardRows.filter((s) => s.completedAt !== null).length;

  const failures = await db
    .select({
      title: tests.title,
      file: tests.file,
      message: testAttempts.errorMessage,
    })
    .from(testAttempts)
    .innerJoin(tests, eq(testAttempts.testRef, tests.id))
    .where(
      and(
        eq(testAttempts.runId, run.id),
        inArray(testAttempts.status, ["failed", "timedOut"]),
        // Only the last attempt of a chain: a test that failed once and passed
        // on retry is flaky, not broken, and does not belong on this list.
        eq(testAttempts.isFlaky, false),
        isNotNull(testAttempts.errorMessage),
      ),
    )
    .groupBy(tests.title, tests.file, testAttempts.errorMessage)
    .orderBy(asc(tests.file), asc(tests.title))
    .limit(MAX_LISTED_FAILURES + 1);

  const done = run.completedAt !== null;
  const headline = done
    ? stats.failed > 0
      ? `${icon("failed")} ${stats.failed} failed`
      : stats.flaky > 0
        ? `${icon("flaky")} passed with ${stats.flaky} flaky`
        : `${icon("passed")} all ${stats.total} passed`
    : `${icon("running")} running — ${running} in flight`;

  const lines: string[] = [
    // A stable marker so a human (or a future cameri) can recognise its own
    // comment in a thread full of bot notes.
    MARKER,
    `### Playwright · ${headline}`,
    "",
    "| Passed | Failed | Flaky | Skipped | Running | Total |",
    "| -----: | -----: | ----: | ------: | ------: | ----: |",
    `| ${stats.passed} | ${stats.failed} | ${stats.flaky} | ${stats.skipped} | ${running} | ${stats.total} |`,
  ];

  if (failures.length > 0) {
    lines.push("", "<details open><summary><b>Failing tests</b></summary>", "");
    for (const failure of failures.slice(0, MAX_LISTED_FAILURES)) {
      lines.push(`- \`${failure.file}\` › ${escapeMd(failure.title)}`);
      if (failure.message) lines.push(`  <br>\`${escapeMd(oneLine(failure.message))}\``);
    }
    if (failures.length > MAX_LISTED_FAILURES) {
      lines.push("", `_…and more. See the full report._`);
    }
    lines.push("", "</details>");
  }

  const meta = [
    `${shardsDone}/${run.expectedShards} shards`,
    run.branch ? `\`${escapeMd(run.branch)}\`` : null,
    run.commitSha ? `\`${run.commitSha.slice(0, 8)}\`` : null,
    `[Full report](${reportUrl(ctx)})`,
  ].filter((part): part is string => part !== null);

  lines.push("", meta.join(" · "));
  lines.push("", `<sub>cameri · updated ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</sub>`);

  return lines.join("\n");
}

export const MARKER = "<!-- cameri:run-status -->";

function reportUrl(ctx: RenderContext): string {
  return `${ctx.webUrl.replace(/\/+$/, "")}/${ctx.projectSlug}/runs/${ctx.run.id}`;
}

function icon(outcome: "passed" | "failed" | "flaky" | "running"): string {
  // Emoji rather than GitLab's `:name:` shortcodes, which self-hosted instances
  // can have disabled.
  return { passed: "✅", failed: "❌", flaky: "⚠️", running: "🔄" }[outcome];
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/**
 * A test title is arbitrary user text landing in a comment on someone's merge
 * request. Neutralising the characters that start markdown or HTML keeps a
 * test named `<img onerror=…>` from rendering as anything but its own name.
 */
function escapeMd(value: string): string {
  return value.replace(/[<>&`|*_[\]\\]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * Parks the failure where someone will see it.
 *
 * A revoked token would otherwise fail silently forever: the run finishes, the
 * comment never appears, and nothing anywhere says why. Settings reads this
 * back and shows it next to the integration.
 */
async function recordFailure(app: AppContext, runId: string, message: string): Promise<void> {
  try {
    const [row] = await app.db
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!row) return;

    await app.db
      .update(integrations)
      .set({ lastError: message })
      .where(
        and(eq(integrations.projectId, row.projectId), eq(integrations.provider, "gitlab")),
      );
  } catch {
    // Best effort. If we cannot even record why the comment failed, the console
    // warning already emitted is the whole story.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
