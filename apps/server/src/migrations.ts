import { fileURLToPath } from "node:url";
import { applyMigrations } from "@camerihq/db";
import type { Env } from "./env.ts";

/**
 * The migrations as laid out in the repository.
 *
 * `src` and `dist` sit at the same depth, so one path serves both `tsx
 * src/index.ts` and the built bundle. The container image ships the SQL
 * somewhere else entirely and sets `MIGRATIONS_DIR`.
 */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));
}

/** Brings the database up to date. Concurrency-safe — see `applyMigrations`. */
export async function migrateToLatest(env: Env): Promise<void> {
  await applyMigrations({
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    folder: env.MIGRATIONS_DIR ?? defaultMigrationsDir(),
  });
}
