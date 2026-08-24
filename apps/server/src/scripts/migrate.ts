/**
 * Applies pending migrations and exits.
 *
 * Only needed where `DB_MIGRATE_ON_BOOT=false` has made a schema change a
 * scheduled act rather than something the container does on its way up. It
 * ships in the image because that is the one place with no `tsx` and no source
 * to point it at:
 *
 *   docker exec cameri node dist/migrate.js
 */
import { loadDotenv } from "@camerihq/db/dotenv";
import { loadEnv } from "../env.ts";
import { migrateToLatest } from "../migrations.ts";

loadDotenv();

try {
  await migrateToLatest(loadEnv());
  console.log("database is up to date");
} catch (error) {
  console.error("migration failed:", error);
  process.exitCode = 1;
}
