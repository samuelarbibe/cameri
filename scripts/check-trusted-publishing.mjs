/**
 * Runs npm's trusted-publishing handshake for every published package, and
 * fails with the reason if any of them cannot get a token.
 *
 *   node scripts/check-trusted-publishing.mjs
 *
 * This exists because `oidc()` in the npm CLI is written never to throw: every
 * failure path — no id-token permission, a refused exchange, a package with no
 * trusted publisher — logs at `silly` and returns undefined, after which npm
 * carries on unauthenticated and dies with `ENEEDAUTH`. That error names
 * nothing and points nowhere, and it looks identical whichever of the five
 * preconditions in CONTRIBUTING.md is the one that slipped.
 *
 * So we do the same two requests here, first, and print what the registry
 * actually said. Nothing is kept: the token is discarded and `pnpm publish`
 * gets its own moments later. This is a check, not an authentication step.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASED = ["apps/server", "packages/reporter", "packages/cli"];
const REGISTRY = "https://registry.npmjs.org";

const published = RELEASED.map((dir) =>
  JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")),
).filter((pkg) => !pkg.private);

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/**
 * The workflow's OIDC token, for npm's audience.
 *
 * The two request variables only exist when the job has `id-token: write`.
 * Their absence is the single most common cause, and npm reports it by saying
 * nothing at all.
 */
async function idToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!url || !token) {
    die(
      "No OIDC token available: ACTIONS_ID_TOKEN_REQUEST_URL and\n" +
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN are not set. The job needs\n" +
        "`permissions: id-token: write`.",
    );
  }

  const audience = `npm:${new URL(REGISTRY).hostname}`;
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    die(`GitHub refused to mint an id_token: ${response.status} ${await response.text()}`);
  }

  return (await response.json()).value;
}

/** The claims npm matches a trusted publisher against. */
function claims(jwt) {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  return {
    repository: payload.repository,
    job_workflow_ref: payload.job_workflow_ref,
    environment: payload.environment ?? "(none)",
    repository_visibility: payload.repository_visibility,
  };
}

async function exchange(jwt, name) {
  const response = await fetch(
    `${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`,
    { method: "POST", headers: { Authorization: `Bearer ${jwt}` } },
  );

  if (response.ok) return null;
  const body = await response.text();
  return `${response.status} ${body}`;
}

const jwt = await idToken();
console.log("id_token claims:", JSON.stringify(claims(jwt), null, 2));

const failures = [];
for (const pkg of published) {
  const error = await exchange(jwt, pkg.name);
  console.log(error ? `✗ ${pkg.name}: ${error}` : `✓ ${pkg.name}`);
  if (error) failures.push(pkg.name);
}

if (failures.length > 0) {
  die(
    `npm will not issue a publish token for: ${failures.join(", ")}.\n\n` +
      "Trusted publishing is configured per package, not per account, at\n" +
      "https://www.npmjs.com/package/<name>/access. The repository, the\n" +
      "workflow filename and the environment all have to match the claims\n" +
      "above exactly — and `environment` is only in the token at all if the\n" +
      "job declares one.\n\n" +
      "`package not found` there means no publisher matched, not that the\n" +
      "package is missing — the registry will not tell an unauthorised caller\n" +
      "which of the two it is.",
  );
}
