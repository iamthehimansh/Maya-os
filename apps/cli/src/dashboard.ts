import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

/**
 * Serve the built dashboard SPA with same-origin /api + /v1 proxying to the
 * gateway — the browser never makes a cross-origin call, so no CORS surface
 * exists at all. SSE streams straight through the pipe. Binds 127.0.0.1 only.
 */
/** Same-origin routes served by the AGENT PLANE's orchestrator service (:4400). */
const ORCHESTRATOR_PREFIXES = ["/api/teams", "/api/agents", "/api/runs", "/api/loop", "/api/orchestrator", "/api/cldz"];
/** Bus REST routes exposed to the dashboard — READ-ONLY, bearer injected server-side. */
const BUS_PREFIX = "/api/channels";

export interface BusProxy {
  port: number;
  /** Injected into bus requests so the browser NEVER holds a bus credential. */
  adminToken: string;
}

export function serveDashboard(distDir: string, port: number, gatewayPort: number, orchestratorPort?: number, bus?: BusProxy): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url.startsWith("/api/") || url.startsWith("/v1/")) {
      const toBus = bus !== undefined && url.startsWith(BUS_PREFIX);
      if (toBus && req.method !== "GET") {
        // The channel viewer is read-only; token minting/policy writes must
        // never be reachable from a browser.
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bus routes are read-only via the dashboard", type: "maya_dashboard_proxy" } }));
        return;
      }
      const toOrchestrator = !toBus && orchestratorPort !== undefined && ORCHESTRATOR_PREFIXES.some((p) => url.startsWith(p));
      const targetPort = toBus ? bus.port : toOrchestrator ? orchestratorPort : gatewayPort;
      const headers = toBus ? { ...req.headers, authorization: `Bearer ${bus.adminToken}` } : req.headers;
      const upstream = http.request(
        { host: "127.0.0.1", port: targetPort, path: url, method: req.method, headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: toBus ? "bus unreachable" : toOrchestrator ? "orchestrator unreachable" : "gateway unreachable", type: "maya_dashboard_proxy" } }));
      });
      req.pipe(upstream);
      return;
    }

    // Static SPA: resolve inside distDir only; unknown routes fall back to index.html.
    const safe = path.normalize(url.split("?")[0] ?? "/").replace(/^(\.\.[/\\])+/, "");
    let file = path.join(distDir, safe);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(distDir, "index.html");
    }
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
