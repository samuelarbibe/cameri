import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { ZodError } from "zod";
import type { AppContext } from "./context.ts";
import { ingestRoutes } from "./routes/ingest.ts";
import { webRoutes } from "./routes/web.ts";
import { appRouter } from "./trpc/router.ts";

export function createApp(app: AppContext) {
  const server = new Hono();

  server.use("*", logger());
  server.use("/api/*", cors());
  server.use("/trpc/*", cors());

  server.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: { code: String(error.status), message: error.message } }, error.status);
    }
    // A malformed payload is the client's bug and will never succeed on retry.
    // Returning 5xx here would send the reporter into its backoff loop for
    // nothing, so answer 400 and say exactly which field is wrong.
    if (error instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "request body failed validation",
            details: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
        400,
      );
    }
    console.error(error);
    return c.json({ error: { code: "internal", message: "internal server error" } }, 500);
  });

  server.get("/health", (c) => c.json({ ok: true }));

  // Public ingest API: versioned, REST, curl-debuggable. Consumed by reporters
  // that may be several releases behind the server.
  server.route("/api/v1", ingestRoutes(app));

  // Private dashboard API: tRPC, versionless, free to change with the UI.
  server.all("/trpc/*", (c) =>
    fetchRequestHandler({
      endpoint: "/trpc",
      req: c.req.raw,
      router: appRouter,
      createContext: () => ({ app, headers: c.req.raw.headers }),
    }),
  );

  // Last, so that every API route above wins its path outright and the
  // dashboard only ever answers what is left over.
  if (app.env.WEB_DIST) server.route("/", webRoutes(app.env.WEB_DIST));

  return server;
}
