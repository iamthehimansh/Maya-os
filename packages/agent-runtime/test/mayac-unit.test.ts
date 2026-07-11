/**
 * maya code (mayac) adapter units: the argv + env contract with the real CLI
 * (packages/harness/src/cli.ts), the stderr telemetry mapping, and the type's
 * registration in the AgentRuntime factory.
 *
 * Verified live against the installed binary before these were written:
 *   $ mayac -p "Reply with exactly: PONG" --provider anthropic \
 *       --auth subscription --model claude-haiku-4-5-20251001
 *   stdout: "PONG"        stderr: "[usage] in=4260 out=6 $0.0043"        exit 0
 * That run is what pins the assertions below: assistant text on stdout, `[usage]`
 * on stderr, and the flags mayac actually accepts.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSpawnSpec } from '@maya-ai/core';
import { AgentRuntime } from '../src/index.js';
import { MayacAdapter, ptyChunk } from '../src/adapters/mayac.js';

const GATEWAY = 'http://127.0.0.1:4100';
const adapter = new MayacAdapter({ gatewayBaseUrl: GATEWAY });

const baseSpec: AgentSpawnSpec = {
  adapter: 'mayac',
  model: 'local/qwen2.5-7b-instruct',
  cwd: '/tmp',
  prompt: 'do the thing',
};

describe('type registration', () => {
  it('AgentRuntime knows "mayac" and hands back the mayac adapter', () => {
    const runtime = new AgentRuntime({ gatewayBaseUrl: GATEWAY });
    expect(runtime.adapterIds()).toContain('mayac');
    expect(runtime.adapter('mayac').id).toBe('mayac');
  });
});

describe('buildArgs (headless one-shot)', () => {
  it('builds `--provider --model --auth --cwd --yolo -p <prompt>`', () => {
    expect(adapter.buildArgs(baseSpec)).toEqual([
      '--provider',
      'anthropic',
      '--model',
      'local/qwen2.5-7b-instruct',
      '--auth',
      'api',
      '--cwd',
      '/tmp',
      '--yolo',
      '-p',
      'do the thing',
    ]);
  });

  it('permissionMode "auto" passes --yolo — without it headless mayac DENIES every write/bash', () => {
    expect(adapter.buildArgs({ ...baseSpec, permissionMode: 'auto' })).toContain('--yolo');
    expect(adapter.buildArgs({ ...baseSpec, permissionMode: 'ask' })).not.toContain('--yolo');
  });

  it('rejects a promptless spawn without options.pty (headless mayac is one-shot)', () => {
    expect(() => adapter.buildArgs({ adapter: 'mayac', model: 'maya/x', cwd: '/tmp' })).toThrow(/one-shot/);
  });

  it('gateway agents pass the Maya ModelId verbatim and use --auth api', () => {
    const args = adapter.buildArgs({ ...baseSpec, model: 'anthropic/claude-opus-4-8' });
    expect(args).toContain('anthropic/claude-opus-4-8'); // the gateway resolves the prefix
    expect(args.slice(args.indexOf('--auth'))[1]).toBe('api');
  });

  it('native subscription uses --auth subscription and STRIPS the gateway model prefix', () => {
    // The real Anthropic API has no model called "anthropic/claude-opus-4-8".
    const args = adapter.buildArgs({
      ...baseSpec,
      model: 'anthropic/claude-opus-4-8',
      options: { auth: 'mayac-subscription' },
    });
    expect(args.slice(args.indexOf('--auth'))[1]).toBe('subscription');
    expect(args).toContain('claude-opus-4-8');
    expect(args).not.toContain('anthropic/claude-opus-4-8');
  });

  it('infers the openai provider from the model prefix, and honors an explicit override', () => {
    expect(adapter.buildArgs({ ...baseSpec, model: 'openai/gpt-5.5' }).slice(1)[0]).toBe('openai');
    expect(adapter.buildArgs({ ...baseSpec, options: { provider: 'openai' } }).slice(1)[0]).toBe('openai');
    expect(adapter.buildArgs(baseSpec).slice(1)[0]).toBe('anthropic'); // default
  });

  it('folds a persona into the prompt — mayac has NO --append-system-prompt, and silently dropping it would spawn a persona-less team agent', () => {
    const args = adapter.buildArgs({ ...baseSpec, options: { appendSystemPrompt: 'You are @qa. Reply via your outbox.' } });
    const prompt = args[args.length - 1] as string;
    expect(prompt).toContain('You are @qa. Reply via your outbox.');
    expect(prompt).toContain('do the thing');
    expect(args).not.toContain('--append-system-prompt');
  });
});

describe('buildEnv (the gateway seam)', () => {
  it('points the Anthropic SDK at the gateway with a dummy key (mayac sets no baseURL, so the SDK env default wins)', () => {
    const env = adapter.buildEnv(baseSpec);
    expect(env['ANTHROPIC_BASE_URL']).toBe(GATEWAY);
    expect(env['ANTHROPIC_API_KEY']).toBe('maya-gateway');
  });

  it('the openai provider gets the gateway OpenAI-compat base (/v1)', () => {
    const env = adapter.buildEnv({ ...baseSpec, model: 'openai/gpt-5.5' });
    expect(env['OPENAI_BASE_URL']).toBe(`${GATEWAY}/v1`);
    expect(env['OPENAI_API_KEY']).toBe('maya-gateway');
  });

  it('native subscription CLEARS an inherited gateway pointer/dummy key, or it would shadow the owner\'s real login', () => {
    const env = adapter.buildEnv({
      ...baseSpec,
      options: { auth: 'mayac-subscription' },
      env: {},
    });
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('strips the launcher\'s Claude Code session identity so the worker is not a nested child', () => {
    const env = adapter.buildEnv(baseSpec);
    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['AI_AGENT']).toBeUndefined();
  });

  it('caller-supplied env wins over the gateway defaults', () => {
    const env = adapter.buildEnv({ ...baseSpec, env: { ANTHROPIC_API_KEY: 'real-key' } });
    expect(env['ANTHROPIC_API_KEY']).toBe('real-key');
  });
});

/**
 * Regression guard for a live-observed standing-agent failure: a typed turn was
 * swallowed whole by mayac's TUI drag-detection. Its handler treats any
 * multi-char write as a paste, and `parseDroppedPaths()` attaches every
 * space-separated token that names an existing file — then RETURNS, discarding
 * the message text. The persona names the agent's real inbox/outbox files, so the
 * agent never saw its brief ("✓ attached in.jsonl, out.jsonl") and went hunting
 * the filesystem instead of answering the channel.
 *
 * The parser bails on a chunk containing '\n' — but it trim()s first, so only an
 * INTERIOR newline works. These lock that in; the two heuristics live in
 * harness/src/tui/{App.tsx,attach.ts}.
 */
describe('ptyChunk — the typed-turn contract with mayac\'s TUI', () => {
  const parseDroppedPathsBails = (chunk: string): boolean => /\n/.test(chunk.trim()); // attach.ts
  const isLargePaste = (chunk: string): boolean => chunk.split('\n').length >= 4; // LARGE_PASTE_LINES

  const PERSONA =
    'You are a persistent agent on a shared team channel. Read /Users/x/.maya/agents/t-a/in.jsonl and append replies to /Users/x/.maya/agents/t-a/out.jsonl. Keep running.';

  it('puts a newline INSIDE the chunk, so the drag/attachment parser bails', () => {
    const chunk = ptyChunk(PERSONA);
    expect(chunk).toContain('\n');
    expect(parseDroppedPathsBails(chunk)).toBe(true);
    // A trailing newline would NOT do: the parser trims before testing.
    expect(parseDroppedPathsBails(`${PERSONA}\n`)).toBe(false);
  });

  it('stays under the 4-line large-paste threshold, so the text arrives literally (not collapsed to a chip)', () => {
    expect(isLargePaste(ptyChunk(PERSONA))).toBe(false);
    expect(ptyChunk('a b c').split('\n')).toHaveLength(2);
  });

  it('flattens the text\'s own newlines (a >=4-line chunk would become a paste chip)', () => {
    const chunk = ptyChunk('line one\nline two\nline three\nline four\nline five');
    expect(chunk.split('\n')).toHaveLength(2);
    expect(isLargePaste(chunk)).toBe(false);
  });

  it('preserves every word — the break replaces the last space, adding no foreign tokens', () => {
    expect(ptyChunk('hello there world').split(/\s+/)).toEqual(['hello', 'there', 'world']);
    expect(ptyChunk(PERSONA).replace('\n', ' ')).toBe(PERSONA);
  });

  it('a single word (no space to promote) is passed through unchanged', () => {
    expect(ptyChunk('/tmp/x.txt')).toBe('/tmp/x.txt');
  });
});

describe('stderr telemetry mapping', () => {
  function collect(lines: string[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    const live = {
      handle: { id: 'ag_t', adapter: 'mayac', state: 'running', model: 'maya/x', cwd: '/tmp', spawnedAt: '' },
      log: { push: (e: AgentEvent) => events.push(e), close() {} },
      logs: [],
      stdoutBuf: '',
      stderrBuf: '',
      sayBuf: '',
      outTail: '',
      interactive: false,
    };
    for (const line of lines) adapter.onStderrLine(live as never, line);
    return events;
  }

  it('maps mayac\'s real `[usage] in=N out=N $X` line to a tokens event', () => {
    const events = collect(['[usage] in=4260 out=6 $0.0043']);
    expect(events.some((e) => e.kind === 'tokens' && e.input === 4260 && e.output === 6)).toBe(true);
  });

  it('maps `[error] …` to an error event', () => {
    expect(
      collect(['[error] rate limited']).some((e) => e.kind === 'error' && (e as { message: string }).message === 'rate limited'),
    ).toBe(true);
  });

  it('keeps a denied permission visible — it is WHY an agent did nothing', () => {
    const lines = collect(['[permission] denied bash: rm -rf (pass --yolo to allow)'])
      .filter((e) => e.kind === 'log')
      .map((e) => (e as { line: string }).line);
    expect(lines.some((l) => l.includes('[permission] denied'))).toBe(true);
  });

  it('tool chatter becomes system logs, not errors', () => {
    const events = collect(['[tool] bash {"cmd":"ls"}', '[tool:done]']);
    expect(events.every((e) => e.kind !== 'error')).toBe(true);
    expect(events.filter((e) => e.kind === 'log').length).toBe(2);
  });

  it('a zero-token usage line emits no tokens event', () => {
    expect(collect(['[usage] in=0 out=0 $0.0000']).some((e) => e.kind === 'tokens')).toBe(false);
  });
});
