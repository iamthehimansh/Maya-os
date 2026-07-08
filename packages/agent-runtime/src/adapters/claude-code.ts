/**
 * Claude Code adapter (contracts: AgentAdapter).
 *
 * Headless integration via `claude --print --output-format stream-json` —
 * structured NDJSON events, no PTY/ANSI scraping (a PTY mode for attended
 * sessions is a later slice). Two spawn shapes:
 *
 * - `prompt` given → one-shot: the task is argv's positional prompt; the
 *   agent runs to completion; send() is invalid.
 * - no `prompt` → conversational: `--input-format stream-json` keeps stdin
 *   open; send() delivers user turns (the Loop lead's mode).
 *
 * Model wiring (proven by 02 on the gateway): every model is a gateway
 * ModelId — we point ANTHROPIC_BASE_URL at Maya and pass `--model <ModelId>`,
 * so Claude Code runs on local GGUFs and cloud models alike, and the gateway
 * keeps guardrails + metering. Keys: a dummy ANTHROPIC_API_KEY satisfies the
 * CLI against the localhost gateway; never logged.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveCwd } from '../cwd.js';
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

/**
 * Resolve a cldz saved profile (~/.cldz/config.json) to the auth env vars Claude
 * Code needs, so a Maya agent can run on the OWNER's real Claude auth (cloud
 * Opus/Sonnet) instead of the local gateway — needed for hard work a small local
 * model can't do. Reads secrets and returns them for the child ENV only; NEVER
 * logs or returns them anywhere they'd be printed. (Same seam cldz itself uses.)
 */
function cldzProfileEnv(profileName?: string): Record<string, string> {
  const home = process.env['CLDZ_HOME']?.trim() || join(homedir(), '.cldz');
  const cfgPath = join(home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    defaultProfile?: string;
    profiles?: Record<string, { type: string; apiKey?: string; oauthToken?: string; baseUrl?: string; authToken?: string }>;
  };
  const name = profileName && profileName !== 'default' ? profileName : cfg.defaultProfile;
  const p = name ? cfg.profiles?.[name] : undefined;
  if (!p) throw new Error(`cldz profile "${name ?? '(default)'}" not found in ${cfgPath}`);
  const env: Record<string, string> = {};
  switch (p.type) {
    case 'apiKey':
      if (p.apiKey) env['ANTHROPIC_API_KEY'] = p.apiKey;
      break;
    case 'oauth':
      if (p.oauthToken) env['CLAUDE_CODE_OAUTH_TOKEN'] = p.oauthToken;
      break;
    case 'gateway':
      if (p.baseUrl) env['ANTHROPIC_BASE_URL'] = p.baseUrl;
      if (p.authToken) env['ANTHROPIC_AUTH_TOKEN'] = p.authToken;
      break;
    default:
      throw new Error(`cldz profile type "${p.type}" not yet supported by the adapter`);
  }
  if (Object.keys(env).length === 0) throw new Error(`cldz profile "${name}" has no usable credential`);
  return env;
}

/** List cldz profile NAMES + types (never secrets) so the web can offer a
 * profile picker for a spawned agent. Empty if there's no cldz config. */
export function listCldzProfiles(): Array<{ name: string; type: string; default: boolean }> {
  try {
    const home = process.env['CLDZ_HOME']?.trim() || join(homedir(), '.cldz');
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      defaultProfile?: string;
      profiles?: Record<string, { type: string }>;
    };
    return Object.entries(cfg.profiles ?? {}).map(([name, p]) => ({ name, type: p.type, default: name === cfg.defaultProfile }));
  } catch {
    return [];
  }
}

export interface ClaudeCodeAdapterOptions {
  /** Maya gateway base (Anthropic-compatible), e.g. "http://127.0.0.1:4100". */
  gatewayBaseUrl: string;
  /** Override the CLI binary (tests). */
  claudeBin?: string;
}

interface LiveAgent {
  handle: AgentHandle;
  child: ChildProcess;
  log: EventLog;
  logs: AgentLogEvent[];
  interactive: boolean;
  stdoutBuf: string;
  /** Rolling tail of raw stdout+stderr — surfaced on an unexpected exit so a
   * silent spawn failure (bad model, over-quota/expired cldz token, missing
   * binary) becomes a visible channel message instead of a mystery. */
  outTail: string;
}

const TERMINAL: ReadonlySet<AgentState> = new Set(['exited', 'killed', 'failed']);
const MAX_LOG_LINES = 10_000;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  private readonly agents = new Map<string, LiveAgent>();
  private detected: { installed: boolean; version?: string; installHint?: string } | null = null;

  constructor(private readonly opts: ClaudeCodeAdapterOptions) {}

  private bin(): string {
    return this.opts.claudeBin ?? 'claude';
  }

  async detect(): Promise<{ installed: boolean; version?: string; installHint?: string }> {
    if (this.detected) return this.detected;
    const result = await new Promise<{ installed: boolean; version?: string; installHint?: string }>((resolve) => {
      execFile(this.bin(), ['--version'], { timeout: 30_000 }, (err, stdout) => {
        if (err) {
          resolve({ installed: false, installHint: 'npm install -g @anthropic-ai/claude-code' });
          return;
        }
        const version = stdout.trim().split(/\s+/)[0];
        resolve(version !== undefined ? { installed: true, version } : { installed: true });
      });
    });
    this.detected = result;
    return result;
  }

  /** Exposed for unit tests — argv construction is a contract with the CLI. */
  buildArgs(spec: AgentSpawnSpec): string[] {
    const interactive = spec.prompt === undefined;
    const args = ['--print', '--output-format', 'stream-json', '--verbose'];
    if (interactive) args.push('--input-format', 'stream-json');
    else args.push(spec.prompt as string);
    args.push('--model', spec.model);
    if ((spec.permissionMode ?? 'auto') === 'auto') args.push('--dangerously-skip-permissions');
    // Worker scoping (the Loop lead relies on these): restrict the tool
    // surface and cap agentic turns — small local models especially need
    // guardrails against tool-hallucination loops.
    const opts = spec.options ?? {};
    const allowedTools = opts['allowedTools'];
    if (Array.isArray(allowedTools) && allowedTools.length > 0) {
      args.push('--allowed-tools', allowedTools.join(','));
      args.push('--tools', allowedTools.join(','));
    }
    const maxTurns = opts['maxTurns'];
    if (typeof maxTurns === 'number' && maxTurns > 0) args.push('--max-turns', String(maxTurns));
    return args;
  }

  async spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    const detect = await this.detect();
    if (!detect.installed) throw new Error(`claude CLI not found — ${detect.installHint ?? ''}`);

    const id = 'ag_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const interactive = spec.prompt === undefined;

    // A worker must run in a DETERMINISTIC env, independent of who launched
    // the orchestrator. When Maya runs inside a Claude Code session (or its
    // serve is nohup'd from one), process.env carries CLAUDE_CODE_* /
    // CLAUDECODE / AI_AGENT session-identity vars — inheriting them makes the
    // spawned worker behave as a NESTED child (observed: it silently declined
    // to write the file). Strip that identity so behavior is reproducible.
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^CLAUDE_CODE_/.test(k) || k === 'CLAUDECODE' || k === 'AI_AGENT' || k === 'CLAUDE_EFFORT') continue;
      env[k] = v;
    }
    // Auth (set AFTER the strip loop so a profile's CLAUDE_CODE_OAUTH_TOKEN
    // survives): a cldz saved profile → the OWNER's real Claude (cloud
    // Opus/Sonnet for work a local model can't do), else Maya's local gateway.
    const cldzProfile = spec.options?.['cldzProfile'];
    if (cldzProfile !== undefined && cldzProfile !== false) {
      Object.assign(env, spec.env, cldzProfileEnv(typeof cldzProfile === 'string' ? cldzProfile : undefined), {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
    } else {
      Object.assign(env, spec.env, {
        ANTHROPIC_BASE_URL: this.opts.gatewayBaseUrl,
        // Any non-empty value satisfies the CLI; the gateway ignores it locally.
        ANTHROPIC_API_KEY: spec.env?.['ANTHROPIC_API_KEY'] ?? 'maya-gateway',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
    }
    // spec.bus wiring note: the bus token must already be present in env
    // under spec.bus.tokenEnv (minted by the orchestrator) — this adapter
    // never mints or logs credentials. Auto-join lands with the loop slice.

    const cwd = resolveCwd(spec.cwd); // expand ~ + ensure the dir exists (else spawn ENOENTs)
    const child = spawn(this.bin(), this.buildArgs(spec), {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const handle: AgentHandle = {
      id,
      adapter: this.id,
      state: 'spawning',
      model: spec.model,
      cwd: cwd ?? spec.cwd,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      spawnedAt: new Date().toISOString(),
    };
    const live: LiveAgent = { handle, child, log: new EventLog(), logs: [], interactive, stdoutBuf: '', outTail: '' };
    this.agents.set(id, live);

    // Orphan guard (02's pattern): our exit takes the child with us; the
    // listener is removed when the child exits so it can't accumulate.
    const killChild = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    process.once('exit', killChild);
    child.once('exit', () => process.removeListener('exit', killChild));

    child.stdout?.on('data', (buf: Buffer) => this.onStdout(live, buf));
    child.stderr?.on('data', (buf: Buffer) => {
      const s = buf.toString();
      live.outTail = (live.outTail + s).slice(-2000);
      this.pushLog(live, 'stderr', s);
    });
    child.once('error', (err) => {
      this.setState(live, 'failed');
      this.pushEvent(live, { kind: 'error', message: String(err), at: now() });
      live.log.close();
    });
    child.once('exit', (code) => {
      if (!TERMINAL.has(live.handle.state)) {
        live.handle = { ...live.handle, ...(code !== null ? { exitCode: code } : {}) };
        // An unexpected non-zero exit (a pause/kill would already have set a
        // terminal state) is a spawn/runtime failure — surface its output so it's
        // not silent. The bridge posts `error` events to the channel, so e.g. a
        // cldz over-quota "You've hit your weekly limit" now shows up immediately
        // instead of an agent that mysteriously never does anything.
        if (code !== 0) {
          const tail = live.outTail.trim().slice(-400);
          this.pushEvent(live, { kind: 'error', message: `agent process exited (code ${code})${tail ? ': ' + tail : ''}`, at: now() });
        }
        this.setState(live, code === 0 ? 'exited' : 'failed');
      }
      live.log.close();
    });

    this.setState(live, 'running');
    return live.handle;
  }

  // ── stream-json parsing ────────────────────────────────────────────────

  private onStdout(live: LiveAgent, buf: Buffer): void {
    const raw = buf.toString();
    live.outTail = (live.outTail + raw).slice(-2000); // for exit-failure surfacing (e.g. a plain-text quota error on stdout)
    live.stdoutBuf += raw;
    for (;;) {
      const nl = live.stdoutBuf.indexOf('\n');
      if (nl === -1) return;
      const line = live.stdoutBuf.slice(0, nl).trim();
      live.stdoutBuf = live.stdoutBuf.slice(nl + 1);
      if (line) this.onStreamLine(live, line);
    }
  }

  /** Exposed for unit tests — maps one stream-json line to AgentEvents. */
  onStreamLine(live: LiveAgent, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.pushLog(live, 'stdout', line);
      return;
    }
    const type = msg['type'];
    if (type === 'system') {
      this.pushLog(live, 'system', `[system] ${String(msg['subtype'] ?? '')}`);
      return;
    }
    if (type === 'assistant' || type === 'user') {
      const message = msg['message'] as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          this.pushLog(live, 'stdout', block['text']);
        } else if (block['type'] === 'tool_use') {
          this.pushLog(live, 'stdout', `[tool] ${String(block['name'] ?? '?')}`);
        } else if (block['type'] === 'tool_result') {
          this.pushLog(live, 'system', '[tool result]');
        }
      }
      return;
    }
    if (type === 'result') {
      // Token accounting must be robust to the result shape varying through
      // the Anthropic-compat translation. Primary: top-level `usage`
      // (input_tokens/output_tokens). Fallback: `modelUsage` (per-model,
      // camelCase) — sum across models. Emit whichever yields a non-zero.
      const usage = msg['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
      let input = usage?.input_tokens ?? 0;
      let output = usage?.output_tokens ?? 0;
      if (input === 0 && output === 0) {
        const modelUsage = msg['modelUsage'] as Record<string, { inputTokens?: number; outputTokens?: number }> | undefined;
        if (modelUsage) {
          for (const u of Object.values(modelUsage)) {
            input += u.inputTokens ?? 0;
            output += u.outputTokens ?? 0;
          }
        }
      }
      if (input > 0 || output > 0) {
        this.pushEvent(live, { kind: 'tokens', input, output, at: now() });
      }
      const ok = msg['subtype'] === 'success';
      if (typeof msg['result'] === 'string' && msg['result'].trim()) {
        this.pushLog(live, 'stdout', msg['result']); // keep for lastOutput + tool-call counting
        // The completed turn is the agent's reply — a first-class 'say' so the
        // bridge posts it to the channel (one clean message per turn, not the
        // intermediate blocks, so a busy worker doesn't flood the room).
        this.pushEvent(live, { kind: 'say', text: msg['result'], at: now() });
      }
      if (!ok) this.pushEvent(live, { kind: 'error', message: String(msg['subtype'] ?? 'error'), at: now() });
      // One-shot runs end after result; conversational agents await more turns.
      if (!live.interactive) this.setState(live, ok ? 'exited' : 'failed');
      return;
    }
    this.pushLog(live, 'system', line);
  }

  // ── control ────────────────────────────────────────────────────────────

  async pause(id: string): Promise<void> {
    const live = this.mustGet(id);
    if (live.handle.state !== 'running' && live.handle.state !== 'waiting_input') {
      throw new Error(`cannot pause from state ${live.handle.state}`);
    }
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

  async send(id: string, text: string): Promise<void> {
    const live = this.mustGet(id);
    if (!live.interactive) throw new Error('one-shot agent (spawned with a prompt) cannot receive input');
    if (TERMINAL.has(live.handle.state)) throw new Error(`agent is ${live.handle.state}`);
    const turn = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    live.child.stdin?.write(JSON.stringify(turn) + '\n');
    if (live.handle.state === 'waiting_input') this.setState(live, 'running');
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

  /** All handles this adapter has spawned (registry facade uses this). */
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
