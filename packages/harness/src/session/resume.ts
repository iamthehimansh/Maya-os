/**
 * Session-id resolution for the CLI. OWNER: @harness.
 *
 * Decides ONE thing: which session id this process writes to, and which
 * transcript (if any) it starts from. It exists because a standing team agent
 * that gets drained and revived must come back into the SAME conversation — so
 * the id has to be assignable from outside (`--session-id <id>`) and reloadable
 * (`--resume <id>`).
 *
 * Rules:
 * - `--resume <id>`  → reload that transcript. If the file is GONE (history
 *   cleared, first revive after a crash), we do NOT mint a new id: we start a
 *   fresh conversation UNDER THE SAME ID and warn. Minting a new one would make
 *   this process write to an id nobody knows, and the next revive would find
 *   nothing again — the agent would be permanently amnesiac.
 * - `--session-id <id>` → fresh conversation written under that id. If a
 *   transcript already exists there we ADOPT it rather than clobber it: the
 *   supervisor asking for an id it already used means "be that agent".
 * - `--continue` → most recently updated session (its own id).
 * - nothing → a brand-new id from the store.
 *
 * Two agents sharing a cwd therefore never cross-resume: the id is per-agent,
 * not per-directory (which is exactly what `--continue` gets wrong).
 */
import type { SessionInit, SessionRecord, SessionStore } from './index.js';

export interface SessionPlanInput {
  store: SessionStore;
  /** `--session-id <id>` */
  sessionId?: string | undefined;
  /** `--resume <id>`, or `true` for the picker. */
  resume?: string | true | undefined;
  /** `--continue` */
  continue?: boolean | undefined;
  /** Used when a brand-new record has to be created. */
  init: SessionInit;
}

export interface SessionPlan {
  /** The record this process saves into. Its `id` is what the TUI writes under. */
  record: SessionRecord;
  /** Transcript to replay into the session, or null for a fresh conversation. */
  preload: SessionRecord | null;
  /** One-line warning to print to stderr (missing session, conflicting flags). */
  warning?: string;
}

/** Build a record with a caller-supplied id (the store only mints random ones). */
function recordWithId(store: SessionStore, id: string, init: SessionInit): SessionRecord {
  return { ...store.create(init), id };
}

export async function resolveSessionPlan(input: SessionPlanInput): Promise<SessionPlan> {
  const { store, init } = input;
  const resumeId = typeof input.resume === 'string' ? input.resume : undefined;
  const warnings: string[] = [];

  // Both flags: `--resume` wins (it's the revive path). Same id on both is a
  // no-op; different ids means the supervisor is confused, so say so — but never
  // crash: a wedged agent is worse than a mis-flagged one.
  let id = resumeId ?? input.sessionId;
  if (resumeId && input.sessionId && resumeId !== input.sessionId) {
    warnings.push(`--resume ${resumeId} overrides --session-id ${input.sessionId}`);
  }

  if (id) {
    const preload = await store.load(id);
    if (!preload && resumeId) {
      warnings.push(`session ${id} not found — starting a fresh session with that id`);
    }
    const record = preload ?? recordWithId(store, id, init);
    return {
      record,
      preload,
      ...(warnings.length ? { warning: warnings.join('; ') } : {}),
    };
  }

  if (input.continue) {
    const preload = await store.latest();
    if (!preload) warnings.push('no previous session to continue — starting a fresh one');
    const record = preload ?? store.create(init);
    return {
      record,
      preload,
      ...(warnings.length ? { warning: warnings.join('; ') } : {}),
    };
  }

  // Bare `--resume` (picker) and the default path both start from a new record;
  // the TUI swaps in the picked session itself.
  return { record: store.create(init), preload: null };
}
