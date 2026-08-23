import { z } from "zod";

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
  WEB_URL: z.string().default("http://localhost:5173"),
  /**
   * 32 bytes of base64. Required only to configure an integration — without it
   * cameri simply refuses to store an outbound credential rather than storing
   * one it cannot protect.
   */
  CAMERI_ENCRYPTION_KEY: z.string().optional(),
  /** Where attachment bytes land. `local` is for development only. */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./.cameri-storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  /** A run with no shard activity for this long is swept to `timedOut`. */
  RUN_STALE_MINUTES: z.coerce.number().int().positive().default(120),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
