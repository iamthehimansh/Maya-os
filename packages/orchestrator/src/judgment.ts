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
