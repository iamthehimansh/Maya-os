/**
 * Verifier's deterministic filename gate: specs that name files fail fast —
 * without any LLM call — when those exact names are absent (the live
 * notices.md-for-NOTES.md incident).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskRow } from '@maya-ai/core';
import { LlmClient } from '../src/llm.js';
import { makeVerifier, requiredFilenames } from '../src/judgment.js';

const deadLlm = new LlmClient({ gatewayBaseUrl: 'http://127.0.0.1:1', model: 'local/none', timeoutMs: 500 });

const task = (spec: string, result = 'done'): TaskRow => ({
  id: 'task_t',
  teamId: 'team_t',
  parentId: null,
  spec,
  scope: [],
  deps: [],
  state: 'done',
  assignee: 'ag_t',
  attempts: 0,
  result,
  createdAt: '',
  updatedAt: '',
});

describe('requiredFilenames', () => {
  it('extracts extension-bearing tokens and skips version numbers', () => {
    expect(requiredFilenames('Create slugify.mjs and NOTES.md using qwen 2.5 style')).toEqual(['slugify.mjs', 'NOTES.md']);
  });

  it('ignores filenames echoed in rework feedback', () => {
    const spec = 'Create NOTES.md\nREWORK (round 1): previous attempt made notices.md instead';
    expect(requiredFilenames(spec)).toEqual(['NOTES.md']);
  });
});

describe('makeVerifier filename gate', () => {
  it('fails fast (no LLM) when a named file is missing or misnamed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-'));
    fs.writeFileSync(path.join(dir, 'notices.md'), 'wrong name');
    const verify = makeVerifier(deadLlm, { workspaceDir: dir });

    const verdict = await verify(task('Create NOTES.md with a description'));
    expect(verdict.ok).toBe(false);
    expect(verdict.feedback).toContain('NOTES.md');
    expect(verdict.feedback).toContain('EXACTLY');
  });

  it('passes the gate when every named file exists (then consults the LLM)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-'));
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'the notes');
    const verify = makeVerifier(deadLlm, { workspaceDir: dir });

    // Gate passes → it proceeds to the (dead) LLM → throws. That throw IS the
    // proof the deterministic gate didn't short-circuit a passing workspace.
    await expect(verify(task('Create NOTES.md with a description'))).rejects.toThrow();
  });
});
