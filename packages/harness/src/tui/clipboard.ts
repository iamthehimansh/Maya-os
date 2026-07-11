/**
 * clipboard.ts — put text on the SYSTEM clipboard from inside the TUI.
 *
 * The Ink app owns the alternate screen and (optionally) the mouse, so the user
 * cannot always drag-select output with the terminal's own selection. Copying
 * therefore has to be something the app can do itself, and it has to work in the
 * two places mayac actually runs:
 *
 *   OSC 52  — an escape sequence that asks the TERMINAL to set the clipboard:
 *             `ESC ] 52 ; c ; <base64> BEL`. This is the important one: it works
 *             full-screen, and it works over SSH/tmux (the bytes travel back over
 *             the same pty), where a local `pbcopy` would set the clipboard of the
 *             wrong machine. Supported by iTerm2, kitty, WezTerm, Alacritty,
 *             foot, and xterm (`allowWindowOps`); Terminal.app ignores it.
 *   pbcopy  — the macOS fallback for terminals that drop OSC 52 (Terminal.app).
 *             Only meaningful when the terminal is LOCAL, so it is skipped when
 *             $SSH_CONNECTION/$SSH_TTY say we are remote.
 *
 * We fire both when we can: they are idempotent (same text, same clipboard) and
 * we have no way to detect OSC 52 support up front. `writeClipboard` never
 * throws — a failed copy reports back as `ok: false` and the App shows a notice.
 */
import { spawn } from 'node:child_process';

/** What the App calls to copy. Injected in tests so nothing touches the real clipboard. */
export type ClipboardWriter = (text: string) => Promise<ClipboardResult> | ClipboardResult;

export interface ClipboardResult {
  ok: boolean;
  /** Which sinks accepted the text (for the "copied N lines" notice + tests). */
  via: ('osc52' | 'pbcopy')[];
  error?: string;
}

/**
 * Build the OSC 52 sequence that sets the system clipboard (`c`) to `text`.
 *
 * tmux only forwards OSC 52 to the outer terminal when `set -g set-clipboard on`
 * (the default since 3.x); inside tmux without it, the pbcopy fallback carries.
 */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/** Are we driving a terminal on another machine? Then a local pbcopy is useless. */
function isRemote(env: NodeJS.ProcessEnv): boolean {
  return !!(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

/** Pipe `text` into a local clipboard command (macOS `pbcopy`). Resolves false on any failure. */
function pipeTo(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.on('error', () => resolve(false));
      child.stdin.end(text, 'utf8');
    } catch {
      resolve(false);
    }
  });
}

export interface ClipboardOptions {
  /** Where the OSC 52 sequence is written (defaults to the real stdout). */
  out?: { write(chunk: string): unknown };
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * The default writer: emit OSC 52 to the terminal, and — on a local macOS box —
 * also shell out to `pbcopy` so Terminal.app users get a working copy too.
 */
export function createClipboard(opts: ClipboardOptions = {}): ClipboardWriter {
  const out = opts.out ?? process.stdout;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  return async (text: string): Promise<ClipboardResult> => {
    const via: ClipboardResult['via'] = [];
    let error: string | undefined;

    try {
      out.write(osc52(text));
      via.push('osc52');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (platform === 'darwin' && !isRemote(env)) {
      if (await pipeTo('pbcopy', [], text)) via.push('pbcopy');
    }

    if (via.length === 0) {
      return { ok: false, via, error: error ?? 'no clipboard sink available' };
    }
    return { ok: true, via };
  };
}
