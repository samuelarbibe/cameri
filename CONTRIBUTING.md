# Contributing

## Layout

```
cameri/
├─ apps/
│  ├─ server/       Hono: REST ingest + tRPC dashboard API + static web host
│  └─ web/          Vite + React dashboard
└─ packages/
   ├─ reporter/     @camerihq/playwright-reporter — runs in your CI
   ├─ cli/          cameri — wraps a Playwright run
   ├─ contract/     wire schemas shared by every client
   ├─ core/         flake detection, clustering, run aggregation
   └─ db/           Drizzle schema and migrations (PostgreSQL)
```

Two of these are published — `@camerihq/playwright-reporter` and `cameri`. The
rest are `private` and get bundled into whatever consumes them, rather than
shipped as packages nobody asked for.

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
pnpm changeset      # before releasing the published packages
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

| Package | Registry |
| --- | --- |
| `@camerihq/playwright-reporter` | npm |
| `cameri` (the CLI) | npm |
| the server image | `ghcr.io/samuelarbibe/cameri` |

Everything in the workspace lives under `@camerihq/`, published or not, so a
package that is one day worth shipping does not have to be renamed — and so
nothing internal can ever be published under a scope somebody else owns. The
`cameri` CLI is the one exception: unscoped, because `npx cameri` is the point
of it.

Describe a change with `pnpm changeset` and commit the file it writes. On
`main`, [`.github/workflows/release.yml`](.github/workflows/release.yml) keeps
a "Version Packages" pull request up to date with everything unreleased;
merging it bumps the versions, writes the changelogs and publishes. Nothing
goes to npm until that PR is merged, which makes the release a reviewed act
rather than a side effect of landing a commit.

The image needs no credentials — it pushes to GHCR with the workflow's own
token, tagged `main` and with the full commit sha, on every push.

### Trusted publishing

npm's trusted publishing exchanges a short-lived OIDC token for publish rights,
so there is no long-lived secret to leak or rotate, and provenance is attached
automatically. It can only be configured on a package that already exists,
which makes the first release a chicken-and-egg problem: it goes out
authenticated by an `NPM_TOKEN` secret, and everything after it does not.

Once `@camerihq/playwright-reporter` and `cameri` are on the registry, add a
trusted publisher to each on npmjs.com — repository `samuelarbibe/cameri`,
workflow `release.yml` (the filename is matched exactly, extension included) —
and then delete the `NODE_AUTH_TOKEN` and `NPM_CONFIG_PROVENANCE` lines from
`release.yml` and revoke the token. Nothing else changes: `id-token: write` is
already set, and the workflow upgrades npm because the one Node 22 ships
predates OIDC support.

Two things that will fail the exchange if they drift: `repository.url` in each
manifest must match the GitHub repository exactly, and only GitHub-hosted
runners are supported.
