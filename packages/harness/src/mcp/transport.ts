/**
 * MCP transports + a tiny JSON-RPC client core. OWNER: @tools.
 *
 * `Transport` is the seam the client talks to and tests mock. Two real ones:
 *   - StdioTransport: spawns the server, frames newline-delimited JSON-RPC.
 *   - HttpTransport: POSTs JSON-RPC (Streamable HTTP); parses JSON or SSE
 *     responses, tracks the Mcp-Session-Id header.
 *
 * `RpcClient` matches responses to requests by id, times out pending calls,
 * and exposes `request`/`notify`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { JsonRpcMessage, JsonRpcResponse, StdioServerConfig, HttpServerConfig } from './types.js';

export interface Transport {
  start(): Promise<void>;
  send(msg: JsonRpcMessage): Promise<void>;
  onMessage(cb: (msg: JsonRpcMessage) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────── stdio ──────

export class StdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private buf = '';
  private msgCb: (m: JsonRpcMessage) => void = () => {};
  private closeCb: (err?: Error) => void = () => {};
  private stderrTail = '';

  constructor(private readonly cfg: StdioServerConfig) {}

  async start(): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      ...(this.cfg.cwd ? { cwd: this.cfg.cwd } : {}),
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => this.onData(d));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      // MCP servers log to stderr — keep a short tail for error messages.
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    child.on('error', (e) => this.closeCb(e));
    child.on('exit', (code, sig) => {
      this.child = null;
      const reason = sig ? `signal ${sig}` : `code ${code}`;
      this.closeCb(code === 0 || code === null ? undefined : new Error(`server exited (${reason})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`));
    });

    // Give a mis-spawned command a beat to fail (ENOENT surfaces via 'error').
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 50);
      child.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        this.msgCb(JSON.parse(line) as JsonRpcMessage);
      } catch {
        /* non-JSON line (some servers print banners) — ignore */
      }
    }
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (!this.child?.stdin) throw new Error('stdio transport not started');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.stdin?.end();
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, 2000).unref?.();
    } catch {
      /* already gone */
    }
  }
}

// ──────────────────────────────────────────────────────────────── http ──────

export class HttpTransport implements Transport {
  private msgCb: (m: JsonRpcMessage) => void = () => {};
  private closeCb: (err?: Error) => void = () => {};
  private sessionId: string | undefined;
  private closed = false;

  constructor(private readonly cfg: HttpServerConfig) {}

  async start(): Promise<void> {
    /* Streamable HTTP is stateless per-POST; nothing to open up-front. */
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('http transport closed');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.cfg.headers ?? {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
    let res: Response;
    try {
      res = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(msg) });
    } catch (e) {
      this.closeCb(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 202 || res.status === 204) return; // notification accepted, no body
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} from MCP server${body ? `: ${body.slice(0, 300)}` : ''}`);
    }

    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('text/event-stream')) {
      await this.readSse(res);
    } else {
      const text = await res.text();
      if (text.trim()) this.dispatch(text);
    }
  }

  private dispatch(text: string): void {
    try {
      this.msgCb(JSON.parse(text) as JsonRpcMessage);
    } catch {
      /* ignore unparsable body */
    }
  }

  /** Parse an SSE stream, forwarding each `data:` JSON-RPC message. */
  private async readSse(res: Response): Promise<void> {
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // Events are separated by a blank line.
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = raw
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data) this.dispatch(data);
      }
    }
  }

  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ─────────────────────────────────────────────────────── JSON-RPC client ─────

const DEFAULT_TIMEOUT_MS = 30_000;

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly transport: Transport) {
    transport.onMessage((m) => this.handle(m));
    transport.onClose((err) => this.failAll(err ?? new Error('transport closed')));
  }

  private handle(m: JsonRpcMessage): void {
    if (m && typeof m === 'object' && 'id' in m && (('result' in m) || ('error' in m))) {
      const res = m as JsonRpcResponse;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      clearTimeout(p.timer);
      if (res.error) p.reject(new Error(`${res.error.message} (code ${res.error.code})`));
      else p.resolve(res.result);
    }
    // Server→client requests/notifications are ignored (we expose no sampling).
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }
}
