/**
 * Mouse capture vs. native drag-select.
 *
 * The contract the owner actually cares about: with capture OFF the app must not
 * put the terminal into ANY mouse-reporting mode, because that is the only thing
 * that lets a plain click-drag select text. These tests assert on the escape
 * bytes we hand the terminal, not on a React flag — a flag can be right while the
 * bytes are wrong, and the bytes are what the terminal obeys.
 */
import { describe, it, expect } from 'vitest';
import type { LoopEvent } from '../src/types.js';
import { MOUSE_ON, MOUSE_OFF, mouseHint } from '../src/tui/App.js';
import { renderApp, makeSession, delay, KEY } from './_app-harness.js';

/** Any mouse-reporting enable — 1000/1002/1003 — is enough to eat drag-select. */
const ANY_MOUSE_ENABLE = /\x1b\[\?100[0-3]h/;

/** Ctrl+G as the terminal sends it: BEL (0x07). */
const CTRL_G = '\x07';

/** A fake stdout that records every terminal-mode escape the App writes. */
function makeTerm(isTTY = true) {
  const writes: string[] = [];
  return {
    isTTY,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    all: () => writes.join(''),
  };
}

const idle = makeSession(async function* (): AsyncGenerator<LoopEvent> {});

/** Render fullscreen against a fake TTY — that is the only mode that writes modes. */
function renderTui(over: Record<string, unknown> = {}) {
  const term = makeTerm();
  const app = renderApp(idle, { fullscreen: true, term, ...over });
  return { term, app };
}

async function type(stdin: { write(s: string): void }, s: string): Promise<void> {
  stdin.write(s);
  await delay(30);
}

describe('mouse capture', () => {
  it('defaults to OFF and never enables mouse reporting, so drag-select works', async () => {
    const { term, app } = renderTui();
    await delay(40);

    expect(term.all()).not.toMatch(ANY_MOUSE_ENABLE);
    // Not merely "absent": we actively disable, in case a crashed run left the
    // terminal reporting mouse events.
    expect(term.all()).toContain(MOUSE_OFF);
    app.unmount();
  });

  it('/mouse turns capture on, and toggling back off disables it again', async () => {
    const { term, app } = renderTui();
    await delay(40);

    await type(app.stdin, '/mouse');
    await type(app.stdin, KEY.enter);
    expect(term.all()).toContain(MOUSE_ON);

    const afterOn = term.all().length;
    await type(app.stdin, '/mouse');
    await type(app.stdin, KEY.enter);
    // A disable was written AFTER the enable — capture really was torn down.
    expect(term.all().slice(afterOn)).toContain(MOUSE_OFF);
    app.unmount();
  });

  it('Ctrl+G toggles capture without typing a command', async () => {
    const { term, app } = renderTui();
    await delay(40);
    expect(term.all()).not.toMatch(ANY_MOUSE_ENABLE);

    await type(app.stdin, CTRL_G);
    expect(term.all()).toContain(MOUSE_ON);

    const afterOn = term.all().length;
    await type(app.stdin, CTRL_G);
    expect(term.all().slice(afterOn)).toContain(MOUSE_OFF);
    app.unmount();
  });

  it('never asks for motion tracking (1002/1003), which defeats the ⌥-drag bypass', async () => {
    const { term, app } = renderTui();
    await delay(40);
    await type(app.stdin, CTRL_G); // capture ON — the only time we enable anything

    expect(term.all()).not.toContain('\x1b[?1002h');
    expect(term.all()).not.toContain('\x1b[?1003h');
    expect(term.all()).toContain('\x1b[?1000h'); // button events only
    app.unmount();
  });

  it('leaves the terminal with mouse reporting off on unmount', async () => {
    const { term, app } = renderTui();
    await delay(40);
    await type(app.stdin, CTRL_G); // ON
    const afterOn = term.all().length;

    app.unmount();
    await delay(20);
    expect(term.all().slice(afterOn)).toContain(MOUSE_OFF);
  });

  it('shows the live capture state in the hint bar', async () => {
    const { app } = renderTui();
    await delay(40);

    expect(app.lastFrame()).toContain(mouseHint(false));
    expect(mouseHint(false)).toMatch(/drag to select/);

    await type(app.stdin, CTRL_G);
    expect(app.lastFrame()).toContain(mouseHint(true));
    expect(mouseHint(true)).toMatch(/⌥/);
    app.unmount();
  });

  it('/help documents the toggle and the ⌥-drag bypass', async () => {
    const { app } = renderTui();
    await delay(40);

    await type(app.stdin, '/help');
    await type(app.stdin, KEY.enter);
    await delay(40);

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Ctrl+G');
    expect(frame).toContain('⌥');
    expect(frame).toMatch(/drag/i);
    app.unmount();
  });

  it('honours an explicit mouseCapture:true start (wheel-scroll users)', async () => {
    const { term, app } = renderTui({ mouseCapture: true });
    await delay(40);
    expect(term.all()).toContain(MOUSE_ON);
    app.unmount();
  });

  it('writes no terminal modes at all when not fullscreen', async () => {
    const term = makeTerm();
    const app = renderApp(idle, { fullscreen: false, term });
    await delay(40);
    expect(term.all()).toBe('');
    app.unmount();
  });
});
