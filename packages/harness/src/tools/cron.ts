/**
 * Cron / schedule tool (item 13). OWNER: @tools.
 *
 * A built-in tool that schedules a message to wake the agent later — once at a
 * time (`at`), once after a delay (`after`), or repeatedly (`every`). Schedules
 * persist to `~/.mayac/cron.json` so they survive restarts; on fire the
 * scheduler calls `onFire(message, schedule)`, which @core wires to
 * `session.inject(text)` to feed the message into the running session.
 *
 * The scheduler is constructed by the CLI (so it can inject into the live
 * session); `cronTool(scheduler)` exposes create/list/cancel to the model.
 * No external deps — plain `setTimeout`, re-armed for delays beyond the 32-bit
 * timer ceiling.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { errResult, optString, reqString } from './util.js';

export type CronKind = 'at' | 'after' | 'every';

export interface CronSchedule {
  id: string;
  message: string;
  kind: CronKind;
  /** Next fire time, epoch ms. */
  fireAt: number;
  /** For `every`: the repeat interval in ms. */
  intervalMs?: number;
  createdAt: number;
  /** Optional human label for the listing. */
  label?: string;
}

/** Persistence backend. The default writes `~/.mayac/cron.json`; tests inject a fake. */
export interface CronStore {
  load(): Promise<CronSchedule[]>;
  save(schedules: readonly CronSchedule[]): Promise<void>;
}

export function fileCronStore(path = join(homedir(), '.mayac', 'cron.json')): CronStore {
  return {
    async load() {
      try {
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw) as { schedules?: CronSchedule[] };
        return Array.isArray(parsed.schedules) ? parsed.schedules : [];
      } catch {
        return []; // missing/corrupt file → start empty
      }
    },
    async save(schedules) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ schedules }, null, 2));
    },
  };
}

/** Timers above this can't be armed directly (setTimeout is 32-bit). Re-arm in chunks. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Parse "30s" | "5m" | "2h" | "1d" | "500ms" | a plain number of ms → milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return Math.max(0, Math.floor(input));
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(input);
  if (!m) throw new Error(`invalid duration "${input}" (use e.g. 30s, 5m, 2h, 1d)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Math.floor(n * mult);
}

export interface CronScheduler {
  /** Load persisted schedules, fire any that are overdue, and arm the rest. */
  start(): Promise<void>;
  /** Create a schedule from one of `at` (ISO/epoch), `after` (duration), `every` (duration). */
  add(opts: { message: string; at?: string | number; after?: string | number; every?: string | number; label?: string }): Promise<CronSchedule>;
  list(): CronSchedule[];
  cancel(id: string): Promise<boolean>;
  /** Clear all timers (call on quit). Does not delete persisted schedules. */
  stop(): void;
}

class CronSchedulerImpl implements CronScheduler {
  private schedules: CronSchedule[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private counter = 0;
  private started = false;

  constructor(
    private readonly store: CronStore,
    private readonly onFire: (message: string, schedule: CronSchedule) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.schedules = await this.store.load();
    // Fire overdue schedules, then arm the rest.
    for (const s of [...this.schedules]) {
      if (s.fireAt <= this.now()) this.fire(s);
      else this.arm(s);
    }
    await this.persist();
  }

  async add(opts: { message: string; at?: string | number; after?: string | number; every?: string | number; label?: string }): Promise<CronSchedule> {
    const message = opts.message?.trim();
    if (!message) throw new Error('message is required');
    const t = this.now();
    let kind: CronKind;
    let fireAt: number;
    let intervalMs: number | undefined;

    if (opts.every !== undefined) {
      kind = 'every';
      intervalMs = parseDuration(opts.every);
      if (intervalMs < 1000) throw new Error('every interval must be ≥ 1s');
      fireAt = t + intervalMs;
    } else if (opts.after !== undefined) {
      kind = 'after';
      fireAt = t + parseDuration(opts.after);
    } else if (opts.at !== undefined) {
      kind = 'at';
      fireAt = typeof opts.at === 'number' ? opts.at : Date.parse(opts.at);
      if (!Number.isFinite(fireAt)) throw new Error(`invalid time "${opts.at}" (use ISO 8601 or epoch ms)`);
    } else {
      throw new Error('provide one of: at, after, every');
    }

    const schedule: CronSchedule = {
      id: `cron${++this.counter}-${fireAt}`,
      message,
      kind,
      fireAt,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      createdAt: t,
      ...(opts.label ? { label: opts.label } : {}),
    };
    this.schedules.push(schedule);
    if (fireAt <= t) this.fire(schedule);
    else this.arm(schedule);
    await this.persist();
    return schedule;
  }

  list(): CronSchedule[] {
    return this.schedules.map((s) => ({ ...s }));
  }

  async cancel(id: string): Promise<boolean> {
    const idx = this.schedules.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.disarm(id);
    this.schedules.splice(idx, 1);
    await this.persist();
    return true;
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private arm(s: CronSchedule): void {
    this.disarm(s.id);
    const delay = Math.max(0, s.fireAt - this.now());
    if (delay > MAX_TIMER_MS) {
      // Re-arm in chunks until within range.
      const t = setTimeout(() => this.arm(s), MAX_TIMER_MS);
      t.unref?.();
      this.timers.set(s.id, t);
      return;
    }
    const t = setTimeout(() => this.onTimer(s.id), delay);
    t.unref?.();
    this.timers.set(s.id, t);
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  private onTimer(id: string): void {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return;
    this.fire(s);
    void this.persist();
  }

  /** Deliver the message, then either reschedule (every) or remove (one-shots). */
  private fire(s: CronSchedule): void {
    try {
      this.onFire(s.message, s);
    } catch {
      /* a bad consumer must not kill the scheduler */
    }
    if (s.kind === 'every' && s.intervalMs) {
      // Advance to the next boundary strictly in the future (skip missed ticks).
      let next = s.fireAt + s.intervalMs;
      const t = this.now();
      while (next <= t) next += s.intervalMs;
      s.fireAt = next;
      this.arm(s);
    } else {
      this.disarm(s.id);
      const idx = this.schedules.findIndex((x) => x.id === s.id);
      if (idx !== -1) this.schedules.splice(idx, 1);
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(this.schedules);
    } catch {
      /* persistence best-effort — don't crash the session on a write error */
    }
  }
}

export function createCronScheduler(opts: {
  store: CronStore;
  onFire: (message: string, schedule: CronSchedule) => void;
  now?: () => number;
}): CronScheduler {
  return new CronSchedulerImpl(opts.store, opts.onFire, opts.now);
}

function describe(s: CronSchedule): string {
  const when = new Date(s.fireAt).toISOString();
  const kind =
    s.kind === 'every' && s.intervalMs
      ? `every ${Math.round(s.intervalMs / 1000)}s (next ${when})`
      : `${s.kind} ${when}`;
  return `${s.id} — ${kind}${s.label ? ` [${s.label}]` : ''}: ${JSON.stringify(s.message)}`;
}

/** The model-facing tool. Backed by a scheduler the CLI constructed + wired to the session. */
export function cronTool(scheduler: CronScheduler): Tool {
  return {
    spec: {
      name: 'schedule',
      description:
        'Schedule a message to wake yourself later — the message is injected into this session when it fires. ' +
        'Actions: "add" creates a schedule (give a message plus ONE of: at=ISO time/epoch ms, after=duration like "30s"/"5m"/"2h", ' +
        'every=recurring duration); "list" shows pending schedules; "cancel" removes one by id. Schedules persist across restarts. ' +
        'Use it to remind yourself to re-check something, poll on an interval, or resume work at a set time.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'cancel'], description: 'What to do.' },
          message: { type: 'string', description: 'For "add": the text to inject when it fires.' },
          at: { type: 'string', description: 'For "add": absolute time (ISO 8601, e.g. 2026-07-11T18:00:00Z).' },
          after: { type: 'string', description: 'For "add": fire once after a delay, e.g. "30s", "5m", "2h".' },
          every: { type: 'string', description: 'For "add": fire repeatedly on this interval, e.g. "10m", "1h".' },
          label: { type: 'string', description: 'For "add": optional label shown in the listing.' },
          id: { type: 'string', description: 'For "cancel": the schedule id to remove.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    async run(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      try {
        const action = optString(input, 'action') ?? 'list';

        if (action === 'list') {
          const items = scheduler.list();
          if (items.length === 0) return { content: '(no scheduled messages)' };
          return { content: items.sort((a, b) => a.fireAt - b.fireAt).map(describe).join('\n') };
        }

        if (action === 'cancel') {
          const id = reqString(input, 'id');
          const ok = await scheduler.cancel(id);
          return { content: ok ? `Cancelled ${id}.` : `No schedule with id ${id}.` };
        }

        if (action === 'add') {
          const message = reqString(input, 'message');
          const at = optString(input, 'at');
          const after = optString(input, 'after');
          const every = optString(input, 'every');
          const label = optString(input, 'label');
          if (!at && !after && !every) {
            return errResult(new Error('add requires one of: at, after, every'));
          }
          const s = await scheduler.add({
            message,
            ...(at ? { at } : {}),
            ...(after ? { after } : {}),
            ...(every ? { every } : {}),
            ...(label ? { label } : {}),
          });
          return { content: `Scheduled ${s.id} — fires ${new Date(s.fireAt).toISOString()}${s.kind === 'every' ? ` and every ${Math.round((s.intervalMs ?? 0) / 1000)}s after` : ''}.` };
        }

        return errResult(new Error(`unknown action "${action}"`));
      } catch (e) {
        return errResult(e);
      }
    },
  };
}
