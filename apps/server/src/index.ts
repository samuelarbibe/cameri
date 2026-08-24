import { serve } from "@hono/node-server";
import { loadDotenv } from "@camerihq/db/dotenv";
import { createApp } from "./app.ts";
import { createContext } from "./context.ts";
import { loadEnv } from "./env.ts";
import { migrateToLatest } from "./migrations.ts";

// Local development convenience. Real environment variables always win, so
// this is a no-op in CI and in containers.
const envFiles = loadDotenv();

const env = loadEnv();
if (envFiles.length > 0 && env.NODE_ENV === "development") {
  console.log(`loaded ${envFiles.join(", ")}`);
}
if (env.DB_MIGRATE_ON_BOOT) {
  // Before the context, so the pool is never opened against a schema that is
  // about to change underneath it — and before `serve`, so a failed migration
  // is a container that never accepts traffic rather than one that serves 500s.
  await migrateToLatest(env);
  console.log("database is up to date");
}

const context = createContext(env);
const app = createApp(context);

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`cameri server listening on http://${env.HOST}:${info.port}`);
  console.log(
    env.WEB_DIST
      ? `serving the dashboard from ${env.WEB_DIST}`
      : "no WEB_DIST set — API only, no dashboard on this port",
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, draining`);
  server.close();
  await context.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { createApp, createContext };
export type { AppRouter } from "./trpc/router.ts";
