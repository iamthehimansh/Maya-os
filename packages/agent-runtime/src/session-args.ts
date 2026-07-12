/**
 * Session identity for STANDING agents — the thing that makes a revived agent
 * the SAME agent. OWNER: @runtime.
 *
 * The problem: a stopped agent (drained, killed, or the serve restarted) used to
 * come back as a blank conversation — it had forgotten the brief, its work, and
 * everything its teammates said. A drained team could never be picked back up.
 *
 * The fix is NOT `--continue`: several agents share one `cwd`, and `--continue`
 * resumes the most-recent conversation in that directory — so agents would
 * resume EACH OTHER's sessions. Instead the orchestrator mints a stable id per
 * standing agent (persisted in the `standing_agents` spec) and hands it to us:
 *
 *   options.sessionId      — the stable id (ALWAYS set for a standing agent)
 *   options.resumeSession  — absent/false = FIRST spawn; true = REVIVE
 *
 * First spawn → `--session-id <id>` (write the conversation under THAT id).
 * Revive     → `--resume <id>`     (reload that exact conversation).
 *
 * Two ways this could wedge an agent, both handled here rather than at the CLI:
 *
 * 1. MISSING TRANSCRIPT. `claude --resume <id>` EXITS with an error when no
 *    conversation has that id (the owner cleared history, or a first spawn died
 *    before writing). A revive would then crash-loop instead of coming back. So
 *    we stat the transcript first and, if it's gone, downgrade to
 *    `--session-id <same id>`: a fresh conversation under the SAME id, so the
 *    NEXT revive resumes normally. A missing session degrades to amnesia, never
 *    to a dead agent.
 * 2. NON-UUID ID. `claude --help`: "--session-id <uuid> … (must be a valid
 *    UUID)". A `sess_abc123` would make the CLI reject the flag and the spawn
 *    fail. We warn and omit rather than crash. (mayac has no such constraint.)
 *
 * Both paths return a `warning` instead of throwing — the adapter surfaces it as
 * one system log line, so a degraded revive is VISIBLE but never fatal.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpawnSpec } from '@maya-ai/core';

/** `--session-id` accepts a UUID only (claude CLI). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionPlan {
  /** Flags to append to argv (empty when the agent has no session identity). */
  args: string[];
  /** A degraded-but-alive condition, surfaced as one system log line. */
  warning?: string;
}

/**
 * Does claude already hold a transcript for this session id?
 *
 * Claude stores it at `~/.claude/projects/<mangled-cwd>/<session-id>.jsonl`. We
 * do NOT try to reproduce its cwd-mangling scheme (an internal detail that has
 * changed between versions, and getting it wrong would silently report "gone"
 * and amnesia every revive) — session ids are UUIDs, so finding the file under
 * ANY project dir is proof enough that the conversation exists.
 */
export function claudeSessionExists(sessionId: string, home: string = homedir()): boolean {
  const projects = join(home, '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false; // no projects dir at all → nothing to resume
  }
  return dirs.some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
}

/** mayac's session store: `~/.maya-harness/sessions/<id>.json` (harness/src/session/index.ts). */
export function mayacSessionExists(sessionId: string, home: string = homedir()): boolean {
  return existsSync(join(home, '.maya-harness', 'sessions', `${sessionId}.json`));
}

export interface PlanSessionOptions {
  /** Does a transcript for this id exist? Injected so tests don't touch $HOME. */
  exists: (sessionId: string) => boolean;
  /** CLI name, for the warning text. */
  cli: string;
  /** Reject a non-UUID id (claude does; mayac doesn't). */
  requireUuid?: boolean;
}

/**
 * Map a spawn spec's session identity to CLI flags. Pure + injectable, because
 * argv construction is a contract with the CLI and must be unit-testable without
 * a real $HOME or a real spawn.
 */
export function planSessionArgs(spec: AgentSpawnSpec, opts: PlanSessionOptions): SessionPlan {
  // Top-level typed fields are the contract; the `options` bag is accepted as an
  // equivalent alias so an adapter-specific caller (or an older orchestrator that
  // still passes extras through options) keeps working rather than silently
  // spawning an agent with no session identity.
  const sessionId = spec.sessionId ?? spec.options?.['sessionId'];
  if (typeof sessionId !== 'string' || !sessionId) return { args: [] }; // not a standing agent

  if (opts.requireUuid && !UUID_RE.test(sessionId)) {
    return {
      args: [],
      warning:
        `[session] ${opts.cli} requires a UUID session id — got "${sessionId}". ` +
        `Running WITHOUT session persistence: this agent will not remember across a revive.`,
    };
  }

  const reviving = spec.resumeSession === true || spec.options?.['resumeSession'] === true;
  if (!reviving) return { args: ['--session-id', sessionId] }; // first spawn: write under this id

  // Revive. Resuming a transcript that isn't there is a hard CLI error, so check
  // first and degrade to a fresh conversation under the SAME id (next revive works).
  if (!opts.exists(sessionId)) {
    return {
      args: ['--session-id', sessionId],
      warning:
        `[session] no ${opts.cli} transcript for ${sessionId} (history cleared?) — ` +
        `starting a FRESH session under the same id. This agent has lost its prior context.`,
    };
  }
  return { args: ['--resume', sessionId] };
}
