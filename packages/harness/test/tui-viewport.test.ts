import { describe, it, expect } from 'vitest';
import {
  initialScroll,
  reconcile,
  scrollLines,
  scrollPage,
  scrollToTop,
  scrollToBottom,
  hasMoreAbove,
  hasMoreBelow,
  windowSlice,
  parseWheel,
} from '../src/tui/viewport.js';

const rows = Array.from({ length: 100 }, (_, i) => i);

describe('scroll math', () => {
  it('sticks to the bottom by default and follows new rows', () => {
    let s = reconcile(initialScroll, 100, 10);
    expect(s).toEqual({ top: 90, stuck: true });
    s = reconcile(s, 120, 10); // more rows arrive
    expect(s.top).toBe(110);
    expect(s.stuck).toBe(true);
  });

  it('scrolling up releases the stick and clamps at 0', () => {
    let s = reconcile(initialScroll, 100, 10); // top 90, stuck
    s = scrollLines(s, -5, 100, 10);
    expect(s).toEqual({ top: 85, stuck: false });
    s = scrollToTop(s, 100, 10);
    expect(s.top).toBe(0);
    expect(hasMoreAbove(s)).toBe(false);
    expect(hasMoreBelow(s, 100, 10)).toBe(true);
  });

  it('re-sticks when scrolled back to the bottom', () => {
    let s = { top: 40, stuck: false };
    s = scrollToBottom(s, 100, 10);
    expect(s).toEqual({ top: 90, stuck: true });
  });

  it('page up/down moves by height-1', () => {
    let s = { top: 50, stuck: false };
    s = scrollPage(s, -1, 100, 10);
    expect(s.top).toBe(41);
    s = scrollPage(s, 1, 100, 10);
    expect(s.top).toBe(50);
  });

  it('when unstuck, keeps position but clamps as rows shrink', () => {
    let s = { top: 80, stuck: false };
    s = reconcile(s, 50, 10); // buffer shrank to 50 rows
    expect(s.top).toBe(40); // maxTop = 40
    expect(s.stuck).toBe(false);
  });

  it('windowSlice returns the visible rows', () => {
    const s = { top: 90, stuck: true };
    expect(windowSlice(rows, s, 10)).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  });
});

describe('parseWheel (SGR mouse-wheel reports)', () => {
  it('wheel-up (btn 64) is a negative delta, wheel-down (btn 65) positive', () => {
    expect(parseWheel('\x1b[<64;10;5M')).toBe(-3);
    expect(parseWheel('\x1b[<65;10;5M')).toBe(3);
  });

  it('sums multiple reports in one chunk', () => {
    expect(parseWheel('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M')).toBe(-3);
  });

  it('honours a custom step', () => {
    expect(parseWheel('\x1b[<64;1;1M', 5)).toBe(-5);
  });

  it('ignores modifier bits on wheel buttons (ctrl+wheel-up = 80)', () => {
    expect(parseWheel('\x1b[<80;1;1M')).toBe(-3); // 64 | 16(ctrl), low bit 0 = up
  });

  it('ignores non-wheel clicks, horizontal wheel, plain keys, and junk', () => {
    expect(parseWheel('\x1b[<0;10;5M')).toBe(0);   // left click
    expect(parseWheel('\x1b[<66;1;1M')).toBe(0);   // horizontal wheel
    expect(parseWheel('hello world')).toBe(0);
    expect(parseWheel('')).toBe(0);
  });
});
