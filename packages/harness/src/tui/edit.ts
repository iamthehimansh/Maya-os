/**
 * edit.ts — a pure line-editor reducer for the input box.
 *
 * The App routes every keypress through ONE handler; the text-editing subset is
 * delegated here so cursor/insert/delete behavior is unit-testable without Ink.
 * Returns the next state, or `null` when the key isn't a text-editing key (so
 * the App can treat it as a command key — submit, scroll, navigate, …).
 */
export interface LineState {
  value: string;
  cursor: number;
}

/** The Ink `Key` fields we care about (kept minimal so tests can fake it). */
export interface KeyLike {
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

const clampCursor = (c: number, len: number) => Math.max(0, Math.min(c, len));

export function editLine(state: LineState, input: string, key: KeyLike): LineState | null {
  const { value, cursor } = state;

  // ── cursor movement ──
  if (key.leftArrow) return { value, cursor: clampCursor(cursor - 1, value.length) };
  if (key.rightArrow) return { value, cursor: clampCursor(cursor + 1, value.length) };
  if (key.ctrl && input === 'a') return { value, cursor: 0 };
  if (key.ctrl && input === 'e') return { value, cursor: value.length };

  // ── deletion ──
  if (key.backspace || key.delete) {
    if (cursor === 0) return state;
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }
  if (key.ctrl && input === 'u') return { value: '', cursor: 0 }; // clear line
  if (key.ctrl && input === 'w') {
    const left = value.slice(0, cursor).replace(/\s*\S+\s*$/, '');
    return { value: left + value.slice(cursor), cursor: left.length };
  }

  // ── printable insertion ──
  // Ignore control/meta chords and empty input (those are command keys).
  if (key.ctrl || key.meta || !input) return null;
  return { value: value.slice(0, cursor) + input + value.slice(cursor), cursor: cursor + input.length };
}

/** Render a value with a block cursor at `cursor` as three slices. */
export function cursorSlices(value: string, cursor: number): { before: string; at: string; after: string } {
  return {
    before: value.slice(0, cursor),
    at: value.slice(cursor, cursor + 1) || ' ',
    after: value.slice(cursor + 1),
  };
}
