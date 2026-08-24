import { fileURLToPath } from "node:url";
import { loadDotenv } from "./dotenv.ts";
import { applyMigrations } from "./migrator.ts";

loadDotenv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

try {
  await applyMigrations({
    url,
    ssl: process.env.DATABASE_SSL === "true",
    folder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  console.log("migrations applied");
} catch (error) {
  console.error("migration failed:", error);
  process.exitCode = 1;
}
