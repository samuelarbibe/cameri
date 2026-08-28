# @camerihq/cli

Command line companion to [cameri](https://github.com/samuelarbibe/cameri), the
self-hostable Playwright reporter. It resolves the reporting environment once
and hands it to your test command, splits your shards by what each spec has
actually cost, and tells you what it detected when CI disagrees with you.

The package is scoped; the command it installs is not.

```sh
npm install -D @camerihq/cli
npx cameri --help
```

```
cameri run    run a command with the cameri variables resolved and injected
cameri shard  print the Playwright arguments for one shard, balanced by duration
cameri info   show what cameri detects about this environment
```

## `cameri run`

Wraps a command with the cameri variables resolved and injected:

```sh
cameri run -- npx playwright test --shard=1/4
```

```
-k, --key <recordKey>      project record key (or CAMERI_RECORD_KEY)
-s, --server <url>         server URL (or CAMERI_SERVER_URL)
    --run-key <key>        override the CI-derived run key
    --shard <index/total>  split the suite for this shard by duration — see below
    --shards <n>           total shards, when --shard=i/n is doing the splitting
```

The point of the wrapper is the run key. N shards have to agree on one value or
they become N separate runs, and resolving it here means every process in the
shard sees the same one — including any tooling you run alongside Playwright.
Without a record key or server URL it warns and runs your command anyway,
unreported.

It forwards the child's exit code and signals verbatim. A test wrapper that can
turn a red run green, or a green one red, is worse than no wrapper.

### `--shard`, and balanced sharding in one command

`--shard=3/8` gives a machine an eighth of the *files*. That is an eighth of the
*time* only if every file costs the same, and no suite works like that: one long
checkout journey among forty quick specs means the build takes as long as
whichever shard drew the long one, while the rest sit idle.

Hand the shard to cameri instead of to Playwright and it splits by measured
duration:

```diff
- npx playwright test --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL
+ cameri run --shard $CI_NODE_INDEX/$CI_NODE_TOTAL -- npx playwright test
```

It runs your command twice: once with `--list --reporter=json` appended to
discover what would run, then for real with the plan's files appended as
filters. Reporting is switched off for the discovery pass, so it cannot open a
run that never gets any results. `CAMERI_SHARD_INDEX` is set for you, the exit
code is still forwarded verbatim, and anything that stops a plan being made
falls back to Playwright's own `--shard=i/n`. The server decides the split the
same way for both forms — [how the split is chosen](#how-the-split-is-chosen).

Use `--shards <n>` instead when Playwright's own `--shard` is doing the
splitting: it tells the server how many shards to expect without changing how
the suite is divided.

The cost is that cameri decides how discovery is invoked. When that first call
should be yours — because it needs `--project`, `--grep`, or a config flag —
use `cameri shard`.

## `cameri shard`

The same split, with the discovery step handed back to you. It runs no tests and
spawns nothing: it reads a spec list on stdin, asks the server which of it
belongs to this machine, and prints Playwright arguments on stdout for you to
pass on:

```sh
LIST=$(npx playwright test --list --reporter=json)
SPECS=$(echo "$LIST" | cameri shard "$CI_NODE_INDEX/$CI_NODE_TOTAL") || exit 1

CAMERI_SHARD_INDEX=$CI_NODE_INDEX npx playwright test $SPECS
```

```
  npx playwright test --list  │  cameri shard 3/8  │  npx playwright test
       └─► 240 spec files          └─► 26 of them        └─► only those 26
             ▲                                                    ▲
             └─────────── you invoke Playwright, both times ───────┘
```

```
cameri shard <index/total>   which shard this is, e.g. 3/8

-k, --key <recordKey>        project record key (or CAMERI_RECORD_KEY)
-s, --server <url>           server URL (or CAMERI_SERVER_URL)
    --run-key <key>          override the CI-derived run key
```

Whatever narrowed the list narrows the plan, because the list is yours: pass
`--project=chromium` or `--grep @smoke` to the `--list` call and the plan covers
exactly what would have run. A plain newline-separated list of paths works too,
if something other than Playwright produced it.

Everything cameri prints about what it decided goes to **stderr**. stdout is the
arguments and nothing else, so it stays pipeable — `| xargs npx playwright test`
works as well as the `$(...)` above.

### The `|| exit 1` matters

Two failures are possible and they are not the same kind of thing.

When cameri cannot get a plan — no record key, an unreachable server, an empty
spec list, fewer spec files than shards — it prints `--shard=i/n`, says why on
stderr, and exits **0**. Your run still happens, split Playwright's way. A slow
planner is not a reason to fail a build.

When no answer is safe — a malformed shard, or a job whose total disagrees with
the plan the other jobs are using — it prints **nothing** and exits **1**. There
is no split it could name that would not either skip specs or run them twice.

That second case is why the `||` is not optional. `$(...)` discards the exit
code of what it runs, so `npx playwright test $(cameri shard 3/8)` on its own
would see an empty expansion, quietly run the *entire suite* on every machine,
and go green. Capture, check, then run. `xargs` has the same hole; `xargs -r`
closes it where your platform has it.

### How the split is chosen

The server weights each file by the median it took across the last 20 completed
runs, and packs the shards longest-file-first. A file it has never seen is
weighted at the median of the ones it has, so a batch of new specs cannot all
land on one machine. With no history at all — the first build on a new project —
it splits by count and says `even` on stderr, then has real numbers by the
second build.

The plan is stored under the run key, so eight machines starting at eight
different moments get one split rather than eight opinions. That is also why
every job must pass the same total, and why a job that disagrees is refused
rather than answered.

Set `CAMERI_SHARD_INDEX` when you invoke Playwright yourself. Playwright is not
being told about the shard any more, so it is what the reporter reads to tell
the machines apart; without it every one of them files results as shard 1.
`cameri run --shard` sets it for you, being the one invoking Playwright.

### On GitHub Actions

```yaml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    env:
      CAMERI_SERVER_URL: https://cameri.example.com
      CAMERI_RECORD_KEY: ${{ secrets.CAMERI_RECORD_KEY }}
      CAMERI_SHARD_INDEX: ${{ matrix.shard }}
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npx playwright install --with-deps

      - name: Run this shard
        run: |
          LIST=$(npx playwright test --list --reporter=json)
          SPECS=$(echo "$LIST" | npx cameri shard "${{ matrix.shard }}/4") || exit 1
          npx playwright test $SPECS
```

The run key is derived from the workflow run id, so all four jobs plan against
one split without being told about each other. The `4` has to match
`matrix.shard`'s length — a job that says `1/2` while its siblings say `i/4` is
refused rather than answered, which is the failure you want.

Planning and running are one step on purpose. The filters are newline-separated,
and `echo "SPECS=…" >> $GITHUB_ENV` only survives a single-line value, so
splitting this across two steps needs the heredoc form of `$GITHUB_ENV` and buys
nothing.

### Or let cameri drive

Where that first `--list` call does not need to be yours, the whole step
collapses to one line and the shell care goes with it:

```yaml
      - name: Run this shard
        run: npx cameri run --shard "${{ matrix.shard }}/4" -- npx playwright test
```

Same split and the same fallbacks — see
[`--shard`](#--shard-and-balanced-sharding-in-one-command) above. There is no
exit code to check because none is being discarded, and `CAMERI_SHARD_INDEX` can
come out of the job's `env`, since cameri sets it.

## `cameri info`

Prints what cameri makes of the current environment — server, whether a record
key is set, the run key it would use, the detected CI provider and build URL,
branch and commit. This is the first thing to run when a build reports into the
wrong run, or into no run at all.

```
api version  v1
server       https://cameri.example.com
record key   set
run key      gha-1234567890-1
ci provider  github-actions
build url    https://github.com/acme/app/actions/runs/1234567890
branch       feature/checkout
commit       8f2c1a9e77b3
```

Nothing is printed that would reveal the record key itself — only whether one
is there.

## Requirements

Node 20.10+. MIT licensed. Issues and discussion at
[samuelarbibe/cameri](https://github.com/samuelarbibe/cameri).
