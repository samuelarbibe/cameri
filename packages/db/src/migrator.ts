import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { createDatabase } from "./client.ts";

/**
 * Arbitrary but fixed: an advisory lock key is only ever compared against
 * itself. Written as a literal so it is greppable if it ever collides with
 * another lock someone adds later.
 */
const MIGRATION_LOCK_ID = 5_741_920;

export interface MigrateOptions {
  url: string;
  ssl?: boolean;
  /** Absolute path to the generated SQL, i.e. `packages/db/drizzle`. */
  folder: string;
}

/**
 * Brings the database up to date, safely from more than one process.
 *
 * Every container runs this on boot, which means a rolling deploy of three
 * replicas runs it three times at once. Drizzle's migrator is not itself
 * concurrency-safe — two processes can both read an empty journal and both try
 * to create the same table — so the whole thing happens under a Postgres
 * advisory lock. The losers block, then find there is nothing left to do.
 *
 * The lock is session-scoped, which is why this opens its own single-connection
 * pool: with more than one connection, the unlock could land on a different
 * session than the lock and leave it held until the process exits.
 */
export async function applyMigrations({ url, ssl, folder }: MigrateOptions): Promise<void> {
  const { db, close } = createDatabase({ url, ssl, maxConnections: 1 });

  try {
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);
    try {
      await migrate(db, { migrationsFolder: folder });
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
    }
  } finally {
    await close();
  }
}
