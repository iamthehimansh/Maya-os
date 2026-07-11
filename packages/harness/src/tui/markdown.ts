/**
 * markdown.ts — render assistant Markdown into styled terminal rows (`Line[]`).
 *
 * The transcript shows agent text through this so it reads like the dashboard
 * chat: bold/italic, links, inline + fenced code (with light syntax
 * highlighting), headings, lists, blockquotes, GFM tables and rules — all
 * theme-aware and laid out to the CURRENT terminal width. Every row we emit is
 * at most `width` display columns, so a resize just re-renders at the new width
 * and nothing overflows or leaves a stale frame behind.
 *
 * Pure + unit-tested — no Ink, no React. Emits the same `Line`/`Seg` shape the
 * scroll viewport consumes, so `entryToLines` just swaps plain wrap for this.
 */
import type { Line, Seg } from './lines.js';
import { theme } from './theme.js';

/** Inline style carried down into `parseInline` (Seg minus the text/inverse). */
type Style = Omit<Seg, 'text' | 'inverse'>;

const mkLine = (segs: Seg[]): Line => ({ segs: segs.length ? segs : [{ text: '' }] });

// ── display-width helpers ────────────────────────────────────────────────────
// Terminals lay text out in cells, not code points: CJK and emoji occupy two,
// combining marks occupy none. Tables only align if we measure in cells.

/** Display columns occupied by one code point. */
function charWidth(cp: number): number {
  if (cp === 0x200d) return 0; // zero-width joiner
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacriticals
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // variation selectors
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) // emoji
  ) {
    return 2;
  }
  return 1;
}

/** Display columns occupied by `s`. */
export function strWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += charWidth(ch.codePointAt(0)!);
  return n;
}

/** Longest prefix of `s` that fits in `w` display columns. */
function sliceWidth(s: string, w: number): string {
  if (w <= 0) return '';
  let out = '';
  let n = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (n + cw > w) break;
    out += ch;
    n += cw;
  }
  return out;
}

/** Total display width of a row of segments. */
const segsWidth = (segs: readonly Seg[]): number => segs.reduce((n, s) => n + strWidth(s.text), 0);

/** Plain text of a row of segments. */
const segsText = (segs: readonly Seg[]): string => segs.map((s) => s.text).join('');

/** Plain-truncate styled segments to `w` display columns (no marker). */
function cutSegs(segs: readonly Seg[], w: number): Seg[] {
  const out: Seg[] = [];
  let room = w;
  for (const s of segs) {
    if (room <= 0) break;
    const piece = sliceWidth(s.text, room);
    if (!piece) break;
    out.push({ ...s, text: piece });
    room -= strWidth(piece);
  }
  return out;
}

/**
 * Fit styled segments into `w` columns leaving a trailing `…` — content was
 * dropped and the reader must be able to see that. Used for table cells that
 * cannot be wrapped any further.
 */
function ellipsize(segs: readonly Seg[], w: number): Seg[] {
  if (w <= 0) return [{ text: '' }];
  if (segsWidth(segs) + 1 <= w) return [...segs, { text: '…', dim: true }];
  return [...cutSegs(segs, w - 1), { text: '…', dim: true }];
}

/** Pad styled segments to exactly `w` columns, honoring the cell alignment. */
function padSegs(segs: Seg[], w: number, align: Align): Seg[] {
  const gap = Math.max(0, w - segsWidth(segs));
  if (gap === 0) return segs;
  if (align === 'right') return [{ text: ' '.repeat(gap) }, ...segs];
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return [{ text: ' '.repeat(left) }, ...segs, { text: ' '.repeat(gap - left) }];
  }
  return [...segs, { text: ' '.repeat(gap) }];
}

// ── inline ───────────────────────────────────────────────────────────────────

/**
 * Parse inline Markdown (`**bold**`, `*italic*`, `` `code` ``, `[label](url)`)
 * into styled segments. `base` styles the plain runs (used to tint
 * headings/quotes). Nested emphasis composes (e.g. **bold `code`**).
 */
export function parseInline(text: string, base: Style = {}): Seg[] {
  const out: Seg[] = [];
  let rest = text;
  // First-match wins, in this priority: code, [link](url)/<autolink>,
  // **bold**/__bold__, *italic*/_italic_.
  const re =
    /(`+)([^`]+?)\1|!?\[([^\]]*)\]\(([^)\s]*)\)|<((?:https?|mailto):[^>\s]+)>|(\*\*|__)([\s\S]+?)\6|(\*|_)(?!\s)([\s\S]*?[^\s*_])\8/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) {
      out.push({ text: rest, ...base });
      break;
    }
    if (m.index > 0) out.push({ text: rest.slice(0, m.index), ...base });
    if (m[1] !== undefined) {
      // inline code — fixed color, ignores surrounding emphasis color
      out.push({ text: m[2]!, color: theme.mdCode });
    } else if (m[3] !== undefined) {
      out.push(...linkSegs(m[3]!, m[4]!, base));
    } else if (m[5] !== undefined) {
      out.push(...linkSegs(m[5]!, m[5]!, base));
    } else if (m[6] !== undefined) {
      out.push(...parseInline(m[7]!, { ...base, bold: true }));
    } else if (m[8] !== undefined) {
      out.push(...parseInline(m[9]!, { ...base, italic: true }));
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out.filter((s) => s.text.length > 0);
}

/** A link renders as its underlined label, followed by the dim target. */
function linkSegs(label: string, url: string, base: Style): Seg[] {
  const shown = label.trim() || url;
  const segs: Seg[] = [{ ...base, text: shown, color: theme.mdLink, underline: true }];
  if (url && url !== shown) segs.push({ text: ` (${url})`, color: theme.muted, dim: true });
  return segs;
}

// ── wrapping ─────────────────────────────────────────────────────────────────

/**
 * Word-wrap styled segments to `width` display columns, breaking at spaces and
 * hard-breaking words longer than the line. Collapses runs of whitespace — for
 * prose only.
 */
export function wrapSegs(segs: Seg[], width: number): Line[] {
  const w = Math.max(1, width);
  const toks: Seg[] = [];
  for (const seg of segs) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (part.length) toks.push({ ...seg, text: part });
    }
  }
  const lines: Line[] = [];
  let cur: Seg[] = [];
  let len = 0;
  const flush = () => {
    lines.push(mkLine(cur));
    cur = [];
    len = 0;
  };
  for (const tok of toks) {
    const isSpace = /^\s+$/.test(tok.text);
    if (isSpace) {
      if (len === 0 || len >= w) continue; // drop leading / overflowing spaces
      cur.push({ ...tok, text: ' ' });
      len += 1;
      continue;
    }
    const tw = strWidth(tok.text);
    if (len + tw <= w) {
      cur.push(tok);
      len += tw;
    } else if (tw > w) {
      // hard-break a very long word across rows
      let piece = tok.text;
      while (piece.length) {
        const room = w - len;
        if (room <= 0) {
          flush();
          continue;
        }
        const chunk = sliceWidth(piece, room);
        if (!chunk) {
          flush();
          continue;
        }
        cur.push({ ...tok, text: chunk });
        len += strWidth(chunk);
        piece = piece.slice(chunk.length);
        if (piece.length) flush();
      }
    } else {
      flush();
      cur.push(tok);
      len += tw;
    }
  }
  if (cur.length || lines.length === 0) flush();
  // Trim a trailing space seg left on any row.
  for (const l of lines) {
    const last = l.segs[l.segs.length - 1];
    if (last && last.text === ' ') l.segs.pop();
    if (l.segs.length === 0) l.segs.push({ text: '' });
  }
  return lines;
}

/**
 * Hard-wrap styled segments to `width` WITHOUT collapsing whitespace — used for
 * code blocks so indentation survives.
 */
function hardWrapSegs(segs: Seg[], width: number): Line[] {
  const w = Math.max(1, width);
  const lines: Line[] = [];
  let cur: Seg[] = [];
  let len = 0;
  for (const seg of segs) {
    let text = seg.text;
    if (text === '') continue;
    while (text.length) {
      const room = w - len;
      const chunk = sliceWidth(text, room) || text.slice(0, 1);
      cur.push({ ...seg, text: chunk });
      len += strWidth(chunk);
      text = text.slice(chunk.length);
      if (len >= w && text.length) {
        lines.push(mkLine(cur));
        cur = [];
        len = 0;
      }
    }
  }
  lines.push(mkLine(cur));
  return lines;
}

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'import', 'export', 'from', 'default',
  'class', 'new', 'extends', 'implements', 'interface', 'type', 'enum', 'await',
  'async', 'yield', 'throw', 'try', 'catch', 'finally', 'void', 'public', 'private',
  'protected', 'static', 'readonly', 'true', 'false', 'null', 'undefined', 'this',
  'def', 'lambda', 'pass', 'elif', 'None', 'True', 'False', 'and', 'or', 'not', 'in',
  'fn', 'let', 'mut', 'pub', 'use', 'struct', 'impl', 'match', 'package', 'func',
]);

/** Very light single-line syntax highlight: comments, strings, keywords. */
export function highlightCodeLine(line: string): Seg[] {
  const out: Seg[] = [];
  const re =
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[1] !== undefined) out.push({ text: m[1], color: theme.mdComment, dim: true });
    else if (m[2] !== undefined) out.push({ text: m[2], color: theme.mdString });
    else if (m[3] !== undefined)
      out.push(KEYWORDS.has(m[3]) ? { text: m[3], color: theme.mdKeyword, bold: true } : { text: m[3], color: theme.mdCodeBlock });
    else if (m[4] !== undefined) out.push({ text: m[4] });
    else if (m[5] !== undefined) out.push({ text: m[5], color: theme.mdCodeBlock });
  }
  return out.length ? out : [{ text: '' }];
}

// ── GFM tables ───────────────────────────────────────────────────────────────

export type Align = 'left' | 'center' | 'right';

export interface TableSpec {
  header: string[];
  rows: string[][];
  align: Align[];
}

/** Split one `| a | b |` row into trimmed cells, honoring `\|` escapes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** `|---|:--:|--:|` → the per-column alignment, or null if it isn't one. */
function parseDelimiter(line: string): Align[] | null {
  if (!line.includes('-') || !line.includes('|')) return null;
  const cells = splitRow(line);
  if (!cells.length || cells.some((c) => !/^:?-+:?$/.test(c))) return null;
  return cells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

const looksLikeRow = (l: string | undefined): boolean => !!l && l.includes('|') && l.trim() !== '';

/**
 * Parse a GFM table starting at `raw[i]` (a header row followed by a delimiter
 * row). Returns the spec and the index of the first line after the table.
 */
export function parseTable(raw: readonly string[], i: number): { spec: TableSpec; next: number } | null {
  if (!looksLikeRow(raw[i])) return null;
  const align = raw[i + 1] !== undefined ? parseDelimiter(raw[i + 1]!) : null;
  if (!align) return null;
  const header = splitRow(raw[i]!);
  const rows: string[][] = [];
  let j = i + 2;
  while (j < raw.length && looksLikeRow(raw[j]) && !parseDelimiter(raw[j]!)) {
    rows.push(splitRow(raw[j]!));
    j++;
  }
  const cols = Math.max(align.length, header.length, ...rows.map((r) => r.length));
  const fill = (r: string[]): string[] => Array.from({ length: cols }, (_, k) => r[k] ?? '');
  const spec: TableSpec = {
    header: fill(header),
    rows: rows.map(fill),
    align: Array.from({ length: cols }, (_, k) => align[k] ?? 'left'),
  };
  return { spec, next: j };
}

/**
 * Fit natural column widths into `avail` columns: cap the widest columns first
 * (water-filling), then hand any leftover back to the columns still squeezed.
 * Every column keeps at least 1 column, so callers must ensure `avail >= n`.
 */
export function fitWidths(natural: readonly number[], avail: number): number[] {
  const n = natural.length;
  if (!n) return [];
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= avail) return [...natural];

  let lo = 1;
  let hi = Math.max(...natural);
  let cap = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sum = natural.reduce((a, x) => a + Math.min(x, mid), 0);
    if (sum <= avail) {
      cap = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const out = natural.map((x) => Math.max(1, Math.min(x, cap)));
  let left = avail - out.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let moved = false;
    for (let k = 0; k < n && left > 0; k++) {
      if (out[k]! < natural[k]!) {
        out[k]!++;
        left--;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // Over-budget only if avail < n (guarded by the caller); clamp defensively.
  while (out.reduce((a, b) => a + b, 0) > avail) {
    const widest = out.indexOf(Math.max(...out));
    if (out[widest]! <= 1) break;
    out[widest]!--;
  }
  return out;
}

const BORDER: Style = { color: theme.mdTableBorder, dim: true };
const HEADER: Style = { bold: true, color: theme.mdTableHeader };

/** Wrap a cell's inline content into at most `maxLines` rows of `w` columns. */
function cellRows(text: string, w: number, base: Style, maxLines: number): Seg[][] {
  const segs = parseInline(text, base);
  if (!segsText(segs).trim()) return [[{ text: '' }]];
  const rows = wrapSegs(segs, w).map((l) => l.segs);
  if (rows.length <= maxLines) return rows;
  // Content was dropped — mark the cut with an ellipsis on the last kept row.
  const kept = rows.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(kept[maxLines - 1]!, w);
  return kept;
}

/**
 * Render a parsed table as an aligned, boxed terminal table that never exceeds
 * `width`. Columns are sized to content, then squeezed (and their contents
 * wrapped, then ellipsized) when the terminal is too narrow. If even one column
 * per cell cannot fit, we fall back to a `key: value` record list.
 */
export function renderTable(spec: TableSpec, width: number, maxCellLines = 4): Line[] {
  const w = Math.max(1, width);
  const n = spec.align.length;
  if (n === 0) return [];

  // Frame overhead: a leading '│' plus ' cell │' per column.
  const avail = w - 1 - 3 * n;
  if (avail < n) return recordLines(spec, w);

  const all = [spec.header, ...spec.rows];
  const natural = Array.from({ length: n }, (_, c) =>
    Math.max(1, ...all.map((r) => strWidth(segsText(parseInline(r[c] ?? ''))))),
  );
  const widths = fitWidths(natural, avail);

  const rule = (l: string, mid: string, r: string): Line =>
    mkLine([{ ...BORDER, text: l + widths.map((cw) => '─'.repeat(cw + 2)).join(mid) + r }]);

  const bodyRow = (cells: string[], base: Style): Line[] => {
    const wrapped = cells.map((c, k) => cellRows(c, widths[k]!, base, maxCellLines));
    const height = Math.max(...wrapped.map((rows) => rows.length));
    const out: Line[] = [];
    for (let line = 0; line < height; line++) {
      const segs: Seg[] = [{ ...BORDER, text: '│' }];
      for (let k = 0; k < n; k++) {
        const cell = wrapped[k]![line] ?? [{ text: '' }];
        segs.push({ text: ' ' }, ...padSegs(cell, widths[k]!, spec.align[k]!), { text: ' ' }, { ...BORDER, text: '│' });
      }
      out.push(mkLine(segs));
    }
    return out;
  };

  return [
    rule('┌', '┬', '┐'),
    ...bodyRow(spec.header, HEADER),
    rule('├', '┼', '┤'),
    ...spec.rows.flatMap((r) => bodyRow(r, {})),
    rule('└', '┴', '┘'),
  ];
}

/**
 * Last-resort layout for a terminal too narrow to frame the table: each row
 * becomes a `header: value` record, which always fits by wrapping.
 */
function recordLines(spec: TableSpec, w: number): Line[] {
  const out: Line[] = [];
  spec.rows.forEach((row, i) => {
    if (i > 0) out.push(mkLine([{ text: '' }]));
    row.forEach((cell, k) => {
      const head = spec.header[k]?.trim();
      const segs: Seg[] = [];
      if (head) segs.push(...parseInline(head, HEADER), { text: ': ' });
      segs.push(...parseInline(cell));
      const rows = wrapSegs(segs, Math.max(1, w - 2));
      rows.forEach((r, idx) => out.push({ segs: [{ text: idx === 0 ? '• ' : '  ', color: theme.mdBullet }, ...r.segs] }));
    });
  });
  return out.length ? out : [mkLine([{ text: '' }])];
}

// ── blocks ───────────────────────────────────────────────────────────────────

const isFence = (l: string) => /^\s*(```+|~~~+)/.test(l);
const isCloseFence = (l: string) => /^\s*(```+|~~~+)\s*$/.test(l);
/** Nested unordered lists step through these markers by depth. */
const BULLETS = ['•', '◦', '▪'];

/**
 * Render Markdown `text` to styled rows laid out at `width` display columns.
 * Blocks recognized: fenced code, ATX headings, GFM tables, horizontal rules,
 * blockquotes, unordered/ordered/nested lists, and paragraphs; inline emphasis,
 * code and links within each. No row ever exceeds `width`.
 */
export function renderMarkdown(text: string, width: number): Line[] {
  const w = Math.max(1, width);
  const raw = text.replace(/\t/g, '  ').split('\n');
  const out: Line[] = [];
  let i = 0;

  while (i < raw.length) {
    const cur = raw[i]!;

    // fenced code block
    if (isFence(cur)) {
      const lang = cur.replace(/^\s*(```+|~~~+)\s*/, '').trim();
      void lang; // reserved for future language-specific rules
      i++;
      const body: string[] = [];
      while (i < raw.length && !isCloseFence(raw[i]!)) body.push(raw[i++]!);
      if (i < raw.length) i++; // consume closing fence
      for (const codeLine of body) {
        const rows = hardWrapSegs(highlightCodeLine(codeLine), Math.max(1, w - 2));
        for (const r of rows) out.push({ segs: [{ text: '│ ', color: theme.mdRule, dim: true }, ...r.segs] });
      }
      continue;
    }

    // ATX heading
    const h = cur.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const content = h[2]!.replace(/\s+#+\s*$/, '');
      out.push(...wrapSegs(parseInline(content, { bold: true, color: theme.mdHeading }), w));
      i++;
      continue;
    }

    // GFM table (header row + `|---|` delimiter row)
    const table = parseTable(raw, i);
    if (table) {
      out.push(...renderTable(table.spec, w));
      i = table.next;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(cur)) {
      out.push(mkLine([{ text: '─'.repeat(Math.min(w, 48)), color: theme.mdRule, dim: true }]));
      i++;
      continue;
    }

    // blockquote
    const q = cur.match(/^\s*>\s?(.*)$/);
    if (q) {
      const rows = wrapSegs(parseInline(q[1]!, { color: theme.mdQuote, dim: true }), Math.max(1, w - 2));
      for (const r of rows) out.push({ segs: [{ text: '│ ', color: theme.mdQuote, dim: true }, ...r.segs] });
      i++;
      continue;
    }

    // list item (unordered - * + or ordered 1. 1) ), nested by indentation
    const li = cur.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const indent = li[1]!.length;
      const isOrdered = /\d/.test(li[2]![0]!);
      const depth = Math.min(Math.floor(indent / 2), BULLETS.length - 1);
      const marker = isOrdered ? li[2]! : BULLETS[depth]!;
      const prefix = ' '.repeat(indent) + marker + ' ';
      const rows = wrapSegs(parseInline(li[3]!), Math.max(1, w - prefix.length));
      rows.forEach((r, idx) => {
        const pad = idx === 0 ? prefix : ' '.repeat(prefix.length);
        const padSeg: Seg = idx === 0 ? { text: pad, color: theme.mdBullet } : { text: pad };
        out.push({ segs: [padSeg, ...r.segs] });
      });
      i++;
      continue;
    }

    // blank line
    if (cur.trim() === '') {
      out.push(mkLine([{ text: '' }]));
      i++;
      continue;
    }

    // paragraph line
    out.push(...wrapSegs(parseInline(cur), w));
    i++;
  }

  return out.length ? out : [mkLine([{ text: '' }])];
}
