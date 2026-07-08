/** Shared test double: scripted one-shot workers (see team-manager.test.ts docs). */
import type { AgentAdapter, AgentEvent, AgentHandle, AgentSpawnSpec } from '@maya-ai/core';
import { EventLog } from '@maya-ai/agent-runtime';

/**
 * Scripted one-shot worker: prompt markers drive behavior.
 *  - "FAIL_ONCE" → first spawn for that prompt fails, later ones succeed
 *  - "TOKENS:<n>" → emits a token event of n before exiting
 *  - "HANG" → emits running then NEVER terminates (tests the watchdog);
 *    only kill() ends it
 *  - "STDERR:<msg>" → emits a stderr log line before the outcome
 *  - "TOOL" → emits a "[tool] Write" stdout line (a real tool call) before the
 *    result, so tests can tell a genuine actor from a 0-tool-call "parrot"
 */
export class ScriptedWorkers implements AgentAdapter {
  readonly id = 'scripted';
  private readonly agents = new Map<string, { handle: AgentHandle; log: EventLog }>();
  private readonly failedOnce = new Set<string>();
  spawned = 0;

  async detect() {
    return { installed: true as const };
  }

  async spawn(spec: AgentSpawnSpec): Promise<AgentHandle> {
    this.spawned += 1;
    const id = `ag_s${this.spawned}`;
    const log = new EventLog();
    const handle: AgentHandle = {
      id,
      adapter: this.id,
      state: 'running',
      model: spec.model,
      cwd: spec.cwd,
      spawnedAt: new Date().toISOString(),
    };
    const entry = { handle, log };
    this.agents.set(id, entry);

    const prompt = spec.prompt ?? '';
    const willFail = prompt.includes('FAIL_ONCE') && !this.failedOnce.has(prompt);
    const tokens = /TOKENS:(\d+)/.exec(prompt);
    const stderr = /STDERR:([^\s]+)/.exec(prompt);
    const hang = prompt.includes('HANG');
    const usesTool = prompt.includes('TOOL');

    setTimeout(() => {
      log.push({ kind: 'state', state: 'running', at: now() });
      if (stderr) log.push({ kind: 'log', stream: 'stderr', line: stderr[1]!, at: now() });
      if (tokens) {
        log.push({ kind: 'tokens', input: Number(tokens[1]), output: 0, at: now() });
      }
      if (hang) return; // never terminal — the watchdog must kill it
      if (willFail) {
        this.failedOnce.add(prompt);
        entry.handle = { ...entry.handle, state: 'failed' };
        log.push({ kind: 'error', message: 'scripted failure', at: now() });
        log.push({ kind: 'state', state: 'failed', at: now() });
      } else {
        if (usesTool) log.push({ kind: 'log', stream: 'stdout', line: '[tool] Write', at: now() });
        log.push({ kind: 'log', stream: 'stdout', line: `result of: ${prompt.slice(0, 40)}`, at: now() });
        entry.handle = { ...entry.handle, state: 'exited', exitCode: 0 };
        log.push({ kind: 'state', state: 'exited', at: now() });
      }
      log.close();
    }, 30);

    return handle;
  }

  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async kill(id: string): Promise<void> {
    const a = this.agents.get(id);
    if (a && a.handle.state !== 'exited') {
      a.handle = { ...a.handle, state: 'killed' };
      a.log.close();
    }
  }
  async send(): Promise<void> {}
  async status(id: string): Promise<AgentHandle> {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    return a.handle;
  }
  async *events(id: string, since?: string): AsyncIterable<AgentEvent> {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    for await (const { event } of a.log.iterate(since)) yield event;
  }
  async logs(): Promise<never[]> {
    return [];
  }
}

const now = () => new Date().toISOString();
