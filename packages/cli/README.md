# cameri

Command line companion to [cameri](https://github.com/samuelarbibe/cameri), the
self-hostable Playwright reporter. It resolves the reporting environment once
and hands it to your test command, and tells you what it detected when CI
disagrees with you.

```sh
npx cameri --help
```

## `cameri run`

Wraps a command with the cameri variables resolved and injected:

```sh
cameri run -- npx playwright test --shard=1/4
```

```
-k, --key <recordKey>   project record key (or CAMERI_RECORD_KEY)
-s, --server <url>      server URL (or CAMERI_SERVER_URL)
    --run-key <key>     override the CI-derived run key
    --shards <n>        total shards in this build
```

The point of the wrapper is the run key. N shards have to agree on one value or
they become N separate runs, and resolving it here means every process in the
shard sees the same one — including any tooling you run alongside Playwright.
Without a record key or server URL it warns and runs your command anyway,
unreported.

It forwards the child's exit code and signals verbatim. A test wrapper that can
turn a red run green, or a green one red, is worse than no wrapper.

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
