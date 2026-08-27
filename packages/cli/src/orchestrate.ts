/**
 * Splitting a suite across shards by asking the server, instead of by counting.
 *
 * `--shard=3/8` gives every shard an eighth of the *files*, which is an eighth
 * of the *time* only if all files cost the same. The three steps here replace
 * that guess with a measurement: find out what would run, ask the server which
 * of it belongs to this machine, and hand Playwright that list.
 *
 * Every failure mode falls back to `--shard=i/n`. The server being slow, or
 * down, or new to this project must not be the reason a build fails — a
 * badly-balanced run is a far better outcome than no run.
 */
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanShardsRequest, PlanShardsResponse } from "@camerihq/contract";
import {
  CLIENT_VERSION_HEADER,
  INGEST_API_VERSION,
  RECORD_KEY_HEADER,
} from "@camerihq/contract/constants";

declare const __CAMERI_VERSION__: string;
const CLIENT_VERSION =
  typeof __CAMERI_VERSION__ === "string" ? __CAMERI_VERSION__ : "0.0.0-dev";

/**
 * Discovery loads every spec file in the repo, which on a large suite is not
 * instant. Generous, because the alternative to waiting is an unbalanced build.
 */
const LIST_TIMEOUT_MS = 120_000;
/** Planning is one small round trip; a slow one is not worth blocking CI for. */
const PLAN_TIMEOUT_MS = 15_000;

export interface Shard {
  /** 1-based, as in `--shard=index/total`. */
  index: number;
  total: number;
}

/** Parses `3/8`. Returns undefined for anything that is not a sane shard. */
export function parseShard(value: string): Shard | undefined {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
  if (!match) return undefined;

  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!index || !total || index > total) return undefined;
  return { index, total };
}

/**
 * Every spec file the given command would run, relative to Playwright's
 * `rootDir`.
 *
 * Runs the user's own command with `--list` appended, so whatever `--project`,
 * `--grep` or config path they passed narrows the list exactly as it will
 * narrow the real run. Appending also means our `--reporter=json` wins over
 * theirs, which is the point — the reporters they configured must not fire for
 * a discovery pass that runs no tests.
 */
export async function listSpecs(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string[] | undefined> {
  const [bin, ...args] = command;
  if (!bin) return undefined;

  const outFile = join(tmpdir(), `cameri-specs-${process.pid}-${Date.now()}.json`);

  try {
    const listed = await run(bin, [...args, "--list", "--reporter=json"], {
      ...env,
      // Sending the report to a file rather than reading stdout: a repo with a
      // `console.log` at config load time would otherwise put its output in
      // front of the JSON and there is no reliable way to tell them apart.
      PLAYWRIGHT_JSON_OUTPUT_NAME: outFile,
      // Reporting during discovery would open a run that never has any results.
      CAMERI_ENABLED: "0",
    });
    if (listed !== 0) return undefined;

    const specs = collectFiles(JSON.parse(await readFile(outFile, "utf8")) as unknown);
    return specs.length > 0 ? specs : undefined;
  } catch {
    return undefined;
  } finally {
    await rm(outFile, { force: true }).catch(() => {});
  }
}

export interface PlanRequest extends PlanShardsRequest {
  serverUrl: string;
  recordKey: string;
}

export type PlanResult =
  | { plan: PlanShardsResponse }
  /** Refused, and why. `fatal` means falling back would corrupt the run. */
  | { error: string; fatal: boolean }
  /** Unreachable, slow or broken. Say nothing much and shard the old way. */
  | undefined;

/** Asks the server for this shard's slice. */
export async function requestPlan(request: PlanRequest): Promise<PlanResult> {
  const { serverUrl, recordKey, ...body } = request;
  const url = `${serverUrl.replace(/\/+$/, "")}/api/${INGEST_API_VERSION}/runs/plan`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        [RECORD_KEY_HEADER]: recordKey,
        [CLIENT_VERSION_HEADER]: `cli/${CLIENT_VERSION}`,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) return { plan: (await response.json()) as PlanShardsResponse };

    // 4xx is the caller's fault and the body says which — a revoked key, or
    // shards that disagree about the total. 5xx is the server's problem and the
    // build should not have to care.
    if (response.status >= 400 && response.status < 500) {
      const detail = await response.json().catch(() => undefined);
      return {
        error: errorMessage(detail) ?? `plan rejected (${response.status})`,
        // 409 is shards disagreeing about how many of them there are. Falling
        // back would leave this machine sharding by one arithmetic while its
        // siblings shard by another, so some specs run twice and some never —
        // and the build would still go green. Stop instead.
        fatal: response.status === 409,
      };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The spec list as it arrives on stdin, from a `--list` the caller ran itself.
 *
 * Accepts Playwright's JSON report or a plain list of paths, one per line,
 * because the second is what anything other than Playwright would produce and
 * there is no reason to refuse it.
 */
export function parseSpecList(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];

  if (text.startsWith("{")) {
    try {
      return collectFiles(JSON.parse(text) as unknown);
    } catch {
      return [];
    }
  }

  return [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))].sort();
}

/** Drains stdin. Resolves empty when nothing is piped in. */
export async function readStdin(): Promise<string> {
  // A terminal means a human typed the command with no pipe, and waiting on
  // stdin there would look like a hang.
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export type ShardOutcome =
  /** A plan was made; `args` are the spec filters for this shard. */
  | { args: string[]; plan: PlanShardsResponse; specsSeen: number }
  /** Could not plan, but `--shard=i/n` is a safe answer. */
  | { args: string[]; reason: string }
  /** No answer is safe. The caller must not run the suite. */
  | { fatal: string };

export interface PlanConnection {
  serverUrl: string | undefined;
  recordKey: string | undefined;
  runKey: string;
}

/**
 * Turns a spec list into the arguments this shard should run with.
 *
 * The single decision point behind both `cameri run --shard` and `cameri shard`,
 * so the two cannot drift into disagreeing about what a shard should do. It
 * decides and reports; deciding what to *print* and whether to exit belongs to
 * the caller, which is the only one that knows whether stdout is a pipe.
 */
export async function planFor(
  shard: Shard,
  specs: readonly string[],
  conn: PlanConnection,
): Promise<ShardOutcome> {
  const staticShard = [`--shard=${shard.index}/${shard.total}`];

  if (!conn.recordKey || !conn.serverUrl) {
    return { args: staticShard, reason: "no record key or server URL" };
  }

  if (specs.length === 0) {
    return { args: staticShard, reason: "no spec list to split" };
  }

  // With fewer files than machines a balanced plan would hand some shard an
  // empty list, and a Playwright run with no file filter runs *everything*.
  // Playwright's own sharding already handles this case correctly.
  if (specs.length < shard.total) {
    return {
      args: staticShard,
      reason: `${specs.length} spec files across ${shard.total} shards`,
    };
  }

  const result = await requestPlan({
    serverUrl: conn.serverUrl,
    recordKey: conn.recordKey,
    runKey: conn.runKey,
    shardIndex: shard.index,
    expectedShards: shard.total,
    specs: [...specs],
  });

  if (!result) return { args: staticShard, reason: "could not reach the planner" };

  if ("error" in result) {
    // See `requestPlan`: falling back here is what produces a build that lies
    // about what it ran.
    if (result.fatal) return { fatal: result.error };
    return { args: staticShard, reason: result.error };
  }

  return {
    args: result.plan.specs.map(specFilter),
    plan: result.plan,
    specsSeen: specs.length,
  };
}

/**
 * Turns a spec path into something safe to pass to Playwright as a filter.
 *
 * Positional arguments are regular expressions matched against the file path,
 * not literal paths — so a repo with a directory called `app(v2)` would hand
 * Playwright a broken pattern, and an unescaped `.` quietly matches one
 * character more than it should. Anchored at the end so `a.spec.ts` cannot also
 * select `a.spec.ts.snap`.
 */
export function specFilter(spec: string): string {
  return `${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/**
 * Walks the JSON report's suite tree for spec file paths.
 *
 * Recursive rather than reading the top level, because the shape has changed
 * across Playwright versions — files have been root suites and have been nested
 * one level under a project suite. Collecting every `file` it can find and
 * de-duplicating is the version-proof reading.
 */
function collectFiles(report: unknown): string[] {
  const files = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    if (typeof record.file === "string" && record.file) files.add(record.file);
    walk(record.suites);
    walk(record.specs);
  };

  walk((report as { suites?: unknown }).suites);
  return [...files].sort();
}

function errorMessage(body: unknown): string | undefined {
  const message = (body as { error?: { message?: unknown } })?.error?.message;
  return typeof message === "string" ? message : undefined;
}

/** Spawns a child, discarding its output, and resolves with the exit code. */
function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | undefined> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env,
      stdio: "ignore",
      shell: process.platform === "win32",
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), LIST_TIMEOUT_MS);
    const finish = (code: number | undefined) => {
      clearTimeout(timer);
      resolve(code);
    };

    child.on("exit", (code) => finish(code ?? undefined));
    child.on("error", () => finish(undefined));
  });
}
