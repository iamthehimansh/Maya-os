/**
 * maya code (`mayac`) adapter (contracts: AgentAdapter) — Maya running on its
 * OWN harness (packages/harness, published as @maya-os/code).
 *
 * Two spawn shapes, mirroring the Claude Code adapter:
 *
 * - `prompt` given → HEADLESS one-shot: `mayac -p "<prompt>"`. mayac streams the
 *   assistant's text to STDOUT and its telemetry to STDERR
 *   (`[tool] <name> {…}`, `[tool:done]`, `[error] …`, `[usage] in=N out=N $X`).
 *   That's the whole wire format — there is no --output-format json — so we map
 *   stderr lines to token/error events and treat accumulated stdout as the
 *   agent's reply, emitted as a single `say` on exit. send() is invalid.
 * - no `prompt` + `options.pty` → INTERACTIVE: the real full-screen Ink TUI in a
 *   pseudo-terminal, for standing team agents. send() types into it.
 *
 * Model wiring. mayac builds its Anthropic/OpenAI SDK client WITHOUT an explicit
 * baseURL (harness/src/providers/*.ts), so the official SDKs fall back to their
 * env defaults — `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`. That is our gateway
 * seam: point the right one at Maya and mayac routes every call through it,
 * keeping guardrails + metering, exactly like the Claude Code adapter does.
 *
 * Auth (`options.auth`):
 * - 'mayac-subscription' → `--auth subscription`: mayac resolves the OWNER's own
 *   login (~/.claude credentials for anthropic, ~/.codex for openai). We must NOT
 *   point it at the gateway or inject a dummy key, or we'd shadow that credential
 *   — same rule the codex adapter follows for 'codex-subscription'.
 * - default → `--auth api` against the Maya gateway with a dummy key.
 *
 * Two mayac CLI facts this adapter is built around (both verified against the
 * binary, see test/mayac-unit.test.ts):
 * - There is NO `--version` flag. mayac's parseArgs ignores unknown dash-flags,
 *   so `mayac --version` BOOTS THE TUI and hangs — detect() probes `--help`.
 * - There is no `--append-system-prompt`. A persona therefore rides IN-BAND:
 *   prepended to the headless prompt, or typed as the TUI's first turn. Silently
 *   dropping it would spawn a persona-less team agent.
 */

import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
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
import { loadPty } from '../pty.js';
import { mayacSessionExists, planSessionArgs, type SessionPlan } from '../session-args.js';

export interface MayacAdapterOptions {
  /** Maya gateway base, e.g. "http://127.0.0.1:4100". Anthropic-compat at the
   * root; "/v1" is appended for the OpenAI-compat provider. */
  gatewayBaseUrl: string;
  /** Override the CLI binary (tests). */
  mayacBin?: string;
  /**
   * Does the installed binary understand `--session-id`? Normally probed from
   * `--help` in detect(); set explicitly only in tests.
   */
  supportsSessionId?: boolean;
}

/** mayac's own provider ids (harness/src/providers/index.ts). */
export type MayacProvider = 'anthropic' | 'openai';

interface LiveAgent {
  handle: AgentHandle;
  /** Headless: piped child running `mayac -p`. Exactly one of child/pty is set. */
  child?: ChildProcess;
  /** PTY: the interactive Ink TUI in a pseudo-terminal. */
  pty?: IPty;
  log: EventLog;
  logs: AgentLogEvent[];
  interactive: boolean;
  stdoutBuf: string;
  stderrBuf: string;
  /** Headless: the assistant's text, accumulated from stdout → emitted as `say`. */
  sayBuf: string;
  /** PTY: serializes send() (type → Enter → settle) so two rapid channel
   * messages can't interleave into one garbled input line. Seeded with the
   * TUI-readiness gate so nothing is typed before the terminal renders. */
  sendChain?: Promise<void>;
  /** Rolling tail of raw output — surfaced on an unexpected exit so a silent
   * failure (bad model, expired token) becomes a visible channel error. */
  outTail: string;
}

const TERMINAL: ReadonlySet<AgentState> = new Set(['exited', 'killed', 'failed']);
const MAX_LOG_LINES = 10_000;
const INSTALL_HINT = 'npm install -g @maya-os/code';

/** `[usage] in=4260 out=6 $0.0043` — mayac's headless token line (on stderr). */
const USAGE_RE = /^\[usage\]\s+in=(\d+)\s+out=(\d+)/;

export class MayacAdapter implements AgentAdapter {
  readonly id = 'mayac';
  private readonly agents = new Map<string, LiveAgent>();
  private detected: { installed: boolean; version?: string; installHint?: string } | null = null;

  constructor(private readonly opts: MayacAdapterOptions) {}

  private bin(): string {
    return this.opts.mayacBin ?? 'mayac';
  }

  private _ptyBin?: string;
  /** Absolute path to mayac — node-pty's posix_spawnp doesn't PATH-resolve a
   * bare name like child_process does. Cached. */
  private ptyBin(): string {
    if (this._ptyBin) return this._ptyBin;
    const b = this.bin();
    if (b.includes('/')) return (this._ptyBin = b);
    try {
      this._ptyBin = execFileSync('which', [b], { encoding: 'utf8' }).trim() || b;
    } catch {
      this._ptyBin = b;
    }
    return this._ptyBin;
  }

  /**
   * mayac has NO `--version`: its parseArgs treats an unknown `-`-prefixed arg as
   * a no-op and falls through to the TUI, which would hang this probe forever.
   * `--help` prints usage and exits 0, so that's the liveness check. There is no
   * version on the wire to report — `version` is optional in the contract.
   */
  async detect(): Promise<{ installed: boolean; version?: string; installHint?: string }> {
    if (this.detected) return this.detected;
    const result = await new Promise<{ installed: boolean; version?: string; installHint?: string }>((resolve) => {
      execFile(this.bin(), ['--help'], { timeout: 30_000 }, (err, stdout) => {
        if (err || !/mayac/i.test(stdout)) {
          resolve({ installed: false, installHint: INSTALL_HINT });
          return;
        }
        // Capability probe, same --help we're already paying for. We spawn the
        // GLOBALLY INSTALLED mayac, which lags this repo: @maya-os/code@0.1.2 has
        // --resume but NO --session-id (verified: `mayac --help | grep session-id`
        // → 0 hits). Passing an unsupported flag there is NOT a harmless no-op —
        // its parseArgs drops the unknown dash-flag but its `default:` branch takes
        // the next BARE token as the prompt, so on an interactive (no -p) spawn —
        // exactly the standing-agent shape — the raw UUID becomes the agent's FIRST
        // TURN. That reads as a flaky agent, not a flag bug. So: only pass the flag
        // if the binary actually advertises it. (@harness found this; confirmed here.)
        this.sessionIdInHelp = /--session-id/.test(stdout);
        resolve({ installed: true });
      });
    });
    this.detected = result;
    return result;
  }

  /** Set by detect() from `--help`; undefined until then. */
  private sessionIdInHelp?: boolean;

  /**
   * Whether this binary can be given a session id. Explicit test override wins;
   * otherwise the --help probe. Before detect() has run we assume yes — spawn()
   * always detects first, so the real path is never un-probed.
   */
  private supportsSessionId(): boolean {
    return this.opts.supportsSessionId ?? this.sessionIdInHelp ?? true;
  }

  /** Maya's gateway is only for LOCAL models (`local/…`). Cloud models must talk
   * to the real provider directly — the gateway has NO route for
   * `claude-opus-4-8` etc., so routing them through it 404s ("model_not_found").
   * Explicit `options.gateway === true` can still force a cloud model through it. */
  private useGateway(spec: AgentSpawnSpec): boolean {
    if (spec.options?.['gateway'] === true) return true;
    return /^local\//i.test(spec.model);
  }

  /** True when this agent talks to the REAL provider (owner's own login or a real
   * key) rather than the Maya gateway — i.e. every cloud model. */
  private native(spec: AgentSpawnSpec): boolean {
    return !this.useGateway(spec);
  }

  /** Whether mayac runs on the owner's own subscription (`--auth subscription`).
   * A native (cloud) agent defaults to subscription — what the owner asked for,
   * and it Just Works off ~/.claude — unless a real API key is supplied or
   * `options.auth === 'api'` is explicit. Gateway agents are never "subscription". */
  private useSubscription(spec: AgentSpawnSpec): boolean {
    if (!this.native(spec)) return false;
    const auth = spec.options?.['auth'];
    if (auth === 'mayac-subscription' || auth === 'subscription') return true;
    if (auth === 'api') return false;
    const key = spec.env?.['ANTHROPIC_API_KEY'] ?? spec.env?.['OPENAI_API_KEY'];
    return !key; // no real key provided → use the owner's subscription
  }

  /**
   * Which mayac provider serves this agent. Explicit `options.provider` wins;
   * otherwise infer from the ModelId's gateway prefix (`openai/gpt-5.5` →
   * openai), defaulting to anthropic.
   */
  provider(spec: AgentSpawnSpec): MayacProvider {
    const explicit = spec.options?.['provider'];
    if (explicit === 'openai' || explicit === 'anthropic') return explicit;
    return /^openai\//i.test(spec.model) ? 'openai' : 'anthropic';
  }

  /**
   * The model name mayac should see. Gateway-backed agents pass the Maya ModelId
   * verbatim (the gateway resolves it). A native-subscription agent talks to the
   * real API, where `anthropic/claude-x` is not a model id — strip the provider
   * prefix or the SDK 404s. (Same rule as the Claude Code adapter's cliModel.)
   */
  private cliModel(spec: AgentSpawnSpec): string {
    // Gateway agents pass the Maya ModelId verbatim (the gateway resolves it).
    // Native (cloud) agents hit the real API, where `anthropic/claude-x` is not a
    // valid id — strip the provider prefix or the SDK 404s.
    if (this.useGateway(spec)) return spec.model;
    return spec.model.replace(/^(anthropic|openai)\//i, '');
  }

  /**
   * mayac has no --append-system-prompt, so a persona can only ride in-band.
   * Headless: prepend it to the prompt. (PTY: typed as the first turn — see
   * spawnPty.) Returning it rather than dropping it is the point: a standing
   * team agent's persona carries its inbox/outbox contract.
   */
  private preamble(spec: AgentSpawnSpec): string | undefined {
    const sp = spec.options?.['appendSystemPrompt'];
    return typeof sp === 'string' && sp.trim() ? sp : undefined;
  }

  /**
   * Session identity for a standing agent: `--session-id <id>` on first spawn,
   * `--resume <id>` on revive, so a stopped agent comes back as the SAME
   * conversation. mayac's store is `~/.maya-harness/sessions/<id>.json`; unlike
   * claude it has no UUID constraint (Maya passes a UUID anyway). See
   * ../session-args.ts. Pure — the caller surfaces `warning` once `live` exists.
   */
  private sessionPlan(spec: AgentSpawnSpec): SessionPlan {
    const plan = planSessionArgs(spec, { exists: mayacSessionExists, cli: 'mayac' });
    if (plan.args.length > 0 && !this.supportsSessionId()) {
      // An old global binary would turn the id into the agent's first prompt —
      // strip BOTH flags and say why. Amnesia across a revive, but a sane agent.
      return {
        args: [],
        warning:
          '[session] the installed mayac has no --session-id (upgrade @maya-os/code) — ' +
          'running WITHOUT session persistence: this agent will not remember across a revive.',
      };
    }
    return plan;
  }

  /** Exposed for unit tests — argv construction is a contract with the CLI. */
  buildArgs(spec: AgentSpawnSpec): string[] {
    if (spec.prompt === undefined) {
      throw new Error('mayac headless mode is one-shot — spawn with a prompt, or pass options.pty for the interactive TUI');
    }
    const args = ['--provider', this.provider(spec), '--model', this.cliModel(spec)];
    args.push('--auth', this.useSubscription(spec) ? 'subscription' : 'api');
    if (spec.cwd) args.push('--cwd', spec.cwd);
    // Headless mayac DENIES every gated action (write/bash) unless --yolo — an
    // 'auto' agent without it can read but never edit, the silent half-failure.
    if ((spec.permissionMode ?? 'auto') === 'auto') args.push('--yolo');
    args.push(...this.sessionPlan(spec).args);
    const preamble = this.preamble(spec);
    args.push('-p', preamble ? `${preamble}\n\n---\n\n${spec.prompt}` : spec.prompt);
    return args;
  }

  /** Args for the INTERACTIVE TUI (no -p): the real terminal, not headless. */
  buildPtyArgs(spec: AgentSpawnSpec): string[] {
    const args = ['--provider', this.provider(spec), '--model', this.cliModel(spec)];
    args.push('--auth', this.useSubscription(spec) ? 'subscription' : 'api');
    if (spec.cwd) args.push('--cwd', spec.cwd);
    if ((spec.permissionMode ?? 'auto') === 'auto') args.push('--yolo');
    args.push(...this.sessionPlan(spec).args);
    return args;
  }

  /**
   * Child env. The gateway seam is the SDKs' own base-URL env vars, which mayac
   * leaves unset (so they win). On native subscription we must clear any
   * inherited gateway pointer/dummy key instead, or it would shadow the owner's
   * real credential.
   */
  buildEnv(spec: AgentSpawnSpec): Record<string, string | undefined> {
    // Deterministic env: strip the launcher's Claude Code session identity so the
    // worker never behaves as a nested child (see the claude-code adapter).
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^CLAUDE_CODE_/.test(k) || k === 'CLAUDECODE' || k === 'AI_AGENT' || k === 'CLAUDE_EFFORT') continue;
      env[k] = v;
    }
    const provider = this.provider(spec);
    if (this.native(spec)) {
      // Cloud model → talk to the REAL provider, never the gateway. Clear any
      // inherited gateway base-URL/dummy key so it can't shadow the owner's real
      // credential; a real key supplied for `--auth api` rides in via spec.env.
      delete env['ANTHROPIC_BASE_URL'];
      delete env['OPENAI_BASE_URL'];
      delete env['ANTHROPIC_API_KEY'];
      delete env['OPENAI_API_KEY'];
      Object.assign(env, spec.env);
      if (this.useSubscription(spec)) {
        // Subscription resolves ~/.claude itself — drop any key so it wins.
        delete env['ANTHROPIC_API_KEY'];
        delete env['OPENAI_API_KEY'];
      }
      return env;
    }
    const base = this.opts.gatewayBaseUrl.replace(/\/$/, '');
    if (provider === 'openai') {
      Object.assign(env, spec.env, {
        // The gateway serves OpenAI-compat under /v1 (same base the codex adapter uses).
        OPENAI_BASE_URL: `${base}/v1`,
        OPENAI_API_KEY: spec.env?.['OPENAI_API_KEY'] ?? 'maya-gateway',
      });
    } else {
      Object.assign(env, spec.env, {
        ANTHROPIC_BASE_URL: base,
        // Any non-empty value satisfies the SDK; the gateway ignores it locally.
        ANTHROPIC_API_KEY: spec.env?.['ANTHROPIC_API_KEY'] ?? 'maya-gateway',
      });
    }
    return env;
  }

  async spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    const detect = await this.detect();
    if (!detect.installed) throw new Error(`mayac CLI not found — ${detect.installHint ?? INSTALL_HINT}`);

    const interactive = spec.prompt === undefined;
    // Headless mayac cannot take further turns, so an interactive spawn MUST be a
    // pty — fail loudly rather than spawning an agent whose send() can never work.
    if (interactive && spec.options?.['pty'] !== true) {
      throw new Error('mayac: an interactive agent (no prompt) requires options.pty — headless mayac is one-shot');
    }

    const id = 'ag_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const env = this.buildEnv(spec);
    const cwd = resolveCwd(spec.cwd); // expand ~ + ensure the dir exists (else spawn ENOENTs)

    if (interactive) return await this.spawnPty(id, spec, cwd, env);

    const child = spawn(this.bin(), this.buildArgs(spec), {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
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
    const live: LiveAgent = {
      handle,
      child,
      log: new EventLog(),
      logs: [],
      interactive: false,
      stdoutBuf: '',
      stderrBuf: '',
      sayBuf: '',
      outTail: '',
    };
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

    // Say what was dropped rather than silently running unscoped: mayac has no
    // CLI surface for these yet (its tool gating is --yolo / in-TUI prompts).
    const ignored = ['allowedTools', 'maxTurns', 'mcpConfig'].filter((k) => spec.options?.[k] !== undefined);
    if (ignored.length > 0) {
      this.pushLog(live, 'system', `[mayac] unsupported options ignored: ${ignored.join(', ')}`);
    }

    child.stdout?.on('data', (buf: Buffer) => this.onStdout(live, buf));
    child.stderr?.on('data', (buf: Buffer) => this.onStderr(live, buf));
    child.once('error', (err) => {
      this.setState(live, 'failed');
      this.pushEvent(live, { kind: 'error', message: String(err), at: now() });
      live.log.close();
    });
    child.once('exit', (code) => {
      // Flush partial trailing lines (no newline at EOF) before we finish.
      if (live.stdoutBuf) {
        this.onStdoutLine(live, live.stdoutBuf);
        live.stdoutBuf = '';
      }
      if (live.stderrBuf) {
        this.onStderrLine(live, live.stderrBuf);
        live.stderrBuf = '';
      }
      if (!TERMINAL.has(live.handle.state)) {
        live.handle = { ...live.handle, ...(code !== null ? { exitCode: code } : {}) };
        // The whole stdout of a headless run IS the agent's reply — emit it as one
        // `say` so the bus bridge posts a single clean channel message per turn.
        const say = live.sayBuf.trim();
        if (code === 0 && say) this.pushEvent(live, { kind: 'say', text: say, at: now() });
        if (code !== 0) {
          const tail = live.outTail.trim().slice(-400);
          this.pushEvent(live, {
            kind: 'error',
            message: `agent process exited (code ${code})${tail ? ': ' + tail : ''}`,
            at: now(),
          });
        }
        this.setState(live, code === 0 ? 'exited' : 'failed');
      }
      live.log.close();
    });

    this.setState(live, 'running');
    return live.handle;
  }

  /**
   * Interactive mayac in a real PTY — the Ink TUI, streamed to the dashboard as
   * `pty` events. Standing team agents run this way: the bridge types incoming
   * channel messages in (send()), and the agent speaks by appending to its outbox
   * file. mayac has no `/maya-team` command (that skill installs into Claude
   * Code's ~/.claude/commands), so the inbox/outbox contract is delivered as the
   * FIRST typed turn — see the persona preamble below.
   */
  private async spawnPty(
    id: string,
    spec: AgentSpawnSpec,
    cwd: string | undefined,
    env: Record<string, string | undefined>,
  ): Promise<AgentHandle> {
    // Lazy native-module load — keeps agent-runtime import-safe in the bundled CLI.
    const { spawn: ptySpawn } = await loadPty();
    const p = ptySpawn(this.ptyBin(), this.buildPtyArgs(spec), {
      name: 'xterm-256color',
      cols: 120,
      rows: 34,
      cwd: cwd ?? spec.cwd,
      env: env as Record<string, string>,
    });

    const handle: AgentHandle = {
      id,
      adapter: this.id,
      state: 'spawning',
      model: spec.model,
      cwd: cwd ?? spec.cwd,
      ...(p.pid !== undefined ? { pid: p.pid } : {}),
      spawnedAt: new Date().toISOString(),
    };
    const live: LiveAgent = {
      handle,
      pty: p,
      log: new EventLog(),
      logs: [],
      interactive: true,
      stdoutBuf: '',
      stderrBuf: '',
      sayBuf: '',
      outTail: '',
    };
    this.agents.set(id, live);

    // Did we actually reload a prior conversation, or are we starting clean?
    // Drives BOTH the warning below and whether the persona is re-typed.
    const plan = this.sessionPlan(spec);
    const resumed = plan.args[0] === '--resume';
    if (plan.warning) this.pushLog(live, 'system', plan.warning);

    const killPty = (): void => {
      try {
        p.kill();
      } catch {
        /* gone */
      }
    };
    process.once('exit', killPty);

    // Readiness gate: send() waits until the TUI has actually rendered (first
    // output + a settle beat) so text isn't typed into a not-yet-started
    // terminal; a 10s cap keeps a silent start from wedging sends forever.
    let readyArmed = false;
    let readyDone = false;
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => {
      readyResolve = (): void => {
        if (!readyDone) {
          readyDone = true;
          resolve();
        }
      };
    });
    const readyCap = setTimeout(() => readyResolve(), 10_000);
    readyCap.unref?.();
    live.sendChain = ready;

    p.onData((data: string) => {
      live.outTail = (live.outTail + data).slice(-2000);
      this.pushEvent(live, { kind: 'pty', data, at: now() });
      if (!readyArmed) {
        readyArmed = true;
        setTimeout(() => {
          clearTimeout(readyCap);
          readyResolve();
        }, 1200);
      }
    });
    p.onExit(({ exitCode }: { exitCode: number }) => {
      process.removeListener('exit', killPty);
      if (!TERMINAL.has(live.handle.state)) {
        live.handle = { ...live.handle, exitCode };
        if (exitCode !== 0) {
          const tail = live.outTail.trim().slice(-400);
          this.pushEvent(live, {
            kind: 'error',
            message: `agent pty exited (code ${exitCode})${tail ? ': ' + tail : ''}`,
            at: now(),
          });
        }
        this.setState(live, exitCode === 0 ? 'exited' : 'failed');
      }
      live.log.close();
    });

    this.setState(live, 'running');

    // The persona/walkie contract as turn 0 (mayac has no --append-system-prompt).
    // Queued through sendChain, so it lands after the TUI renders and BEFORE any
    // channel message the bridge types in.
    //
    // NOT on a successful resume: the persona is already the first turn of the
    // reloaded transcript. Re-typing it would burn a turn re-answering "reply with
    // ONE short line to confirm" — and its "do not explore or change anything now"
    // frame would stall an agent that was mid-task when it was stopped. A degraded
    // revive (transcript gone → fresh session, `resumed` false) DOES re-send it:
    // that agent has no persona at all and would otherwise come back inert.
    //
    // The FRAME matters, and both halves of it are load-bearing (observed on a
    // live haiku agent without them): a bare persona reads as a TASK, so the agent
    // went off exploring its cwd and asked "what do you want me to do?"; and when
    // later told to reply on the channel it wrote a RELATIVE `out.jsonl` into its
    // workspace instead of the absolute outbox the bridge watches — so its reply
    // never reached the room. Say "standing contract, not a task" and "absolute
    // paths only" explicitly.
    const preamble = this.preamble(spec);
    if (preamble && !resumed) {
      const framed =
        '[STANDING INSTRUCTIONS — your operating contract, NOT a task. Do not explore or change anything now: ' +
        'reply with ONE short line to confirm, then wait for messages. When these instructions give you a file ' +
        'path, always use that EXACT ABSOLUTE path — never a relative filename in your working directory.]\n\n' +
        preamble;
      void this.send(id, framed).catch(() => {});
    }

    return live.handle;
  }

  // ── output mapping ──────────────────────────────────────────────────────

  private onStdout(live: LiveAgent, buf: Buffer): void {
    const raw = buf.toString();
    live.outTail = (live.outTail + raw).slice(-2000);
    live.sayBuf += raw; // stdout IS the assistant's text in headless mayac
    live.stdoutBuf += raw;
    for (;;) {
      const nl = live.stdoutBuf.indexOf('\n');
      if (nl === -1) return;
      const line = live.stdoutBuf.slice(0, nl);
      live.stdoutBuf = live.stdoutBuf.slice(nl + 1);
      if (line.trim()) this.onStdoutLine(live, line);
    }
  }

  private onStdoutLine(live: LiveAgent, line: string): void {
    this.pushLog(live, 'stdout', line);
  }

  private onStderr(live: LiveAgent, buf: Buffer): void {
    const raw = buf.toString();
    live.outTail = (live.outTail + raw).slice(-2000);
    live.stderrBuf += raw;
    for (;;) {
      const nl = live.stderrBuf.indexOf('\n');
      if (nl === -1) return;
      const line = live.stderrBuf.slice(0, nl);
      live.stderrBuf = live.stderrBuf.slice(nl + 1);
      if (line.trim()) this.onStderrLine(live, line);
    }
  }

  /**
   * Exposed for unit tests. mayac's headless telemetry is plain text on stderr
   * (harness/src/cli.ts): `[tool] <name> {json}`, `[tool:done]`, `[error] <msg>`,
   * `[permission] denied …`, `[usage] in=N out=N $X`.
   */
  onStderrLine(live: LiveAgent, line: string): void {
    const text = line.trim();
    if (!text) return;

    const usage = USAGE_RE.exec(text);
    if (usage) {
      const input = Number(usage[1]);
      const output = Number(usage[2]);
      if (input > 0 || output > 0) this.pushEvent(live, { kind: 'tokens', input, output, at: now() });
      return;
    }
    if (text.startsWith('[error]')) {
      this.pushEvent(live, { kind: 'error', message: text.slice('[error]'.length).trim() || 'error', at: now() });
      return;
    }
    // A denied gated action is why an agent "did nothing" — keep it visible.
    if (text.startsWith('[permission]') || text.startsWith('[tool:done]') || text.startsWith('[tool]')) {
      this.pushLog(live, 'system', text);
      return;
    }
    this.pushLog(live, 'stderr', text);
  }

  // ── control ─────────────────────────────────────────────────────────────

  async pause(id: string): Promise<void> {
    const live = this.mustGet(id);
    if (live.handle.state !== 'running' && live.handle.state !== 'waiting_input') {
      throw new Error(`cannot pause from state ${live.handle.state}`);
    }
    if (live.pty) process.kill(live.pty.pid, 'SIGSTOP');
    else live.child?.kill('SIGSTOP');
    this.setState(live, 'paused');
  }

  async resume(id: string): Promise<void> {
    const live = this.mustGet(id);
    if (live.handle.state !== 'paused') throw new Error(`cannot resume from state ${live.handle.state}`);
    if (live.pty) process.kill(live.pty.pid, 'SIGCONT');
    else live.child?.kill('SIGCONT');
    this.setState(live, 'running');
  }

  async kill(id: string, graceMs = 3000): Promise<void> {
    const live = this.mustGet(id);
    if (TERMINAL.has(live.handle.state)) return;
    this.setState(live, 'killed');

    if (live.pty) {
      // Graceful (SIGHUP) first — an interactive TUI can ignore it — then force,
      // awaiting the ACTUAL exit so kill/drain never resolve with it still alive.
      const p = live.pty;
      const exited = new Promise<void>((resolve) => p.onExit(() => resolve()));
      try {
        p.kill();
      } catch {
        /* gone */
      }
      const escalate = setTimeout(() => {
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, graceMs);
      escalate.unref?.();
      await Promise.race([exited, sleep(graceMs + 2000)]);
      clearTimeout(escalate);
      return;
    }

    const child = live.child;
    if (!child) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Deliver a turn to an interactive (pty) agent by TYPING it into the TUI. */
  async send(id: string, text: string): Promise<void> {
    const live = this.mustGet(id);
    if (!live.interactive || !live.pty) {
      throw new Error('headless mayac agent (spawned with a prompt) cannot receive input — spawn with options.pty');
    }
    if (TERMINAL.has(live.handle.state)) throw new Error(`agent is ${live.handle.state}`);

    // Type, then submit with Enter a beat later — the Ink input needs the text to
    // register before the newline submits it. Serialized through the per-agent
    // chain (seeded by the readiness gate): without it, two sends ~400ms apart
    // type into the same box and submit as one merged prompt.
    //
    // The chunk shape is a hard contract with mayac's TUI paste handler
    // (harness/src/tui/App.tsx), which treats ANY multi-char write as a paste.
    // See ptyChunk() for the two heuristics we have to thread between.
    const p = live.pty;
    const chunk = ptyChunk(text);
    const run = async (): Promise<void> => {
      try {
        p.write(chunk);
        await sleep(400);
        p.write('\r');
        await sleep(150); // settle before the next queued send types
      } catch {
        /* pty gone mid-send */
      }
    };
    const chained = (live.sendChain ?? Promise.resolve()).then(run);
    live.sendChain = chained;
    await chained;

    if (live.handle.state === 'waiting_input') this.setState(live, 'running');
  }

  /** RAW pty passthrough for the dashboard's interactive terminal — the human's
   * keystrokes go straight through (no Enter appended, no escaping). */
  writeRaw(id: string, data: string): void {
    const live = this.mustGet(id);
    if (!live.pty) throw new Error('raw terminal input needs a pty agent');
    if (TERMINAL.has(live.handle.state)) throw new Error(`agent is ${live.handle.state}`);
    live.pty.write(data);
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

  // ── internals ───────────────────────────────────────────────────────────

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shape one typed turn so mayac's TUI takes it as LITERAL TEXT.
 *
 * Its input handler treats any multi-char write as a paste and applies two
 * heuristics before the text ever reaches the input box
 * (harness/src/tui/{App.tsx,attach.ts}) — we have to thread between both:
 *
 * 1. DRAG DETECTION. `parseDroppedPaths()` splits the chunk on spaces; every
 *    token that resolves to an existing file becomes an attachment, and the
 *    handler then `return`s — THE ENTIRE MESSAGE TEXT IS DISCARDED. A standing
 *    agent's persona names its real inbox/outbox files, so a one-line chunk was
 *    silently eaten: the TUI showed "✓ attached in.jsonl, out.jsonl" and the
 *    agent, never having seen its brief, went hunting the filesystem for them
 *    (observed live). The parser bails on a chunk containing '\n' — but it
 *    `trim()`s FIRST, so a leading/trailing newline is stripped and does nothing.
 *    Only an INTERIOR newline immunizes the chunk.
 * 2. LARGE-PASTE COLLAPSE. A chunk of >= LARGE_PASTE_LINES (4) lines is collapsed
 *    into a "pasted text" chip instead of literal input. So we flatten the text's
 *    own newlines and stay at exactly 2 lines.
 *
 * Hence: flatten to one logical line, then promote the LAST space to a newline —
 * an interior break that reads identically to the model (a newline where a space
 * was) but adds no foreign tokens. A single word with no space can't be split;
 * that degrades to the drag path only if it names a real file, which for a bare
 * one-word channel message is the human-intended "attach it" behavior anyway.
 *
 * DO NOT DELETE THIS once the TUI's own parser is fixed upstream. We spawn the
 * GLOBALLY INSTALLED `mayac` binary, not this repo's packages/harness source — a
 * source-side fix reaches agents only after mayac is rebuilt, published AND
 * re-installed, and an owner still on an older global would silently regress to
 * having every persona swallowed. Against a fixed TUI this is a no-op (a 2-line
 * chunk is literal text either way), so it stays as the compat shim for old
 * binaries. (@tui, who owns attach.ts, concurred.)
 */
export function ptyChunk(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ').trim();
  const lastSpace = flat.lastIndexOf(' ');
  return lastSpace > 0 ? `${flat.slice(0, lastSpace)}\n${flat.slice(lastSpace + 1)}` : flat;
}
