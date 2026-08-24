import { initTRPC, TRPCError } from "@trpc/server";
import { safeEqual } from "../auth.ts";
import type { AppContext } from "../context.ts";

/** The header the dashboard presents on a call that changes something. */
export const ADMIN_TOKEN_HEADER = "x-cameri-admin-token";

export interface TrpcContext {
  app: AppContext;
  /** Request headers, for the admin check. Absent when a caller is synthetic. */
  headers?: Headers;
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** Whether this request carries the configured admin token. */
export function isAdmin(ctx: TrpcContext): boolean {
  const expected = ctx.app.env.CAMERI_ADMIN_TOKEN;
  const presented = ctx.headers?.get(ADMIN_TOKEN_HEADER);
  return Boolean(expected && presented && safeEqual(expected, presented));
}

/**
 * For procedures that write.
 *
 * With no token configured this refuses rather than waves everyone through.
 * The same reasoning as `createCipher`: the failure a deployment deserves is
 * the loud one, and "there is no way to lock this, so it is unlocked" is how a
 * dashboard on a public hostname ends up handing its GitLab connection to
 * whoever finds it.
 */
export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.app.env.CAMERI_ADMIN_TOKEN) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "CAMERI_ADMIN_TOKEN is not set, so this server will not accept a change to its " +
        "settings. Generate one with `node -e \"console.log(require('crypto')" +
        '.randomBytes(32).toString(\'base64url\'))"` and set it.',
    });
  }

  if (!isAdmin(ctx)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "admin token missing or incorrect" });
  }

  return next();
});
