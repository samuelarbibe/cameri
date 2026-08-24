/**
 * Creates a project and prints a fresh record key.
 *
 * The plaintext key is shown exactly once — only its sha256 is stored — so
 * whatever this prints is the only copy.
 *
 *   pnpm --filter @camerihq/server exec tsx src/scripts/bootstrap.ts "My App"
 */
import { randomBytes } from "node:crypto";
import { projects, recordKeys } from "@camerihq/db";
import { loadDotenv } from "@camerihq/db/dotenv";
import { hashRecordKey } from "../auth.ts";
import { createContext } from "../context.ts";

loadDotenv();

const name = process.argv[2] ?? "Default";
const slug = name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

const context = createContext();

try {
  const [project] = await context.db
    .insert(projects)
    .values({ name, slug })
    .onConflictDoUpdate({ target: projects.slug, set: { name } })
    .returning();

  if (!project) throw new Error("could not create project");

  const raw = `cam_${randomBytes(24).toString("base64url")}`;
  await context.db.insert(recordKeys).values({
    projectId: project.id,
    name: "bootstrap",
    keyHash: hashRecordKey(raw),
  });

  console.log(`project   ${project.name} (${project.slug})`);
  console.log(`id        ${project.id}`);
  console.log(`record key (shown once):\n\n  ${raw}\n`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.close();
}
