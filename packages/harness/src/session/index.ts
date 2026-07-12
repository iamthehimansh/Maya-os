/**
 * Session persistence + command history. OWNER: @runtime.
 *
 * Sessions are written to `~/.maya-harness/sessions/<id>.json` (transcript +
 * provider/model/cwd) so `/resume` and `--continue` can reload a conversation.
 * Command history is a readline-style dedup'd list in `~/.maya-harness/history`
 * that powers the input's ↑/↓ recall.
 *
 * SECURITY: never persist credentials. We store only provider id / model / cwd /
 * message content — `Credential` and auth tokens never reach this module.
 *
 * No Ink/React deps; consumed by the TUI and CLI, tested standalone.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage, ProviderId } from '../types.js';

export interface SessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  provider: ProviderId;
  model: string;
  cwd: string;
  messages: ModelMessage[];
}

/** Lightweight entry for the `/resume` picker (no full transcript). */
export interface SessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  provider: ProviderId;
  model: string;
  cwd: string;
  messageCount: number;
  /** First user message, trimmed to one line, for the picker. */
  preview: string;
}

export interface SessionInit {
  provider: ProviderId;
  model: string;
  cwd: string;
}

export interface SessionSavePatch {
  id: string;
  provider: ProviderId;
  model: string;
  cwd: string;
  messages: ModelMessage[];
}

export interface SessionStore {
  /** Allocate a new session id + record (not yet written to disk). */
  create(init: SessionInit): SessionRecord;
  /** Persist (create or overwrite) a session, stamping updatedAt. */
  save(patch: SessionSavePatch): Promise<void>;
  load(id: string): Promise<SessionRecord | null>;
  /** Summaries, newest-updated first. */
  list(): Promise<SessionSummary[]>;
  /** Most-recently-updated full record, or null if none. */
  latest(): Promise<SessionRecord | null>;
}

const DEFAULT_BASE = join(homedir(), '.maya-harness');

/** Extract a one-line preview from the first user text block. */
function previewOf(messages: ModelMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) {
        return b.text.trim().replace(/\s+/g, ' ').slice(0, 80);
      }
    }
  }
  return '(no messages)';
}

/** URL-safe-ish random id without pulling in a dep. */
function makeId(seed: number): string {
  const rnd = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return `${Math.floor(seed).toString(36)}-${rnd}`;
}

/**
 * Epoch ms with SUB-MS resolution. `Date.now()` is integer-ms, so two sessions
 * saved in the same millisecond tie — and `latest()`'s sort then falls back to
 * readdir() order, making `--continue` pick an ARBITRARY session among them
 * rather than the newest. performance.now() is monotonic within the process, so
 * back-to-back saves always order correctly; the origin keeps it a real epoch
 * timestamp (the picker renders it as a date) and comparable with the integer
 * timestamps already on disk.
 */
const CLOCK_ORIGIN = Date.now() - performance.now();
function now(): number {
  return CLOCK_ORIGIN + performance.now();
}

class SessionStoreImpl implements SessionStore {
  private readonly dir: string;

  constructor(baseDir: string = DEFAULT_BASE) {
    this.dir = join(baseDir, 'sessions');
  }

  create(init: SessionInit): SessionRecord {
    const t = now();
    return {
      id: makeId(t),
      createdAt: t,
      updatedAt: t,
      provider: init.provider,
      model: init.model,
      cwd: init.cwd,
      messages: [],
    };
  }

  async save(patch: SessionSavePatch): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const t = now();
    let createdAt = t;
    // Preserve the original createdAt across overwrites.
    const existing = await this.load(patch.id);
    if (existing) createdAt = existing.createdAt;
    const rec: SessionRecord = {
      id: patch.id,
      createdAt,
      updatedAt: t,
      provider: patch.provider,
      model: patch.model,
      cwd: patch.cwd,
      messages: patch.messages,
    };
    await writeFile(this.pathFor(patch.id), JSON.stringify(rec, null, 2), 'utf8');
  }

  async load(id: string): Promise<SessionRecord | null> {
    try {
      const raw = await readFile(this.pathFor(id), 'utf8');
      const rec = JSON.parse(raw) as SessionRecord;
      if (!rec || typeof rec.id !== 'string' || !Array.isArray(rec.messages)) return null;
      return rec;
    } catch {
      return null;
    }
  }

  async list(): Promise<SessionSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const rec = await this.load(f.slice(0, -5));
      if (!rec) continue;
      out.push({
        id: rec.id,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        provider: rec.provider,
        model: rec.model,
        cwd: rec.cwd,
        messageCount: rec.messages.length,
        preview: previewOf(rec.messages),
      });
    }
    // Newest first. Sessions written by an OLDER build still carry integer-ms
    // stamps and can genuinely tie, so break ties on createdAt then id: an
    // arbitrary-but-STABLE order beats readdir() order, which varies by filesystem.
    out.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return out;
  }

  async latest(): Promise<SessionRecord | null> {
    const summaries = await this.list();
    if (summaries.length === 0) return null;
    return this.load(summaries[0]!.id);
  }

  private pathFor(id: string): string {
    // Guard against path traversal via a crafted id.
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }
}

export function createSessionStore(baseDir?: string): SessionStore {
  return new SessionStoreImpl(baseDir);
}

// ─────────────────────────────────────────────────────── command history ────

export interface CommandHistory {
  /** Append a command, deduped against the immediately previous entry; persists. */
  add(cmd: string): void;
  /** All entries, oldest → newest. */
  all(): string[];
  /** Load persisted history from disk (call once at startup). */
  load(): Promise<void>;
  /** Resolve once all pending writes have flushed (await on quit / in tests). */
  flush(): Promise<void>;
}

const HISTORY_MAX = 1000;

class CommandHistoryImpl implements CommandHistory {
  private readonly file: string;
  private entries: string[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(baseDir: string = DEFAULT_BASE) {
    this.file = join(baseDir, 'history');
  }

  add(cmd: string): void {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    // Readline-style: skip if identical to the last entry.
    if (this.entries[this.entries.length - 1] === trimmed) return;
    this.entries.push(trimmed);
    if (this.entries.length > HISTORY_MAX) {
      this.entries = this.entries.slice(-HISTORY_MAX);
    }
    this.persist();
  }

  all(): string[] {
    return [...this.entries];
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      this.entries = raw.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
    } catch {
      this.entries = [];
    }
  }

  flush(): Promise<void> {
    return this.writing;
  }

  /** Serialize writes so rapid `add()` calls don't interleave. */
  private persist(): void {
    const snapshot = [...this.entries];
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(join(this.file, '..'), { recursive: true });
        await writeFile(this.file, `${snapshot.join('\n')}\n`, 'utf8');
      } catch {
        /* history is best-effort; never crash the app over it */
      }
    });
  }
}

export function createCommandHistory(baseDir?: string): CommandHistory {
  return new CommandHistoryImpl(baseDir);
}
