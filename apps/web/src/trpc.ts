import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";
// Type-only: the router never ships to the browser, but its shape does.
import type { AppRouter } from "@camerihq/server/router";

/**
 * The only place the client learns the API's shape. Everything downstream —
 * argument types, return types, nested field names — is inferred from the
 * server's Drizzle queries, so there is no second copy of these types to
 * maintain and no codegen step to forget to run.
 */
/**
 * Where the admin token lives between calls.
 *
 * `sessionStorage`, so it is gone when the tab is: this is a shared secret
 * typed by whoever is administering the deployment, not a login, and leaving
 * it in `localStorage` would make one careless afternoon on a shared machine
 * permanent. Not in a cookie either — nothing here is same-site enough for
 * that to be an improvement.
 */
const ADMIN_TOKEN_KEY = "cameri.adminToken";

export const adminToken = {
  get: (): string | null => sessionStorage.getItem(ADMIN_TOKEN_KEY),
  set: (value: string) => sessionStorage.setItem(ADMIN_TOKEN_KEY, value),
  clear: () => sessionStorage.removeItem(ADMIN_TOKEN_KEY),
};

export const trpc: TRPCClient<AppRouter> = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/trpc",
      // Read per request rather than captured once: the token is typed into
      // the settings page long after this client is built.
      headers: () => {
        const token = adminToken.get();
        return token ? { "x-cameri-admin-token": token } : {};
      },
    }),
  ],
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

/** Logs, steps and attachments — fetched per attempt, never with the run. */
export type AttemptDetail = NonNullable<Awaited<ReturnType<typeof trpc.tests.attempt.query>>>;
export type AttemptStep = AttemptDetail["steps"][number];
export type DailyHistoryRow = Awaited<ReturnType<typeof trpc.tests.dailyHistory.query>>[number];
export type ExplorerRow = Awaited<ReturnType<typeof trpc.tests.explorer.query>>[number];
export type Attachment = AttemptDetail["attachments"][number];

/** One merge request, rolled up from its runs. */
export type MergeRequestRow = Awaited<ReturnType<typeof trpc.mergeRequests.list.query>>[number];
export type Integration = Awaited<ReturnType<typeof trpc.integrations.list.query>>[number];
