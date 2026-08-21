import { createDatabase, type Database } from "@cameri/db";
import { loadEnv, type Env } from "./env.ts";
import { createStorage, type Storage } from "./storage.ts";

export interface AppContext {
  env: Env;
  db: Database;
  storage: Storage;
  close: () => Promise<void>;
}

export function createContext(env: Env = loadEnv()): AppContext {
  const { db, close } = createDatabase({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL });
  return { env, db, storage: createStorage(env), close };
}
