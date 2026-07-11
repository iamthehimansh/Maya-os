/**
 * TUI theme — a small, consistent palette used across the Ink components.
 * Colors are Ink color names (mapped to the terminal's 16-color set) so the UI
 * reads well on both light and dark terminals.
 */
export const theme = {
  /** Brand / primary accent — used for the header title and prompt marker. */
  accent: 'magenta',
  /** Assistant text. Left at the terminal default for maximum legibility. */
  assistant: undefined as string | undefined,
  /** The user's echoed input. */
  user: 'cyan',
  /** Tool invocation headers. */
  tool: 'yellow',
  /** Tool result / secondary text. */
  muted: 'gray',
  /** Success / affordances. */
  ok: 'green',
  /** Errors and denials. */
  error: 'red',
  /** Warnings, compaction notices. */
  warn: 'yellow',

  // ── Markdown rendering (assistant transcript) ──
  /** Headings (#, ##, …). */
  mdHeading: 'magenta',
  /** Inline `code`. */
  mdCode: 'green',
  /** Fenced code-block default text + punctuation. */
  mdCodeBlock: 'cyan',
  /** Code keywords (const, function, def, …). */
  mdKeyword: 'magenta',
  /** Code string literals. */
  mdString: 'green',
  /** Code comments. */
  mdComment: 'gray',
  /** List bullets and ordered markers. */
  mdBullet: 'yellow',
  /** Blockquote gutter + text. */
  mdQuote: 'gray',
  /** Horizontal rules + code gutter. */
  mdRule: 'gray',
  /** Link labels ([text](url)); the URL itself is muted. */
  mdLink: 'blue',
  /** Table box-drawing frame. */
  mdTableBorder: 'gray',
  /** Table header cells. */
  mdTableHeader: 'magenta',
} as const;

/** A short spinner frame set for "thinking" indicators (Braille dots). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
