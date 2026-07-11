/**
 * Background sub-agent registry. OWNER: @agents.
 *
 * Foreground sub-agents run inline (the tool call blocks until they finish).
 * *Background* sub-agents kick off immediately and run in-process while the
 * parent keeps going — this registry tracks them and exposes a snapshot shape
 * deliberately mirroring `TaskRunner`/`BgTask` (id, status, output, onUpdate,
 * kill) so the TUI's `/tasks` view can render sub-agents alongside bg-bash jobs.
 *
 * A background agent is an async function, not a child process, so we drive it
 * with an AbortController for `kill` and buffer its final text as `output`.
 */
import type { Usage } from '../types.js';
import { promptPreview } from './sub-agent.js';

export type AgentStatus = 'running' | 'done' | 'error' | 'killed';

export interface AgentTask {
  /** Short stable handle, e.g. "agent1". */
  id: string;
  /** Human label, e.g. `sub-agent: audit the auth flow`. */
  label: string;
  prompt: string;
  status: AgentStatus;
  startedAt: number;
  /** null while running. */
  endedAt: number | null;
  /** Final assistant text once done (empty while running). */
  output: string;
  usage: Usage;
  costUsd: number;
  /** Error detail when status === 'error'. */
  error: string | null;
}

/** What a background run needs to execute; the registry supplies the signal. */
export type AgentJob = (signal: AbortSignal) => Promise<{
  text: string;
  usage: Usage;
  costUsd: number;
  isError: boolean;
  errorMessage?: string;
}>;

export interface AgentRegistry {
  /** Start a background sub-agent; returns its snapshot immediately (never blocks). */
  start(prompt: string, job: AgentJob, opts?: { label?: string }): AgentTask;
  /** Snapshot of every sub-agent, oldest first. */
  list(): AgentTask[];
  get(id: string): AgentTask | undefined;
  /** Cancel a running sub-agent. Returns true if it was running. */
  kill(id: string): boolean;
  /** Subscribe to state changes. Returns an unsubscribe fn. */
  onUpdate(cb: (task: AgentTask) => void): () => void;
  /** How many sub-agents are still running. */
  runningCount(): number;
  /** Cancel everything — call on quit. */
  killAll(): void;
}

interface Entry {
  task: AgentTask;
  controller: AbortController;
}

class AgentRegistryImpl implements AgentRegistry {
  private readonly entries: Entry[] = [];
  private readonly subs = new Set<(t: AgentTask) => void>();
  private counter = 0;
  private clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  start(prompt: string, job: AgentJob, opts?: { label?: string }): AgentTask {
    const id = `agent${++this.counter}`;
    const controller = new AbortController();
    const task: AgentTask = {
      id,
      label: opts?.label ?? `sub-agent: ${promptPreview(prompt)}`,
      prompt,
      status: 'running',
      startedAt: this.clock(),
      endedAt: null,
      output: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      error: null,
    };
    const entry: Entry = { task, controller };
    this.entries.push(entry);

    // Fire-and-forget; state transitions flow through emit().
    void job(controller.signal)
      .then((res) => {
        if (task.status === 'killed') return;
        task.output = res.text;
        task.usage = res.usage;
        task.costUsd = res.costUsd;
        task.status = res.isError ? 'error' : 'done';
        task.error = res.errorMessage ?? null;
        task.endedAt = this.clock();
        this.emit(task);
      })
      .catch((err) => {
        if (task.status === 'killed') return;
        task.status = 'error';
        task.error = err instanceof Error ? err.message : String(err);
        task.endedAt = this.clock();
        this.emit(task);
      });

    this.emit(task);
    return { ...task };
  }

  list(): AgentTask[] {
    return this.entries.map((e) => ({ ...e.task }));
  }

  get(id: string): AgentTask | undefined {
    const e = this.entries.find((x) => x.task.id === id);
    return e ? { ...e.task } : undefined;
  }

  kill(id: string): boolean {
    const entry = this.entries.find((x) => x.task.id === id);
    if (!entry || entry.task.status !== 'running') return false;
    entry.task.status = 'killed';
    entry.task.endedAt = this.clock();
    entry.controller.abort();
    this.emit(entry.task);
    return true;
  }

  onUpdate(cb: (t: AgentTask) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  runningCount(): number {
    return this.entries.reduce((n, e) => n + (e.task.status === 'running' ? 1 : 0), 0);
  }

  killAll(): void {
    for (const e of this.entries) {
      if (e.task.status === 'running') {
        e.task.status = 'killed';
        e.task.endedAt = this.clock();
        e.controller.abort();
      }
    }
  }

  private emit(task: AgentTask): void {
    const snapshot = { ...task };
    for (const cb of this.subs) {
      try {
        cb(snapshot);
      } catch {
        /* a bad subscriber must not break the registry */
      }
    }
  }
}

export function createAgentRegistry(clock?: () => number): AgentRegistry {
  return new AgentRegistryImpl(clock);
}
