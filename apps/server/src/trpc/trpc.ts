import { initTRPC } from "@trpc/server";
import type { AppContext } from "../context.ts";

export interface TrpcContext {
  app: AppContext;
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
