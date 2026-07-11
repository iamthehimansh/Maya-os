/**
 * copy.ts — pure state + text extraction for COPY MODE.
 *
 * Copy mode is tmux's: a cursor moves over the rendered row buffer (the same
 * `Line[]` the viewport paints, so what you select is exactly what you see),
 * `v` drops an anchor, further movement extends the selection, `y` copies.
 *
 * Selection is a row range, not a character range. Rows are what the transcript
 * is made of — an assistant paragraph, a wrapped table row, a line of tool output
 * — and a row range is what a user reaching for "copy that error" actually wants.
 * Sub-row selection would need pixel-accurate hit-testing through the styled
 * segments for very little gain.
 *
 * No Ink, no React, no clipboard here — the App wires this to keys and the sink.
 */
import type { Entry } from './entries.js';
import type { Line } from './lines.js';
import type { ToolEntry } from './ToolView.js';
import type { ScrollState } from './viewport.js';

export interface CopyState {
  /** Row the cursor sits on (index into the rendered `Line[]`). */
  cursor: number;
  /** Row the selection was anchored at (`v`), or null when only the cursor row is selected. */
  anchor: number | null;
}

/** Enter copy mode with the cursor on the last row currently in view. */
export function enterCopy(scroll: ScrollState, total: number, height: number): CopyState {
  const lastVisible = Math.min(total - 1, scroll.top + height - 1);
  return { cursor: Math.max(0, lastVisible), anchor: null };
}

/** Move the cursor by `delta` rows, clamped. The anchor (if any) stays put — that's the extend. */
export function moveCopy(state: CopyState, delta: number, total: number): CopyState {
  const cursor = Math.max(0, Math.min(total - 1, state.cursor + delta));
  return { ...state, cursor };
}

/** `v` — start extending from the cursor row, or collapse back to a single row. */
export function toggleAnchor(state: CopyState): CopyState {
  return { ...state, anchor: state.anchor === null ? state.cursor : null };
}

/** Select every row in the buffer. */
export function selectAll(total: number): CopyState {
  return { cursor: Math.max(0, total - 1), anchor: 0 };
}

/** The inclusive row range currently selected. */
export function copyRange(state: CopyState): { from: number; to: number } {
  const a = state.anchor ?? state.cursor;
  return { from: Math.min(a, state.cursor), to: Math.max(a, state.cursor) };
}

/** Keep the copy cursor inside the viewport, scrolling only as far as needed. */
export function revealRow(scroll: ScrollState, row: number, total: number, height: number): ScrollState {
  const maxTop = Math.max(0, total - height);
  let top = scroll.top;
  if (row < top) top = row;
  else if (row >= top + height) top = row - height + 1;
  const clamped = Math.max(0, Math.min(top, maxTop));
  return { top: clamped, stuck: false };
}

/** Flatten rows [from..to] of the rendered buffer back to plain text. */
export function linesToText(lines: readonly Line[], from: number, to: number): string {
  return lines
    .slice(Math.max(0, from), Math.min(lines.length, to + 1))
    .map((l) => l.segs.map((s) => s.text).join('').replace(/\s+$/, ''))
    .join('\n');
}

/** The text of the most recent assistant message, or '' when there isn't one. */
export function lastAssistantText(entries: readonly Entry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'assistant') return e.text;
  }
  return '';
}

/**
 * One tool call as copyable text: the invocation, its arguments as JSON, and its
 * output. Built from the ENTRY, not the rendered rows, so a copy carries the full
 * output rather than the viewport's truncated preview.
 */
export function toolBlockText(entries: readonly Entry[], id: string): string {
  const t = entries.find((e): e is ToolEntry => e.kind === 'tool' && e.id === id);
  if (!t) return '';
  const parts = [`${t.name}(${t.input === undefined ? '' : safeJson(t.input)})`];
  if (t.done) parts.push(t.output ?? '');
  else parts.push('(running…)');
  return parts.join('\n').replace(/\s+$/, '');
}

/** The whole transcript as plain text (what `/copy all` yields). */
export function transcriptText(entries: readonly Entry[]): string {
  const out: string[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case 'user':
        out.push(`› ${e.text}`);
        break;
      case 'assistant':
        out.push(e.text);
        break;
      case 'notice':
        out.push(e.text);
        break;
      case 'tool':
        out.push(toolBlockText(entries, e.id));
        break;
    }
  }
  return out.join('\n\n').replace(/\s+$/, '');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
