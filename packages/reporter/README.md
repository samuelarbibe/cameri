# @camerihq/playwright-reporter

Streams Playwright results to a [cameri](https://github.com/samuelarbibe/cameri)
server while the run is still going — live shard progress, per-attempt steps,
errors and attachments, and a run status that survives sharding.

```sh
npm install --save-dev @camerihq/playwright-reporter
```

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

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
same config works on a laptop without ceremony — and says why, once, rather
than being a silent no-op.

## Options

Every option has an environment variable, and **the environment wins**: the
config file is committed, and CI is where the secrets and per-build values are.

| Option | Variable | Default | |
| --- | --- | --- | --- |
| `serverUrl` | `CAMERI_SERVER_URL` | — | base URL of your cameri server |
| `recordKey` | `CAMERI_RECORD_KEY` | — | project record key |
| `runKey` | `CAMERI_RUN_KEY` | derived from CI | what makes N shards one run — see below |
| `expectedShards` | `CAMERI_EXPECTED_SHARDS` | Playwright's `--shard` total | |
| `enabled` | `CAMERI_ENABLED` | on when the URL and key are both set | |
| `batchSize` | `CAMERI_BATCH_SIZE` | `50` | attempts buffered before a flush |
| `flushIntervalMs` | `CAMERI_FLUSH_INTERVAL_MS` | `2000` | longest a result waits to be sent |
| `timeoutMs` | `CAMERI_TIMEOUT_MS` | `15000` | per request |
| `maxRetries` | `CAMERI_MAX_RETRIES` | `3` | attempts per batch before giving up on it |
| `debug` | `CAMERI_DEBUG` | `false` | logs what it is doing |

## Sharded runs

Playwright shards across N machines and no shard knows when the build is
finished, so the run key is what ties them together: every shard of one build
must send the same one. It is derived from the CI environment — the pipeline or
workflow run id — which is right on GitHub Actions, GitLab CI, CircleCI,
Buildkite and Jenkins without configuration.

Where the detection is wrong, set `CAMERI_RUN_KEY` yourself to anything stable
across the build. Off CI it falls back to a per-invocation local key, so two
`playwright test` runs on your machine stay two runs.

The server closes the run when the last shard reports in, or sweeps it to
`timedOut` if a machine dies mid-run.

## What gets sent

Results stream in batches as tests finish rather than in one payload at the end,
which is what makes a dashboard watching a live run useful. Each attempt carries
its status, timings, errors with stacks and snippets, the step tree, tags,
annotations, and stdout/stderr — capped, so a chatty test cannot push a megabyte
per attempt.

File attachments — traces, screenshots, videos — are uploaded directly to
storage against short-lived URLs the server hands out. The bytes never pass
through the API. Inline attachment bodies are skipped.

## Two rules it will not break

**It will never fail your run.** Anything that throws inside a reporter hook is
caught, logged once, and reporting switches off for the rest of the run. A
dashboard being down must not turn a green build red.

**It will not hold your run up.** Batches flush on a serialized chain that
overlaps with test execution, and the flush timer is `unref`d so a pending send
is never what keeps Node alive after the tests are done.

## Requirements

Node 20.10+, Playwright 1.40+. Ships ESM and CJS, so it works whichever flavour
your `playwright.config` is.

MIT licensed. Issues and discussion at
[samuelarbibe/cameri](https://github.com/samuelarbibe/cameri).
