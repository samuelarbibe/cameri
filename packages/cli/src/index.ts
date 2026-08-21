// The shebang is added by tsup's banner, not here — two of them is a syntax error.
import { spawn } from "node:child_process";
import {
  detectCiContext,
  detectGitContext,
  detectRunKey,
  localRunKey,
} from "@cameri/contract/ci";
import { INGEST_API_VERSION } from "@cameri/contract/constants";
import { Command } from "commander";
import pc from "picocolors";

declare const __CAMERI_VERSION__: string;
const VERSION = typeof __CAMERI_VERSION__ === "string" ? __CAMERI_VERSION__ : "0.0.0-dev";

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
  .option("--shards <n>", "total shards in this build", Number.parseInt)
  .argument("<command...>", "command to run, e.g. -- npx playwright test")
  .action(
    (
      command: string[],
      options: { key?: string; server?: string; runKey?: string; shards?: number },
    ) => {
      const recordKey = options.key ?? process.env.CAMERI_RECORD_KEY;
      const server = options.server ?? process.env.CAMERI_SERVER_URL;

      if (!recordKey || !server) {
        warn("no record key or server URL — running without reporting");
      }

      // Resolved once here so every process in this shard agrees, and so the
      // value is visible in `cameri info` output when debugging CI.
      const runKey =
        options.runKey ?? process.env.CAMERI_RUN_KEY ?? detectRunKey() ?? localRunKey();

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CAMERI_RUN_KEY: runKey,
        ...(recordKey ? { CAMERI_RECORD_KEY: recordKey } : {}),
        ...(server ? { CAMERI_SERVER_URL: server } : {}),
        ...(options.shards ? { CAMERI_EXPECTED_SHARDS: String(options.shards) } : {}),
      };

      const [bin, ...args] = command;
      if (!bin) {
        warn("nothing to run");
        process.exit(1);
      }

      const child = spawn(bin, args, { stdio: "inherit", env, shell: process.platform === "win32" });

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
  .command("info")
  .description("Show what Cameri detects about this environment")
  .action(() => {
    const ci = detectCiContext();
    const git = detectGitContext();
    const runKey = process.env.CAMERI_RUN_KEY ?? detectRunKey();

    const rows: Array<[string, string]> = [
      ["api version", INGEST_API_VERSION],
      ["server", process.env.CAMERI_SERVER_URL ?? pc.dim("unset")],
      ["record key", process.env.CAMERI_RECORD_KEY ? pc.green("set") : pc.red("unset")],
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

function warn(message: string): void {
  console.error(`${pc.yellow("cameri")} ${message}`);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  warn(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
