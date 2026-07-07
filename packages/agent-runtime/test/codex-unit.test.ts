/**
 * Codex adapter units: argv/provider-injection contract and JSONL mapping for
 * BOTH shapes codex has shipped (legacy msg-envelope and current item/turn).
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentSpawnSpec } from '@maya-ai/core';
import { CodexAdapter } from '../src/adapters/codex.js';

const adapter = new CodexAdapter({ gatewayBaseUrl: 'http://127.0.0.1:4100' });

const baseSpec: AgentSpawnSpec = {
  adapter: 'codex',
  model: 'local/qwen2.5-0.5b-instruct',
  cwd: '/tmp',
  prompt: 'do the thing',
};

describe('buildArgs', () => {
  it('injects the maya provider purely via -c overrides and targets /v1', () => {
    const args = adapter.buildArgs(baseSpec);
    const joined = args.join(' ');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(joined).toContain('model_providers.maya.base_url=http://127.0.0.1:4100/v1');
    expect(joined).toContain('model_providers.maya.env_key=MAYA_API_KEY');
    expect(joined).toContain('model_providers.maya.wire_api=chat');
    expect(joined).toContain('model_provider=maya');
    expect(joined).toContain('-m local/qwen2.5-0.5b-instruct');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox'); // auto default
    expect(args[args.length - 1]).toBe('do the thing'); // prompt last, after flags
  });

  it('permissionMode ask drops the bypass flag', () => {
    const args = adapter.buildArgs({ ...baseSpec, permissionMode: 'ask' });
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('rejects promptless spawn (one-shot slice)', () => {
    const spec: AgentSpawnSpec = { adapter: 'codex', model: 'local/x', cwd: '/tmp' };
    expect(() => adapter.buildArgs(spec)).toThrow(/one-shot/);
  });
});

describe('JSONL mapping', () => {
  function collect(lines: string[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    const live = {
      handle: { id: 'ag_t', adapter: 'codex', state: 'running', model: 'local/x', cwd: '/tmp', spawnedAt: '' },
      child: { kill() {} },
      log: { push: (e: AgentEvent) => events.push(e), close() {} },
      logs: [],
      stdoutBuf: '',
    };
    for (const line of lines) adapter.onStreamLine(live as never, line);
    return events;
  }

  it('legacy shape: agent_message, exec, token_count, task_complete', () => {
    const events = collect([
      JSON.stringify({ id: '1', msg: { type: 'agent_message', message: 'hi from codex' } }),
      JSON.stringify({ id: '2', msg: { type: 'exec_command_begin', command: ['ls', '-la'] } }),
      JSON.stringify({ id: '3', msg: { type: 'token_count', info: { total_token_usage: { input_tokens: 9, output_tokens: 4 } } } }),
      JSON.stringify({ id: '4', msg: { type: 'task_complete' } }),
    ]);
    const logLines = events.filter((e) => e.kind === 'log').map((e) => (e as { line: string }).line);
    expect(logLines).toContain('hi from codex');
    expect(logLines).toContain('[exec] ls -la');
    expect(events.some((e) => e.kind === 'tokens' && e.input === 9 && e.output === 4)).toBe(true);
    expect(events.some((e) => e.kind === 'state' && e.state === 'exited')).toBe(true);
  });

  it('current shape: item.completed + turn.completed with usage', () => {
    const events = collect([
      JSON.stringify({ type: 'item.completed', item: { item_type: 'assistant_message', text: 'done it' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 7 } }),
    ]);
    expect(events.some((e) => e.kind === 'log' && (e as { line: string }).line === 'done it')).toBe(true);
    expect(events.some((e) => e.kind === 'tokens' && e.input === 20 && e.output === 7)).toBe(true);
    expect(events.some((e) => e.kind === 'state' && e.state === 'exited')).toBe(true);
  });

  it('error shapes end in failed state with an error event', () => {
    const events = collect([JSON.stringify({ id: '1', msg: { type: 'error', message: 'boom' } })]);
    expect(events.some((e) => e.kind === 'error' && (e as { message: string }).message === 'boom')).toBe(true);
    expect(events.some((e) => e.kind === 'state' && e.state === 'failed')).toBe(true);
  });

  it('terminal state is sticky — later events cannot resurrect the agent', () => {
    const events = collect([
      JSON.stringify({ id: '1', msg: { type: 'task_complete' } }),
      JSON.stringify({ id: '2', msg: { type: 'error', message: 'late noise' } }),
    ]);
    const states = events.filter((e) => e.kind === 'state').map((e) => (e as { state: string }).state);
    expect(states).toEqual(['exited']); // no 'failed' after terminal
  });

  it('non-JSON lines fall through as raw stdout logs', () => {
    const events = collect(['garbage line']);
    expect(events.some((e) => e.kind === 'log' && (e as { line: string }).line === 'garbage line')).toBe(true);
  });
});
