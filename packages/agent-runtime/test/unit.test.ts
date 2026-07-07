/**
 * Unit tests: argv contract with the claude CLI, stream-json event mapping,
 * event-log tailing semantics. No real CLI or model needed (that's
 * test/smoke.mjs).
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSpawnSpec } from '@maya-ai/core';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { EventLog } from '../src/events.js';

const adapter = new ClaudeCodeAdapter({ gatewayBaseUrl: 'http://127.0.0.1:4100' });

const baseSpec: AgentSpawnSpec = {
  adapter: 'claude-code',
  model: 'local/qwen2.5-0.5b-instruct',
  cwd: '/tmp',
};

describe('buildArgs', () => {
  it('one-shot: positional prompt, stream-json out, skip-permissions by default', () => {
    const args = adapter.buildArgs({ ...baseSpec, prompt: 'do the thing' });
    expect(args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      'do the thing',
      '--model',
      'local/qwen2.5-0.5b-instruct',
      '--dangerously-skip-permissions',
    ]);
  });

  it('conversational: stream-json in AND out, no positional prompt', () => {
    const args = adapter.buildArgs(baseSpec);
    expect(args).toContain('--input-format');
    expect(args).not.toContain('do the thing');
  });

  it('permissionMode ask drops the skip flag', () => {
    const args = adapter.buildArgs({ ...baseSpec, prompt: 'x', permissionMode: 'ask' });
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

describe('stream-json mapping', () => {
  function collect(lines: string[], interactive = false): AgentEvent[] {
    const events: AgentEvent[] = [];
    const live = {
      handle: { id: 'ag_t', adapter: 'claude-code', state: 'running', model: 'local/x', cwd: '/tmp', spawnedAt: '' },
      child: { kill() {} },
      log: { push: (e: AgentEvent) => events.push(e), close() {} },
      logs: [],
      interactive,
      stdoutBuf: '',
    };
    for (const line of lines) adapter.onStreamLine(live as never, line);
    return events;
  }

  it('assistant text and tool_use become log events', () => {
    const events = collect([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash' }] } }),
    ]);
    const lines = events.filter((e) => e.kind === 'log').map((e) => (e as { line: string }).line);
    expect(lines).toEqual(['hello', '[tool] Bash']);
  });

  it('result carries tokens and ends a one-shot run', () => {
    const events = collect(
      [JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 10, output_tokens: 5 } })],
      false,
    );
    expect(events.some((e) => e.kind === 'tokens' && e.input === 10 && e.output === 5)).toBe(true);
    expect(events.some((e) => e.kind === 'state' && e.state === 'exited')).toBe(true);
  });

  it('result does NOT end a conversational agent', () => {
    const events = collect(
      [JSON.stringify({ type: 'result', subtype: 'success', result: 'turn done', usage: { input_tokens: 1, output_tokens: 1 } })],
      true,
    );
    expect(events.some((e) => e.kind === 'state' && e.state === 'exited')).toBe(false);
  });

  it('error result emits error + failed state', () => {
    const events = collect([JSON.stringify({ type: 'result', subtype: 'error_during_execution' })], false);
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    expect(events.some((e) => e.kind === 'state' && e.state === 'failed')).toBe(true);
  });

  it('non-JSON lines fall through as raw stdout logs', () => {
    const events = collect(['plain noise']);
    expect(events.some((e) => e.kind === 'log' && (e as { line: string }).line === 'plain noise')).toBe(true);
  });
});

describe('EventLog', () => {
  it('tails live events and finishes on close', async () => {
    const log = new EventLog();
    const seen: string[] = [];
    const done = (async () => {
      for await (const { event } of log.iterate()) {
        if (event.kind === 'log') seen.push(event.line);
      }
    })();
    log.push({ kind: 'log', stream: 'stdout', line: 'a', at: '' });
    await new Promise((r) => setTimeout(r, 10));
    log.push({ kind: 'log', stream: 'stdout', line: 'b', at: '' });
    log.close();
    await done;
    expect(seen).toEqual(['a', 'b']);
  });

  it('cursor resume skips already-seen events', async () => {
    const log = new EventLog();
    log.push({ kind: 'log', stream: 'stdout', line: 'first', at: '' });
    let cursor = '';
    for await (const item of log.iterate()) {
      cursor = item.cursor;
      break;
    }
    log.push({ kind: 'log', stream: 'stdout', line: 'second', at: '' });
    log.close();
    const rest: string[] = [];
    for await (const { event } of log.iterate(cursor)) {
      if (event.kind === 'log') rest.push(event.line);
    }
    expect(rest).toEqual(['second']);
  });
});
