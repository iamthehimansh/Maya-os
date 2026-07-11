/**
 * lines.ts — the heart of the managed scroll viewport.
 *
 * The whole transcript is rendered to a FLAT array of styled terminal rows
 * (`Line[]`). The viewport then shows a window `lines.slice(top, top+height)`.
 * Windowing by row count (rather than leaning on Ink's `<Static>`) is what gives
 * us real PageUp/PageDown scrollback, a scroll indicator, and auto-stick.
 *
 * Everything here is pure and unit-tested — no Ink, no React.
 */
import type { Entry } from './entries.js';
import type { ToolEntry } from './ToolView.js';
import { summarizeInput } from './ToolView.js';
import { renderMarkdown, strWidth } from './markdown.js';
import { theme } from './theme.js';

/** One styled span within a row. */
export interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
}

/** One terminal row. `toolId` marks rows that belong to a collapsible tool block. */
export interface Line {
  segs: Seg[];
  /** Set on every row of a tool block (for selection highlight + click hit-testing). */
  toolId?: string;
  /** True only on the block's header row (the selectable/focusable line). */
  toolHeader?: boolean;
}

export interface RenderOptions {
  width: number;
  /** Tool-call ids currently expanded (App seeds this with the most-recent call). */
  expandedToolIds: ReadonlySet<string>;
  /** Tool block under the selection cursor, if any. */
  selectedToolId?: string | undefined;
}

const line = (segs: Seg[], extra?: Partial<Line>): Line => ({ segs, ...extra });

/** Hard word-wrap `text` to `width`, honoring embedded newlines. Never returns []. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  const paragraphs = text.replace(/\t/g, '  ').split('\n');
  for (const para of paragraphs) {
    if (para.length === 0) {
      out.push('');
      continue;
    }
    let rest = para;
    while (rest.length > w) {
      // Prefer breaking at the last space within the window.
      let brk = rest.lastIndexOf(' ', w);
      if (brk <= 0) brk = w; // no space → hard break
      out.push(rest.slice(0, brk).replace(/\s+$/, ''));
      rest = rest.slice(brk).replace(/^\s+/, '');
    }
    out.push(rest);
  }
  return out.length ? out : [''];
}

/** Truncate a single-line string to `width` with an ellipsis. */
export function truncate(text: string, width: number): string {
  const w = Math.max(1, width);
  const flat = text.replace(/\n/g, ' ');
  return flat.length <= w ? flat : flat.slice(0, Math.max(0, w - 1)) + '…';
}

function toolStatus(t: ToolEntry): { marker: string; color: string; note: string } {
  if (!t.done) return { marker: '⋯', color: theme.muted, note: 'running' };
  if (t.isError) return { marker: '✗', color: theme.error, note: 'error' };
  return { marker: '✓', color: theme.ok, note: 'ok' };
}

/** Trim tool output for the expanded view: cap lines + total chars. */
function trimOutput(text: string, maxLines = 16, maxChars = 2000): { body: string; clipped: number } {
  let out = text.replace(/\s+$/, '');
  if (out.length > maxChars) out = out.slice(0, maxChars);
  const all = out.split('\n');
  const clipped = all.length > maxLines ? all.length - maxLines : 0;
  return { body: all.slice(0, maxLines).join('\n'), clipped };
}

function toolLines(t: ToolEntry, opts: RenderOptions): Line[] {
  const { marker, color, note } = toolStatus(t);
  const summary = summarizeInput(t.name, t.input);
  const expanded = opts.expandedToolIds.has(t.id);
  const selected = opts.selectedToolId === t.id;
  const caret = expanded ? '▾' : '▸';

  // Header row.
  const headSegs: Seg[] = [];
  if (selected) headSegs.push({ text: '❯ ', color: theme.accent, bold: true });
  else headSegs.push({ text: '  ' });
  headSegs.push({ text: `${caret} `, color: theme.muted });
  headSegs.push({ text: marker + ' ', color });
  headSegs.push({ text: t.name, color: theme.tool, bold: true, inverse: selected });
  if (summary) headSegs.push({ text: '  ' + truncate(summary, Math.max(8, opts.width - t.name.length - 12)), color: theme.muted });
  if (!expanded && t.done) headSegs.push({ text: `  (${note})`, color: theme.muted });
  const out: Line[] = [line(headSegs, { toolId: t.id, toolHeader: true })];

  if (!expanded) return out;

  // Expanded detail: args, then output.
  const argStr = summarizeInput(t.name, t.input) || (t.input != null ? safeJson(t.input) : '');
  if (argStr && argStr !== summary) {
    for (const l of wrapText('args: ' + argStr, opts.width - 4)) {
      out.push(line([{ text: '    ' }, { text: l, color: theme.muted, dim: true }], { toolId: t.id }));
    }
  }
  if (t.done && t.output) {
    const { body, clipped } = trimOutput(t.output);
    for (const l of wrapText(body, opts.width - 4)) {
      out.push(line([{ text: '    ' }, { text: l, color: t.isError ? theme.error : theme.muted }], { toolId: t.id }));
    }
    if (clipped > 0) {
      out.push(line([{ text: '    ' }, { text: `… (+${clipped} more lines)`, color: theme.muted, dim: true }], { toolId: t.id }));
    }
  } else if (!t.done) {
    out.push(line([{ text: '    ' }, { text: '…running…', color: theme.muted, dim: true }], { toolId: t.id }));
  }
  return out;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const noticeColor: Record<string, string> = {
  info: theme.muted,
  ok: theme.ok,
  warn: theme.warn,
  error: theme.error,
};
const noticeMarker: Record<string, string> = { info: 'ℹ', ok: '✓', warn: '!', error: '✗' };

/** Render one entry to its styled rows. */
export function entryToLines(entry: Entry, opts: RenderOptions): Line[] {
  switch (entry.kind) {
    case 'user': {
      const out: Line[] = [];
      const rows = wrapText(entry.text, opts.width - 2);
      // Only emit text rows when there's actual text (attachment-only turns skip).
      if (entry.text.trim() || !entry.attachments?.length) {
        for (let i = 0; i < rows.length; i++) {
          out.push(
            line([
              { text: i === 0 ? '› ' : '  ', color: theme.user, bold: true },
              { text: rows[i]!, color: theme.user },
            ]),
          );
        }
      }
      // Attachment chips, one per row, dim under the user line.
      for (const chip of entry.attachments ?? []) {
        out.push(line([{ text: '  ' }, { text: chip, color: theme.muted, dim: true }]));
      }
      return out;
    }
    case 'assistant': {
      // Render agent text as Markdown (bold/italic, code, headings, lists, …).
      const out = renderMarkdown(entry.text, opts.width);
      if (entry.streaming) {
        const last = out[out.length - 1];
        if (last) last.segs = [...last.segs, { text: '▋', color: theme.muted }];
        else out.push(line([{ text: '▋', color: theme.muted }]));
      }
      return out;
    }
    case 'notice': {
      const rows = wrapText(entry.text, opts.width - 2);
      const c = noticeColor[entry.tone] ?? theme.muted;
      return rows.map((r, i) =>
        line([{ text: i === 0 ? `${noticeMarker[entry.tone] ?? 'ℹ'} ` : '  ', color: c }, { text: r, color: c }]),
      );
    }
    case 'tool':
      return toolLines(entry, opts);
    default:
      return [];
  }
}

/**
 * Clamp one row to `width` display columns. The renderers already lay out to the
 * width, so this is a backstop: a row that slipped through (an over-long tool
 * summary, a pathological glyph) gets cut rather than wrapped by the terminal,
 * which would desync the viewport's row math.
 */
export function clampLine(l: Line, width: number): Line {
  const w = Math.max(1, width);
  if (strWidth(l.segs.map((s) => s.text).join('')) <= w) return l;
  const segs: Seg[] = [];
  let room = w;
  for (const s of l.segs) {
    if (room <= 0) break;
    if (strWidth(s.text) <= room) {
      segs.push(s);
      room -= strWidth(s.text);
    } else {
      let piece = '';
      for (const ch of s.text) {
        const cw = strWidth(ch);
        if (strWidth(piece) + cw > room) break;
        piece += ch;
      }
      if (piece) segs.push({ ...s, text: piece });
      room = 0;
    }
  }
  return { ...l, segs: segs.length ? segs : [{ text: '' }] };
}

/** Render the whole transcript to a flat row buffer, with a blank line between entries. */
export function entriesToLines(entries: readonly Entry[], opts: RenderOptions): Line[] {
  const out: Line[] = [];
  entries.forEach((e, i) => {
    if (i > 0) out.push(line([{ text: '' }])); // spacer
    for (const l of entryToLines(e, opts)) out.push(clampLine(l, opts.width));
  });
  return out;
}

/** Ordered ids of tool blocks in the transcript (for selection navigation). */
export function toolIdsOf(entries: readonly Entry[]): string[] {
  return entries.filter((e): e is ToolEntry => e.kind === 'tool').map((e) => e.id);
}
