/**
 * Session persistence + command history units. OWNER: @runtime.
 * Everything runs against a fresh tmp baseDir so nothing touches ~/.maya-harness.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCommandHistory,
  createSessionStore,
  type SessionStore,
} from '../src/session/index.js';
import type { ModelMessage } from '../src/types.js';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'harness-session-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const msgs = (text: string): ModelMessage[] => [
  { role: 'user', content: [{ type: 'text', text }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
];

describe('session store', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = createSessionStore(base);
  });

  it('create allocates a fresh record without writing to disk', async () => {
    const rec = store.create({ provider: 'anthropic', model: 'claude-x', cwd: '/tmp' });
    expect(rec.id).toBeTruthy();
    expect(rec.messages).toEqual([]);
    // Not persisted yet.
    expect(await store.list()).toEqual([]);
  });

  it('saves and loads a full transcript', async () => {
    const rec = store.create({ provider: 'openai', model: 'gpt-x', cwd: '/work' });
    await store.save({ id: rec.id, provider: 'openai', model: 'gpt-x', cwd: '/work', messages: msgs('hi there') });
    const loaded = await store.load(rec.id);
    expect(loaded?.provider).toBe('openai');
    expect(loaded?.model).toBe('gpt-x');
    expect(loaded?.cwd).toBe('/work');
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0]?.content[0]).toEqual({ type: 'text', text: 'hi there' });
  });

  it('never writes secrets — only provider/model/cwd/messages fields', async () => {
    const rec = store.create({ provider: 'anthropic', model: 'claude-x', cwd: '/w' });
    await store.save({ id: rec.id, provider: 'anthropic', model: 'claude-x', cwd: '/w', messages: msgs('q') });
    const raw = await readFile(join(base, 'sessions', `${rec.id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`), 'utf8');
    expect(raw).not.toMatch(/token|api[-_]?key|secret|bearer|sk-/i);
    const keys = Object.keys(JSON.parse(raw)).sort();
    expect(keys).toEqual(['createdAt', 'cwd', 'id', 'messages', 'model', 'provider', 'updatedAt']);
  });

  it('list returns summaries newest-updated first with a preview', async () => {
    const a = store.create({ provider: 'anthropic', model: 'm', cwd: '/a' });
    await store.save({ id: a.id, provider: 'anthropic', model: 'm', cwd: '/a', messages: msgs('first session') });
    // Ensure a strictly later updatedAt for the second save.
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create({ provider: 'openai', model: 'm2', cwd: '/b' });
    await store.save({ id: b.id, provider: 'openai', model: 'm2', cwd: '/b', messages: msgs('second session') });

    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(b.id);
    expect(list[0]?.preview).toBe('second session');
    expect(list[0]?.messageCount).toBe(2);
  });

  it('latest reloads the most-recently-updated record; --continue path', async () => {
    const a = store.create({ provider: 'anthropic', model: 'm', cwd: '/a' });
    await store.save({ id: a.id, provider: 'anthropic', model: 'm', cwd: '/a', messages: msgs('older') });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create({ provider: 'openai', model: 'm2', cwd: '/b' });
    await store.save({ id: b.id, provider: 'openai', model: 'm2', cwd: '/b', messages: msgs('newer') });
    const latest = await store.latest();
    expect(latest?.id).toBe(b.id);
  });

  it('preserves createdAt across overwrites but bumps updatedAt', async () => {
    const rec = store.create({ provider: 'anthropic', model: 'm', cwd: '/w' });
    await store.save({ id: rec.id, provider: 'anthropic', model: 'm', cwd: '/w', messages: msgs('one') });
    const v1 = await store.load(rec.id);
    await new Promise((r) => setTimeout(r, 5));
    await store.save({ id: rec.id, provider: 'anthropic', model: 'm', cwd: '/w', messages: msgs('two') });
    const v2 = await store.load(rec.id);
    expect(v2?.createdAt).toBe(v1?.createdAt);
    expect(v2!.updatedAt).toBeGreaterThanOrEqual(v1!.updatedAt);
    expect(v2?.messages[0]?.content[0]).toEqual({ type: 'text', text: 'two' });
  });

  it('load returns null for a missing session and empty list on no dir', async () => {
    expect(await store.load('does-not-exist')).toBeNull();
    expect(await store.latest()).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});

describe('command history', () => {
  it('appends, dedupes consecutive entries, and returns oldest→newest', async () => {
    const h = createCommandHistory(base);
    h.add('one');
    h.add('two');
    h.add('two'); // consecutive dup skipped
    h.add('one'); // non-consecutive dup kept
    expect(h.all()).toEqual(['one', 'two', 'one']);
    await h.flush(); // let the debounced write land before teardown
  });

  it('ignores blank entries', async () => {
    const h = createCommandHistory(base);
    h.add('  ');
    h.add('');
    h.add('real');
    expect(h.all()).toEqual(['real']);
    await h.flush();
  });

  it('persists across instances (readline-style ↑/↓ recall)', async () => {
    const h1 = createCommandHistory(base);
    h1.add('build');
    h1.add('test');
    await h1.flush(); // deterministic — no more sleep-and-hope
    const h2 = createCommandHistory(base);
    await h2.load();
    expect(h2.all()).toEqual(['build', 'test']);
  });
});
