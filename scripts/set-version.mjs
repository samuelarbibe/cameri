/**
 * Moves every released artifact to one version number.
 *
 *   node scripts/set-version.mjs patch|minor|major|1.2.3
 *
 * The current version is the highest `v*` tag, not anything in the working
 * tree: releases are cut by the workflow and never pushed back to `main`, so
 * the manifests here stay at 0.0.0 and get their real version written on the
 * way to the registry.
 *
 * The server image, the reporter and the CLI ship together and are versioned
 * together, so "which reporter goes with this image" is answered by reading
 * the two numbers. Nothing else in the workspace has a version worth having —
 * it is bundled into one of these three or it is not published at all.
 *
 * Prints the new version, which is how the release workflow learns it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RELEASED = ["apps/server", "packages/reporter", "packages/cli"];

const manifest = (dir) => join(root, dir, "package.json");

/**
 * The highest released version, or 0.0.0 if nothing has been released.
 *
 * Sorted by `v:refname`, so `v0.10.0` beats `v0.9.0` — a plain lexical sort
 * would get that backwards, and would do it silently.
 */
function currentVersion() {
  const tags = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return tags[0]?.slice(1) ?? "0.0.0";
}

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

const next = bump(currentVersion(), process.argv[2] ?? "patch");

for (const dir of RELEASED) {
  const pkg = JSON.parse(readFileSync(manifest(dir), "utf8"));
  pkg.version = next;
  // Trailing newline, so this does not show up as a whitespace change against
  // whatever wrote the file last.
  writeFileSync(manifest(dir), `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log(next);
