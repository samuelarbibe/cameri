import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

export type Database = ReturnType<typeof createDatabase>["db"];

export interface DatabaseOptions {
  url: string;
  /** Keep this modest: every CI shard holds a connection while it reports. */
  maxConnections?: number;
  ssl?: boolean;
}

export function createDatabase({ url, maxConnections = 10, ssl = false }: DatabaseOptions) {
  const pool = new Pool({
    connectionString: url,
    max: maxConnections,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });

  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
