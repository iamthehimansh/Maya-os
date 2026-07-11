/**
 * Slash-command parsing + metadata.
 *
 * The App owns execution (some commands open interactive pickers, others mutate
 * the Session directly). This module just turns raw input into a typed command
 * and provides the catalog used by `/help` and the hint line.
 */

export type SlashName =
  | 'model'
  | 'provider'
  | 'auth'
  | 'resume'
  | 'clear'
  | 'yolo'
  | 'bg'
  | 'tasks'
  | 'compact'
  | 'memory'
  | 'agent'
  | 'workflow'
  | 'mcp'
  | 'skills'
  | 'copy'
  | 'mouse'
  | 'help'
  | 'quit';

export interface SlashCommand {
  name: SlashName;
  /** Accepted aliases (without the leading slash). */
  aliases?: string[];
  /** Argument hint shown in help, e.g. "[name]". */
  usage?: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'model', usage: '[name]', description: 'Switch model (no arg opens a picker)' },
  { name: 'provider', usage: '[id]', description: 'Switch provider (no arg opens a picker)' },
  { name: 'auth', usage: '[api|subscription]', description: 'Switch auth mode' },
  { name: 'resume', usage: '[id]', description: 'Reload a past session (no arg opens a picker)' },
  { name: 'clear', description: 'Clear the conversation transcript' },
  { name: 'yolo', description: 'Toggle auto-approve for writes/bash' },
  { name: 'bg', usage: '<cmd>', description: 'Run a shell command as a background task' },
  { name: 'tasks', aliases: ['jobs'], description: 'View / kill background tasks' },
  { name: 'compact', description: 'Summarize old turns to free context (reports before/after tokens)' },
  { name: 'memory', usage: '[add <note> | edit <old> => <new>]', description: 'View memory, append a note, or edit an entry (find→replace)' },
  { name: 'agent', usage: '<prompt>', description: 'Run a prompt as a sub-agent and show its answer' },
  { name: 'workflow', usage: '<script.js>', description: 'Run a workflow script that orchestrates sub-agents' },
  { name: 'mcp', usage: '[add <spec> | remove <name>]', description: 'Show MCP servers, or add/remove one live' },
  { name: 'skills', usage: '[add <owner/repo> | search <q> | remove <name>]', description: 'List skills, or add/search/remove (skills.sh-compatible)' },
  { name: 'copy', usage: '[last|all|tool|mode]', description: 'Copy the last reply / transcript / tool block' },
  { name: 'mouse', description: 'Toggle mouse capture — same as Ctrl+G (off = drag to select)' },
  { name: 'help', aliases: ['?'], description: 'List slash commands' },
  { name: 'quit', aliases: ['exit', 'q'], description: 'Exit the harness' },
];

export interface ParsedSlash {
  name: SlashName;
  /** Everything after the command word, trimmed. */
  arg: string;
}

/** Is this line a slash command (starts with `/` and a letter)? */
export function isSlash(line: string): boolean {
  return /^\/[a-zA-Z?]/.test(line.trimStart());
}

/**
 * Parse a slash line into a known command. Returns `null` for a bare `/` and
 * `{ name: 'help', arg: '<unknown>' }`-style is NOT used — unknown commands
 * return `{ unknown: word }` so the App can show a friendly error.
 */
export function parseSlash(line: string): ParsedSlash | { unknown: string } | null {
  const trimmed = line.trim();
  if (!isSlash(trimmed)) return null;
  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const word = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase();
  const arg = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();

  const match = SLASH_COMMANDS.find(
    (c) => c.name === word || c.aliases?.includes(word),
  );
  if (!match) return { unknown: word };
  return { name: match.name, arg };
}
