/**
 * `--session-id` / `--resume <id>` — the revive-into-the-same-conversation path.
 * OWNER: @harness.
 *
 * The feature these guard: a standing team agent is drained and later revived, and
 * must come back into its OWN session — even though several agents share one cwd.
 * Everything runs against a fresh tmp baseDir so nothing touches ~/.maya-harness.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSessionStore, type SessionStore } from '../src/session/index.js';
import { resolveSessionPlan } from '../src/session/resume.js';
import { parseArgs } from '../src/args.js';
import type { ModelMessage } from '../src/types.js';

let base: string;
let store: SessionStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'harness-resume-'));
  store = createSessionStore(base);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const init = { provider: 'anthropic' as const, model: 'claude-opus-4-8', cwd: '/repo' };
const msgs = (text: string): ModelMessage[] => [
  { role: 'user', content: [{ type: 'text', text }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
];

describe('parseArgs --session-id', () => {
  it('parses --session-id <id>', () => {
    expect(parseArgs(['--session-id', 'abc-123']).sessionId).toBe('abc-123');
  });

  it('leaves sessionId undefined when the flag is absent', () => {
    expect(parseArgs(['-p', 'hi']).sessionId).toBeUndefined();
  });

  it('parses --session-id alongside the other flags (spawn shape Maya emits)', () => {
    const id = randomUUID();
    const a = parseArgs(['--auth', 'api', '--session-id', id, '--cwd', '/repo', '-p', 'hello']);
    expect(a).toMatchObject({ sessionId: id, cwd: '/repo', print: 'hello', auth: 'api' });
    // The id must not be swallowed as the positional prompt.
    expect(a.print).toBe('hello');
  });

  it('still parses --resume <id> and bare --resume (picker)', () => {
    expect(parseArgs(['--resume', 'xyz']).resume).toBe('xyz');
    expect(parseArgs(['--resume']).resume).toBe(true);
    expect(parseArgs(['--resume', '--yolo']).resume).toBe(true);
  });
});

describe('resolveSessionPlan', () => {
  it('--session-id writes the conversation under THAT id (first spawn)', async () => {
    const id = randomUUID();
    const plan = await resolveSessionPlan({ store, sessionId: id, init });
    expect(plan.record.id).toBe(id);
    expect(plan.preload).toBeNull();
    expect(plan.warning).toBeUndefined();

    // And that id is the file the store actually writes.
    await store.save({ id: plan.record.id, ...init, messages: msgs('first') });
    await expect(stat(join(base, 'sessions', `${id}.json`))).resolves.toBeTruthy();
  });

  it('--resume <id> reloads that exact transcript (revive)', async () => {
    const id = randomUUID();
    await store.save({ id, ...init, messages: msgs('remember me') });

    const plan = await resolveSessionPlan({ store, resume: id, init });
    expect(plan.record.id).toBe(id);
    expect(plan.preload?.messages).toEqual(msgs('remember me'));
    expect(plan.warning).toBeUndefined();
  });

  it('spawn → save → revive round-trips: the agent reopens its own conversation', async () => {
    const id = randomUUID();
    // First spawn: --session-id, fresh, then it talks.
    const first = await resolveSessionPlan({ store, sessionId: id, init });
    await store.save({ id: first.record.id, ...init, messages: msgs('the brief') });

    // Revive: --resume <same id>.
    const second = await resolveSessionPlan({ store, resume: id, init });
    expect(second.record.id).toBe(id);
    expect(second.preload?.messages).toEqual(msgs('the brief'));
  });

  it('missing session file → fresh conversation with the SAME id + a warning (never wedges)', async () => {
    const id = randomUUID();
    const plan = await resolveSessionPlan({ store, resume: id, init });

    expect(plan.preload).toBeNull();
    // The critical part: the id is NOT re-minted, so the NEXT revive still works.
    expect(plan.record.id).toBe(id);
    expect(plan.warning).toContain('not found');

    await store.save({ id: plan.record.id, ...init, messages: msgs('after wipe') });
    const again = await resolveSessionPlan({ store, resume: id, init });
    expect(again.preload?.messages).toEqual(msgs('after wipe'));
  });

  it('two agents in the SAME cwd get different ids and never cross-resume', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await store.save({ id: a, ...init, messages: msgs('I am agent A') });
    await store.save({ id: b, ...init, messages: msgs('I am agent B') });

    const planA = await resolveSessionPlan({ store, resume: a, init });
    const planB = await resolveSessionPlan({ store, resume: b, init });

    expect(planA.record.id).toBe(a);
    expect(planB.record.id).toBe(b);
    expect(planA.preload?.messages).toEqual(msgs('I am agent A'));
    expect(planB.preload?.messages).toEqual(msgs('I am agent B'));

    // `--continue` is the trap this feature exists to avoid: in a shared cwd it
    // resumes whoever saved LAST, so agent A would wake up as agent B.
    const cont = await resolveSessionPlan({ store, continue: true, init });
    expect(cont.preload?.messages).toEqual(msgs('I am agent B'));
  });

  it('latest() is deterministic for saves that land in the same millisecond', async () => {
    // Regression (caught by @orch): Date.now() is integer-ms, so back-to-back saves
    // tied, the sort fell through to readdir() order, and `--continue` picked an
    // ARBITRARY session instead of the newest. Save fast enough to share a ms.
    for (const [a, b] of [['s1', 's2'], ['s3', 's4'], ['s5', 's6']] as const) {
      await store.save({ id: a, ...init, messages: msgs(a) });
      await store.save({ id: b, ...init, messages: msgs(b) });
      const latest = await store.latest();
      expect(latest?.id).toBe(b);
    }
  });

  it('--session-id on an id that already has a transcript adopts it (no clobber)', async () => {
    const id = randomUUID();
    await store.save({ id, ...init, messages: msgs('prior life') });

    const plan = await resolveSessionPlan({ store, sessionId: id, init });
    expect(plan.record.id).toBe(id);
    expect(plan.preload?.messages).toEqual(msgs('prior life'));
  });

  it('--resume wins over a conflicting --session-id, and warns instead of crashing', async () => {
    const resumeId = randomUUID();
    const otherId = randomUUID();
    await store.save({ id: resumeId, ...init, messages: msgs('resume me') });

    const plan = await resolveSessionPlan({ store, resume: resumeId, sessionId: otherId, init });
    expect(plan.record.id).toBe(resumeId);
    expect(plan.preload?.messages).toEqual(msgs('resume me'));
    expect(plan.warning).toContain('overrides');
  });

  it('bare --resume (picker) and the default path mint a new id', async () => {
    const picker = await resolveSessionPlan({ store, resume: true, init });
    const fresh = await resolveSessionPlan({ store, init });
    expect(picker.preload).toBeNull();
    expect(fresh.preload).toBeNull();
    expect(picker.record.id).not.toBe(fresh.record.id);
  });

  it('--continue with no history starts fresh and warns', async () => {
    const plan = await resolveSessionPlan({ store, continue: true, init });
    expect(plan.preload).toBeNull();
    expect(plan.record.id).toBeTruthy();
    expect(plan.warning).toContain('no previous session');
  });
});
