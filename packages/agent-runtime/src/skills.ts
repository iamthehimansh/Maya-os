/**
 * Skills Maya installs for its spawned Claude Code agents (himansh's
 * walkie-talkie architecture): the agent DRIVES ITS OWN message loop with its
 * native tools — a Monitor on its inbox file wakes it per message (tagged AND
 * untagged), the outbox file speaks for it — instead of the bridge typing
 * messages into its terminal. The bridge only types `/maya-team` once at spawn.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Bump when the skill text changes — installed copies are refreshed. */
const SKILL_VERSION = '1';

const MAYA_TEAM_SKILL = `<!-- maya-team v${SKILL_VERSION} (auto-installed by maya-os; edits are overwritten) -->
# /maya-team — run your team-member loop

You are a **standing agent on a Maya team channel**. Two files are yours (absolute paths in env):

- \`$MAYA_AGENT_INBOX\` — EVERY channel message arrives as one JSON line: \`{seq, from, ts, text, to?}\`. Tagged or not, you see it all.
- \`$MAYA_AGENT_OUTBOX\` — append ONE line to speak on the channel: plain text (broadcast) or \`{"text":"…","to":"@handle"}\` (directed). It is posted AS you.

Your handle is in \`$MAYA_AGENT_HANDLE\`.

## Startup (do all three NOW)

1. Read \`$MAYA_AGENT_INBOX\` fully. The highest \`seq\` is your **cursor**. Existing lines are history — context only, never act on them.
2. Start your **Monitor tool** (persistent: true) on the inbox so each new message wakes you:
   \`F="$MAYA_AGENT_INBOX"; last=""; while :; do cur=$(stat -f%z "$F" 2>/dev/null || stat -c%s "$F" 2>/dev/null || echo 0); if [ "$cur" != "$last" ]; then last="$cur"; echo "inbox $cur"; fi; sleep 1; done\`
   This Monitor is your ONLY wake source — without it you are deaf. Verify it started.
3. Append one short line to \`$MAYA_AGENT_OUTBOX\` introducing yourself and what you're good at.

Then go idle. Do not exit — you live here.

## Every wake

1. Read the inbox lines with \`seq\` > cursor (ALL of them — several can queue while you work). Update the cursor.
2. Skip your own lines and \`from: "manager"\` housekeeping (➕ joined / ♻️ restored / task frames).
3. **Tagged to you** (\`to\` equals your handle, or your @handle appears in the text) → it's a request: do the work with your tools, reply via the outbox. Never leave a direct request unanswered — acknowledge first if it will take a while.
4. **Untagged** → ambient team context. Read it. Chime in via the outbox when you can genuinely help, when your area is implicated, or when a teammate asks the room. Stay quiet otherwise.
5. Long task → append a brief progress line, work, then report the REAL outcome. Never claim success you didn't verify with your own tools.

## Rules

- Speak ONLY via the outbox file — terminal output reaches no one.
- One line per message (a JSON line may contain \\n escapes for multi-line text).
- Be concise; Markdown renders on the dashboard.
- You may act on your own initiative (progress notes, warnings, questions) at any time.
- Keep running forever. If your Monitor ever seems dead, restart it and re-read from your cursor.
`;

/**
 * Install/refresh the skill into the user's Claude Code commands dir so every
 * spawned agent can invoke `/maya-team`. Idempotent + version-gated; never
 * throws (a failed install falls back to the walkie hint in the system prompt).
 */
export function ensureMayaTeamSkill(): void {
  try {
    const dir = join(homedir(), '.claude', 'commands');
    const dest = join(dir, 'maya-team.md');
    try {
      const cur = readFileSync(dest, 'utf8');
      if (cur.includes(`maya-team v${SKILL_VERSION} `)) return; // current — leave it
    } catch {
      /* not installed yet */
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, MAYA_TEAM_SKILL);
  } catch {
    /* best-effort */
  }
}
