/**
 * Moves every released artifact to one version number.
 *
 *   node scripts/set-version.mjs patch|minor|major|1.2.3
 *
 * The server image, the reporter and the CLI ship together and are versioned
 * together, so "which reporter goes with this image" is answered by reading
 * the two numbers. Nothing else in the workspace has a version worth having —
 * it is bundled into one of these three or it is not published at all.
 *
 * Prints the new version, which is how the release workflow learns it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RELEASED = ["apps/server", "packages/reporter", "packages/cli"];

/** The one that decides. The others are held to it. */
const SOURCE_OF_TRUTH = "apps/server";

const manifest = (dir) => join(root, dir, "package.json");
const read = (dir) => JSON.parse(readFileSync(manifest(dir), "utf8"));

function bump(current, how) {
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(how)) return how;

  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`cannot bump a non-semver version: ${current}`);
  }

  const [major, minor, patch] = parts;
  switch (how) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`expected patch, minor, major or an explicit version, got: ${how}`);
  }
}

const next = bump(read(SOURCE_OF_TRUTH).version, process.argv[2] ?? "patch");

for (const dir of RELEASED) {
  const pkg = read(dir);
  pkg.version = next;
  // Trailing newline, so this does not show up as a whitespace change against
  // whatever wrote the file last.
  writeFileSync(manifest(dir), `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log(next);
