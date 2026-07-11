/**
 * Background terminal tasks. OWNER: @runtime.
 *
 * A small, TUI-agnostic runner for detached bash commands: `start` returns
 * immediately with a handle, output streams into a capped buffer, and the TUI's
 * `/tasks` view reads `list`/`output` and can `kill`. Subscribers (`onUpdate`)
 * are notified on every state change so the TUI can re-render live.
 *
 * No Ink/React deps here — this is pure Node. The bash tool and the TUI both
 * consume it; it is tested standalone against real short-lived processes.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export type BgStatus = 'running' | 'exited' | 'killed' | 'error';

export interface BgTask {
  /** Short stable handle, e.g. "bg1". */
  id: string;
  command: string;
  cwd: string;
  status: BgStatus;
  /** null while running; process exit code once exited. */
  exitCode: number | null;
  /** Signal name if the process was killed, else null. */
  signal: string | null;
  startedAt: number;
  /** null while running. */
  endedAt: number | null;
  /** Combined stdout+stderr, capped to the tail. */
  output: string;
}

export interface TaskRunner {
  /** Start a detached command; returns a snapshot immediately (never blocks). */
  start(command: string, opts?: { cwd?: string }): BgTask;
  /**
   * Register an in-process job (not a bash child) as a BgTask so it shows in the
   * `/tasks` view — used by background sub-agents. `run` receives an AbortSignal
   * wired to `kill(id)`; its resolved string becomes the task output.
   */
  register(label: string, run: (signal: AbortSignal) => Promise<string>): BgTask;
  /** Snapshot of every task, oldest first. */
  list(): BgTask[];
  get(id: string): BgTask | undefined;
  /** Current buffered combined output for one task. */
  output(id: string): string;
  /** SIGTERM (then SIGKILL) a running task. Returns true if it was running. */
  kill(id: string): boolean;
  /** Subscribe to state/output changes. Returns an unsubscribe fn. */
  onUpdate(cb: (task: BgTask) => void): () => void;
  /** How many tasks are still running (for the header chip). */
  runningCount(): number;
  /** Kill everything — call on quit. */
  killAll(): void;
}

/** Keep only the tail of a task's output so a chatty command can't grow unbounded. */
const MAX_BUFFER = 100_000;

interface Entry {
  task: BgTask;
  child: ChildProcess | null;
  /** For in-process jobs (register): cancels the job on kill(). */
  abort?: () => void;
}

class TaskRunnerImpl implements TaskRunner {
  private readonly tasks: Entry[] = [];
  private readonly subs = new Set<(t: BgTask) => void>();
  private counter = 0;

  constructor(private readonly defaultCwd: string = process.cwd()) {}

  start(command: string, opts?: { cwd?: string }): BgTask {
    const id = `bg${++this.counter}`;
    const cwd = opts?.cwd ?? this.defaultCwd;
    const task: BgTask = {
      id,
      command,
      cwd,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      endedAt: null,
      output: '',
    };
    const entry: Entry = { task, child: null };
    this.tasks.push(entry);

    let child: ChildProcess;
    try {
      child = spawn('bash', ['-lc', command], { cwd, env: process.env });
    } catch (e) {
      task.status = 'error';
      task.endedAt = Date.now();
      task.output += `Failed to start: ${e instanceof Error ? e.message : String(e)}`;
      this.emit(task);
      return { ...task };
    }
    entry.child = child;

    const append = (b: Buffer) => {
      task.output += b.toString();
      if (task.output.length > MAX_BUFFER) {
        task.output = `… [earlier output truncated]\n${task.output.slice(-MAX_BUFFER)}`;
      }
      this.emit(task);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => {
      if (task.status !== 'running') return;
      task.status = 'error';
      task.endedAt = Date.now();
      task.output += `\n[error] ${e.message}`;
      entry.child = null;
      this.emit(task);
    });
    child.on('close', (code, sig) => {
      // `kill` already set status to 'killed'; don't overwrite it.
      if (task.status === 'running') {
        task.status = sig ? 'killed' : 'exited';
      }
      task.exitCode = code;
      task.signal = sig;
      task.endedAt = Date.now();
      entry.child = null;
      this.emit(task);
    });

    return { ...task };
  }

  register(label: string, run: (signal: AbortSignal) => Promise<string>): BgTask {
    const id = `bg${++this.counter}`;
    const ac = new AbortController();
    const task: BgTask = {
      id,
      command: label,
      cwd: this.defaultCwd,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      endedAt: null,
      output: '',
    };
    const entry: Entry = { task, child: null, abort: () => ac.abort() };
    this.tasks.push(entry);
    this.emit(task);

    run(ac.signal)
      .then((out) => {
        // A kill() already set status to 'killed'; don't overwrite it.
        if (task.status === 'running') {
          task.output = out;
          task.status = 'exited';
          task.exitCode = 0;
        }
      })
      .catch((e) => {
        if (task.status === 'running') {
          task.status = 'error';
          task.output += (task.output ? '\n' : '') + (e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        task.endedAt = Date.now();
        this.emit(task);
      });

    return { ...task };
  }

  list(): BgTask[] {
    return this.tasks.map((e) => ({ ...e.task }));
  }

  get(id: string): BgTask | undefined {
    const e = this.tasks.find((t) => t.task.id === id);
    return e ? { ...e.task } : undefined;
  }

  output(id: string): string {
    return this.tasks.find((t) => t.task.id === id)?.task.output ?? '';
  }

  kill(id: string): boolean {
    const entry = this.tasks.find((t) => t.task.id === id);
    if (!entry || entry.task.status !== 'running') return false;
    // In-process job (register): abort its signal and mark killed.
    if (entry.abort) {
      entry.task.status = 'killed';
      entry.task.endedAt = Date.now();
      entry.abort();
      this.emit(entry.task);
      return true;
    }
    if (!entry.child) return false;
    entry.task.status = 'killed';
    const child = entry.child;
    child.kill('SIGTERM');
    // Escalate if it ignores SIGTERM.
    const pid = child.pid;
    setTimeout(() => {
      if (entry.task.status === 'killed' && entry.child === child && pid) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 2000).unref?.();
    this.emit(entry.task);
    return true;
  }

  onUpdate(cb: (t: BgTask) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  runningCount(): number {
    return this.tasks.reduce((n, e) => n + (e.task.status === 'running' ? 1 : 0), 0);
  }

  killAll(): void {
    for (const e of this.tasks) {
      if (e.task.status !== 'running') continue;
      e.task.status = 'killed';
      if (e.abort) {
        try { e.abort(); } catch { /* ignore */ }
      } else if (e.child) {
        try { e.child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  }

  private emit(task: BgTask): void {
    const snapshot = { ...task };
    for (const cb of this.subs) {
      try {
        cb(snapshot);
      } catch {
        /* a bad subscriber must not break the runner */
      }
    }
  }
}

export function createTaskRunner(defaultCwd?: string): TaskRunner {
  return new TaskRunnerImpl(defaultCwd);
}
