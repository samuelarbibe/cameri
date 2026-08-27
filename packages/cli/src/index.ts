// The shebang is added by tsup's banner, not here — two of them is a syntax error.
import { spawn } from "node:child_process";
import {
  detectCiContext,
  detectGitContext,
  detectRunKey,
  localRunKey,
} from "@camerihq/contract/ci";
import { INGEST_API_VERSION } from "@camerihq/contract/constants";
import { Command } from "commander";
import pc from "picocolors";
import {
  listSpecs,
  parseShard,
  parseSpecList,
  planFor,
  readStdin,
  type Shard,
  type ShardOutcome,
} from "./orchestrate.ts";

declare const __CAMERI_VERSION__: string;
const VERSION =
  typeof __CAMERI_VERSION__ === "string" ? __CAMERI_VERSION__ : "0.0.0-dev";

const program = new Command();

program
  .name("cameri")
  .description("Run Playwright with Cameri reporting wired up")
  .version(VERSION);

program
  .command("run", { isDefault: true })
  .description("Run a command with Cameri env vars resolved and injected")
  .option("-k, --key <recordKey>", "project record key (or CAMERI_RECORD_KEY)")
  .option("-s, --server <url>", "Cameri server URL (or CAMERI_SERVER_URL)")
  .option("--run-key <key>", "override the CI-derived run key")
  .option(
    "--shard <index/total>",
    "let cameri split the suite for this shard, weighted by past durations",
  )
  .option(
    "--shards <n>",
    "total shards, when Playwright's own --shard is doing the splitting",
    Number.parseInt,
  )
  .argument("<command...>", "command to run, e.g. -- npx playwright test")
  .action(
    async (
      command: string[],
      options: {
        key?: string;
        server?: string;
        runKey?: string;
        shard?: string;
        shards?: number;
      },
    ) => {
      const recordKey = options.key ?? process.env.CAMERI_RECORD_KEY;
      const server = options.server ?? process.env.CAMERI_SERVER_URL;

      if (!recordKey || !server) {
        warn("no record key or server URL — running without reporting");
      }

      let shard: Shard | undefined;
      if (options.shard) {
        shard = parseShard(options.shard);
        // A typo here would otherwise mean a build that reports as one shard
        // while CI thinks it launched eight, which is a green run missing
        // seven eighths of its tests.
        if (!shard) {
          warn(`--shard must look like 3/8, not ${JSON.stringify(options.shard)}`);
          process.exit(1);
        }
      }

      // Resolved once here so every process in this shard agrees, and so the
      // value is visible in `cameri info` output when debugging CI.
      const runKey =
        options.runKey ??
        process.env.CAMERI_RUN_KEY ??
        detectRunKey() ??
        localRunKey();

      const expectedShards = shard?.total ?? options.shards;

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CAMERI_RUN_KEY: runKey,
        ...(recordKey ? { CAMERI_RECORD_KEY: recordKey } : {}),
        ...(server ? { CAMERI_SERVER_URL: server } : {}),
        ...(expectedShards
          ? { CAMERI_EXPECTED_SHARDS: String(expectedShards) }
          : {}),
        // Playwright is not being told about the shard when cameri splits the
        // suite, so the reporter cannot read the index off its config.
        ...(shard ? { CAMERI_SHARD_INDEX: String(shard.index) } : {}),
      };

      const [bin, ...args] = command;
      if (!bin) {
        warn("nothing to run");
        process.exit(1);
      }

      const finalArgs = shard
        ? [...args, ...(await resolveShardArgs(shard, { command, env, recordKey, server, runKey }))]
        : args;

      const child = spawn(bin, finalArgs, {
        stdio: "inherit",
        env,
        shell: process.platform === "win32",
      });

      // Forward the child's fate verbatim: the CLI must never turn a red test
      // run green, or a green one red.
      child.on("exit", (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 1);
      });
      child.on("error", (error) => {
        warn(`could not start ${bin}: ${error.message}`);
        process.exit(1);
      });
    },
  );

program
  .command("shard")
  .description("Print the Playwright arguments for one shard, for you to pass on")
  .argument("<index/total>", "which shard this is, e.g. 3/8")
  .option("-k, --key <recordKey>", "project record key (or CAMERI_RECORD_KEY)")
  .option("-s, --server <url>", "Cameri server URL (or CAMERI_SERVER_URL)")
  .option("--run-key <key>", "override the CI-derived run key")
  .action(
    async (
      value: string,
      options: { key?: string; server?: string; runKey?: string },
    ) => {
      const shard = parseShard(value);
      // Nothing is printed here, unlike the fallbacks below: a typo is not a
      // degraded split, it is an unanswerable question.
      if (!shard) {
        warn(`shard must look like 3/8, not ${JSON.stringify(value)}`);
        process.exit(1);
      }

      const specs = parseSpecList(await readStdin());
      if (specs.length === 0) {
        warn("no spec list on stdin — pipe `playwright test --list --reporter=json` in");
      }

      const outcome = await planFor(shard, specs, {
        serverUrl: options.server ?? process.env.CAMERI_SERVER_URL,
        recordKey: options.key ?? process.env.CAMERI_RECORD_KEY,
        runKey:
          options.runKey ??
          process.env.CAMERI_RUN_KEY ??
          detectRunKey() ??
          localRunKey(),
      });

      // Printing nothing and exiting 1 is the only safe answer, and it is only
      // safe if the caller checks: `$(cameri shard 3/8)` swallows the exit code,
      // and an empty expansion runs the whole suite on every machine. Hence the
      // `||` form in the docs.
      if ("fatal" in outcome) {
        warn(outcome.fatal);
        process.exit(1);
      }

      reportOutcome(shard, outcome);

      // Playwright is not being told about the shard, and unlike `cameri run`
      // this command cannot set the variable in the shell that will invoke it.
      if ("plan" in outcome && !process.env.CAMERI_SHARD_INDEX) {
        warn(`set CAMERI_SHARD_INDEX=${shard.index} so the reporter can tell the shards apart`);
      }

      // One per line, so both `$(...)` and `xargs` read it the way it is meant.
      console.log(outcome.args.join("\n"));
    },
  );

program
  .command("info")
  .description("Show what Cameri detects about this environment")
  .action(() => {
    const ci = detectCiContext();
    const git = detectGitContext();
    const runKey = process.env.CAMERI_RUN_KEY ?? detectRunKey();

    const rows: Array<[string, string]> = [
      ["api version", INGEST_API_VERSION],
      ["server", process.env.CAMERI_SERVER_URL ?? pc.dim("unset")],
      [
        "record key",
        process.env.CAMERI_RECORD_KEY ? pc.green("set") : pc.red("unset"),
      ],
      ["run key", runKey ?? pc.yellow("not detected (would use a local key)")],
      ["ci provider", ci.provider ?? "-"],
      ["build url", ci.buildUrl ?? "-"],
      ["branch", git.branch ?? "-"],
      ["commit", git.commitSha?.slice(0, 12) ?? "-"],
    ];

    const width = Math.max(...rows.map(([label]) => label.length));
    for (const [label, value] of rows) {
      console.log(`${pc.dim(label.padEnd(width))}  ${value}`);
    }
  });

interface ShardContext {
  command: string[];
  env: NodeJS.ProcessEnv;
  recordKey: string | undefined;
  server: string | undefined;
  runKey: string;
}

/**
 * Works out what to append to the test command so this machine runs its share.
 *
 * Either a list of spec filters the server chose, or `--shard=i/n` — the two
 * are mutually exclusive, and every path that cannot produce the former ends at
 * the latter. Only one thing here is worth failing the build over, and it is
 * flagged where it happens.
 */
async function resolveShardArgs(shard: Shard, ctx: ShardContext): Promise<string[]> {
  const staticShard = [`--shard=${shard.index}/${shard.total}`];

  if (!ctx.recordKey || !ctx.server) return staticShard;

  // Their `--shard` is an explicit instruction about how to split. Two splits
  // at once is not a thing, and theirs is the one they typed.
  if (ctx.command.some((arg) => arg === "--shard" || arg.startsWith("--shard="))) {
    warn("--shard passed to both cameri and the test command — leaving the split to Playwright");
    return staticShard;
  }

  const specs = await listSpecs(ctx.command, ctx.env);
  if (!specs) {
    warn("could not list specs — falling back to Playwright's own sharding");
    return staticShard;
  }

  const outcome = await planFor(shard, specs, {
    serverUrl: ctx.server,
    recordKey: ctx.recordKey,
    runKey: ctx.runKey,
  });

  if ("fatal" in outcome) {
    warn(outcome.fatal);
    process.exit(1);
  }

  reportOutcome(shard, outcome);
  return outcome.args;
}

/**
 * Says on stderr what was decided and why, for both shard commands.
 *
 * stderr rather than stdout without exception: under `cameri shard` stdout is
 * the arguments and nothing else, and a log line landing in it would be passed
 * to Playwright as a filter.
 */
function reportOutcome(shard: Shard, outcome: Exclude<ShardOutcome, { fatal: string }>): void {
  if (!("plan" in outcome)) {
    warn(`${outcome.reason} — leaving the split to Playwright`);
    return;
  }

  const { plan, specsSeen } = outcome;

  // Every shard is given a slice of the *first* shard's list. If this machine
  // is looking at a different set of files, some of its filters will match
  // nothing and some files will go unrun — usually a matrix where one job is on
  // a stale commit.
  if (!plan.specsMatch) {
    warn(
      `this shard sees ${specsSeen} spec files but the plan was built from ${plan.totalSpecs} — ` +
        "shards may be on different commits",
    );
  }

  const estimate = plan.estimatedMs > 0 ? `, ~${Math.round(plan.estimatedMs / 1000)}s` : "";
  console.error(
    `${pc.cyan("cameri")} shard ${shard.index}/${shard.total}: ${plan.specs.length} of ` +
      `${plan.totalSpecs} spec files (${plan.strategy}${estimate})`,
  );
}

function warn(message: string): void {
  console.error(`${pc.yellow("cameri")} ${message}`);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  warn(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
