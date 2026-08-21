# cameri

A smart, self-hostable Playwright test reporter.

Point your Playwright suite at a Cameri server and every run — across every CI
shard — lands in one place, with flake detection, failure clustering and
run-over-run test history.

## Layout

```
cameri/
├─ apps/
│  ├─ server/       Hono: REST ingest + tRPC dashboard API
│  └─ web/          Vite + React dashboard
└─ packages/
   ├─ reporter/     @cameri/playwright-reporter — runs in your CI
   ├─ cli/          cameri — wraps a Playwright run
   ├─ contract/     wire schemas shared by every client
   ├─ core/         flake detection, clustering, run aggregation
   └─ db/           Drizzle schema and migrations (PostgreSQL)
```

Two of these are published: `@cameri/playwright-reporter` and `cameri`. The rest
are internal and get bundled into whatever consumes them.

## Getting started

```sh
pnpm install
pnpm docker:up                     # postgres + minio
pnpm db:generate && pnpm db:migrate
pnpm --filter @cameri/server exec tsx src/scripts/bootstrap.ts "My App"
pnpm dev                           # server on :3000, web on :5173
```

`bootstrap` prints a record key once. Keep it — only its hash is stored.

## Environment

Create a `.env` at the repo root. `loadDotenv()` in `packages/db/src/dotenv.ts`
walks up to the workspace root reading `.env.local` then `.env` at each level,
and is called by the server, the migration runner and `drizzle.config.ts`. Real
environment variables always win, so the file is a no-op in CI and in
containers. The server validates the result on boot and refuses to start on
anything missing or malformed.

```sh
DATABASE_URL=postgres://cameri:cameri@localhost:5432/cameri
```

is the only required variable; everything else has a default.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | required |
| `DATABASE_SSL` | `false` | literal `true`/`false` |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST` | `0.0.0.0` | |
| `PORT` | `3000` | |
| `PUBLIC_URL` | `http://localhost:3000` | base for presigned upload URLs — must be reachable from wherever the tests run, not just from the server |
| `STORAGE_DRIVER` | `local` | `local` \| `s3` |
| `STORAGE_LOCAL_DIR` | `./.cameri-storage` | |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` | — | `s3` driver only |
| `RUN_STALE_MINUTES` | `120` | a run with no shard activity for this long is swept to `timedOut` |

The `local` storage driver hands out **unsigned** PUT URLs — anyone who can
reach the server can write to it. It exists so `pnpm dev` works without MinIO;
do not run it in production.

The reporter and CLI read their own variables: `CAMERI_URL`,
`CAMERI_RECORD_KEY`, `CAMERI_RUN_KEY` (overrides CI detection — every shard of
one logical run must agree on it) and `CAMERI_DISABLED`.

## Wiring up a suite

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ["list"],
    ["@cameri/playwright-reporter", { serverUrl: "https://cameri.internal" }],
  ],
});
```

```sh
CAMERI_RECORD_KEY=cam_... npx playwright test --shard=1/4
```

Reporting turns itself off when there is no server URL or record key, so the
same config works locally without ceremony. `npx cameri info` prints what it
detects about the current environment when CI disagrees with you.

## How a sharded run holds together

Playwright shards across N machines, so N reporters report into one logical run
and none of them knows when the build is done. The server owns that:

```
  shard 1 ─┐
  shard 2 ─┼─► POST /api/v1/runs ──► upsert on (project, run_key)
  shard 3 ─┤                          first one creates, rest join
  shard 4 ─┘
                    │
                    ▼
           POST /api/v1/results          (streamed in batches)
           PUT  presigned URL ──► object storage   (traces, videos)
                    │
                    ▼
           POST /api/v1/shards/complete
                    │
        last shard in ──► run status resolved
        or stale_at passes ──► swept to timedOut
```

The run key is derived from the CI build id — never from a hostname, pid or
timestamp — because every shard has to arrive at the same value independently.

## Two APIs, on purpose

| Surface | Style | Consumer | Stability |
|---|---|---|---|
| `/api/v1/*` | REST + zod | reporter, CLI | public, versioned |
| `/trpc/*` | tRPC | dashboard | internal, free to change |

The ingest API is called by reporters that may be months out of date, so it is
versioned and curl-debuggable. The dashboard API ships with the UI, so it gets
end-to-end inference and no version discipline at all.

Types follow the same split. Read models are generated from the Drizzle schema
and inferred through tRPC into the client, so nothing is hand-copied. The ingest
DTOs in `@cameri/contract` are hand-written, because a published wire format
must not shift every time a column does.

## Development

```sh
pnpm build          # turbo, respects the dependency graph
pnpm test           # node:test in packages/core
pnpm typecheck
pnpm changeset      # before releasing the published packages
```

### Node versions

Everything that *ships* — server, reporter, CLI — targets Node 20.10 and is
built with `target: "node20"`. CI runs the typecheck, tests and those builds on
both 20.10 and 22.

Two dev-only tools refuse to install below that line: `vite@8` wants
`^20.19.0 || >=22.12.0` and `@changesets/cli@3` wants `^22.11 || ^24 || >=26`.
Neither runs in production, so the web build gets its own Node 22 CI job rather
than dragging the runtime floor up. If you want contributors on plain 20.10,
downgrade to `vite@6`.

## Licence

MIT
