/**
 * viewport.ts — pure scroll math for the message window.
 *
 * The App keeps a `ScrollState` and feeds it (total row count, viewport height)
 * plus intents (line up/down, page up/down, jump). All decisions live here so
 * they can be unit-tested without a terminal. `stuck` means "auto-follow the
 * bottom as new output arrives"; any manual upward scroll releases the stick.
 */
export interface ScrollState {
  /** Index of the first visible row. */
  top: number;
  /** When true, the view auto-follows the newest output. */
  stuck: boolean;
}

export const initialScroll: ScrollState = { top: 0, stuck: true };

function maxTop(total: number, height: number): number {
  return Math.max(0, total - height);
}

/** Reconcile scroll position after the buffer or height changes. */
export function reconcile(state: ScrollState, total: number, height: number): ScrollState {
  const mt = maxTop(total, height);
  if (state.stuck) return { top: mt, stuck: true };
  return { top: Math.min(state.top, mt), stuck: false };
}

function moveTo(top: number, total: number, height: number): ScrollState {
  const mt = maxTop(total, height);
  const clamped = Math.max(0, Math.min(top, mt));
  // Re-stick once the user scrolls back to the very bottom.
  return { top: clamped, stuck: clamped >= mt };
}

export function scrollLines(state: ScrollState, delta: number, total: number, height: number): ScrollState {
  return moveTo(state.top + delta, total, height);
}

export function scrollPage(state: ScrollState, dir: -1 | 1, total: number, height: number): ScrollState {
  const step = Math.max(1, height - 1);
  return moveTo(state.top + dir * step, total, height);
}

export function scrollToTop(_state: ScrollState, total: number, height: number): ScrollState {
  return moveTo(0, total, height);
}

export function scrollToBottom(_state: ScrollState, total: number, height: number): ScrollState {
  return moveTo(maxTop(total, height), total, height);
}

/** Are there rows below the current window (i.e. unseen newer output)? */
export function hasMoreBelow(state: ScrollState, total: number, height: number): boolean {
  return state.top < maxTop(total, height);
}

/** Are there rows above the current window? */
export function hasMoreAbove(state: ScrollState): boolean {
  return state.top > 0;
}

/** The visible slice [top, top+height). */
export function windowSlice<T>(rows: readonly T[], state: ScrollState, height: number): T[] {
  return rows.slice(state.top, state.top + height) as T[];
}

/**
 * Parse SGR mouse-wheel reports out of a raw stdin chunk, returning the net
 * line delta (negative = scroll up toward history, positive = scroll down toward
 * the newest output). Non-wheel and malformed sequences are ignored, so it is
 * safe to feed every stdin chunk through it. `step` = lines per wheel notch.
 *
 * SGR format (enabled with `\x1b[?1006h`): `ESC [ < btn ; col ; row (M|m)`.
 * Wheel reports set bit 6 (value 64); the low bit selects up (0) or down (1).
 * Modifier bits (shift/meta/ctrl) and horizontal-wheel codes are ignored.
 */
export function parseWheel(data: string, step = 3): number {
  const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
  let delta = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null) {
    const btn = Number(m[1]);
    if ((btn & 64) === 0) continue; // not a wheel event
    const dir = btn & 3; // 0 = up, 1 = down (2/3 = horizontal — ignore)
    if (dir === 0) delta -= step;
    else if (dir === 1) delta += step;
  }
  return delta;
}
