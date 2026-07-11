import { describe, it, expect } from 'vitest';
import { computeCompletions, applyCompletion, type DirLister } from '../src/tui/autocomplete.js';

const listDir: DirLister = (dir) => {
  const fs: Record<string, string[]> = {
    '/repo': ['src/', 'package.json', 'README.md'],
    '/repo/src': ['index.ts', 'tui/'],
  };
  return fs[dir.replace(/\/$/, '')] ?? [];
};
const ctx = { history: ['git status', 'git commit -m x', 'run tests'], cwd: '/repo', listDir };

describe('slash completions', () => {
  it('completes a partial command', () => {
    const r = computeCompletions('/mod', 4, ctx)!;
    expect(r.kind).toBe('slash');
    expect(r.items.map((i) => i.value)).toContain('/model ');
    expect(r.replaceStart).toBe(0);
  });
  it('lists all commands for a bare slash', () => {
    const r = computeCompletions('/', 1, ctx)!;
    expect(r.items.length).toBeGreaterThan(5);
  });
  it('does not trigger once a space is typed', () => {
    const r = computeCompletions('/model ', 7, ctx);
    expect(r).toBeNull();
  });
  it('resolves aliases (/q → quit)', () => {
    const r = computeCompletions('/q', 2, ctx)!;
    expect(r.items.some((i) => i.value === '/quit')).toBe(true);
  });
});

describe('file completions', () => {
  it('completes a path-like token from the cwd', () => {
    const r = computeCompletions('cat ./', 6, ctx)!;
    expect(r.kind).toBe('file');
    expect(r.items.map((i) => i.label)).toEqual(['./src/', './package.json', './README.md']);
  });
  it('filters by the basename prefix', () => {
    const r = computeCompletions('open src/i', 10, ctx)!;
    expect(r.items.map((i) => i.value)).toEqual(['src/index.ts']);
  });
  it('keeps the @ prefix on the replacement', () => {
    const r = computeCompletions('see @src/tui', 12, ctx)!;
    expect(r.kind).toBe('file');
    expect(r.items[0]!.value).toBe('@src/tui/');
  });
  it('replaces only the active token', () => {
    const r = computeCompletions('open src/i', 10, ctx)!;
    const applied = applyCompletion('open src/i', r, r.items[0]!);
    expect(applied.value).toBe('open src/index.ts');
    expect(applied.cursor).toBe('open src/index.ts'.length);
  });
});

describe('history completions', () => {
  it('suggests earlier commands by prefix, newest first', () => {
    const r = computeCompletions('git', 3, ctx)!;
    expect(r.kind).toBe('history');
    expect(r.items.map((i) => i.value)).toEqual(['git commit -m x', 'git status']);
  });
  it('yields nothing when no history matches', () => {
    expect(computeCompletions('zzz', 3, ctx)).toBeNull();
  });
});
