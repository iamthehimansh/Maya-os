/**
 * Session identity: a revived agent must resume its SAME conversation.
 *
 * The bug this pins: a stopped agent used to come back as a BLANK conversation —
 * a drained team could never be picked up and a serve restart lobotomised
 * everyone. And the naive fix is a trap: agents on one team SHARE a cwd, so
 * `--continue` (resume the most recent conversation *in this directory*) would
 * hand agents EACH OTHER's sessions. Hence a stable per-agent id:
 * `--session-id <id>` on first spawn, `--resume <id>` on every revive.
 *
 * Flags verified against the real CLI before these were written:
 *   $ claude --help
 *     --session-id <uuid>   Use a specific session ID for the conversation
 *                           (must be a valid UUID)          <-- the UUID rule below
 *     -r, --resume [value]  Resume a conversation by session ID
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSpawnSpec } from '@maya-ai/core';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { MayacAdapter } from '../src/adapters/mayac.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { claudeSessionExists, mayacSessionExists, planSessionArgs } from '../src/session-args.js';

const GATEWAY = 'http://127.0.0.1:4100';
const claude = new ClaudeCodeAdapter({ gatewayBaseUrl: GATEWAY });
const mayac = new MayacAdapter({ gatewayBaseUrl: GATEWAY });

/** Two REAL UUIDs — `--session-id` rejects anything else. */
const ID_A = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ID_B = 'b1ca9a1e-1f4d-4a2b-9c3e-77f0a1d2e5b7';

/** The team's shared workspace — the whole reason `--continue` is unusable. */
const SHARED_CWD = '/tmp/team-workspace';

const claudeSpec = (options: Record<string, unknown>): AgentSpawnSpec => ({
  adapter: 'claude-code',
  model: 'anthropic/claude-opus-4-8',
  cwd: SHARED_CWD,
  options: { pty: true, ...options },
});

const mayacSpec = (options: Record<string, unknown>): AgentSpawnSpec => ({
  adapter: 'mayac',
  model: 'local/qwen2.5-7b-instruct',
  cwd: SHARED_CWD,
  options: { pty: true, ...options },
});

/** A transcript that exists / doesn't, without touching the real $HOME. */
const found = (): boolean => true;
const gone = (): boolean => false;

/**
 * The ADAPTERS probe the real filesystem (that's the point — a revive must not
 * `--resume` a transcript that isn't there). `os.homedir()` honours $HOME on
 * POSIX, so we point HOME at a temp dir and stage real transcript files there.
 */
const REAL_HOME = process.env['HOME'];
afterEach(() => {
  process.env['HOME'] = REAL_HOME;
});

/** A temp $HOME holding real transcripts for the given ids. */
function homeWithTranscripts(ids: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'maya-home-'));
  const proj = join(home, '.claude', 'projects', '-tmp-team-workspace');
  const mayacDir = join(home, '.maya-harness', 'sessions');
  mkdirSync(proj, { recursive: true });
  mkdirSync(mayacDir, { recursive: true });
  for (const id of ids) {
    writeFileSync(join(proj, `${id}.jsonl`), '{}\n');
    writeFileSync(join(mayacDir, `${id}.json`), '{}');
  }
  process.env['HOME'] = home;
  return home;
}

describe('planSessionArgs — first spawn vs revive', () => {
  const opts = { exists: found, cli: 'claude', requireUuid: true };

  it('FIRST spawn writes the conversation under the assigned id (--session-id)', () => {
    const plan = planSessionArgs(claudeSpec({ sessionId: ID_A }), opts);
    expect(plan.args).toEqual(['--session-id', ID_A]);
    expect(plan.warning).toBeUndefined();
  });

  it('REVIVE reloads that exact conversation (--resume), never --continue', () => {
    const plan = planSessionArgs(claudeSpec({ sessionId: ID_A, resumeSession: true }), opts);
    expect(plan.args).toEqual(['--resume', ID_A]);
    expect(plan.args).not.toContain('--continue');
    expect(plan.warning).toBeUndefined();
  });

  it('resumeSession: false is a first spawn, not a revive', () => {
    expect(planSessionArgs(claudeSpec({ sessionId: ID_A, resumeSession: false }), opts).args).toEqual([
      '--session-id',
      ID_A,
    ]);
  });

  it('an agent with NO sessionId is untouched (a one-shot worker keeps working)', () => {
    expect(planSessionArgs(claudeSpec({}), opts).args).toEqual([]);
    expect(planSessionArgs(claudeSpec({ sessionId: '' }), opts).args).toEqual([]);
  });

  // The orchestrator emits the TYPED top-level fields; the options bag is an
  // accepted alias. Both must reach the CLI, or a standing agent spawns with no
  // session identity and silently loses its memory on the next revive.
  it('reads the top-level typed fields (the shape team-manager emits)', () => {
    const first: AgentSpawnSpec = { adapter: 'claude-code', model: 'anthropic/claude-opus-4-8', cwd: SHARED_CWD, sessionId: ID_A };
    expect(planSessionArgs(first, opts).args).toEqual(['--session-id', ID_A]);

    const revive: AgentSpawnSpec = { ...first, resumeSession: true };
    expect(planSessionArgs(revive, opts).args).toEqual(['--resume', ID_A]);
  });

  it('top-level and options-bag spawns produce identical argv', () => {
    const viaField: AgentSpawnSpec = {
      adapter: 'claude-code',
      model: 'anthropic/claude-opus-4-8',
      cwd: SHARED_CWD,
      sessionId: ID_A,
      resumeSession: true,
      options: { pty: true },
    };
    expect(claude.buildPtyArgs(viaField)).toEqual(
      claude.buildPtyArgs(claudeSpec({ sessionId: ID_A, resumeSession: true })),
    );
  });
});

describe('the --continue trap: two agents, ONE cwd', () => {
  it('two agents in the SAME cwd resume their OWN id — never each other’s', () => {
    homeWithTranscripts([ID_A, ID_B]); // both have really been alive before
    const a = claude.buildPtyArgs(claudeSpec({ sessionId: ID_A, resumeSession: true }));
    const b = claude.buildPtyArgs(claudeSpec({ sessionId: ID_B, resumeSession: true }));

    expect(a).toEqual(expect.arrayContaining(['--resume', ID_A]));
    expect(b).toEqual(expect.arrayContaining(['--resume', ID_B]));
    expect(a).toContain(ID_A);
    expect(a).not.toContain(ID_B); // <-- the cross-resume that `--continue` would cause
    expect(b).toContain(ID_B);
    expect(b).not.toContain(ID_A);
    // Neither agent may EVER be resumed by directory.
    expect([...a, ...b]).not.toContain('--continue');
    expect([...a, ...b]).not.toContain('-c');
  });
});

describe('fallback: the transcript is gone (owner cleared history)', () => {
  it('degrades to a FRESH session under the SAME id — and says so, instead of crashing', () => {
    const plan = planSessionArgs(claudeSpec({ sessionId: ID_A, resumeSession: true }), {
      exists: gone,
      cli: 'claude',
      requireUuid: true,
    });
    // Not `--resume` (the CLI would exit with an error and the agent would never
    // come back); the id is KEPT, so the NEXT revive resumes normally.
    expect(plan.args).toEqual(['--session-id', ID_A]);
    expect(plan.warning).toMatch(/no claude transcript/i);
    expect(plan.warning).toMatch(/lost its prior context/i);
  });

  it('a non-UUID id warns and runs WITHOUT session flags (claude rejects non-UUIDs)', () => {
    const plan = planSessionArgs(claudeSpec({ sessionId: 'sess_abc123', resumeSession: true }), {
      exists: found,
      cli: 'claude',
      requireUuid: true,
    });
    expect(plan.args).toEqual([]); // never pass a bad id — the spawn would fail
    expect(plan.warning).toMatch(/requires a UUID/i);
  });

  it('mayac has no UUID rule — a plain id is passed through', () => {
    const plan = planSessionArgs(mayacSpec({ sessionId: 'sess_abc123' }), { exists: found, cli: 'mayac' });
    expect(plan.args).toEqual(['--session-id', 'sess_abc123']);
    expect(plan.warning).toBeUndefined();
  });
});

describe('transcript probes (real files, temp $HOME)', () => {
  it('claudeSessionExists finds <id>.jsonl under ANY project dir, and misses when absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'maya-home-'));
    const proj = join(home, '.claude', 'projects', '-tmp-team-workspace');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${ID_A}.jsonl`), '{}\n');

    expect(claudeSessionExists(ID_A, home)).toBe(true);
    expect(claudeSessionExists(ID_B, home)).toBe(false);
  });

  it('claudeSessionExists is false (not a throw) when ~/.claude/projects does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'maya-home-'));
    expect(claudeSessionExists(ID_A, home)).toBe(false);
  });

  it('mayacSessionExists reads ~/.maya-harness/sessions/<id>.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'maya-home-'));
    const dir = join(home, '.maya-harness', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID_A}.json`), '{}');

    expect(mayacSessionExists(ID_A, home)).toBe(true);
    expect(mayacSessionExists(ID_B, home)).toBe(false);
  });
});

describe('argv contract — the flags actually reach each CLI', () => {
  it('claude PTY (a standing team agent): --session-id first, --resume on revive', () => {
    homeWithTranscripts([ID_A]);
    expect(claude.buildPtyArgs(claudeSpec({ sessionId: ID_A }))).toEqual(
      expect.arrayContaining(['--session-id', ID_A]),
    );
    expect(claude.buildPtyArgs(claudeSpec({ sessionId: ID_A, resumeSession: true }))).toEqual(
      expect.arrayContaining(['--resume', ID_A]),
    );
  });

  it('claude headless (--print) carries it too', () => {
    const args = claude.buildArgs({ ...claudeSpec({ sessionId: ID_A }), prompt: 'do the thing' });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(ID_A);
  });

  it('mayac PTY + headless carry --session-id / --resume', () => {
    homeWithTranscripts([ID_A]);
    expect(mayac.buildPtyArgs(mayacSpec({ sessionId: ID_A }))).toEqual(
      expect.arrayContaining(['--session-id', ID_A]),
    );
    expect(mayac.buildPtyArgs(mayacSpec({ sessionId: ID_A, resumeSession: true }))).toEqual(
      expect.arrayContaining(['--resume', ID_A]),
    );

    const headless = mayac.buildArgs({ ...mayacSpec({ sessionId: ID_A }), prompt: 'do the thing' });
    expect(headless[headless.indexOf('--session-id') + 1]).toBe(ID_A);
    // -p stays LAST: the prompt must not swallow a trailing flag.
    expect(headless[headless.length - 2]).toBe('-p');
  });

  it('a revive with NO transcript on disk degrades to --session-id, through the real adapter', () => {
    homeWithTranscripts([]); // empty $HOME: the owner cleared history
    const args = claude.buildPtyArgs(claudeSpec({ sessionId: ID_A, resumeSession: true }));
    expect(args).not.toContain('--resume'); // would have exited the CLI with an error
    expect(args).toEqual(expect.arrayContaining(['--session-id', ID_A]));
  });

  it('an agent with no sessionId gets no session flags (no regression for existing spawns)', () => {
    const args = claude.buildPtyArgs(claudeSpec({}));
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--resume');
  });
});

describe('capability gate: an OLD global mayac that has no --session-id', () => {
  // We spawn the GLOBALLY INSTALLED mayac, which lags this repo (@maya-os/code@0.1.2:
  // `mayac --help | grep session-id` → 0 hits). Passing the flag there is not a
  // no-op: parseArgs drops the unknown dash-flag but takes the next BARE token as
  // the prompt — so on an interactive spawn (no -p, the standing-agent shape) the
  // raw UUID becomes the agent's FIRST TURN. Strip both flags instead.
  const old = new MayacAdapter({ gatewayBaseUrl: GATEWAY, supportsSessionId: false });

  it('passes NO session flags, and never leaks the id into argv (it would become the prompt)', () => {
    homeWithTranscripts([ID_A]);
    const pty = old.buildPtyArgs(mayacSpec({ sessionId: ID_A, resumeSession: true }));
    expect(pty).not.toContain('--session-id');
    expect(pty).not.toContain('--resume');
    expect(pty).not.toContain(ID_A); // <-- the bare token that 0.1.2 would treat as the prompt
  });

  it('the headless prompt is still the PROMPT, not the session id', () => {
    const args = old.buildArgs({ ...mayacSpec({ sessionId: ID_A }), prompt: 'do the thing' });
    expect(args[args.length - 2]).toBe('-p');
    expect(args[args.length - 1]).toBe('do the thing');
    expect(args).not.toContain(ID_A);
  });

  it('a NEW mayac (flag present) does pass the id', () => {
    const fresh = new MayacAdapter({ gatewayBaseUrl: GATEWAY, supportsSessionId: true });
    expect(fresh.buildPtyArgs(mayacSpec({ sessionId: ID_A }))).toEqual(
      expect.arrayContaining(['--session-id', ID_A]),
    );
  });
});

describe('adapters with no resume support ignore the keys silently', () => {
  // The orchestrator sets sessionId on EVERY standing agent regardless of type,
  // so forwarding it as an unknown flag here would fail the spawn outright.
  it('codex argv carries no session flags', () => {
    const args = new CodexAdapter({ gatewayBaseUrl: GATEWAY }).buildArgs({
      adapter: 'codex',
      model: 'openai/gpt-5.5',
      cwd: SHARED_CWD,
      prompt: 'do the thing',
      options: { sessionId: ID_A, resumeSession: true },
    });
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain(ID_A);
  });

  it('opencode argv carries no session flags', () => {
    const args = new OpenCodeAdapter({ gatewayBaseUrl: GATEWAY }).buildArgs({
      adapter: 'opencode',
      model: 'anthropic/claude-opus-4-8',
      cwd: SHARED_CWD,
      prompt: 'do the thing',
      options: { sessionId: ID_A, resumeSession: true },
    });
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain(ID_A);
  });
});
