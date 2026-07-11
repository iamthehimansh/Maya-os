/**
 * Workflow runner. OWNER: @agents.
 *
 * Runs a small JS script that orchestrates sub-agents programmatically — the
 * same idea as Maya's own Workflow tool, scoped to `mayac`. The script body runs
 * in an async context with a curated API injected:
 *
 *   agent(prompt, opts?)      → Promise<string>   spawn one sub-agent, get its answer
 *   parallel([() => …, …])    → Promise<any[]>    run thunks concurrently (barrier)
 *   pipeline(items, ...stages)→ Promise<any[]>    each item flows through all stages, no barrier
 *   log(msg)                  → void              progress line
 *   args                      → any               value passed in from the caller
 *
 * The script is wrapped in an AsyncFunction so top-level `await` and a final
 * `return` work. It is the user's own script on their machine (same trust level
 * as the bash tool) — not a hardened sandbox — but it has no access to this
 * module's locals.
 */

/** Run thunks concurrently; a barrier — awaits them all. A throwing thunk → null. */
export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
  return Promise.all(
    thunks.map(async (t) => {
      try {
        return await t();
      } catch {
        return null;
      }
    }),
  );
}

/**
 * Run each item through every stage independently (no barrier between stages).
 * Each stage receives `(prevResult, originalItem, index)`. A stage that throws
 * drops that item to `null` and skips its remaining stages.
 */
export async function pipeline(
  items: unknown[],
  ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown | Promise<unknown>>
): Promise<unknown[]> {
  return Promise.all(
    items.map(async (item, i) => {
      let value: unknown = item;
      try {
        for (const stage of stages) value = await stage(value, item, i);
        return value;
      } catch {
        return null;
      }
    }),
  );
}

export interface WorkflowDeps {
  /** Spawn one sub-agent and return its final text. Each call = a fresh sub-agent. */
  agent: (prompt: string, opts?: { label?: string }) => Promise<string>;
  /** Progress sink (defaults to no-op). */
  log?: (msg: string) => void;
  /** Value exposed to the script as `args`. */
  args?: unknown;
  /** Max concurrent `agent()` calls across the whole workflow (default 8). */
  maxConcurrent?: number;
}

/** A tiny FIFO semaphore so a fan-out can't launch unbounded sub-agents at once. */
function makeSemaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

// AsyncFunction isn't a global; grab its constructor off an async fn instance.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>;

/**
 * Execute a workflow script source. Returns whatever the script `return`s.
 * Every `agent()` call is throttled by the concurrency semaphore.
 */
export async function runWorkflow(source: string, deps: WorkflowDeps): Promise<unknown> {
  const log = deps.log ?? (() => {});
  const sem = makeSemaphore(Math.max(1, deps.maxConcurrent ?? 8));
  const agent = (prompt: string, opts?: { label?: string }) => sem(() => deps.agent(prompt, opts));

  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'args', source);
  return fn(agent, parallel, pipeline, log, deps.args);
}
