/**
 * OpenCode adapter units: argv contract (from OpenCode's documented `run`
 * CLI) and the best-effort JSON event mapping. The event shape is unconfirmed
 * against a live run (opencode not installed on this box), so these lock the
 * parts we KNOW and exercise the defensive parser; the live smoke is pending.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSpawnSpec } from '@maya-ai/core';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';

const adapter = new OpenCodeAdapter({ gatewayBaseUrl: 'http://127.0.0.1:4100' });

const baseSpec: AgentSpawnSpec = {
  adapter: 'opencode',
  model: 'maya/qwen2.5-3b-instruct',
  cwd: '/tmp',
  prompt: 'do the thing',
};

describe('buildArgs', () => {
  it('builds the documented `run --format json --dir --model … --auto <prompt>`', () => {
    const args = adapter.buildArgs(baseSpec);
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/tmp',
      '--model',
      'maya/qwen2.5-3b-instruct',
      '--auto',
      'do the thing',
    ]);
  });

  it('permissionMode ask drops --auto', () => {
    const args = adapter.buildArgs({ ...baseSpec, permissionMode: 'ask' });
    expect(args).not.toContain('--auto');
  });

  it('rejects promptless spawn (one-shot slice)', () => {
    expect(() => adapter.buildArgs({ adapter: 'opencode', model: 'maya/x', cwd: '/tmp' })).toThrow(/one-shot/);
  });
});

describe('best-effort JSON event mapping', () => {
  function collect(lines: string[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    const live = {
      handle: { id: 'ag_t', adapter: 'opencode', state: 'running', model: 'maya/x', cwd: '/tmp', spawnedAt: '' },
      child: { kill() {} },
      log: { push: (e: AgentEvent) => events.push(e), close() {} },
      logs: [],
      stdoutBuf: '',
    };
    for (const line of lines) adapter.onStreamLine(live as never, line);
    return events;
  }

  it('maps text content and tool events to logs', () => {
    const events = collect([
      JSON.stringify({ type: 'message', text: 'hello from opencode' }),
      JSON.stringify({ type: 'tool_use', name: 'edit' }),
    ]);
    const lines = events.filter((e) => e.kind === 'log').map((e) => (e as { line: string }).line);
    expect(lines).toContain('hello from opencode');
    expect(lines).toContain('[tool] edit');
  });

  it('maps a usage object to a tokens event (both field conventions)', () => {
    expect(collect([JSON.stringify({ usage: { input: 100, output: 20 } })]).some((e) => e.kind === 'tokens' && e.input === 100 && e.output === 20)).toBe(true);
    expect(collect([JSON.stringify({ tokens: { input_tokens: 5, output_tokens: 3 } })]).some((e) => e.kind === 'tokens' && e.input === 5 && e.output === 3)).toBe(true);
  });

  it('maps an error field to an error event', () => {
    expect(collect([JSON.stringify({ type: 'error', error: 'boom' })]).some((e) => e.kind === 'error' && (e as { message: string }).message === 'boom')).toBe(true);
  });

  it('non-JSON lines fall through as raw stdout logs', () => {
    expect(collect(['plain text']).some((e) => e.kind === 'log' && (e as { line: string }).line === 'plain text')).toBe(true);
  });
});
