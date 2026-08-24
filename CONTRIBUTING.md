# Contributing

## Layout

```
cameri/
├─ apps/
│  ├─ server/       Hono: REST ingest + tRPC dashboard API + static web host
│  └─ web/          Vite + React dashboard
└─ packages/
   ├─ reporter/     @camerihq/playwright-reporter — runs in your CI
   ├─ cli/          @camerihq/cli — wraps a Playwright run
   ├─ contract/     wire schemas shared by every client
   ├─ core/         flake detection, clustering, run aggregation
   └─ db/           Drizzle schema and migrations (PostgreSQL)
```

Two of these are published — `@camerihq/playwright-reporter` and
`@camerihq/cli`. The rest are `private` and get bundled into whatever consumes
them, rather than shipped as packages nobody asked for.

## Getting started

```sh
pnpm install
pnpm docker:up                     # postgres + minio
pnpm db:generate && pnpm db:migrate
pnpm --filter @camerihq/server exec tsx src/scripts/bootstrap.ts "My App"
pnpm dev                           # server on :3000, web on :5173
```

`bootstrap` prints a record key once. Keep it — only its hash is stored.

Configuration goes in a `.env` at the repo root. `loadDotenv()` in
`packages/db/src/dotenv.ts` walks up to the workspace root reading `.env.local`
then `.env` at each level, and is called by the server, the migration runner
and `drizzle.config.ts`. Real environment variables always win, so the file is
a no-op in CI and in containers. The variables themselves are documented in the
[README](README.md#configuration).

```sh
pnpm build          # turbo, respects the dependency graph
pnpm test           # node:test in packages/core
pnpm typecheck
```

To exercise the container rather than the source:

```sh
docker compose -f docker/docker-compose.yml --profile app up -d --build
```

The app service sits behind the `app` profile, so a plain `pnpm docker:up`
still brings up only the backing services for `pnpm dev`. It reads
`docker/.env`, next to the compose file, for `CAMERI_ENCRYPTION_KEY`,
`CAMERI_PUBLIC_URL` and `CAMERI_PORT`.

## Two APIs, on purpose

| Surface | Style | Consumer | Stability |
|---|---|---|---|
| `/api/v1/*` | REST + zod | reporter, CLI | public, versioned |
| `/trpc/*` | tRPC | dashboard | internal, free to change |

The ingest API is called by reporters that may be months out of date, so it is
versioned and curl-debuggable. The dashboard API ships with the UI, so it gets
end-to-end inference and no version discipline at all.

Types follow the same split. Read models are generated from the Drizzle schema
and inferred through tRPC into the client, so nothing is hand-copied. The
ingest DTOs in `@camerihq/contract` are hand-written, because a published wire
format must not shift every time a column does.

## Node versions

Everything that *ships* — server, reporter, CLI — targets Node 20.10 and is
built with `target: "node20"`. CI runs the typecheck, tests and those builds on
both 20.10 and 22.

Two dev-only tools refuse to install below that line: `vite@8` wants
`^20.19.0 || >=22.12.0` and `@changesets/cli@3` wants `^22.11 || ^24 || >=26`.
Neither runs in production, so the web build gets its own Node 22 CI job rather
than dragging the runtime floor up. If you want contributors on plain 20.10,
downgrade to `vite@6`.

## Releasing

| Artifact | Where it lands |
| --- | --- |
| `@camerihq/playwright-reporter` | npm |
| `@camerihq/cli` | npm |
| the server image | `ghcr.io/samuelarbibe/cameri` |

Releasing is a decision, not a consequence of merging. Push to `main` as often
as you like and nothing ships; when you want a release, run the workflow:

```sh
gh workflow run release.yml -f version=minor
```

or hit **Run workflow** on the Actions tab and pick `patch`, `minor`, `major`
or an explicit version. [`.github/workflows/release.yml`](.github/workflows/release.yml)
is four jobs, and nothing ships unless the one in front of it passed:

```
  test ─────► the same suite pull requests run, unchanged
    │
    ▼
  publish ──► set-version.mjs: one number across server, reporter and CLI
    │         pnpm publish -r ──► npm, authenticated by OIDC
    │         tag vX.Y.Z
    ▼
  image ────► buildx ──► ghcr.io, tagged latest / X.Y / X.Y.Z / sha
    │
    ▼
  announce ─► gh release create --generate-notes
```

`test` is [`test.yml`](.github/workflows/test.yml), called as a reusable
workflow by both this and [`ci.yml`](.github/workflows/ci.yml), so a release
runs exactly what a pull request runs — including the Docker build — rather
than a second definition of "the tests" that drifts from the first.

The release notes are generated from the pull requests merged since the last
tag, which is the changelog nobody has to remember to write. Squash-merge with
a sensible PR title and it reads properly.

### Where the version lives

In the tags, and nowhere else. The three released manifests sit at `0.0.0` in
the working tree; `set-version.mjs` reads the highest `v*` tag, computes the
next one and writes it into them on the runner, minutes before they are
published. Nothing is committed and `main` never receives a push from CI.

That is not only tidier — it is what makes required status checks possible at
all. A required check blocks a direct push exactly as it blocks a merge, and
the version commit would be a brand new commit with no checks against it. The
usual answer is to let the GitHub Actions app bypass the ruleset, but bypass
actors of that type are only available to organisation-owned repositories.
Tagging sidesteps the whole question: the ruleset targets branches, so pushing
a tag is not something it has an opinion about.

### Protecting `main`

The checks that gate a pull request are `test / check (20.10)`,
`test / check (22)`, `test / web` and `test / image`. They are declared in a
repository ruleset on the default branch; the names have to match the job
names in `test.yml`, prefixed with the calling job's id, so renaming a job
there quietly stops gating anything until the ruleset is updated too.

The three released artifacts share one version, set by
[`scripts/set-version.mjs`](scripts/set-version.mjs). A server-only change
still bumps the reporter, and that is the point: "which reporter goes with this
image" is answered by reading the two numbers. Everything else in the workspace
is `private` and unversioned — it is bundled into one of the three or it is not
published at all.

`pnpm publish -r` picks up exactly the packages that are not `private`, so
adding a fourth published package is a matter of dropping the `private` flag
and adding its directory to `RELEASED` in the version script. It has to be
`pnpm publish` and not `npm publish`: the manifests carry `workspace:*`, and
only pnpm rewrites that into a real version on the way out. The publish itself
is still delegated to the npm binary on `PATH`, which is why the workflow
upgrades npm first.

Pull requests build the image without pushing it, so a break in the Dockerfile
shows up before it lands rather than during a release.

### Trusted publishing

There is no npm token anywhere in this repository, and there should never be
one. npm's trusted publishing exchanges the workflow's short-lived OIDC token
for publish rights, and attaches provenance — a signed, verifiable link from
the tarball back to the run that built it — automatically.

Five things have to line up, and the failure mode for each is the same
unhelpful authentication error:

- `id-token: write` on the job.
- The trusted publisher on npmjs.com naming repository `samuelarbibe/cameri`
  and workflow `release.yml` — the filename is matched exactly, extension
  included, so renaming this file breaks publishing until npm is told.
- `repository.url` in each published manifest matching the GitHub repository.
- npm 11.5.1 or newer. Node 22 ships npm 10, which has no OIDC support at all,
  which is why the workflow upgrades it before publishing.
- **No `registry-url` on `actions/setup-node`.** It looks harmless and it is
  not: with `registry-url` set, setup-node always writes an `.npmrc` containing
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`, and with no token
  supplied it fills in the literal placeholder `XXXXX-XXXXX-XXXXX-XXXXX`. npm
  then believes it is authenticated, never attempts the OIDC exchange, and the
  registry rejects the bogus credential with `404 Not Found` — not 403, because
  it will not confirm a package exists to someone who cannot write to it.

A trusted publisher can only be configured on a package that already exists, so
a brand new package name has to be published once by hand — `npm login && pnpm
--filter <name> publish --access public` — before the workflow can take it
over. Only GitHub-hosted runners are supported.
