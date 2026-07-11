import { describe, it, expect } from 'vitest';
import { wrapText, truncate, entriesToLines, entryToLines, toolIdsOf, type Line } from '../src/tui/lines.js';
import type { Entry } from '../src/tui/entries.js';
import type { ToolEntry } from '../src/tui/ToolView.js';

const flat = (lines: Line[]): string[] => lines.map((l) => l.segs.map((s) => s.text).join(''));

describe('wrapText', () => {
  it('wraps at word boundaries within width', () => {
    expect(wrapText('the quick brown fox', 9)).toEqual(['the quick', 'brown fox']);
  });
  it('hard-breaks words longer than width', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('preserves embedded newlines and blank lines', () => {
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });
  it('never returns an empty array', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
});

describe('truncate', () => {
  it('adds an ellipsis past width', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
  });
  it('leaves short strings intact', () => {
    expect(truncate('hi', 8)).toBe('hi');
  });
});

const tool = (over: Partial<ToolEntry>): ToolEntry => ({
  kind: 'tool',
  id: 't1',
  name: 'bash',
  input: { command: 'git status' },
  done: true,
  isError: false,
  output: 'On branch main\nnothing to commit',
  ...over,
});

describe('tool collapse / expand', () => {
  const opts = (over: Partial<Parameters<typeof entryToLines>[1]> = {}) => ({
    width: 80,
    expandedToolIds: new Set<string>(),
    selectedToolId: undefined,
    ...over,
  });

  it('collapses to a single summary line when not expanded', () => {
    const lines = entryToLines(tool({}), opts());
    expect(lines).toHaveLength(1);
    const text = flat(lines)[0]!;
    expect(text).toContain('▸');
    expect(text).toContain('bash');
    expect(text).toContain('git status');
    expect(text).toContain('(ok)');
    expect(text).not.toContain('nothing to commit');
  });

  it('shows full output when expanded', () => {
    const lines = entryToLines(tool({}), opts({ expandedToolIds: new Set(['t1']) }));
    const joined = flat(lines).join('\n');
    expect(joined).toContain('▾');
    expect(joined).toContain('nothing to commit');
  });

  it('marks the selected block with a caret', () => {
    const lines = entryToLines(tool({}), opts({ selectedToolId: 't1' }));
    expect(flat(lines)[0]).toContain('❯');
    expect(lines[0]!.toolHeader).toBe(true);
    expect(lines[0]!.toolId).toBe('t1');
  });

  it('shows a running marker for in-flight tools', () => {
    const lines = entryToLines(tool({ done: false, output: undefined }), opts({ expandedToolIds: new Set(['t1']) }));
    expect(flat(lines).join('\n')).toContain('running');
  });
});

describe('entriesToLines', () => {
  const entries: Entry[] = [
    { kind: 'user', text: 'hi there' },
    { kind: 'assistant', text: 'hello', streaming: false },
    tool({ id: 'a' }),
    tool({ id: 'b' }),
  ];

  it('renders a blank spacer between entries', () => {
    const lines = entriesToLines(entries, { width: 80, expandedToolIds: new Set(), selectedToolId: undefined });
    const texts = flat(lines);
    expect(texts.some((t) => t.includes('hi there'))).toBe(true);
    expect(texts.some((t) => t === '')).toBe(true);
  });

  it('lists tool ids in order', () => {
    expect(toolIdsOf(entries)).toEqual(['a', 'b']);
  });
});
