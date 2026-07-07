/**
 * Production judgment functions for the LoopLead — both are thin prompts
 * over Maya's own gateway (LlmClient). Deterministic tests inject their own;
 * these are what `maya loop` wires in.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import type { TaskRow } from '@maya-ai/core';
import type { LlmClient } from './llm.js';
import type { Plan, Planner, Verifier } from './loop-lead.js';

const PLANNER_SYSTEM = `You are the planning head of a software team lead. Decompose the user's goal into 1–5 SELF-CONTAINED tasks for one-shot worker agents (each worker sees ONLY its task text, no other context — write complete instructions).
Reply with ONLY JSON:
{"tasks":[{"spec":"complete instruction for one worker","deps":[indexes of tasks that must finish first],"scope":["files/dirs this task may touch"],"acceptance":"how to check it worked"}]}
Rules:
- Prefer FEWER, meatier tasks. Parallel tasks must have disjoint scopes.
- Only if the goal is genuinely undecidable without the owner (e.g. two contradictory readings), reply instead: {"clarification":{"prompt":"the question","options":["option A","option B"]}} — at most ONE clarification, never for preferences you can default sensibly.`;

const VERIFIER_SYSTEM = `You are the verification head of a software team lead. Judge whether a worker's task is ACTUALLY complete.
CRITICAL: workers sometimes claim success without doing the work. When a WORKSPACE section is provided, it is the ground truth — judge ONLY against it (do files with the exact required names exist? does content match the task?), and ignore the worker's own claims. Without a workspace section, judge the reported result pragmatically.
Reply with ONLY JSON: {"ok":true} or {"ok":false,"feedback":"what is missing or wrongly named, one sentence"}`;

export function makePlanner(llm: LlmClient): Planner {
  return async (goal, context) => {
    const user = context.answer ? `Goal: ${goal}\n\nOwner's answer to your clarification: ${context.answer}` : `Goal: ${goal}`;
    return llm.json<Plan>(PLANNER_SYSTEM, user, (v) => {
      const obj = v as Partial<Plan>;
      if (obj.clarification) {
        if (typeof obj.clarification.prompt !== 'string' || !Array.isArray(obj.clarification.options)) {
          throw new Error('clarification must have prompt + options[]');
        }
        return { tasks: [], clarification: { prompt: obj.clarification.prompt, options: obj.clarification.options.map(String) } };
      }
      if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) throw new Error('tasks[] required');
      return {
        tasks: obj.tasks.map((t) => {
          const spec = (t as { spec?: unknown }).spec;
          if (typeof spec !== 'string' || spec.length < 8) throw new Error('every task needs a spec string');
          const deps = (t as { deps?: unknown }).deps;
          const scope = (t as { scope?: unknown }).scope;
          const acceptance = (t as { acceptance?: unknown }).acceptance;
          return {
            spec,
            ...(Array.isArray(deps) ? { deps: deps.map(Number).filter((n) => Number.isInteger(n) && n >= 0) } : {}),
            ...(Array.isArray(scope) ? { scope: scope.map(String) } : {}),
            ...(typeof acceptance === 'string' ? { acceptance } : {}),
          };
        }),
      };
    });
  };
}

export interface VerifierOptions {
  /**
   * Ground truth: when set, the verifier reads this directory (names + first
   * 1KB of each file) into the prompt and judges against REALITY instead of
   * the worker's claims — workers sometimes report success without doing the
   * work (observed live: a 0.5B created junk filenames and said "done").
   */
  workspaceDir?: string;
}

export function makeVerifier(llm: LlmClient, opts?: VerifierOptions): Verifier {
  return async (task: TaskRow) => {
    let workspace = '';
    if (opts?.workspaceDir) {
      // Deterministic gate FIRST: every filename the spec names must exist
      // with that EXACT name (observed live: a worker created notices.md for
      // NOTES.md and the LLM verifier shrugged). No LLM call needed to fail.
      const missing = requiredFilenames(task.spec).filter((f) => !fileExists(opts.workspaceDir!, f));
      if (missing.length > 0) {
        return {
          ok: false,
          feedback: `required file(s) missing or misnamed — create EXACTLY: ${missing.join(', ')}`,
        };
      }
      // Content gate: when the spec dictates EXACT content ("containing
      // exactly: X", "content: X", or a backtick-quoted literal), that string
      // must actually appear somewhere in the workspace (observed live: goal
      // wanted "Maya M3 demo complete", worker wrote "2026-07-08", verifier
      // passed it). Workers lie about content, not just filenames.
      const haystack = concatWorkspace(opts.workspaceDir);
      const missingContent = requiredContent(task.spec).filter((s) => !haystack.includes(s));
      if (missingContent.length > 0) {
        return {
          ok: false,
          feedback: `required content not found in any file — must contain exactly: ${missingContent.map((s) => JSON.stringify(s)).join(', ')}`,
        };
      }
      workspace = `\n\nWORKSPACE (ground truth — directory listing with file heads):\n${snapshotDir(opts.workspaceDir)}`;
    }
    const user = `Task: ${task.spec}\n\nWorker's reported result: ${task.result ?? '(none)'}${workspace}`;
    return llm.json<{ ok: boolean; feedback?: string }>(VERIFIER_SYSTEM, user, (v) => {
      const obj = v as { ok?: unknown; feedback?: unknown };
      if (typeof obj.ok !== 'boolean') throw new Error('ok:boolean required');
      return { ok: obj.ok, ...(typeof obj.feedback === 'string' ? { feedback: obj.feedback } : {}) };
    });
  };
}

/**
 * Filenames the spec explicitly requires (extension-bearing tokens, minus
 * REWORK-feedback echoes). Exported for tests.
 */
export function requiredFilenames(spec: string): string[] {
  // Ignore the rework preamble's repetition of verifier feedback.
  const base = spec.split('\nREWORK (round')[0] ?? spec;
  const seen = new Set<string>();
  for (const m of base.matchAll(/\b([A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z]{1,6})\b/g)) {
    const name = m[1]!;
    // Skip version-ish tokens (e.g. "2.5") and bare domains people write in prose.
    if (/^\d+(\.\d+)+$/.test(name)) continue;
    seen.add(name);
  }
  return [...seen];
}

function fileExists(dir: string, name: string): boolean {
  try {
    return statSync(`${dir}/${name}`).isFile();
  } catch {
    return false;
  }
}

/**
 * Exact-content requirements the spec dictates. Matches the common phrasings
 * ("containing exactly: X", "content: X", "exactly X") and backtick literals.
 * Exported for tests. REWORK echoes excluded. Conservative — only fires on an
 * explicit exactness cue, so free-form goals aren't over-constrained.
 */
export function requiredContent(spec: string): string[] {
  const base = spec.split('\nREWORK (round')[0] ?? spec;
  const out = new Set<string>();
  // Quoted/backtick literal after a content cue.
  const quoted = /(?:containing|contains?|content(?:s)?|says?|write[s]?|exactly)\s*(?:exactly)?\s*[:=]?\s*[`"“]([^`"”\n]{2,120})[`"”]/gi;
  for (const m of base.matchAll(quoted)) out.add(m[1]!.trim());
  // UNQUOTED after an EXPLICIT exactness cue → capture to end of line (the
  // natural phrasing `containing exactly: Maya M3 demo complete`, which the
  // quoted pattern misses — the v2 miss 02 caught live).
  const unquoted = /(?:contain(?:ing|s)?|content(?:s)?)\s+exactly\s*[:=]?\s*([^\n`"“]{2,120})|(?:content(?:s)?)\s*[:=]\s*([^\n`"“]{2,120})/gi;
  for (const m of base.matchAll(unquoted)) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    // Trim trailing prose/punctuation that isn't part of the literal.
    const cleaned = raw.replace(/\s*(?:and nothing else|nothing more|then stop|\.)\s*$/i, '').trim();
    if (cleaned.length >= 2) out.add(cleaned);
  }
  // Bare backtick literals used as required content (e.g. `MAYA-OK`).
  for (const m of base.matchAll(/`([^`\n]{2,120})`/g)) {
    const s = m[1]!.trim();
    // Skip things that are clearly filenames or code identifiers with dots/parens.
    if (!/\.[A-Za-z]{1,6}$/.test(s) && !/[()]/.test(s)) out.add(s);
  }
  return [...out];
}

/**
 * Default goal-level acceptance for the LoopLead: the GOAL's required
 * filenames must exist and its required exact content must appear in the
 * workspace — checked against REALITY, independent of how the planner
 * paraphrased tasks. Case-sensitive filename check (macOS's case-insensitive
 * FS otherwise passes `status.md` for `STATUS.md`).
 */
export function makeGoalCheck(workspaceDir: string): (goal: string) => Promise<{ met: boolean; missing: string[] }> {
  return async (goal: string) => {
    const missing: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(workspaceDir);
    } catch {
      /* unreadable */
    }
    const nameSet = new Set(names);
    for (const f of requiredFilenames(goal)) {
      if (!nameSet.has(f)) missing.push(`file ${f} (exact name)`);
    }
    const haystack = concatWorkspace(workspaceDir);
    for (const c of requiredContent(goal)) {
      if (!haystack.includes(c)) missing.push(`content ${JSON.stringify(c)}`);
    }
    return { met: missing.length === 0, missing };
  };
}

/** Concatenated head of every workspace file — the content-gate haystack. */
function concatWorkspace(dir: string): string {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const name of entries.slice(0, 40)) {
    try {
      const p = `${dir}/${name}`;
      if (statSync(p).isFile()) parts.push(readHead(p, 4096));
    } catch {
      /* skip */
    }
  }
  return parts.join('\n');
}

/** Names + first 1KB of up to 20 files (one level deep) — small by design. */
function snapshotDir(dir: string): string {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return '(workspace unreadable)';
  }
  if (entries.length === 0) return '(workspace is EMPTY — no files exist)';
  const lines: string[] = [];
  for (const name of entries.slice(0, 20)) {
    const p = `${dir}/${name}`;
    try {
      const stat = statSync(p);
      if (stat.isDirectory()) {
        lines.push(`${name}/ (dir: ${readdirSync(p).slice(0, 10).join(', ')})`);
      } else {
        lines.push(`${name} (${stat.size}B): ${readHead(p, 1024).replaceAll('\n', '\\n')}`);
      }
    } catch {
      lines.push(`${name} (unreadable)`);
    }
  }
  return lines.join('\n');
}

function readHead(p: string, bytes: number): string {
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
