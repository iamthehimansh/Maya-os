/**
 * Shared fakes for driving <App/> under ink-testing-library.
 * Everything the App touches is faked so tests are deterministic and offline.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { App, type AppProps } from '../src/tui/App.js';
import { TuiPermissionGate } from '../src/tui/permission.js';
import type { LoopEvent, ModelMessage, Session, SessionState, Credential } from '../src/types.js';
import type { TaskRunner, BgTask } from '../src/tasks/index.js';
import type { SessionStore, SessionRecord, SessionSummary, CommandHistory } from '../src/session/index.js';
import type { Model } from '../src/models/index.js';

export const delay = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── key byte sequences ──
export const KEY = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  ctrlP: '\x10',
  ctrlN: '\x0e',
  ctrlC: '\x03',
  backspace: '\x7f',
};

export type RunImpl = (
  text: string,
  signal: AbortSignal | undefined,
  callIndex: number,
) => AsyncGenerator<LoopEvent>;

export interface FakeSession extends Session {
  _state: SessionState;
}

export function makeSession(run: RunImpl, over: Partial<SessionState> = {}): FakeSession {
  const state: SessionState = {
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    authMode: 'api',
    authSource: 'test-key',
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    contextTokens: 0,
    ...over,
  };
  let messages: ModelMessage[] = [];
  let calls = 0;
  const session: FakeSession = {
    _state: state,
    get state() {
      return state;
    },
    get messages() {
      return messages;
    },
    run(input, opts) {
      const text = typeof input === 'string' ? input : '';
      messages.push({ role: 'user', content: [{ type: 'text', text }] });
      return run(input as never, opts?.signal, calls++);
    },
    inject() {
      return 0;
    },
    async compact() {
      return null;
    },
    setModel(m) {
      state.model = m;
    },
    async setProvider(p) {
      state.provider = p;
      state.model = p === 'openai' ? 'gpt-5.5' : 'claude-opus-4-8';
    },
    async setAuth(mode) {
      state.authMode = mode;
    },
    clear() {
      messages = [];
    },
    loadMessages(m) {
      messages = m.map((x) => ({ role: x.role, content: [...x.content] }));
    },
  };
  return session;
}

/** A no-op run that ends immediately. */
export async function* endTurn(): AsyncGenerator<LoopEvent> {
  yield { type: 'turn_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
}

export function makeTasks(initial: BgTask[] = []): TaskRunner & { _emit(t: BgTask): void; _tasks: BgTask[] } {
  const tasks = [...initial];
  const subs = new Set<(t: BgTask) => void>();
  let n = 0;
  return {
    _tasks: tasks,
    start(command, opts) {
      const t: BgTask = { id: `bg${++n}`, command, cwd: opts?.cwd ?? '.', status: 'running', exitCode: null, signal: null, startedAt: 0, endedAt: null, output: '' };
      tasks.push(t);
      subs.forEach((s) => s(t));
      return t;
    },
    list: () => [...tasks],
    get: (id) => tasks.find((t) => t.id === id),
    output: (id) => tasks.find((t) => t.id === id)?.output ?? '',
    kill(id) {
      const t = tasks.find((x) => x.id === id);
      if (t && t.status === 'running') { t.status = 'killed'; subs.forEach((s) => s(t)); return true; }
      return false;
    },
    onUpdate(cb) { subs.add(cb); return () => subs.delete(cb); },
    runningCount: () => tasks.filter((t) => t.status === 'running').length,
    killAll() { tasks.forEach((t) => { if (t.status === 'running') t.status = 'killed'; }); },
    _emit(t) { subs.forEach((s) => s(t)); },
  };
}

export function makeStore(records: SessionRecord[] = []): SessionStore {
  const map = new Map(records.map((r) => [r.id, r]));
  let n = records.length;
  return {
    create(init) {
      const rec: SessionRecord = { id: `s${++n}`, createdAt: 0, updatedAt: 0, ...init, messages: [] };
      map.set(rec.id, rec);
      return rec;
    },
    async save(patch) {
      const prev = map.get(patch.id);
      map.set(patch.id, { id: patch.id, createdAt: prev?.createdAt ?? 0, updatedAt: 1, provider: patch.provider, model: patch.model, cwd: patch.cwd, messages: patch.messages });
    },
    async load(id) {
      return map.get(id) ?? null;
    },
    async list() {
      return [...map.values()].map<SessionSummary>((r) => ({ id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt, provider: r.provider, model: r.model, cwd: r.cwd, messageCount: r.messages.length, preview: firstUserText(r.messages) }));
    },
    async latest() {
      const all = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      return all[0] ?? null;
    },
  };
}

function firstUserText(messages: ModelMessage[]): string {
  for (const m of messages) {
    if (m.role === 'user') {
      for (const b of m.content) if (b.type === 'text') return b.text.slice(0, 40);
    }
  }
  return '';
}

export function makeHistory(seed: string[] = []): CommandHistory {
  const entries = [...seed];
  return {
    add(cmd) { const t = cmd.trim(); if (t && entries[entries.length - 1] !== t) entries.push(t); },
    all: () => [...entries],
    async load() {},
    async flush() {},
  };
}

export function makeModels(models: Model[], source: 'api' | 'fallback' = 'api'): AppProps['fetchModels'] {
  return async (provider) => ({ models, source, provider });
}

export const fakeCred: Credential = { provider: 'anthropic', kind: 'api', source: 'test', token: 'x' };

export interface HarnessOverrides extends Partial<AppProps> {}

export function renderApp(session: Session, over: HarnessOverrides = {}) {
  const gate = over.gate ?? new TuiPermissionGate();
  const props: AppProps = {
    session,
    gate,
    tasks: over.tasks ?? makeTasks(),
    store: over.store ?? makeStore(),
    history: over.history ?? makeHistory(),
    sessionId: 's1',
    cwd: '/repo',
    fullscreen: false,
    cols: 80,
    rows: 24,
    resolveCred: async () => fakeCred,
    fetchModels: over.fetchModels ?? makeModels([{ id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic' }]),
    listDir: over.listDir ?? (() => []),
    ...over,
  };
  return render(<App {...props} />);
}
