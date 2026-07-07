/**
 * Codex adapter (contracts: AgentAdapter).
 *
 * Headless integration via `codex exec --json` — JSONL events on stdout.
 * One-shot only in this slice: `send()` rejects (Codex continues sessions via
 * `codex exec resume`, which lands with the conversational slice).
 *
 * Model wiring: Codex speaks OpenAI-compat natively, so it points straight at
 * the Maya gateway's `/v1` — no sidecar. A custom provider is injected purely
 * with `-c` config overrides (nothing written to the user's ~/.codex):
 *   -c model_providers.maya.base_url=<gateway>/v1
 *   -c model_providers.maya.env_key=MAYA_API_KEY   (dummy on localhost)
 *   -c model_provider=maya
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  AgentLogEvent,
  AgentSpawnSpec,
  AgentState,
} from '@maya-ai/core';
import { EventLog } from '../events.js';

export interface CodexAdapterOptions {
  /** Maya gateway base, e.g. "http://127.0.0.1:4100" ("/v1" is appended). */
  gatewayBaseUrl: string;
  /** Override the CLI binary (tests). */
  codexBin?: string;
}

interface LiveAgent {
  handle: AgentHandle;
  child: ChildProcess;
  log: EventLog;
  logs: AgentLogEvent[];
  stdoutBuf: string;
}

const TERMINAL: ReadonlySet<AgentState> = new Set(['exited', 'killed', 'failed']);
const MAX_LOG_LINES = 10_000;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  private readonly agents = new Map<string, LiveAgent>();
  private detected: { installed: boolean; version?: string; installHint?: string } | null = null;

  constructor(private readonly opts: CodexAdapterOptions) {}

  private bin(): string {
    return this.opts.codexBin ?? 'codex';
  }

  async detect(): Promise<{ installed: boolean; version?: string; installHint?: string }> {
    if (this.detected) return this.detected;
    const result = await new Promise<{ installed: boolean; version?: string; installHint?: string }>((resolve) => {
      execFile(this.bin(), ['--version'], { timeout: 30_000 }, (err, stdout) => {
        if (err) {
          resolve({ installed: false, installHint: 'npm install -g @openai/codex' });
          return;
        }
        const version = stdout.trim().split(/\s+/).pop();
        resolve(version !== undefined ? { installed: true, version } : { installed: true });
      });
    });
    this.detected = result;
    return result;
  }

  /** Exposed for unit tests — argv construction is a contract with the CLI. */
  buildArgs(spec: AgentSpawnSpec): string[] {
    if (spec.prompt === undefined) {
      throw new Error('codex adapter is one-shot in this slice — spawn with a prompt (resume lands later)');
    }
    const base = this.opts.gatewayBaseUrl.replace(/\/$/, '');
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-c', `model_providers.maya.name=Maya`,
      '-c', `model_providers.maya.base_url=${base}/v1`,
      '-c', `model_providers.maya.env_key=MAYA_API_KEY`,
      // Codex defaults to the OpenAI Responses API (/v1/responses); the Maya
      // gateway speaks chat completions — pin the wire protocol.
      '-c', `model_providers.maya.wire_api=chat`,
      '-c', `model_provider=maya`,
      '-m', spec.model,
    ];
    if ((spec.permissionMode ?? 'auto') === 'auto') args.push('--dangerously-bypass-approvals-and-sandbox');
    args.push(spec.prompt);
    return args;
  }

  async spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    const detect = await this.detect();
    if (!detect.installed) throw new Error(`codex CLI not found — ${detect.installHint ?? ''}`);

    const id = 'ag_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...spec.env,
      // Dummy key satisfies the provider's env_key against the localhost gateway.
      MAYA_API_KEY: spec.env?.['MAYA_API_KEY'] ?? 'maya-gateway',
    };

    const child = spawn(this.bin(), this.buildArgs(spec), {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const handle: AgentHandle = {
      id,
      adapter: this.id,
      state: 'spawning',
      model: spec.model,
      cwd: spec.cwd,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      spawnedAt: new Date().toISOString(),
    };
    const live: LiveAgent = { handle, child, log: new EventLog(), logs: [], stdoutBuf: '' };
    this.agents.set(id, live);

    // Orphan guard (shared pattern): our exit takes the child; listener removed
    // on child exit so it never accumulates.
    const killChild = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    };
    process.once('exit', killChild);
    child.once('exit', () => process.removeListener('exit', killChild));

    child.stdout?.on('data', (buf: Buffer) => this.onStdout(live, buf));
    child.stderr?.on('data', (buf: Buffer) => this.pushLog(live, 'stderr', buf.toString()));
    child.once('error', (err) => {
      this.setState(live, 'failed');
      this.pushEvent(live, { kind: 'error', message: String(err), at: now() });
      live.log.close();
    });
    child.once('exit', (code) => {
      if (!TERMINAL.has(live.handle.state)) {
        live.handle = { ...live.handle, ...(code !== null ? { exitCode: code } : {}) };
        this.setState(live, code === 0 ? 'exited' : 'failed');
      }
      live.log.close();
    });

    this.setState(live, 'running');
    return live.handle;
  }

  // ── JSONL event mapping ────────────────────────────────────────────────

  private onStdout(live: LiveAgent, buf: Buffer): void {
    live.stdoutBuf += buf.toString();
    for (;;) {
      const nl = live.stdoutBuf.indexOf('\n');
      if (nl === -1) return;
      const line = live.stdoutBuf.slice(0, nl).trim();
      live.stdoutBuf = live.stdoutBuf.slice(nl + 1);
      if (line) this.onStreamLine(live, line);
    }
  }

  /**
   * Exposed for unit tests. Codex has shipped two JSONL shapes; map both:
   *  - legacy: {"id":…, "msg":{"type":"agent_message","message":…}}
   *  - current: {"type":"item.completed","item":{"item_type":…,"text":…}},
   *             {"type":"turn.completed","usage":{…}}, {"type":"error",…}
   */
  onStreamLine(live: LiveAgent, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.pushLog(live, 'stdout', line);
      return;
    }

    const legacy = msg['msg'] as Record<string, unknown> | undefined;
    const kind = String(legacy?.['type'] ?? msg['type'] ?? '');

    switch (kind) {
      case 'agent_message':
        this.pushLog(live, 'stdout', String(legacy?.['message'] ?? ''));
        return;
      case 'exec_command_begin': {
        const cmd = legacy?.['command'];
        this.pushLog(live, 'stdout', `[exec] ${Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '')}`);
        return;
      }
      case 'exec_command_end':
        this.pushLog(live, 'system', '[exec done]');
        return;
      case 'token_count': {
        const info = (legacy?.['info'] ?? legacy) as Record<string, unknown>;
        const total = (info?.['total_token_usage'] ?? info) as Record<string, unknown> | undefined;
        const input = Number(total?.['input_tokens'] ?? 0);
        const output = Number(total?.['output_tokens'] ?? 0);
        if (input || output) this.pushEvent(live, { kind: 'tokens', input, output, at: now() });
        return;
      }
      case 'task_complete':
        this.setState(live, 'exited');
        return;
      case 'error':
        this.pushEvent(live, {
          kind: 'error',
          message: String(legacy?.['message'] ?? msg['message'] ?? 'error'),
          at: now(),
        });
        this.setState(live, 'failed');
        return;
      case 'item.completed': {
        const item = msg['item'] as Record<string, unknown> | undefined;
        const itemType = String(item?.['item_type'] ?? item?.['type'] ?? '');
        if (itemType === 'assistant_message' || itemType === 'agent_message') {
          this.pushLog(live, 'stdout', String(item?.['text'] ?? ''));
        } else if (itemType === 'command_execution') {
          this.pushLog(live, 'stdout', `[exec] ${String(item?.['command'] ?? '')}`);
        } else {
          this.pushLog(live, 'system', `[${itemType || 'item'}]`);
        }
        return;
      }
      case 'turn.completed': {
        const usage = msg['usage'] as Record<string, unknown> | undefined;
        const input = Number(usage?.['input_tokens'] ?? 0);
        const output = Number(usage?.['output_tokens'] ?? 0);
        if (input || output) this.pushEvent(live, { kind: 'tokens', input, output, at: now() });
        this.setState(live, 'exited');
        return;
      }
      case 'turn.failed':
        this.pushEvent(live, { kind: 'error', message: JSON.stringify(msg['error'] ?? {}), at: now() });
        this.setState(live, 'failed');
        return;
      default:
        this.pushLog(live, 'system', `[${kind || 'event'}]`);
    }
  }

  // ── control (same semantics as the Claude Code adapter) ───────────────

  async pause(id: string): Promise<void> {
    const live = this.mustGet(id);
    if (live.handle.state !== 'running') throw new Error(`cannot pause from state ${live.handle.state}`);
    live.child.kill('SIGSTOP');
    this.setState(live, 'paused');
  }

  async resume(id: string): Promise<void> {
    const live = this.mustGet(id);
    if (live.handle.state !== 'paused') throw new Error(`cannot resume from state ${live.handle.state}`);
    live.child.kill('SIGCONT');
    this.setState(live, 'running');
  }

  async kill(id: string, graceMs = 3000): Promise<void> {
    const live = this.mustGet(id);
    if (TERMINAL.has(live.handle.state)) return;
    this.setState(live, 'killed');
    live.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          live.child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, graceMs);
      live.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async send(): Promise<void> {
    throw new Error('codex adapter is one-shot in this slice — conversational resume lands later');
  }

  async status(id: string): Promise<AgentHandle> {
    return this.mustGet(id).handle;
  }

  async *events(id: string, since?: string): AsyncIterable<AgentEvent> {
    const live = this.mustGet(id);
    for await (const { event } of live.log.iterate(since)) yield event;
  }

  async logs(id: string, opts?: { tail?: number }): Promise<AgentLogEvent[]> {
    const live = this.mustGet(id);
    const tail = opts?.tail ?? 200;
    return live.logs.slice(Math.max(0, live.logs.length - tail));
  }

  list(): AgentHandle[] {
    return [...this.agents.values()].map((a) => a.handle);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private mustGet(id: string): LiveAgent {
    const live = this.agents.get(id);
    if (!live) throw new Error(`unknown agent ${id}`);
    return live;
  }

  private setState(live: LiveAgent, state: AgentState): void {
    if (TERMINAL.has(live.handle.state)) return; // never leave a terminal state
    live.handle = { ...live.handle, state };
    this.pushEvent(live, { kind: 'state', state, at: now() });
  }

  private pushEvent(live: LiveAgent, event: AgentEvent): void {
    live.log.push(event);
  }

  private pushLog(live: LiveAgent, stream: AgentLogEvent['stream'], line: string): void {
    const entry: AgentLogEvent = { ts: Date.now(), stream, line };
    live.logs.push(entry);
    if (live.logs.length > MAX_LOG_LINES) live.logs.shift();
    this.pushEvent(live, { kind: 'log', stream, line, at: now() });
  }
}

const now = (): string => new Date().toISOString();
