# cameri

A self-hostable Playwright reporter. Point your suite at a cameri server and
every run — across every CI shard — lands in one place, with flake detection,
failure clustering and run-over-run test history.

**[Screenshots and a quickstart →](https://samuelarbibe.github.io/cameri/)**

Two moving parts: a server you host, and a reporter you add to
`playwright.config.ts`.

```
   your CI                                   your infrastructure
 ┌───────────────┐                        ┌──────────────────────────┐
 │  playwright   │   results, live  ────► │  cameri            :3000 │
 │  + reporter   │   traces, videos ────► │   ├─ ingest API          │
 └───────────────┘                        │   ├─ dashboard           │
                                          │   └─ attachments  /data  │
                                          └────────────┬─────────────┘
                                                       ▼
                                                  PostgreSQL
```

Everything a run produces is written as it happens, so the dashboard is live
while the build is still going, not a report published at the end.

## Run the server

The image is `ghcr.io/samuelarbibe/cameri`. It holds both halves — the API and
the dashboard it serves — so a deployment is one container and one Postgres,
with no reverse proxy needed to put them back on the same origin.

Every release is tagged `latest`, `0.2`, `0.2.1` and by full commit sha. Pin to
whichever of those you are comfortable with; the image and the reporter share a
version number, so `0.2.1` on both means they were built and tested together.

```yaml
# compose.yml
services:
  cameri:
    image: ghcr.io/samuelarbibe/cameri:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://cameri:cameri@postgres:5432/cameri
      # Where this instance is reachable from outside. It goes into the upload
      # URLs handed to CI runners and into links posted on merge requests, so
      # `localhost` is right only while you are the only reader.
      PUBLIC_URL: https://cameri.example.com
      # `openssl rand -base64 32`. Signs upload URLs and encrypts integration
      # tokens. Skip it and the server still starts, but every outstanding
      # upload URL stops verifying at the next restart.
      CAMERI_ENCRYPTION_KEY: ${CAMERI_ENCRYPTION_KEY:?generate one}
      # Required before anyone can change a project's settings. Reading is
      # open; connecting a GitLab account is not.
      CAMERI_ADMIN_TOKEN: ${CAMERI_ADMIN_TOKEN:?generate one}
    volumes:
      # Attachment bytes on the default storage driver. Losing this volume
      # means losing every trace and video ever uploaded.
      - cameri-storage:/data

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: cameri
      POSTGRES_PASSWORD: cameri
      POSTGRES_DB: cameri
    volumes:
      - cameri-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cameri"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  cameri-storage:
  cameri-db:
```

```sh
docker compose up -d
docker compose exec cameri node dist/bootstrap.js "My App"
```

The dashboard is on `http://localhost:3000`, on the same port as the API.

`bootstrap` creates a project and prints a record key — that is what your CI
authenticates with. It is shown exactly once, because only its sha256 is
stored; if you lose it, create another from the dashboard rather than looking
for it.

### Upgrading

Pull a newer image and restart. The container applies pending migrations on
boot under a Postgres advisory lock, so rolling three replicas at once is three
processes racing to run the same SQL and only one of them winning. A migration
that fails is a container that never accepts traffic, rather than one serving
500s against a schema it does not understand.

Set `DB_MIGRATE_ON_BOOT=false` where a schema change has to be a scheduled,
reviewed act instead, and run it yourself when you mean to:

```sh
docker compose exec cameri node dist/migrate.js
```

## Point your suite at it

```sh
npm install -D @camerihq/playwright-reporter
```

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ["list"],
    ["@camerihq/playwright-reporter", { serverUrl: "https://cameri.example.com" }],
  ],
});
```

```sh
CAMERI_RECORD_KEY=cam_... npx playwright test --shard=1/4
```

Reporting turns itself off when there is no server URL or record key, so the
same config works on a laptop without ceremony — no second config, no
conditional in the file. Every option can also come from the environment
(`CAMERI_SERVER_URL`, `CAMERI_RECORD_KEY`, `CAMERI_ENABLED`, and more), which
is what lets the config stay committed and the credentials stay in CI. The full
list is in [`packages/reporter/README.md`](packages/reporter/README.md).

The reporter never fails your run and never holds it up: if cameri is
unreachable, the tests still decide the exit code.

### Sharded runs

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
           PUT  presigned URL ──► storage      (traces, videos)
                    │
                    ▼
           POST /api/v1/shards/complete
                    │
        last shard in ──► run status resolved
        or stale_at passes ──► swept to timedOut
```

The run key is what ties them together, and it is derived from the CI build id
— never from a hostname, pid or timestamp — because every shard has to arrive
at the same value independently. GitHub Actions, GitLab CI, CircleCI, Buildkite
and Jenkins are detected automatically. Anywhere else, set `CAMERI_RUN_KEY` to
something every shard of one build agrees on.

If a shard dies without reporting, the run does not hang: it is swept to
`timedOut` after `RUN_STALE_MINUTES` of silence.

[`@camerihq/cli`](packages/cli/README.md) is there for when detection is wrong
or a run spawns Playwright more than once — `npx cameri run -- playwright test`
resolves the environment once and injects it, and `npx cameri info` prints what
it detected.

### Balanced sharding

`--shard=3/8` splits the suite by file count, which balances the build only if
every file costs the same. Since cameri already knows what each spec has cost on
past runs, it can split by time instead:

```diff
- npx playwright test --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL
+ npx cameri run --shard $CI_NODE_INDEX/$CI_NODE_TOTAL -- npx playwright test
```

That one command discovers the specs, asks the server which of them belong to
this machine, and runs Playwright with the answer — setting `CAMERI_SHARD_INDEX`
so the shards can be told apart, and forwarding the exit code untouched. The
server weights each spec by its median over the last 20 completed runs and packs
longest-first, storing the result under the run key so every machine in the build
gets one split rather than its own. On a suite where one file dominates, the
difference is the whole point:

```
  by file count      shard 1 ▓▓▓░░░░░░░  28s
                     shard 2 ▓▓▓▓░░░░░░  37s
                     shard 3 ▓▓▓▓▓░░░░░  55s
                     shard 4 ▓▓▓▓▓▓▓▓▓▓ 108s   ◄── the build is this long

  by duration        shard 1 ▓▓▓▓▓▓▓▓░░  80s   ◄── one 80s spec; the floor
                     shard 2 ▓▓▓▓░░░░░░  46s
                     shard 3 ▓▓▓▓▓░░░░░  49s
                     shard 4 ▓▓▓▓▓░░░░░  53s
```

No history yet means an even split and real numbers by the next build. An
unreachable server, or anything else that stops a plan being made, falls back to
Playwright's own `--shard` rather than failing the build.

The cost of the one-liner is that your command runs twice — once with `--list`
appended to discover the specs, then for real — and cameri chooses how that
first call is made. To own it, `cameri shard` reads a spec list on stdin and
prints the filters for you to pass on:

```sh
LIST=$(npx playwright test --list --reporter=json)
SPECS=$(echo "$LIST" | npx cameri shard "$CI_NODE_INDEX/$CI_NODE_TOTAL") || exit 1

CAMERI_SHARD_INDEX=$CI_NODE_INDEX npx playwright test $SPECS
```

Whatever narrowed the list narrows the plan, so `--project` or `--grep` on the
`--list` call carries through. Keep the `|| exit 1`: a job whose shard total
disagrees with the rest of the build prints nothing and exits 1, and `$(...)`
throws that exit code away. Both forms, and every failure mode, are in the
[CLI README](packages/cli/README.md#cameri-shard).

## Storage

Attachment bytes never pass through the ingest API. A trace can be hundreds of
megabytes, and proxying forty shards' worth of them through the app server is
how you fall over — so clients get a presigned target and write straight to
storage.

**Local** (`STORAGE_DRIVER=local`, the default) writes to `STORAGE_LOCAL_DIR`,
which the image sets to `/data`, and serves the bytes back through the server's
own blob endpoint. Mount a volume there and back it up like anything else; it
grows with every trace you keep.

**S3** (`STORAGE_DRIVER=s3`) is not implemented yet — the server refuses to
start rather than pretending. The `S3_*` variables exist for it, and the
`Storage` interface is already presign-shaped, so the change is one driver.

Upload URLs are signed and expire after an hour, because `/api/v1/blobs/*`
would otherwise be an unauthenticated write to anyone who could reach the
server. The signing key comes from `CAMERI_ENCRYPTION_KEY`; with none set the
server generates one at boot, which is fine on a laptop but means outstanding
URLs stop verifying after a restart and never verify across two replicas.

Downloads are deliberately not signed. The Playwright trace viewer fetches them
cross-origin and uncredentialed, and every read path in cameri is open anyway
— that changes when the dashboard grows authentication, not before.

## Merge request comments

A project can be pointed at a GitLab instance from its settings page, after
which cameri posts one comment per merge request and rewrites it in place as
the run progresses, rather than adding a note per push.

The access token is encrypted with `CAMERI_ENCRYPTION_KEY` before it is stored,
and never leaves the server again — the dashboard only ever sees a hint of it.
Without an encryption key configured, cameri refuses to store the token at all
rather than keeping one it cannot protect.

Connecting one also needs `CAMERI_ADMIN_TOKEN`. Reading cameri is open — a test
report nobody can see is not a report — but storing a credential the server
will later spend is not something an anonymous visitor gets to do, so the
settings page asks for that token before it will accept a change. Generate one
the same way, and hold on to it:

```sh
CAMERI_ADMIN_TOKEN=$(node -e \
  "console.log(require('crypto').randomBytes(32).toString('base64url'))")
```

By default cameri will only connect an integration to a **public** address. A
self-hosted GitLab is usually on the private network the server is sitting in,
so name it explicitly and cameri will trust that host and no other:

```yaml
CAMERI_INTEGRATION_HOSTS: gitlab.internal,gitlab.example.com
```

That list is not decoration. Without it, an instance URL is a value someone
else typed that this server then connects to from inside your network — which
is a way to reach your metadata endpoint, not a feature.

## Configuration

`DATABASE_URL` is the only required variable; everything else has a default.
The server validates the lot on boot and refuses to start on anything missing
or malformed.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | required |
| `DATABASE_SSL` | `false` | literal `true`/`false` |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST` | `0.0.0.0` | |
| `PORT` | `3000` | |
| `PUBLIC_URL` | `http://localhost:3000` | where this instance is reachable from CI and from a browser — it is baked into upload URLs and posted links |
| `WEB_URL` | `http://localhost:5173` | where the dashboard lives, for links posted outside cameri. Defaults to `PUBLIC_URL` when `WEB_DIST` is set, which the image does |
| `WEB_DIST` | — | directory holding the built dashboard. Unset means API only |
| `DB_MIGRATE_ON_BOOT` | `true` | apply pending migrations at startup |
| `MIGRATIONS_DIR` | the repo's `packages/db/drizzle` | only needed when the SQL is not where the code expects it — the image sets it |
| `CAMERI_ENCRYPTION_KEY` | — | 32 bytes of base64. Signs upload URLs and encrypts integration tokens |
| `CAMERI_ADMIN_TOKEN` | — | shared secret required to change a project's settings. Unset means those calls are refused |
| `CAMERI_INTEGRATION_HOSTS` | — | comma-separated hosts an integration may point at. Unset means public addresses only |
| `STORAGE_DRIVER` | `local` | `local` \| `s3` |
| `STORAGE_LOCAL_DIR` | `./.cameri-storage` | `/data` in the image |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` | — | `s3` driver only, and not implemented yet |
| `RUN_STALE_MINUTES` | `120` | a run with no shard activity for this long is swept to `timedOut` |

Outside a container these can go in a `.env` at the root of wherever you are
running from; real environment variables always win, so the file is a no-op in
CI and in the image.

`/api/*`, `/trpc/*` and `/health` always win their paths against the dashboard,
so a mistyped API call gets a JSON 404 rather than a page of HTML. Hashed
assets are served `immutable`; `index.html` is `no-cache`, because a cached
shell pins a browser to a deployment that is gone.

## Running without Docker

```sh
pnpm install
pnpm build
DATABASE_URL=postgres://... \
WEB_DIST=apps/web/dist \
PUBLIC_URL=https://cameri.example.com \
  pnpm --filter @camerihq/server start
```

Point `WEB_DIST` at the built client and the API process serves it too, with a
fallback to `index.html` so client-side routes survive a reload. Leave it unset
and you get the API alone.

## Contributing

Development setup, the layout of the monorepo and how releases work are in
[CONTRIBUTING.md](CONTRIBUTING.md). The landing page and the seed-and-shoot
recipe behind its screenshots are in [`site/`](site/README.md).

## Licence

MIT
