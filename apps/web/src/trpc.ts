import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";
// Type-only: the router never ships to the browser, but its shape does.
import type { AppRouter } from "@cameri/server/router";

/**
 * The only place the client learns the API's shape. Everything downstream —
 * argument types, return types, nested field names — is inferred from the
 * server's Drizzle queries, so there is no second copy of these types to
 * maintain and no codegen step to forget to run.
 */
export const trpc: TRPCClient<AppRouter> = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/trpc" })],
});

export type { AppRouter };

/**
 * Row shapes, read off the client rather than off `inferRouterOutputs`, so the
 * browser bundle never needs `@trpc/server` on its dependency list. Still the
 * same chain: Drizzle select → tRPC → here.
 */
export type RunListItem = Awaited<ReturnType<typeof trpc.runs.list.query>>[number];
export type ProjectListItem = Awaited<ReturnType<typeof trpc.projects.list.query>>[number];

/** `runs.get` returns null for an unknown id; the page types work off the hit. */
export type RunDetail = NonNullable<Awaited<ReturnType<typeof trpc.runs.get.query>>>;
export type RunAttempt = RunDetail["attempts"][number];
export type RunShard = RunDetail["shards"][number];
