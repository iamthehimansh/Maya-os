/**
 * mayac CLI argument parsing + usage. OWNER: @harness.
 *
 * Split out of cli.ts so it can be unit-tested without booting a provider: cli.ts
 * runs main() on import, this module is pure.
 */
import type { AuthMode, ProviderId } from './types.js';

export interface Args {
  provider: ProviderId;
  model?: string;
  auth?: AuthMode;
  cwd: string;
  print?: string;
  yolo: boolean;
  help: boolean;
  /** Reload a specific session id, or open the resume picker when `true`. */
  resume?: string | true;
  /** Continue the most recently updated session. */
  continue: boolean;
  /**
   * Use THIS id for the session instead of minting one (claude-code's
   * `--session-id` semantics). Lets a supervisor (Maya's orchestrator) assign a
   * standing agent a stable id at first spawn, then `--resume <same id>` to
   * revive it into the very same conversation.
   */
  sessionId?: string;
  /** Run a workflow script that orchestrates sub-agents, then exit. */
  workflow?: string;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { provider: 'anthropic', cwd: process.cwd(), yolo: false, help: false, continue: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--provider': { const v = next(); if (v) a.provider = v as ProviderId; break; }
      case '--model': { const v = next(); if (v) a.model = v; break; }
      case '--auth': { const v = next(); if (v) a.auth = v as AuthMode; break; }
      case '--cwd': { const v = next(); if (v) a.cwd = v; break; }
      case '-p': case '--print': { const v = next(); if (v !== undefined) a.print = v; break; }
      case '--yolo': a.yolo = true; break;
      case '--resume': {
        // Optional id: `--resume <id>` reloads it; bare `--resume` opens the picker.
        const peek = argv[i + 1];
        if (peek && !peek.startsWith('-')) { a.resume = peek; i++; } else a.resume = true;
        break;
      }
      case '--session-id': { const v = next(); if (v) a.sessionId = v; break; }
      case '--continue': case '-c': a.continue = true; break;
      case '--workflow': { const v = next(); if (v) a.workflow = v; break; }
      case '-h': case '--help': a.help = true; break;
      default:
        if (arg && !arg.startsWith('-') && a.print === undefined) a.print = arg;
    }
  }
  return a;
}

export const USAGE = `mayac — maya code, Maya's coding-agent harness

Usage:
  mayac [options]                 start the interactive TUI
  mayac -p "<prompt>" [options]   run one prompt headless

Options:
  --provider <anthropic|openai>   provider (default: anthropic)
  --model <id>                    model override
  --auth <api|subscription>       auth mode (default: auto-detect)
  --cwd <dir>                     working directory
  -p, --print "<prompt>"          headless one-shot
  --workflow <script.js>          run a sub-agent workflow script, then exit
  --resume [id]                   reload a past session (no id = picker)
  --session-id <id>               use this id for the session (instead of a new one)
  -c, --continue                  continue the most recent session
  --yolo                          auto-allow writes/bash (no prompts)
  -h, --help                      show this help`;
