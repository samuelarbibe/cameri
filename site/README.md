# site

The landing page, served by GitHub Pages from this directory at
<https://samuelarbibe.github.io/cameri/>.

`index.html`, `styles.css` and a folder of PNGs. No build step on purpose: the
thing that has to keep working for the project to have a homepage should not be
a toolchain nobody is watching. `.github/workflows/pages.yml` uploads the
directory verbatim on every push to `main` that touches it.

To work on it, open `index.html` — or serve the folder if you want the relative
paths to behave exactly as they will in production:

```sh
python3 -m http.server -d site 8080
```

## Retaking the screenshots

The shots are committed, not generated in CI. Reproducing them needs a seeded
Postgres and a real Chromium, and a flaky capture should break on a laptop
rather than on the deploy that publishes the homepage.

Everything below runs against a **scratch database**. The seed deletes the
project it is about to write, so do not point it at anything you care about.

```sh
# 1. A database to throw away.
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml exec -T postgres \
  psql -U cameri -d postgres -c 'create database cameri_demo'

export DEMO_DB=postgres://cameri:cameri@localhost:5432/cameri_demo

# 2. Schema, then a month of plausible history.
DATABASE_URL=$DEMO_DB pnpm --filter @camerihq/db exec tsx src/migrate.ts
DATABASE_URL=$DEMO_DB pnpm --filter @camerihq/server exec tsx src/scripts/seed-demo.ts

# 3. Serve the built dashboard from the built server.
pnpm build
DATABASE_URL=$DEMO_DB PORT=3100 PUBLIC_URL=http://localhost:3100 \
WEB_DIST=apps/web/dist DB_MIGRATE_ON_BOOT=false NODE_ENV=production \
  node apps/server/dist/index.js &

# 4. Photograph it.
pnpm exec playwright install chromium
node --import tsx scripts/shoot-site-screenshots.mts
```

Both scripts are deterministic — the seed runs off a fixed PRNG seed and the
capture freezes every animation — so re-shooting one image does not turn into a
diff across all five. Relative timestamps ("6 hours ago") still move with the
wall clock, which is the one thing that will change if you run it tomorrow.

- [`apps/server/src/scripts/seed-demo.ts`](../apps/server/src/scripts/seed-demo.ts)
  — the demo project. Deliberately not a `tsup` entry, so it never ships in the
  image.
- [`scripts/shoot-site-screenshots.mts`](../scripts/shoot-site-screenshots.mts)
  — the capture. Picks which run, merge request and test to open by querying
  the API, rather than hard-coding ids that change on every reseed.

When you are done, drop the scratch database:

```sh
docker compose -f docker/docker-compose.yml exec -T postgres \
  psql -U cameri -d postgres -c 'drop database cameri_demo'
```
