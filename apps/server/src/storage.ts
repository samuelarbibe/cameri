import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { Signer } from "./crypto.ts";
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
  /** Whether this server issued the upload URL a request is presenting. */
  verifyUpload?(key: string, query: Record<string, string>): boolean;
}

/**
 * How long an upload URL stays valid.
 *
 * Generous, because it is handed out when results are reported and spent when
 * the shard has finished writing a trace that may be hundreds of megabytes on a
 * CI runner with a slow disk. Short enough that a URL leaked through a log is
 * not a standing invitation.
 */
const UPLOAD_TTL_MS = 60 * 60 * 1000;

/**
 * Writes attachment bytes to a local directory, served back by this server's
 * own blob endpoint.
 *
 * Upload URLs are signed: without that, `/api/v1/blobs/*` would be an
 * unauthenticated write to anyone who could reach the server — enough to
 * overwrite another project's trace with anything at all, or to fill the disk.
 *
 * Downloads are deliberately *not* signed. The Playwright trace viewer fetches
 * them cross-origin and uncredentialed, and every read path in cameri is open
 * anyway, so a signature there would cost a feature and buy nothing until the
 * dashboard itself has authentication.
 */
export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(
    private readonly publicUrl: string,
    dir: string,
    private readonly signer: Signer,
  ) {
    this.root = resolve(dir);
  }

  keyFor(runId: string, attemptId: string, name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    return `${runId}/${attemptId}/${safe}`;
  }

  async presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    const { exp, sig } = this.signer.sign(key, UPLOAD_TTL_MS);
    return {
      uploadUrl: `${this.publicUrl}/api/v1/blobs/${encodeURI(key)}?exp=${exp}&sig=${sig}`,
      headers: { "content-type": contentType },
    };
  }

  verifyUpload(key: string, query: Record<string, string>): boolean {
    return this.signer.verify(key, query.exp, query.sig);
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

export function createStorage(env: Env, signer: Signer): Storage {
  if (env.STORAGE_DRIVER === "s3") {
    // TODO: @aws-sdk/s3-request-presigner against S3 or MinIO.
    throw new Error("the s3 storage driver is not implemented yet");
  }
  return new LocalStorage(env.PUBLIC_URL, env.STORAGE_LOCAL_DIR, signer);
}
