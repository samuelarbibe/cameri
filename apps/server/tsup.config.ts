import { defineConfig } from "tsup";

export default defineConfig({
  // `bootstrap` ships too: creating the first project is the one administrative
  // act with no route behind it, and in a container there is no `tsx` and no
  // source to point it at — only what tsup emitted.
  // `migrate` ships for the same reason, and is what `DB_MIGRATE_ON_BOOT=false`
  // leaves you to run.
  //
  // Named form, so the scripts land at `dist/bootstrap.js` and `dist/migrate.js`
  // rather than mirroring their source path into something nobody wants to type.
  entry: {
    index: "src/index.ts",
    bootstrap: "src/scripts/bootstrap.ts",
    migrate: "src/scripts/migrate.ts",
  },
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node20",
  platform: "node",
  // Workspace packages are consumed from source, so they must be bundled in.
  noExternal: [/^@camerihq\//],
});
