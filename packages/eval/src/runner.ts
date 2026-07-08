/**
 * runSuite — glue: for each task, prepare a fresh isolated workspace, drive the
 * Loop (via an injected LoopRunner), then score the workspace independently.
 *
 * Each task gets its OWN empty temp dir so tasks can't contaminate each other
 * and an "absence" expectation means something. The runner is injected so the
 * suite can run against the real HTTP loop in production and a deterministic
 * fake in tests.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSuite, resolveTasks, type ResolvedTask, type Suite } from './spec.js';
import { scoreSuite, scoreTask, type SuiteScore, type TaskScore } from './scorer.js';
import type { LoopRunInput, LoopRunner } from './loop-client.js';

/** Load + validate a suite file from disk. */
export function loadSuite(path: string): Suite {
  return parseSuite(readFileSync(path, 'utf8'));
}

export interface RunSuiteOptions {
  runner: LoopRunner;
  /** Where per-task workspaces are created. Default: OS temp dir. */
  workspaceRoot?: string;
  /** Keep workspaces after the run (for debugging). Default false. */
  keepWorkspaces?: boolean;
  /** Called before/after each task so the CLI can show live progress. */
  onTaskStart?: (task: ResolvedTask, index: number, total: number) => void;
  onTaskDone?: (score: TaskScore, index: number, total: number) => void;
}

function mustModel(task: ResolvedTask): { leadModel: string } {
  if (!task.leadModel) {
    throw new Error(`task ${task.id}: leadModel is required (set it on the task or in suite.defaults)`);
  }
  return { leadModel: task.leadModel };
}

/** Run a whole suite and return the aggregate score. */
export async function runSuite(suite: Suite, opts: RunSuiteOptions): Promise<SuiteScore> {
  const tasks = resolveTasks(suite);
  const root = opts.workspaceRoot ?? tmpdir();
  const scores: TaskScore[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    opts.onTaskStart?.(task, i, tasks.length);
    const cwd = mkdtempSync(join(root, `maya-eval-${task.id}-`));
    try {
      const input: LoopRunInput = {
        goal: task.goal,
        cwd,
        ...mustModel(task),
        ...(task.workerModel !== undefined ? { workerModel: task.workerModel } : {}),
        ...(task.workerAdapter !== undefined ? { workerAdapter: task.workerAdapter } : {}),
        ...(task.cldzProfile !== undefined ? { cldzProfile: task.cldzProfile } : {}),
        ...(task.allowedTools !== undefined ? { allowedTools: task.allowedTools } : {}),
        ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
        ...(task.tokenBudget !== undefined ? { tokenBudget: task.tokenBudget } : {}),
      };
      const result = await opts.runner(input);
      const score = scoreTask(task, cwd, {
        reported: result.reported,
        ...(result.tokensUsed !== undefined ? { tokensUsed: result.tokensUsed } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
      scores.push(score);
      opts.onTaskDone?.(score, i, tasks.length);
    } finally {
      if (!opts.keepWorkspaces) rmSync(cwd, { recursive: true, force: true });
    }
  }

  return scoreSuite(scores);
}
