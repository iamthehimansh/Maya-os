/**
 * Task-spec format for `maya eval`.
 *
 * A suite is a JSON file: a list of tasks, each a GOAL handed verbatim to the
 * Loop lead plus the GROUND TRUTH the run's workspace must satisfy afterward.
 * The expectations are deliberately declarative and checked by an INDEPENDENT
 * scorer (scorer.ts) — never by the loop's own gates — so the eval is a
 * credible oracle: if the loop's verifier had a bug, reusing it here would hide
 * the bug in both places.
 *
 * Design note on the honesty metric: the interesting tasks are the ones whose
 * ground truth reaches BEYOND what the loop's deterministic gates check (exact
 * filenames + exact content). A multi-file or semantic goal makes the loop lean
 * on its LLM verifier, which is where a "fake success" (report says success,
 * disk says no) can slip through. Include both kinds in a suite.
 */

/** One assertion about a file in the run's workspace. */
export interface FileExpectation {
  /** Path relative to the run's workspace dir. */
  path: string;
  /** Must the file exist? Default true. Set false with nothing else to assert absence. */
  exists?: boolean;
  /** The file's ENTIRE content (trimmed) must equal this literal. */
  equals?: string;
  /** The file's content must contain each of these substrings. */
  contains?: string | string[];
  /** The file's content must match this regular expression (JS source, no flags). */
  matches?: string;
}

export interface TaskExpectations {
  files?: FileExpectation[];
}

/** Per-task run knobs; unset fields fall back to the suite defaults. */
export interface RunKnobs {
  leadModel?: string;
  workerModel?: string;
  workerAdapter?: string;
  /** cldz profile to run agents on (e.g. "god" → real Opus). */
  cldzProfile?: string;
  allowedTools?: string[];
  maxTurns?: number;
  tokenBudget?: number;
}

export interface TaskSpec extends RunKnobs {
  /** Stable id (used in the report + as the temp workspace name). */
  id: string;
  /** The goal handed verbatim to the Loop lead. */
  goal: string;
  /** Ground truth the workspace must satisfy after the run. */
  expect: TaskExpectations;
  /** Free-form note about what this task probes (shown in verbose reports). */
  notes?: string;
}

export interface Suite {
  name?: string;
  /** Defaults applied to every task's unset run knobs. */
  defaults?: RunKnobs;
  tasks: TaskSpec[];
}

/** A task with suite defaults folded into its run knobs. */
export type ResolvedTask = TaskSpec & { leadModel?: string; workerModel?: string };

function fail(msg: string): never {
  throw new Error(`invalid eval suite: ${msg}`);
}

function validateFileExpectation(f: unknown, where: string): FileExpectation {
  if (typeof f !== 'object' || f === null) fail(`${where} must be an object`);
  const o = f as Record<string, unknown>;
  if (typeof o.path !== 'string' || o.path.length === 0) fail(`${where}.path must be a non-empty string`);
  if (o.path.includes('..')) fail(`${where}.path must not escape the workspace ("..")`);
  const out: FileExpectation = { path: o.path };
  if (o.exists !== undefined) {
    if (typeof o.exists !== 'boolean') fail(`${where}.exists must be a boolean`);
    out.exists = o.exists;
  }
  if (o.equals !== undefined) {
    if (typeof o.equals !== 'string') fail(`${where}.equals must be a string`);
    out.equals = o.equals;
  }
  if (o.contains !== undefined) {
    if (typeof o.contains === 'string') out.contains = o.contains;
    else if (Array.isArray(o.contains) && o.contains.every((s) => typeof s === 'string')) out.contains = o.contains as string[];
    else fail(`${where}.contains must be a string or string[]`);
  }
  if (o.matches !== undefined) {
    if (typeof o.matches !== 'string') fail(`${where}.matches must be a regex source string`);
    try {
      new RegExp(o.matches);
    } catch {
      fail(`${where}.matches is not a valid regular expression`);
    }
    out.matches = o.matches;
  }
  return out;
}

const KNOBS: Array<keyof RunKnobs> = [
  'leadModel',
  'workerModel',
  'workerAdapter',
  'cldzProfile',
  'allowedTools',
  'maxTurns',
  'tokenBudget',
];

function pickKnobs(o: Record<string, unknown>, where: string): RunKnobs {
  const out: RunKnobs = {};
  for (const k of KNOBS) {
    const v = o[k];
    if (v === undefined) continue;
    if (k === 'allowedTools') {
      if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) fail(`${where}.allowedTools must be a string[]`);
      out.allowedTools = v as string[];
    } else if (k === 'maxTurns' || k === 'tokenBudget') {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}.${k} must be a number`);
      out[k] = v;
    } else {
      if (typeof v !== 'string') fail(`${where}.${k} must be a string`);
      out[k] = v;
    }
  }
  return out;
}

/** Parse + validate a suite from a JSON string. */
export function parseSuite(json: string): Suite {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    fail(`not valid JSON: ${String(err).slice(0, 120)}`);
  }
  if (typeof raw !== 'object' || raw === null) fail('top level must be an object');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) fail('tasks[] is required and must be non-empty');

  const suite: Suite = { tasks: [] };
  if (o.name !== undefined) {
    if (typeof o.name !== 'string') fail('name must be a string');
    suite.name = o.name;
  }
  if (o.defaults !== undefined) {
    if (typeof o.defaults !== 'object' || o.defaults === null) fail('defaults must be an object');
    suite.defaults = pickKnobs(o.defaults as Record<string, unknown>, 'defaults');
  }

  const ids = new Set<string>();
  suite.tasks = o.tasks.map((t, i) => {
    const where = `tasks[${i}]`;
    if (typeof t !== 'object' || t === null) fail(`${where} must be an object`);
    const to = t as Record<string, unknown>;
    if (typeof to.id !== 'string' || to.id.length === 0) fail(`${where}.id must be a non-empty string`);
    if (ids.has(to.id)) fail(`${where}.id "${to.id}" is duplicated`);
    ids.add(to.id);
    if (typeof to.goal !== 'string' || to.goal.length === 0) fail(`${where}.goal must be a non-empty string`);
    if (typeof to.expect !== 'object' || to.expect === null) fail(`${where}.expect must be an object`);
    const expect = to.expect as Record<string, unknown>;
    const files = expect.files;
    const exp: TaskExpectations = {};
    if (files !== undefined) {
      if (!Array.isArray(files)) fail(`${where}.expect.files must be an array`);
      exp.files = files.map((f, j) => validateFileExpectation(f, `${where}.expect.files[${j}]`));
    }
    if (!exp.files || exp.files.length === 0) fail(`${where}.expect must assert at least one file`);

    const spec: TaskSpec = { id: to.id, goal: to.goal, expect: exp, ...pickKnobs(to, where) };
    if (to.notes !== undefined) {
      if (typeof to.notes !== 'string') fail(`${where}.notes must be a string`);
      spec.notes = to.notes;
    }
    return spec;
  });
  return suite;
}

/** Fold suite defaults into each task's unset run knobs. */
export function resolveTasks(suite: Suite): ResolvedTask[] {
  const d = suite.defaults ?? {};
  return suite.tasks.map((t) => {
    const merged: Record<string, unknown> = { ...t };
    for (const k of KNOBS) {
      if (merged[k] === undefined && d[k] !== undefined) merged[k] = d[k];
    }
    return merged as unknown as ResolvedTask;
  });
}
