import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  noExternal: ["@cameri/contract"],
  define: {
    __CAMERI_VERSION__: JSON.stringify(pkg.version),
  },
});
