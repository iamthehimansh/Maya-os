import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // node-pty is a native module — never bundle it (its CJS loader needs __dirname
  // + the platform pty.node binary from node_modules); leave it as a runtime import.
  external: ["node:sqlite", "node-pty"],
  // Bundled CJS deps (ws) use require(builtin) — provide it in ESM output.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
