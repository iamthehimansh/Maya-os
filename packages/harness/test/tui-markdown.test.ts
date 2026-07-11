import { describe, it, expect } from 'vitest';
import { renderMarkdown, parseInline, wrapSegs, highlightCodeLine } from '../src/tui/markdown.js';
import { entryToLines } from '../src/tui/lines.js';
import { theme } from '../src/tui/theme.js';
import type { Seg, Line } from '../src/tui/lines.js';
import type { Entry } from '../src/tui/entries.js';

const text = (segs: Seg[]): string => segs.map((s) => s.text).join('');
const rowText = (l: Line): string => text(l.segs);
const seg = (segs: Seg[], t: string): Seg | undefined => segs.find((s) => s.text === t);

describe('parseInline', () => {
  it('marks **bold** runs bold, stripping the markers', () => {
    const segs = parseInline('a **big** cat');
    expect(text(segs)).toBe('a big cat');
    expect(seg(segs, 'big')?.bold).toBe(true);
    expect(seg(segs, 'a ')?.bold).toBeUndefined();
  });

  it('marks *italic* runs italic', () => {
    const segs = parseInline('be *bold* now'.replace('bold', 'quick'));
    expect(seg(segs, 'quick')?.italic).toBe(true);
  });

  it('colors `inline code` with the code color and drops backticks', () => {
    const segs = parseInline('run `npm test` now');
    const code = seg(segs, 'npm test');
    expect(code?.color).toBe(theme.mdCode);
    expect(text(segs)).toBe('run npm test now');
  });

  it('composes nested emphasis (**bold with `code`**)', () => {
    const segs = parseInline('**bold `x` end**');
    expect(seg(segs, 'bold ')?.bold).toBe(true);
    // inline code keeps its own color even inside bold
    expect(seg(segs, 'x')?.color).toBe(theme.mdCode);
  });

  it('leaves a bare asterisk alone', () => {
    const segs = parseInline('2 * 3 = 6');
    expect(text(segs)).toBe('2 * 3 = 6');
    expect(segs.every((s) => !s.italic)).toBe(true);
  });
});

describe('wrapSegs', () => {
  it('wraps styled text at word boundaries preserving style', () => {
    const rows = wrapSegs(parseInline('the **quick** brown fox'), 9);
    expect(rows.map(rowText)).toEqual(['the quick', 'brown fox']);
    const quick = seg(rows[0]!.segs, 'quick');
    expect(quick?.bold).toBe(true);
  });

  it('hard-breaks a word longer than the width', () => {
    const rows = wrapSegs([{ text: 'abcdefghij' }], 4);
    expect(rows.map(rowText)).toEqual(['abcd', 'efgh', 'ij']);
  });
});

describe('highlightCodeLine', () => {
  it('colors keywords, strings, and comments distinctly', () => {
    const segs = highlightCodeLine('const x = "hi" // note');
    expect(seg(segs, 'const')?.color).toBe(theme.mdKeyword);
    expect(seg(segs, '"hi"')?.color).toBe(theme.mdString);
    expect(seg(segs, '// note')?.color).toBe(theme.mdComment);
  });
});

describe('renderMarkdown blocks', () => {
  it('renders a heading bold in the heading color', () => {
    const rows = renderMarkdown('# Title here', 40);
    const title = seg(rows[0]!.segs, 'Title');
    expect(title?.bold).toBe(true);
    expect(title?.color).toBe(theme.mdHeading);
  });

  it('renders a bullet list with markers', () => {
    const rows = renderMarkdown('- one\n- two', 40).map(rowText);
    expect(rows.some((r) => r.startsWith('• one'))).toBe(true);
    expect(rows.some((r) => r.startsWith('• two'))).toBe(true);
  });

  it('keeps ordered-list numbers', () => {
    const rows = renderMarkdown('1. first\n2. second', 40).map(rowText);
    expect(rows.some((r) => r.startsWith('1. first'))).toBe(true);
    expect(rows.some((r) => r.startsWith('2. second'))).toBe(true);
  });

  it('renders a fenced code block with a gutter, preserving indentation', () => {
    const rows = renderMarkdown('```js\n  const a = 1\n```', 40);
    const code = rows.find((r) => rowText(r).includes('const'));
    expect(code).toBeDefined();
    expect(rowText(code!)).toContain('│ ');
    // leading indentation inside the code survives
    expect(rowText(code!)).toContain('  const a = 1');
    expect(seg(code!.segs, 'const')?.color).toBe(theme.mdKeyword);
  });

  it('does NOT treat text inside a code fence as list/heading markup', () => {
    const rows = renderMarkdown('```\n# not a heading\n```', 40).map(rowText);
    expect(rows.some((r) => r.includes('# not a heading'))).toBe(true);
  });

  it('renders a blockquote with a gutter', () => {
    const rows = renderMarkdown('> quoted', 40);
    expect(rowText(rows[0]!)).toContain('│ ');
    expect(rowText(rows[0]!)).toContain('quoted');
  });

  it('renders a horizontal rule', () => {
    const rows = renderMarkdown('---', 40);
    expect(rowText(rows[0]!)).toMatch(/─+/);
  });

  it('renders links as an underlined label plus the target, not raw brackets', () => {
    const rows = renderMarkdown('see [the docs](https://x.dev/a) now', 60);
    const t = rowText(rows[0]!);
    expect(t).not.toContain('](');
    expect(t).toContain('the docs');
    expect(t).toContain('https://x.dev/a');
    // the label is underlined + link-colored (wrapping splits it into word segs)
    expect(seg(rows[0]!.segs, 'docs')?.underline).toBe(true);
    expect(seg(rows[0]!.segs, 'docs')?.color).toBe(theme.mdLink);
    expect(seg(parseInline('[the docs](https://x.dev/a)'), 'the docs')?.underline).toBe(true);
  });

  it('steps the bullet marker through nested list levels', () => {
    const rows = renderMarkdown('- top\n  - nested\n    - deeper', 40).map(rowText);
    expect(rows[0]).toBe('• top');
    expect(rows[1]).toBe('  ◦ nested');
    expect(rows[2]).toBe('    ▪ deeper');
  });

  it('renders every block of a mixed message, in source order', () => {
    const md = [
      '# Head',
      '',
      '> quoted',
      '',
      '- bullet',
      '  - nested',
      '1. numbered',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---',
      '',
      'plain **bold** and `code`.',
    ].join('\n');
    const rows = renderMarkdown(md, 60).map(rowText);
    const at = (needle: string) => rows.findIndex((r) => r.includes(needle));
    expect(at('Head')).toBeGreaterThanOrEqual(0);
    expect(at('quoted')).toBeGreaterThan(at('Head'));
    expect(at('• bullet')).toBeGreaterThan(at('quoted'));
    expect(at('◦ nested')).toBeGreaterThan(at('• bullet'));
    expect(at('1. numbered')).toBeGreaterThan(at('◦ nested'));
    expect(at('const a = 1')).toBeGreaterThan(at('1. numbered'));
    expect(at('┌')).toBeGreaterThan(at('const a = 1'));
    expect(at('─────')).toBeGreaterThan(at('└'));
    expect(at('plain bold and code.')).toBeGreaterThan(at('┌'));
    // the table is a frame, never raw pipes-and-dashes
    expect(rows.some((r) => r.includes('|---|') || r.includes('| A | B |'))).toBe(false);
  });
});

// ── GFM tables ──
const TABLE = [
  '| # | Item | Status |',
  '|---|:-----|-------:|',
  '| 1 | alpha | ok |',
  '| 2 | a much longer cell | pending |',
].join('\n');

describe('renderMarkdown tables', () => {
  it('renders a GFM table as an aligned box, not raw markdown', () => {
    const rows = renderMarkdown(TABLE, 60).map(rowText);
    // NOT raw markdown
    expect(rows.some((r) => r.includes('|---|') || r.includes(':-----'))).toBe(false);
    // a real frame
    expect(rows[0]!.startsWith('┌')).toBe(true);
    expect(rows[rows.length - 1]!.startsWith('└')).toBe(true);
    expect(rows.some((r) => r.startsWith('├'))).toBe(true);
    // header + both data rows survive
    expect(rows.some((r) => r.includes('Item'))).toBe(true);
    expect(rows.some((r) => r.includes('alpha'))).toBe(true);
    expect(rows.some((r) => r.includes('a much longer cell'))).toBe(true);
  });

  it('aligns the columns: every frame row is the same width, with pipes in the same places', () => {
    const rows = renderMarkdown(TABLE, 60).map(rowText);
    const widths = new Set(rows.map((r) => r.length));
    expect(widths.size).toBe(1); // uniform frame width
    const barsIn = (r: string): number[] => [...r].flatMap((c, i) => (c === '│' ? [i] : []));
    const body = rows.filter((r) => r.startsWith('│'));
    const cols = barsIn(body[0]!);
    expect(cols.length).toBe(4); // 3 columns → 4 separators
    for (const r of body) expect(barsIn(r)).toEqual(cols); // columns line up
  });

  it('honors :--- / ---: alignment', () => {
    const rows = renderMarkdown(TABLE, 60).map(rowText);
    const alpha = rows.find((r) => r.includes('alpha'))!;
    const cells = alpha.split('│').slice(1, -1);
    expect(cells[1]).toMatch(/^ alpha +$/); // left-aligned  (:-----)
    expect(cells[2]).toMatch(/^ +ok $/); // right-aligned (-------:)
  });

  it('marks up cell contents (bold / inline code) inside the table', () => {
    const rows = renderMarkdown('| A |\n| - |\n| **hi** `x` |', 40);
    const body = rows.find((r) => rowText(r).includes('hi'))!;
    expect(seg(body.segs, 'hi')?.bold).toBe(true);
    expect(seg(body.segs, 'x')?.color).toBe(theme.mdCode);
    expect(rowText(body)).not.toContain('**');
  });

  it('never exceeds the render width — wide table at a narrow width', () => {
    const wide = [
      '| Column one | Column two | Column three | Column four |',
      '| --- | --- | --- | --- |',
      '| a fairly long value here | another long value | yet more text in here | and a fourth one |',
    ].join('\n');
    for (const w of [100, 60, 40, 30, 20, 12]) {
      const rows = renderMarkdown(wide, w).map(rowText);
      for (const r of rows) expect(r.length).toBeLessThanOrEqual(w);
      // content is still there in some form
      expect(rows.some((r) => r.length > 0)).toBe(true);
    }
  });

  it('wraps long cells inside the column rather than overflowing', () => {
    const rows = renderMarkdown(TABLE, 30).map(rowText);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(30);
    // the long cell spilled onto extra rows inside the same frame
    expect(rows.filter((r) => r.startsWith('│')).length).toBeGreaterThan(3);
    expect(rows[rows.length - 1]!.startsWith('└')).toBe(true);
  });

  it('marks a cell whose content had to be dropped with an ellipsis', () => {
    const md = ['| Notes |', '| --- |', `| ${'word '.repeat(40).trim()} |`].join('\n');
    const rows = renderMarkdown(md, 20).map(rowText);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(20);
    expect(rows.some((r) => r.includes('…'))).toBe(true); // the cut is visible
    expect(rows[rows.length - 1]!.startsWith('└')).toBe(true); // frame still closes
  });

  it('degrades to a record list when the terminal is far too narrow to frame it', () => {
    const rows = renderMarkdown(TABLE, 12).map(rowText);
    expect(rows.some((r) => r.includes('┌'))).toBe(false);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(12);
    expect(rows.join('\n')).toContain('alpha');
  });

  it('re-fits the same table when the width changes (resize)', () => {
    const frameWidth = (w: number) =>
      renderMarkdown(TABLE, w).map(rowText).find((r) => r.startsWith('┌'))!.length;
    // sized to content when there is room — it does not stretch to fill 120…
    const natural = frameWidth(120);
    expect(natural).toBeLessThanOrEqual(60);
    expect(frameWidth(60)).toBe(natural);
    // …and squeezes down when the terminal shrinks under it
    expect(frameWidth(28)).toBeLessThan(natural);
    for (const w of [120, 60, 28]) {
      for (const r of renderMarkdown(TABLE, w).map(rowText)) expect(r.length).toBeLessThanOrEqual(w);
    }
  });

  it('leaves a lone pipe-row alone when there is no delimiter row', () => {
    const rows = renderMarkdown('a | b | c', 40).map(rowText);
    expect(rows[0]).toBe('a | b | c');
  });
});

describe('every markdown row fits the width', () => {
  const md = [
    '# A heading that is quite long and will need to wrap at narrow widths',
    '',
    'A paragraph with a **bold** run, `inline code`, and a [link](https://example.com/some/path).',
    '',
    '- a bullet item with enough text that it has to wrap somewhere',
    '  - a nested bullet with more text still',
    '',
    '> a blockquote that also runs on for a while and must wrap',
    '',
    '```ts',
    'const aVeryLongIdentifierName = someFunctionCall(withArguments, andMore)',
    '```',
    '',
    TABLE,
  ].join('\n');

  for (const w of [120, 80, 60, 40, 24]) {
    it(`fits at ${w} columns`, () => {
      for (const row of renderMarkdown(md, w)) {
        expect(rowText(row).length).toBeLessThanOrEqual(w);
      }
    });
  }
});

describe('assistant entry uses Markdown + streaming caret', () => {
  const opts = { width: 40, expandedToolIds: new Set<string>(), selectedToolId: undefined };

  it('renders assistant bold via Markdown', () => {
    const e: Entry = { kind: 'assistant', text: 'hi **there**', streaming: false };
    const lines = entryToLines(e, opts);
    expect(seg(lines[0]!.segs, 'there')?.bold).toBe(true);
  });

  it('appends the streaming caret to the last row while streaming', () => {
    const e: Entry = { kind: 'assistant', text: 'typing', streaming: true };
    const lines = entryToLines(e, opts);
    expect(rowText(lines[lines.length - 1]!)).toContain('▋');
  });
});
