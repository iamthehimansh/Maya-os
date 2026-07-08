import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Cloudflare quick-tunnels: expose a local port to a public
 * `*.trycloudflare.com` URL for testing/sharing. Each tunnel is an explicit,
 * supervised `cloudflared` child — nothing is auto-exposed; the user chooses
 * every port that goes public, sees the URL, and can stop it. Same
 * process-supervision discipline as the model servers.
 */
export interface Tunnel {
  id: string;
  port: number;
  url: string | null; // null until cloudflared reports the public URL
  state: "starting" | "live" | "failed" | "stopped";
  startedAt: string;
  error?: string;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class TunnelManager {
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly procs = new Map<string, ChildProcess>();

  async detect(): Promise<{ installed: boolean; version?: string; hint?: string }> {
    try {
      const { stdout } = await execFileP("cloudflared", ["--version"], { timeout: 8_000 });
      const version = stdout.trim().split(/\s+/)[2];
      return { installed: true, ...(version ? { version } : {}) };
    } catch {
      return { installed: false, hint: "brew install cloudflared" };
    }
  }

  list(): Tunnel[] {
    return [...this.tunnels.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Open a quick tunnel to localhost:<port>. Resolves once the URL is up (or fails). */
  async open(port: number): Promise<Tunnel> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
    const det = await this.detect();
    if (!det.installed) throw new Error(`cloudflared not installed — ${det.hint}`);

    const id = `tun_${randomUUID().slice(0, 8)}`;
    const tunnel: Tunnel = { id, port, url: null, state: "starting", startedAt: new Date().toISOString() };
    this.tunnels.set(id, tunnel);

    const child = spawn(
      "cloudflared",
      ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.procs.set(id, child);

    // cloudflared prints the public URL to stderr as it comes up.
    const onData = (buf: Buffer): void => {
      const m = URL_RE.exec(buf.toString());
      if (m && !tunnel.url) {
        tunnel.url = m[0];
        tunnel.state = "live";
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      this.procs.delete(id);
      if (tunnel.state !== "stopped") {
        tunnel.state = "failed";
        tunnel.error = `cloudflared exited (${code})`;
      }
    });

    // Wait up to 25s for the URL.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (tunnel.url) return tunnel;
      if (tunnel.state === "failed") throw new Error(tunnel.error ?? "tunnel failed");
      await new Promise((r) => setTimeout(r, 400));
    }
    await this.close(id);
    tunnel.state = "failed";
    tunnel.error = "timed out waiting for tunnel URL";
    throw new Error(tunnel.error);
  }

  async close(id: string): Promise<void> {
    const child = this.procs.get(id);
    const tunnel = this.tunnels.get(id);
    if (tunnel) tunnel.state = "stopped";
    if (child) {
      child.kill("SIGTERM");
      this.procs.delete(id);
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.procs.keys()]) await this.close(id);
  }
}
