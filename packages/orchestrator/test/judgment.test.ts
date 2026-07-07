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
import { makeVerifier, requiredContent, requiredFilenames } from '../src/judgment.js';

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

describe('requiredContent', () => {
  it('extracts exact-content requirements from common phrasings', () => {
    expect(requiredContent('create x.txt containing exactly: `MAYA-OK`')).toEqual(['MAYA-OK']);
    expect(requiredContent('the file content: "Maya M3 demo complete"')).toContain('Maya M3 demo complete');
  });

  it('ignores filename-looking and code-looking backtick literals', () => {
    expect(requiredContent('edit `slugify.mjs` and call `slugify(s)`')).toEqual([]);
  });

  it('excludes rework-echoed content', () => {
    const spec = 'write exactly: `GOAL-TEXT`\nREWORK (round 1): must contain exactly: "GOAL-TEXT"';
    expect(requiredContent(spec)).toEqual(['GOAL-TEXT']);
  });
});

describe('makeVerifier content gate (finding #2: workers lie about content)', () => {
  it('fails when required exact content is absent from every file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifc-'));
    fs.writeFileSync(path.join(dir, 'out.txt'), '2026-07-08'); // the live wrong-content case
    const verify = makeVerifier(deadLlm, { workspaceDir: dir });

    const verdict = await verify(task('create out.txt containing exactly: `Maya M3 demo complete`'));
    expect(verdict.ok).toBe(false);
    expect(verdict.feedback).toContain('Maya M3 demo complete');
  });

  it('passes the content gate when the exact string is present', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifc-'));
    fs.writeFileSync(path.join(dir, 'out.txt'), 'header\nMaya M3 demo complete\nfooter');
    const verify = makeVerifier(deadLlm, { workspaceDir: dir });

    // Both gates pass → reaches the dead LLM → throws (proves gate didn't reject).
    await expect(verify(task('create out.txt containing exactly: `Maya M3 demo complete`'))).rejects.toThrow();
  });
});
