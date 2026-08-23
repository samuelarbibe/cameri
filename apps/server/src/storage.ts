import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { Env } from "./env.ts";

export interface PresignedUpload {
  uploadUrl: string;
  headers: Record<string, string>;
}

/**
 * Attachment bytes never pass through the ingest API — a Playwright trace can be
 * hundreds of megabytes, and proxying forty shards' worth of them through the
 * app server is how you fall over. Clients get a presigned target and write
 * straight to storage.
 */
export interface Storage {
  /** Opaque key under which an attachment's bytes live. */
  keyFor(runId: string, attemptId: string, name: string): string;
  presignUpload(key: string, contentType: string): Promise<PresignedUpload>;
  /**
   * Absolute URL the bytes can be fetched from.
   *
   * Absolute rather than a path, because the one consumer that matters is
   * `trace.playwright.dev`: the viewer runs on Playwright's origin and fetches
   * the trace itself, so a relative URL resolves against the wrong host.
   */
  downloadUrl(key: string): Promise<string>;
  /** Only implemented by the local driver; S3 clients read presigned GETs. */
  write?(key: string, body: Readable): Promise<void>;
  read?(key: string): Promise<Readable>;
  size?(key: string): Promise<number>;
}

/**
 * Development driver: writes under a local directory and hands back a URL
 * pointing at this server's own blob endpoint. Not for production — there is no
 * signature, so anyone who can reach the server can write blobs.
 */
export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(
    private readonly publicUrl: string,
    dir: string,
  ) {
    this.root = resolve(dir);
  }

  keyFor(runId: string, attemptId: string, name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    return `${runId}/${attemptId}/${safe}`;
  }

  async presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    return {
      uploadUrl: `${this.publicUrl}/api/v1/blobs/${encodeURI(key)}`,
      headers: { "content-type": contentType },
    };
  }

  async downloadUrl(key: string): Promise<string> {
    return `${this.publicUrl}/api/v1/blobs/${encodeURI(key)}`;
  }

  async write(key: string, body: Readable): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(body, createWriteStream(target));
  }

  async read(key: string): Promise<Readable> {
    return createReadStream(this.pathFor(key));
  }

  /** Resolves a key under the root, refusing anything that escapes it. */
  private pathFor(key: string): string {
    const target = join(this.root, key);
    if (!target.startsWith(this.root)) throw new Error("path traversal rejected");
    return target;
  }

  async size(key: string): Promise<number> {
    try {
      return (await stat(join(this.root, key))).size;
    } catch {
      return 0;
    }
  }
}

export function createStorage(env: Env): Storage {
  if (env.STORAGE_DRIVER === "s3") {
    // TODO: @aws-sdk/s3-request-presigner against S3 or MinIO.
    throw new Error("the s3 storage driver is not implemented yet");
  }
  return new LocalStorage(env.PUBLIC_URL, env.STORAGE_LOCAL_DIR);
}
