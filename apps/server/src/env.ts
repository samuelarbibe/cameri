import { z } from "zod";

/**
 * Sentinel for "nobody configured this". The Vite dev server is the right guess
 * while `pnpm dev` is the only way anyone runs cameri, and the wrong one the
 * moment this process is also serving the dashboard — see the transform below.
 */
const WEB_URL_DEFAULT = "http://localhost:5173";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Public origin, used to build absolute upload URLs. */
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  /**
   * Where the dashboard lives, for links posted outside cameri. Usually the
   * same origin as the API; in development the Vite server is on its own port.
   */
  WEB_URL: z.string().default(WEB_URL_DEFAULT),
  /**
   * Directory holding the built dashboard (`apps/web/dist`). Unset means API
   * only, which is what `pnpm dev` wants: Vite serves the app there and proxies
   * back here. The container image sets it.
   */
  WEB_DIST: z.string().optional(),
  /**
   * Apply pending migrations at startup.
   *
   * On by default: a self-hosted deployment that has to remember a separate
   * migrate step before every upgrade is a deployment that will one day boot
   * against a schema it does not understand. Set `false` where a migration is
   * a reviewed, scheduled act.
   */
  DB_MIGRATE_ON_BOOT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Where the generated SQL lives. The default resolves inside the repo. */
  MIGRATIONS_DIR: z.string().optional(),
  /**
   * 32 bytes of base64. Required only to configure an integration — without it
   * cameri simply refuses to store an outbound credential rather than storing
   * one it cannot protect.
   */
  CAMERI_ENCRYPTION_KEY: z.string().optional(),
  /**
   * Shared secret for the handful of dashboard calls that change something.
   *
   * Reading cameri is open by design — a test report nobody can see is not a
   * report. Writing is not: connecting a GitLab account stores a credential
   * this server will later spend, so it asks who is calling. Unset means those
   * routes are refused outright rather than left open.
   */
  CAMERI_ADMIN_TOKEN: z.string().min(16).optional(),
  /**
   * Hostnames an integration may point at, comma separated.
   *
   * Unset, cameri will only connect to a public address, which is right for
   * gitlab.com and stops the server being used to reach things the caller
   * cannot. Naming your own instance here is what makes a GitLab on a private
   * network reachable — see `integrations/url-guard.ts`.
   */
  CAMERI_INTEGRATION_HOSTS: z.string().optional(),
  /** Where attachment bytes land. `local` is for development only. */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./.cameri-storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  /** A run with no shard activity for this long is swept to `timedOut`. */
  RUN_STALE_MINUTES: z.coerce.number().int().positive().default(120),
});

/**
 * One origin when this process serves both halves.
 *
 * Left alone, a single-container deployment would post merge request comments
 * linking to `localhost:5173` — a dead link on everyone's machine but the
 * developer who wrote it.
 */
function collapseWebUrl(env: z.infer<typeof envSchema>): z.infer<typeof envSchema> {
  if (!env.WEB_DIST || env.WEB_URL !== WEB_URL_DEFAULT) return env;
  return { ...env, WEB_URL: env.PUBLIC_URL };
}

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return collapseWebUrl(parsed.data);
}
