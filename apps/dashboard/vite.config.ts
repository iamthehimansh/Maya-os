import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Mirror the prod proxy's split (apps/cli/src/dashboard.ts): agent-plane routes
// live on the orchestrator (:4400), everything else on the gateway (:4100).
// Order matters — vite matches proxy keys top-down, so the specific prefixes
// must precede the catch-all "/api".
const ORCHESTRATOR = "http://127.0.0.1:4400";
const GATEWAY = "http://127.0.0.1:4100";
const ORCHESTRATOR_PREFIXES = ["/api/teams", "/api/agents", "/api/runs", "/api/loop", "/api/orchestrator", "/api/cldz"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4200,
    proxy: {
      ...Object.fromEntries(ORCHESTRATOR_PREFIXES.map((p) => [p, ORCHESTRATOR])),
      "/api": GATEWAY,
      "/v1": GATEWAY,
    },
  },
  build: { outDir: "dist" },
});
