import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node20",
  platform: "node",
  // Workspace packages are consumed from source, so they must be bundled in.
  noExternal: [/^@cameri\//],
});
