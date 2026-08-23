import { createDatabase, type Database } from "@cameri/db";
import { parseEncryptionKey } from "./crypto.ts";
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

  // Built in two steps because the comment sync needs the context it lives on:
  // it reads runs and integrations through the same db handle.
  const app: AppContext = {
    env,
    db,
    storage: createStorage(env),
    // Parsed at boot so a malformed key fails to start rather than failing at
    // the moment someone first tries to save a token.
    encryptionKey: parseEncryptionKey(env.CAMERI_ENCRYPTION_KEY),
    mrComments: undefined as unknown as MrCommentSync,
    close: async () => {
      await app.mrComments.close();
      await close();
    },
  };
  app.mrComments = createMrCommentSync(app);
  return app;
}
