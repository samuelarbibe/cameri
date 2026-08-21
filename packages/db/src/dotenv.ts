import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "dotenv";

/**
 * Loads `.env` files for local development.
 *
 * Lives in this package because every entry point that needs a `DATABASE_URL`
 * — the server, the migrator, drizzle-kit, the bootstrap script — already
 * depends on it, and they all run from different working directories.
 *
 * Walks up from the current directory to the workspace root, so a repo-root
 * `.env` is found whether you run from the root or from inside a package.
 * Precedence, highest first:
 *
 *   1. real environment variables (CI sets these; nothing here overwrites them)
 *   2. the nearest `.env.local`, then `.env`
 *   3. the same pair at each parent, up to the workspace root
 *
 * Returns the files it actually read, which is worth logging when someone
 * insists their `.env` is being ignored.
 */
export function loadDotenv(cwd: string = process.cwd()): string[] {
  const loaded: string[] = [];
  let dir = resolve(cwd);

  for (;;) {
    // `.env.local` first: dotenv never overwrites an already-set key, so
    // whatever is read earliest wins.
    for (const name of [".env.local", ".env"]) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      config({ path: candidate, quiet: true });
      loaded.push(candidate);
    }

    if (existsSync(join(dir, "pnpm-workspace.yaml"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return loaded;
}
