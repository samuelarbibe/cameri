import { readFile, stat } from "node:fs/promises";
import type {
  Attachment,
  AttachmentKind,
  RunStats,
  TestAttempt,
  TestStatus,
} from "@cameri/contract";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError as PwTestError,
  TestResult,
} from "@playwright/test/reporter";
import {
  detectCiContext,
  detectGitContext,
  detectRunKey,
  localRunKey,
} from "@cameri/contract/ci";
import { IngestClient } from "./client.ts";
import {
  describeDisabled,
  resolveConfig,
  type CameriReporterOptions,
  type ResolvedConfig,
} from "./config.ts";

export type { CameriReporterOptions } from "./config.ts";

interface FinalAttempt {
  testId: string;
  retry: number;
  status: TestStatus;
  durationMs: number;
}

/**
 * Streams Playwright results to a Cameri server.
 *
 * Two rules govern everything in here:
 *
 *  1. Never fail the user's test run. Any error inside a hook is caught, logged
 *     once, and reporting is switched off for the rest of the run. A broken
 *     dashboard must not turn a green build red.
 *  2. Never block the run longer than necessary. Batches are flushed on a
 *     serialized promise chain so results overlap with test execution instead
 *     of piling up until `onEnd`.
 */
export default class CameriReporter implements Reporter {
  private readonly config: ResolvedConfig;
  private readonly client: IngestClient;

  private runId?: string;
  private shardId?: string;
  private disabled: boolean;
  private buffer: TestAttempt[] = [];
  private finals = new Map<string, FinalAttempt>();
  private pendingUploads = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private ready: Promise<void> = Promise.resolve();
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(options: CameriReporterOptions = {}) {
    this.config = resolveConfig(options);
    this.client = new IngestClient(this.config);
    this.disabled = !this.config.enabled;

    const reason = describeDisabled(this.config);
    if (reason) this.log(`reporting disabled — ${reason}`);
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    if (this.disabled) return;

    const runKey = this.config.runKey ?? detectRunKey() ?? localRunKey();
    const expectedShards = this.config.expectedShards ?? config.shard?.total ?? 1;
    const shardIndex = config.shard?.current ?? 1;

    this.ready = this.guard("open run", async () => {
      const response = await this.client.createRun({
        runKey,
        expectedShards,
        shardIndex,
        playwrightVersion: config.version,
        git: detectGitContext(),
        ci: detectCiContext(),
        metadata: {},
      });
      this.runId = response.runId;
      this.shardId = response.shardId;
      this.log(
        `shard ${shardIndex}/${expectedShards} joined run ${response.runId}` +
          (response.isNewRun ? " (created)" : ""),
      );
    });
  }

  /**
   * Announces a test as in flight.
   *
   * The row this writes is a placeholder: the server replaces it with the real
   * one when `onTestEnd` reports the same (run, test, retry). It exists purely
   * so a dashboard watching a live run can show what is happening *now* rather
   * than a growing list of things that already finished.
   *
   * It deliberately never enters `finals` — a start marker is not a verdict, and
   * counting one would corrupt the shard stats.
   */
  onTestBegin(test: TestCase, result: TestResult): void {
    if (this.disabled) return;

    try {
      // `durationMs` is meaningless here; the UI measures a running bar against
      // the wall clock instead, so zero is the honest value.
      this.buffer.push({ ...this.toAttempt(test, result), status: "running", durationMs: 0 });
      this.armFlushTimer();
    } catch (error) {
      this.fail("collect test start", error);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (this.disabled) return;

    try {
      const attempt = this.toAttempt(test, result);
      this.buffer.push(attempt);

      // Keep only the latest retry per test — that is the verdict the run
      // status is computed from.
      const previous = this.finals.get(attempt.testId);
      if (!previous || previous.retry <= attempt.retry) {
        this.finals.set(attempt.testId, {
          testId: attempt.testId,
          retry: attempt.retry,
          status: attempt.status,
          durationMs: attempt.durationMs,
        });
      }

      if (this.buffer.length >= this.config.batchSize) this.scheduleFlush();
      else this.armFlushTimer();
    } catch (error) {
      this.fail("collect result", error);
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.disabled) return;

    this.scheduleFlush();
    await this.chain;

    if (!this.runId || !this.shardId) return;

    await this.guard("complete shard", async () => {
      const response = await this.client.completeShard({
        runId: this.runId as string,
        shardId: this.shardId as string,
        status: result.status === "interrupted" ? "abandoned" : "completed",
        stats: this.stats(),
      });
      this.log(
        `shard complete — ${response.shardsCompleted}/${response.expectedShards} in, run is ${response.runStatus}`,
      );
    });
  }

  onError(error: PwTestError): void {
    // A global error (e.g. a broken globalSetup) means no tests ran. Nothing to
    // report; just make sure the shard is not left hanging forever.
    this.log(`playwright reported a global error: ${error.message ?? "unknown"}`);
  }

  /**
   * Puts a ceiling on how stale the buffer can get.
   *
   * `unref` matters: a pending timer must never be the thing keeping Node alive
   * after the tests are done.
   */
  private armFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.scheduleFlush();
    }, this.config.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  /** Queues a flush onto the serialized chain so batches arrive in order. */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    this.chain = this.chain
      .then(() => this.ready)
      .then(() =>
        this.guard("report results", async () => {
          if (!this.runId || !this.shardId) return;
          await this.fillAttachmentSizes(batch);
          const response = await this.client.reportResults({
            runId: this.runId,
            shardId: this.shardId,
            results: batch,
          });
          await this.uploadAttachments(response.uploads);
        }),
      );
  }

  /**
   * Sizing happens here rather than in `onTestEnd` because that hook is
   * synchronous and a stat() per attachment would serialise against the run.
   */
  private async fillAttachmentSizes(batch: TestAttempt[]): Promise<void> {
    await Promise.all(
      batch.flatMap((attempt) =>
        attempt.attachments.map(async (attachment) => {
          const path = this.pendingUploads.get(attachment.clientRef);
          if (!path) return;
          try {
            attachment.sizeBytes = (await stat(path)).size;
          } catch {
            attachment.sizeBytes = 0;
          }
        }),
      ),
    );
  }

  private async uploadAttachments(
    uploads: Array<{ clientRef: string; uploadUrl: string; headers: Record<string, string> }>,
  ): Promise<void> {
    for (const target of uploads) {
      const path = this.pendingUploads.get(target.clientRef);
      if (!path) continue;
      this.pendingUploads.delete(target.clientRef);
      try {
        const body = await readFile(path);
        await this.client.upload(target.uploadUrl, body, target.headers);
      } catch (error) {
        // A missing trace is a degraded report, not a failed build.
        this.log(`attachment upload failed for ${path}: ${describe(error)}`);
      }
    }
  }

  private toAttempt(test: TestCase, result: TestResult): TestAttempt {
    return {
      testId: test.id,
      title: test.title,
      titlePath: test.titlePath(),
      file: test.location.file,
      location: {
        file: test.location.file,
        line: test.location.line,
        column: test.location.column,
      },
      projectName: test.parent.project()?.name ?? "",
      status: result.status,
      expectedStatus: test.expectedStatus,
      retry: result.retry,
      durationMs: result.duration,
      startedAt: result.startTime.toISOString(),
      parallelIndex: result.parallelIndex,
      workerIndex: result.workerIndex,
      errors: result.errors.map((error) => ({
        message: stripAnsi(error.message ?? "unknown error"),
        stack: error.stack ? stripAnsi(error.stack) : null,
        snippet: error.snippet ? stripAnsi(error.snippet) : null,
        location: error.location ?? null,
      })),
      annotations: test.annotations.map((a) => ({
        type: a.type,
        description: a.description ?? null,
      })),
      tags: readTags(test),
      stdout: joinStream(result.stdout),
      stderr: joinStream(result.stderr),
      attachments: this.collectAttachments(test, result),
    };
  }

  private collectAttachments(test: TestCase, result: TestResult): Attachment[] {
    const collected: Attachment[] = [];

    for (const [index, attachment] of result.attachments.entries()) {
      if (!attachment.path) continue; // inline bodies are not worth a round trip yet
      const clientRef = `${test.id}:${result.retry}:${index}`;
      this.pendingUploads.set(clientRef, attachment.path);
      collected.push({
        clientRef,
        name: attachment.name,
        kind: classifyAttachment(attachment.name, attachment.contentType),
        contentType: attachment.contentType,
        sizeBytes: 0, // filled in at flush time, see fillAttachmentSizes
        sha256: null,
      });
    }

    return collected;
  }

  private stats(): RunStats {
    const stats: RunStats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
      durationMs: 0,
    };
    for (const final of this.finals.values()) {
      stats.total += 1;
      stats.durationMs += final.durationMs;
      if (final.retry > 0 && final.status === "passed") stats.flaky += 1;
      else if (final.status === "passed") stats.passed += 1;
      else if (final.status === "skipped") stats.skipped += 1;
      else stats.failed += 1;
    }
    return stats;
  }

  /**
   * Runs an operation and, if it throws, disables reporting for the rest of the
   * run rather than letting the error escape into Playwright.
   */
  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    if (this.disabled) return;
    try {
      await fn();
    } catch (error) {
      this.fail(what, error);
    }
  }

  private fail(what: string, error: unknown): void {
    this.disabled = true;
    console.warn(`[cameri] ${what} failed, reporting is now off: ${describe(error)}`);
  }

  private log(message: string): void {
    if (this.config.debug) console.log(`[cameri] ${message}`);
  }
}

const ANSI = /\[[0-9;]*m/g;
function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

function joinStream(chunks: Array<string | Buffer>): string | null {
  if (chunks.length === 0) return null;
  const joined = chunks.map((c) => (typeof c === "string" ? c : c.toString("utf8"))).join("");
  // Cap it — a chatty test should not push a megabyte of logs per attempt.
  return joined.length > 50_000 ? `${joined.slice(0, 50_000)}\n…truncated` : joined;
}

function readTags(test: TestCase): string[] {
  // `tags` landed in Playwright 1.42; the peer range allows older versions.
  const tags = (test as TestCase & { tags?: string[] }).tags;
  return Array.isArray(tags) ? tags : [];
}

function classifyAttachment(name: string, contentType: string): AttachmentKind {
  if (name === "trace" || contentType === "application/zip") return "trace";
  if (contentType.startsWith("image/")) return "screenshot";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("text/")) return "log";
  return "other";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
