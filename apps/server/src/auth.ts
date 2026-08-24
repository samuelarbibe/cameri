import { createHash, timingSafeEqual } from "node:crypto";
import { RECORD_KEY_HEADER } from "@camerihq/contract/constants";
import { recordKeys, type Database } from "@camerihq/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";

export interface AuthedProject {
  projectId: string;
  recordKeyId: string;
}

export function hashRecordKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Constant-time compare so the hash lookup cannot be probed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function resolveRecordKey(
  db: Database,
  raw: string,
): Promise<AuthedProject | undefined> {
  const hash = hashRecordKey(raw);
  const [row] = await db
    .select({
      id: recordKeys.id,
      projectId: recordKeys.projectId,
      keyHash: recordKeys.keyHash,
    })
    .from(recordKeys)
    .where(and(eq(recordKeys.keyHash, hash), isNull(recordKeys.revokedAt)))
    .limit(1);

  if (!row || !safeEqual(row.keyHash, hash)) return undefined;
  return { projectId: row.projectId, recordKeyId: row.id };
}

declare module "hono" {
  interface ContextVariableMap {
    project: AuthedProject;
  }
}

/** Gate for every ingest route. Rejects before any body parsing happens. */
export function recordKeyAuth(app: AppContext) {
  return async (c: Context, next: Next) => {
    const raw = c.req.header(RECORD_KEY_HEADER);
    if (!raw) {
      throw new HTTPException(401, { message: `missing ${RECORD_KEY_HEADER} header` });
    }

    const project = await resolveRecordKey(app.db, raw);
    if (!project) throw new HTTPException(401, { message: "invalid record key" });

    c.set("project", project);
    await next();

    // Best-effort usage stamp; never block the response on it.
    void app.db
      .update(recordKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(recordKeys.id, project.recordKeyId))
      .catch(() => {});
  };
}
