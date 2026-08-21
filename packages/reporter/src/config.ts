export interface CameriReporterOptions {
  /** Base URL of the Cameri server, e.g. https://cameri.internal. */
  serverUrl?: string;
  /** Project record key. Falls back to CAMERI_RECORD_KEY. */
  recordKey?: string;
  /** Overrides the CI-derived run key. All shards of a build must agree on it. */
  runKey?: string;
  /** Total shards in this build. Falls back to Playwright's own shard config. */
  expectedShards?: number;
  /** Explicitly turn reporting off without editing the config. */
  enabled?: boolean;
  /** Results are flushed once this many attempts are buffered. */
  batchSize?: number;
  /**
   * Longest a buffered attempt waits before being sent even if the batch is not
   * full. This is what makes a live dashboard live: without it a slow suite
   * would sit on its "running" markers until 50 tests had come and gone.
   */
  flushIntervalMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts per request before giving up on that batch. */
  maxRetries?: number;
  debug?: boolean;
}

export interface ResolvedConfig {
  serverUrl: string;
  recordKey: string;
  runKey: string | undefined;
  expectedShards: number | undefined;
  enabled: boolean;
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
  maxRetries: number;
  debug: boolean;
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value !== "0" && value.toLowerCase() !== "false";
}

function envInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Env wins over inline options, because the config file is committed and the
 * env is where CI puts secrets and per-build values.
 */
export function resolveConfig(options: CameriReporterOptions = {}): ResolvedConfig {
  const env = process.env;
  const serverUrl = (env.CAMERI_SERVER_URL ?? options.serverUrl ?? "").replace(/\/+$/, "");
  const recordKey = env.CAMERI_RECORD_KEY ?? options.recordKey ?? "";

  const explicitlyEnabled = envBool(env.CAMERI_ENABLED) ?? options.enabled;
  const enabled = explicitlyEnabled ?? Boolean(serverUrl && recordKey);

  return {
    serverUrl,
    recordKey,
    runKey: env.CAMERI_RUN_KEY ?? options.runKey,
    expectedShards: envInt(env.CAMERI_EXPECTED_SHARDS) ?? options.expectedShards,
    enabled,
    batchSize: envInt(env.CAMERI_BATCH_SIZE) ?? options.batchSize ?? 50,
    flushIntervalMs: envInt(env.CAMERI_FLUSH_INTERVAL_MS) ?? options.flushIntervalMs ?? 2_000,
    timeoutMs: envInt(env.CAMERI_TIMEOUT_MS) ?? options.timeoutMs ?? 15_000,
    maxRetries: envInt(env.CAMERI_MAX_RETRIES) ?? options.maxRetries ?? 3,
    debug: envBool(env.CAMERI_DEBUG) ?? options.debug ?? false,
  };
}

/** Explains why reporting is off, so users are not left guessing at a silent no-op. */
export function describeDisabled(config: ResolvedConfig): string | undefined {
  if (config.enabled) return undefined;
  if (!config.serverUrl) return "no server URL (set CAMERI_SERVER_URL)";
  if (!config.recordKey) return "no record key (set CAMERI_RECORD_KEY)";
  return "disabled via CAMERI_ENABLED";
}
