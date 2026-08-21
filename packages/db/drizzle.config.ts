import { defineConfig } from "drizzle-kit";
import { loadDotenv } from "./src/dotenv.ts";

loadDotenv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://cameri:cameri@localhost:5432/cameri",
  },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
