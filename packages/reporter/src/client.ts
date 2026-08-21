import type {
  CompleteShardRequest,
  CompleteShardResponse,
  CreateRunRequest,
  CreateRunResponse,
  ReportResultsRequest,
  ReportResultsResponse,
} from "@cameri/contract";
// Values come from the zod-free entry point — see packages/contract/src/constants.ts.
import {
  CLIENT_VERSION_HEADER,
  INGEST_API_VERSION,
  RECORD_KEY_HEADER,
} from "@cameri/contract/constants";
import type { ResolvedConfig } from "./config.ts";

// Injected at build time by tsup so the server can spot stale reporters.
declare const __CAMERI_VERSION__: string;
const CLIENT_VERSION =
  typeof __CAMERI_VERSION__ === "string" ? __CAMERI_VERSION__ : "0.0.0-dev";

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IngestClient {
  constructor(private readonly config: ResolvedConfig) {}

  createRun(body: CreateRunRequest): Promise<CreateRunResponse> {
    return this.post<CreateRunResponse>("/runs", body);
  }

  reportResults(body: ReportResultsRequest): Promise<ReportResultsResponse> {
    return this.post<ReportResultsResponse>("/results", body);
  }

  completeShard(body: CompleteShardRequest): Promise<CompleteShardResponse> {
    return this.post<CompleteShardResponse>("/shards/complete", body);
  }

  /**
   * Presigned upload straight to object storage — deliberately not routed
   * through the ingest API, since a trace can be hundreds of megabytes.
   */
  async upload(url: string, body: Uint8Array, headers: Record<string, string>): Promise<void> {
    const response = await fetch(url, { method: "PUT", body, headers });
    if (!response.ok) {
      throw new IngestError(`upload failed: ${response.status}`, response.status, true);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.config.serverUrl}/api/${INGEST_API_VERSION}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        // Exponential backoff with jitter, so 40 shards retrying do not
        // synchronise into a thundering herd against the server.
        const backoff = Math.min(2 ** attempt * 250, 5_000);
        await sleep(backoff + Math.random() * 250);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            [RECORD_KEY_HEADER]: this.config.recordKey,
            [CLIENT_VERSION_HEADER]: `playwright-reporter/${CLIENT_VERSION}`,
          },
          body: JSON.stringify(body),
        });

        if (response.ok) return (await response.json()) as T;

        const retryable = response.status >= 500 || response.status === 429;
        const detail = await response.text().catch(() => "");
        lastError = new IngestError(
          `${path} → ${response.status} ${detail.slice(0, 200)}`,
          response.status,
          retryable,
        );
        if (!retryable) throw lastError;
      } catch (error) {
        if (error instanceof IngestError && !error.retryable) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new IngestError(`${path} failed after ${this.config.maxRetries} retries`);
  }
}
