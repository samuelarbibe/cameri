import { createDatabase, type Database } from "@camerihq/db";
import { createSigner, parseEncryptionKey } from "./crypto.ts";
import { loadEnv, type Env } from "./env.ts";
import { createMrCommentSync, type MrCommentSync } from "./integrations/mr-comment.ts";
import { createStorage, type Storage } from "./storage.ts";

export interface AppContext {
  env: Env;
  db: Database;
  storage: Storage;
  /** Null when CAMERI_ENCRYPTION_KEY is unset; integrations are then unavailable. */
  encryptionKey: Buffer | null;
  mrComments: MrCommentSync;
  close: () => Promise<void>;
}

export function createContext(env: Env = loadEnv()): AppContext {
  const { db, close } = createDatabase({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL });

  // Parsed at boot so a malformed key fails to start rather than failing at
  // the moment someone first tries to save a token.
  const encryptionKey = parseEncryptionKey(env.CAMERI_ENCRYPTION_KEY);

  if (!encryptionKey && env.STORAGE_DRIVER === "local" && env.NODE_ENV === "production") {
    console.warn(
      "[cameri] CAMERI_ENCRYPTION_KEY is not set: upload URLs are signed with a key generated " +
        "at boot, so they stop verifying after a restart and across replicas. Set one.",
    );
  }

  // Built in two steps because the comment sync needs the context it lives on:
  // it reads runs and integrations through the same db handle.
  const app: AppContext = {
    env,
    db,
    storage: createStorage(env, createSigner(encryptionKey, "blob-upload")),
    encryptionKey,
    mrComments: undefined as unknown as MrCommentSync,
    close: async () => {
      await app.mrComments.close();
      await close();
    },
  };
  app.mrComments = createMrCommentSync(app);
  return app;
}
