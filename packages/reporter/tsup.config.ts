import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts"],
  // Playwright configs come in both flavours, so ship both.
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  platform: "node",
  treeshake: true,
  // @camerihq/contract is a private workspace package: inline it rather than
  // publishing a second package users would have to install.
  noExternal: ["@camerihq/contract"],
  external: ["@playwright/test"],
  define: {
    __CAMERI_VERSION__: JSON.stringify(pkg.version),
  },
});
