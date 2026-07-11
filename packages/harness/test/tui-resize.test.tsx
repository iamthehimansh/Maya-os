/**
 * The transcript must lay out to the CURRENT terminal width and re-flow when it
 * changes: markdown re-wraps, tables re-fit, nothing overflows or is left over
 * from the old width.
 *
 * ink-testing-library's virtual stdout is fixed at 100 columns, so App-level
 * width changes are driven through the `cols` prop (the same value the real App
 * derives from `process.stdout.columns`, which it now re-reads on `resize`).
 * The pure renderer is exercised at wider widths in tui-markdown.test.ts.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { App, type AppProps } from '../src/tui/App.js';
import { TuiPermissionGate } from '../src/tui/permission.js';
import type { Entry } from '../src/tui/entries.js';
import { makeSession, makeTasks, makeStore, makeHistory, makeModels, fakeCred, endTurn } from './_app-harness.js';

const TABLE_MD = [
  '# Release checklist',
  '',
  '| # | Item | Status | Notes |',
  '|---|:-----|:------:|------:|',
  '| 1 | markdown tables | done | now rendered as a real table |',
  '| 2 | resize reflow | wip | re-wraps on terminal resize |',
  '',
  '- a bullet with enough words that it has to wrap at 60 columns',
  '  - and a nested one',
].join('\n');

const entries: Entry[] = [{ kind: 'assistant', text: TABLE_MD, streaming: false }];

/** Drop SGR escapes so a row's length is its display width. */
const strip = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, '');
const rowsOf = (frame: string | undefined): string[] => strip(frame ?? '').split('\n');
const tableRows = (frame: string | undefined): string[] =>
  rowsOf(frame).filter((r) => /[┌├└│]/.test(r) && !r.includes('maya'));

function appEl(cols: number): React.ReactElement {
  const props: AppProps = {
    session: makeSession(endTurn),
    gate: new TuiPermissionGate(),
    tasks: makeTasks(),
    store: makeStore(),
    history: makeHistory(),
    sessionId: 's1',
    cwd: '/repo',
    fullscreen: false,
    cols,
    rows: 40,
    initialEntries: entries,
    resolveCred: async () => fakeCred,
    fetchModels: makeModels([{ id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic' }]),
    listDir: () => [],
  };
  return <App {...props} />;
}

describe('transcript fits the terminal and re-flows on resize', () => {
  it('renders a markdown table as a box at the current width, then re-fits when it shrinks', () => {
    const { lastFrame, rerender, unmount } = render(appEl(100));

    const wide = tableRows(lastFrame());
    expect(wide.length).toBeGreaterThan(0);
    expect(wide.some((r) => r.includes('┌'))).toBe(true);
    // it is a table, not the raw markdown source
    expect(strip(lastFrame() ?? '')).not.toContain('|---|');
    expect(strip(lastFrame() ?? '')).not.toContain('| # | Item |');
    const wideFrame = wide.find((r) => r.includes('┌'))!.trim().length;

    // ── the terminal shrinks ──
    rerender(appEl(60));

    const narrowAll = rowsOf(lastFrame());
    for (const r of narrowAll) expect(r.length).toBeLessThanOrEqual(60);

    const narrow = tableRows(lastFrame());
    const narrowFrame = narrow.find((r) => r.includes('┌'))!.trim().length;
    expect(narrowFrame).toBeLessThan(wideFrame); // re-fitted, not stale
    expect(narrowFrame).toBeLessThanOrEqual(60);
    // content survived the squeeze
    expect(strip(lastFrame() ?? '')).toContain('Status');

    // ── and grows back ──
    rerender(appEl(100));
    const again = tableRows(lastFrame());
    expect(again.find((r) => r.includes('┌'))!.trim().length).toBe(wideFrame);

    unmount();
  });

  it('keeps every transcript row within the terminal width at several sizes', () => {
    for (const cols of [100, 80, 60, 40]) {
      const { lastFrame, unmount } = render(appEl(cols));
      for (const r of rowsOf(lastFrame())) {
        expect(r.length, `row overflowed at ${cols} cols: ${JSON.stringify(r)}`).toBeLessThanOrEqual(cols);
      }
      unmount();
    }
  });
});
