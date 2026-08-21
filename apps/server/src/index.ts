import { serve } from "@hono/node-server";
import { loadDotenv } from "@cameri/db/dotenv";
import { createApp } from "./app.ts";
import { createContext } from "./context.ts";
import { loadEnv } from "./env.ts";

// Local development convenience. Real environment variables always win, so
// this is a no-op in CI and in containers.
const envFiles = loadDotenv();

const env = loadEnv();
if (envFiles.length > 0 && env.NODE_ENV === "development") {
  console.log(`loaded ${envFiles.join(", ")}`);
}
const context = createContext(env);
const app = createApp(context);

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`cameri server listening on http://${env.HOST}:${info.port}`);
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
