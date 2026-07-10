/**
 * maya remote — control Maya from anywhere, securely.
 *
 * A bearer-guarded localhost HTTP proxy in front of the ORCHESTRATOR API only
 * (/api/* → http://127.0.0.1:<orchestratorPort>), plus an optional cloudflared
 * quick tunnel that gives it a public https URL. The gateway (model admin
 * plane) is local-only BY DESIGN and is never forwarded — remote callers get
 * teams/loops/agents, not model load/unload or provider config.
 *
 * Security posture:
 *   - EVERY request needs `Authorization: Bearer <token>` (timing-safe compare;
 *     the token lives in ~/.maya/remote.token, 0600, minted once).
 *   - Only /api/* paths forward; `..` traversal (raw or percent-encoded) is
 *     rejected before anything reaches the upstream.
 *   - The inbound Authorization header is STRIPPED before forwarding (the
 *     remote token is not the orchestrator's admin bearer) and
 *     `x-maya-remote: 1` is added so audits can tell remote calls apart.
 *   - Streaming passes through untouched both ways (SSE run-events, agent
 *     /output) and the upstream request is aborted when the client hangs up.
 *   - The token is never logged here; the CLI prints it exactly once as the
 *     deliberate owner handoff.
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mayaHome } from "@maya-ai/core";

export interface RemoteProxyHandle {
  /** Local port the proxy is listening on (127.0.0.1 only). */
  port: number;
  /** The bearer token remote callers must present. */
  token: string;
  /** Where the token is persisted (0600). */
  tokenPath: string;
  close(): void;
}

/** A live cloudflared quick tunnel. */
export interface ActiveTunnel {
  url: string;
  child: ChildProcess;
}

/** cloudflared is not installed — how to get it. */
export interface TunnelUnavailable {
  url: null;
  installHint: string;
}

/**
 * Read ~/.maya/remote.token, or mint it (32 random bytes as hex, 0600) on
 * first use. Reused across `maya remote` runs so curl scripts keep working.
 */
export function loadOrCreateRemoteToken(): { token: string; tokenPath: string } {
  const tokenPath = path.join(mayaHome(), "remote.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return { token: existing, tokenPath };
  } catch {
    // absent or unreadable — mint below
  }
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, tokenPath };
}

/**
 * Constant-time bearer check. Hashing both sides first gives equal-length
 * buffers, so `timingSafeEqual` never throws and length itself leaks nothing.
 */
function bearerMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/**
 * Start the remote proxy on 127.0.0.1:<port> (default 4500). Resolves once
 * it is listening; rejects if the port is taken.
 */
export async function startRemoteProxy(opts: { orchestratorPort: number; port?: number }): Promise<RemoteProxyHandle> {
  const { token, tokenPath } = loadOrCreateRemoteToken();
  const port = opts.port ?? 4500;
  const server = createServer((req, res) => forward(req, res, token, opts.orchestratorPort));
  // SSE responses (loop follow, agent /output) stay open indefinitely — don't
  // let node's default idle timeouts cut them off mid-stream.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    port,
    token,
    tokenPath,
    close: (): void => {
      server.close();
      // Kill keep-alive + SSE sockets so close actually completes.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    },
  };
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** Bearer-check, path-allowlist, then stream the request through. */
function forward(req: IncomingMessage, res: ServerResponse, token: string, orchestratorPort: number): void {
  // Auth FIRST — unauthenticated callers learn nothing about the path space.
  if (!bearerMatches(req.headers.authorization, token)) {
    res.setHeader("www-authenticate", "Bearer");
    return deny(res, 401, "unauthorized");
  }
  let pathname: string;
  let search: string;
  try {
    const u = new URL(req.url ?? "", "http://remote.invalid");
    pathname = u.pathname;
    search = u.search;
  } catch {
    return deny(res, 400, "bad request url");
  }
  // Allow ONLY the orchestrator API. `new URL` collapses raw `..`, so a
  // surviving prefix mismatch or any percent-encoded dot-dot is rejected here
  // — nothing else (dashboard, gateway/model plane) is reachable remotely.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return deny(res, 400, "bad path encoding");
  }
  if (!pathname.startsWith("/api/") || decoded.split("/").includes("..") || decoded.includes("\\")) {
    return deny(res, 404, "not found");
  }

  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const k = key.toLowerCase();
    // Strip the remote bearer (it is NOT the orchestrator's admin token) and
    // hop-by-hop/host headers; http.request re-derives host + connection.
    if (k === "authorization" || k === "host" || k === "connection" || k === "keep-alive" || k === "upgrade" || k === "proxy-authorization" || k === "te" || k === "trailer" || k === "transfer-encoding") continue;
    headers[k] = value;
  }
  headers["x-maya-remote"] = "1";

  const upstream = httpRequest(
    { host: "127.0.0.1", port: orchestratorPort, method: req.method ?? "GET", path: pathname + search, headers },
    (ures) => {
      res.writeHead(ures.statusCode ?? 502, ures.headers);
      ures.pipe(res); // streaming pass-through — SSE chunks flush as they arrive
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else deny(res, 502, "orchestrator unreachable — is `maya serve` running?");
  });
  // Client hung up (curl Ctrl-C, dropped tunnel) → abort upstream so SSE
  // follows don't leak server-side. Harmless after a normal end.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * Spawn a cloudflared quick tunnel to 127.0.0.1:<localPort> and wait (≤20s)
 * for the https://…trycloudflare.com URL it prints on stderr.
 *
 * Returns `{url: null, installHint}` when cloudflared is not on PATH; throws
 * if it starts but never prints a URL (the child is killed first).
 */
export async function startTunnel(localPort: number): Promise<ActiveTunnel | TunnelUnavailable> {
  const installed = await new Promise<boolean>((resolve) => {
    execFile("cloudflared", ["--version"], { timeout: 10_000 }, (err) => resolve(!err));
  });
  if (!installed) return { url: null, installHint: "brew install cloudflared" };

  const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${localPort}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string | null>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) done(m[0]);
    };
    const onExit = (): void => done(null);
    const timer = setTimeout(() => done(null), 20_000);
    const done = (value: string | null): void => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      resolve(value);
    };
    child.stderr?.on("data", onData); // cloudflared logs the URL to stderr
    child.stdout?.on("data", onData); // belt-and-braces for future versions
    child.on("exit", onExit);
  });
  if (url === null) {
    child.kill("SIGTERM");
    throw new Error("cloudflared started but printed no trycloudflare.com URL within 20s");
  }
  return { url, child };
}
