/**
 * OpenCode adapter (contracts: AgentAdapter).
 *
 * Headless integration via `opencode run --format json` (one-shot). The argv
 * contract + lifecycle here are from OpenCode's documented CLI and the shared
 * adapter pattern; the JSON EVENT SHAPE is best-effort and marked TODO — it
 * must be confirmed against a real `opencode run --format json` stream (the
 * tool isn't installed on this dev box, so the live smoke is pending).
 *
 * Model wiring: OpenCode resolves `provider/model`; to route through Maya's
 * gateway we write a throwaway config declaring a `maya` OpenAI-compatible
 * provider at the gateway and point OPENCODE_CONFIG at it, then pass
 * `--model maya/<name>`. (Also pending live confirmation of the config schema.)
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  AgentLogEvent,
  AgentSpawnSpec,
  AgentState,
} from '@maya-ai/core';
import { EventLog } from '../events.js';
import { resolveCwd } from '../cwd.js';

export interface OpenCodeAdapterOptions {
  /** Maya gateway base, e.g. "http://127.0.0.1:4100" ("/v1" appended). */
  gatewayBaseUrl: string;
  /** Override the CLI binary (tests). */
  opencodeBin?: string;
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

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  private readonly agents = new Map<string, LiveAgent>();
  private detected: { installed: boolean; version?: string; installHint?: string } | null = null;

  constructor(private readonly opts: OpenCodeAdapterOptions) {}

  private bin(): string {
    return this.opts.opencodeBin ?? 'opencode';
  }

  async detect(): Promise<{ installed: boolean; version?: string; installHint?: string }> {
    if (this.detected) return this.detected;
    const result = await new Promise<{ installed: boolean; version?: string; installHint?: string }>((resolve) => {
      execFile(this.bin(), ['--version'], { timeout: 30_000 }, (err, stdout) => {
        if (err) {
          resolve({ installed: false, installHint: 'npm install -g opencode-ai' });
          return;
        }
        const version = stdout.trim().split(/\s+/).pop();
        resolve(version !== undefined ? { installed: true, version } : { installed: true });
      });
    });
    this.detected = result;
    return result;
  }

  /** Write a throwaway config declaring the gateway as a `maya` provider. */
  private writeGatewayConfig(): string {
    const dir = mkdtempSync(join(tmpdir(), 'maya-opencode-'));
    const cfg = join(dir, 'opencode.json');
    const base = this.opts.gatewayBaseUrl.replace(/\/$/, '');
    writeFileSync(
      cfg,
      JSON.stringify({
        provider: {
          maya: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: `${base}/v1`, apiKey: 'maya-gateway' },
          },
        },
      }),
    );
    return cfg;
  }

  /** Exposed for unit tests — argv construction is a contract with the CLI. */
  buildArgs(spec: AgentSpawnSpec): string[] {
    if (spec.prompt === undefined) {
      throw new Error('opencode adapter is one-shot in this slice — spawn with a prompt');
    }
    const args = ['run', '--format', 'json', '--dir', spec.cwd, '--model', spec.model];
    if ((spec.permissionMode ?? 'auto') === 'auto') args.push('--auto');
    args.push(spec.prompt);
    return args;
  }

  async spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    const detect = await this.detect();
    if (!detect.installed) throw new Error(`opencode CLI not found — ${detect.installHint ?? ''}`);

    const id = 'ag_' + randomUUID().replaceAll('-', '').slice(0, 12);
    // Deterministic env: strip the launcher's Claude Code / agent session
    // identity (see the claude-code adapter for the nested-child failure this
    // prevents), then point OpenCode at the gateway provider config.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^CLAUDE_CODE_/.test(k) || k === 'CLAUDECODE' || k === 'AI_AGENT' || k === 'CLAUDE_EFFORT') continue;
      env[k] = v;
    }
    Object.assign(env, spec.env, { OPENCODE_CONFIG: spec.env?.['OPENCODE_CONFIG'] ?? this.writeGatewayConfig() });

    const cwd = resolveCwd(spec.cwd); // expand ~ + ensure the dir exists (else spawn ENOENTs)
    const child = spawn(this.bin(), this.buildArgs(spec), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    const handle: AgentHandle = {
      id,
      adapter: this.id,
      state: 'spawning',
      model: spec.model,
      cwd: cwd ?? spec.cwd,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      spawnedAt: new Date().toISOString(),
    };
    const live: LiveAgent = { handle, child, log: new EventLog(), logs: [], stdoutBuf: '' };
    this.agents.set(id, live);

    const killChild = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    };
    process.once('exit', killChild);
    child.once('exit', () => process.removeListener('exit', killChild));

    // OpenCode has no native mapping (yet) for Maya's scoping/persona options —
    // say what was dropped instead of silently running unrestricted/persona-less.
    const ignored = ['allowedTools', 'maxTurns', 'systemPrompt', 'appendSystemPrompt'].filter(
      (k) => spec.options?.[k] !== undefined,
    );
    if (ignored.length > 0) {
      this.pushLog(live, 'system', `[opencode] unsupported options ignored: ${ignored.join(', ')}`);
    }

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
   * Exposed for unit tests. BEST-EFFORT JSON event mapping — OpenCode's
   * `--format json` event shape is not yet confirmed on a live run, so this
   * handles the common fields defensively: text/message content → log, tool
   * use → log, a usage/tokens object → tokens event, an error → error+failed.
   * TODO: confirm against a real stream and tighten.
   */
  onStreamLine(live: LiveAgent, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.pushLog(live, 'stdout', line);
      return;
    }
    const type = String(msg['type'] ?? msg['event'] ?? '');
    const text = (msg['text'] ?? msg['message'] ?? msg['content']) as unknown;
    if (typeof text === 'string' && text.trim()) this.pushLog(live, 'stdout', text);
    if (type.includes('tool')) this.pushLog(live, 'stdout', `[tool] ${String(msg['name'] ?? msg['tool'] ?? '?')}`);

    const usage = (msg['usage'] ?? msg['tokens']) as { input?: number; output?: number; input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      const input = usage.input ?? usage.input_tokens ?? 0;
      const output = usage.output ?? usage.output_tokens ?? 0;
      if (input || output) this.pushEvent(live, { kind: 'tokens', input, output, at: now() });
    }
    if (type.includes('error') || msg['error'] !== undefined) {
      this.pushEvent(live, { kind: 'error', message: String(msg['error'] ?? msg['message'] ?? 'error'), at: now() });
    }
  }

  // ── control (shared semantics) ────────────────────────────────────────

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
    throw new Error('opencode adapter is one-shot in this slice — conversational mode lands later');
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

  private mustGet(id: string): LiveAgent {
    const live = this.agents.get(id);
    if (!live) throw new Error(`unknown agent ${id}`);
    return live;
  }

  private setState(live: LiveAgent, state: AgentState): void {
    if (TERMINAL.has(live.handle.state)) return;
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
