/**
 * Ink (React) TUI. OWNER: @tui.
 *
 * `runTui(opts)` mounts the Ink app: streaming assistant text, rendered tool
 * calls + results, a prompt input, a status bar with provider/model/auth + a live
 * token/cost meter, and slash commands (/model /provider /auth /clear /yolo /help
 * /quit). Drives the session via `session.run()` and its runtime switches.
 *
 * The permission prompt lives here: `TuiPermissionGate` (src/tui/permission.ts)
 * is constructed by the CLI, injected as the session's `permission`, and passed
 * back in so the React app can resolve y/n prompts.
 */
import React from 'react';
import { render } from 'ink';
import { App, type AppProps } from './App.js';

/** Everything the App needs; the CLI builds these and hands them over. */
export type RunTuiOptions = AppProps;

export async function runTui(opts: RunTuiOptions): Promise<void> {
  const { waitUntilExit } = render(React.createElement(App, opts), {
    // We render our own ctrl+c (double-press) affordance.
    exitOnCtrlC: false,
  });
  await waitUntilExit();
}

export { App } from './App.js';
export { TuiPermissionGate } from './permission.js';
