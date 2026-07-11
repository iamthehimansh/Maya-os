import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGlobalMemory,
  loadProjectMemory,
  loadMemory,
  renderMemory,
  appendMemory,
  editMemory,
  rememberTool,
  memoryTool,
} from '../src/memory/index.js';
import type { ToolContext } from '../src/types.js';

let root: string;
let globalDir: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mayac-mem-'));
  globalDir = join(root, 'global');
  projectDir = join(root, 'a', 'b', 'c'); // nested so we can test upward discovery
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (cwd: string): ToolContext => ({ cwd, permission: { request: async () => true } });

describe('memory — global', () => {
  it('loads MAYAC.md plus memory/*.md, skips missing gracefully', async () => {
    await mkdir(join(globalDir, 'memory'), { recursive: true });
    await writeFile(join(globalDir, 'MAYAC.md'), 'always use pnpm', 'utf8');
    await writeFile(join(globalDir, 'memory', 'style.md'), 'two-space indent', 'utf8');
    await writeFile(join(globalDir, 'memory', 'ignore.txt'), 'not markdown', 'utf8');

    const files = await loadGlobalMemory(globalDir);
    expect(files.map((f) => f.content)).toEqual(['always use pnpm', 'two-space indent']);
    expect(files.every((f) => f.scope === 'global')).toBe(true);
  });

  it('returns [] when the global dir does not exist', async () => {
    expect(await loadGlobalMemory(join(root, 'nope'))).toEqual([]);
  });
});

describe('memory — project discovery (walks cwd upward)', () => {
  it('finds MAYAC.md at ancestors, ordered outermost→innermost', async () => {
    await writeFile(join(root, 'a', 'MAYAC.md'), 'ROOT note', 'utf8');
    await writeFile(join(projectDir, 'MAYAC.md'), 'LEAF note', 'utf8');

    const files = await loadProjectMemory(projectDir);
    // Outermost (a/) first, nearest (c/) last so it can override.
    expect(files.map((f) => f.content)).toEqual(['ROOT note', 'LEAF note']);
  });

  it('also discovers .mayac/MAYAC.md', async () => {
    await mkdir(join(projectDir, '.mayac'), { recursive: true });
    await writeFile(join(projectDir, '.mayac', 'MAYAC.md'), 'dot note', 'utf8');
    const files = await loadProjectMemory(projectDir);
    expect(files.some((f) => f.content === 'dot note')).toBe(true);
  });
});

describe('renderMemory', () => {
  it('produces a labeled section, empty memory → empty string', async () => {
    expect(renderMemory({ files: [], chars: 0 })).toBe('');
    const rendered = renderMemory({
      files: [{ scope: 'project', path: '/x/MAYAC.md', content: 'do the thing' }],
      chars: 12,
    });
    expect(rendered).toContain('# Memory');
    expect(rendered).toContain('project:');
    expect(rendered).toContain('do the thing');
  });
});

describe('appendMemory', () => {
  it('creates a project file with a header on first write, then appends bullets', async () => {
    const p1 = await appendMemory('project', 'first fact', { cwd: projectDir });
    expect(p1).toBe(join(projectDir, 'MAYAC.md'));
    await appendMemory('project', 'second fact', { cwd: projectDir });

    const body = await readFile(p1, 'utf8');
    expect(body).toContain('# Maya code — project memory');
    expect(body).toContain('- first fact');
    expect(body).toContain('- second fact');
    // No doubled blank lines between consecutive bullets.
    expect(body).not.toContain('- first fact\n\n- second fact');
  });

  it('appends to an existing file lacking a trailing newline without joining lines', async () => {
    const file = join(projectDir, 'MAYAC.md');
    await writeFile(file, '# notes\n- pre-existing', 'utf8'); // no trailing newline
    await appendMemory('project', 'added', { cwd: projectDir });
    const body = await readFile(file, 'utf8');
    expect(body).toContain('- pre-existing\n- added\n');
  });

  it('writes global scope to <globalDir>/MAYAC.md', async () => {
    const p = await appendMemory('global', 'g note', { globalDir });
    expect(p).toBe(join(globalDir, 'MAYAC.md'));
    expect(await readFile(p, 'utf8')).toContain('- g note');
  });

  it('rejects an empty note', async () => {
    await expect(appendMemory('project', '   ', { cwd: projectDir })).rejects.toThrow();
  });
});

describe('loadMemory (combined)', () => {
  it('merges global + project and counts chars', async () => {
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'MAYAC.md'), 'GG', 'utf8');
    await writeFile(join(projectDir, 'MAYAC.md'), 'PPPP', 'utf8');

    const loaded = await loadMemory(projectDir, { globalDir });
    expect(loaded.files.map((f) => f.scope)).toEqual(['global', 'project']);
    expect(loaded.chars).toBe(2 + 4);
  });
});

describe('rememberTool', () => {
  it('appends a note (default project scope) and reports the path', async () => {
    const res = await rememberTool.run({ note: 'remember this' }, ctx(projectDir));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('project memory');
    const body = await readFile(join(projectDir, 'MAYAC.md'), 'utf8');
    expect(body).toContain('- remember this');
  });

  it('errors on a missing note', async () => {
    const res = await rememberTool.run({}, ctx(projectDir));
    expect(res.isError).toBe(true);
  });
});

describe('editMemory', () => {
  it('replaces the first occurrence of `find` and returns the path', async () => {
    await appendMemory('project', 'use tabs', { cwd: projectDir });
    const p = await editMemory('project', 'use tabs', 'use spaces', { cwd: projectDir });
    expect(p).toBe(join(projectDir, 'MAYAC.md'));
    const body = await readFile(p, 'utf8');
    expect(body).toContain('- use spaces');
    expect(body).not.toContain('use tabs');
  });

  it('edits global scope at <globalDir>/MAYAC.md', async () => {
    await appendMemory('global', 'g old', { globalDir });
    const p = await editMemory('global', 'g old', 'g new', { globalDir });
    expect(p).toBe(join(globalDir, 'MAYAC.md'));
    expect(await readFile(p, 'utf8')).toContain('- g new');
  });

  it('throws when the text to replace is not present (never clobbers)', async () => {
    await appendMemory('project', 'something', { cwd: projectDir });
    await expect(editMemory('project', 'absent', 'x', { cwd: projectDir })).rejects.toThrow();
  });

  it('throws on an empty find string', async () => {
    await appendMemory('project', 'x', { cwd: projectDir });
    await expect(editMemory('project', '', 'y', { cwd: projectDir })).rejects.toThrow();
  });

  it('throws when the memory file does not exist yet', async () => {
    await expect(editMemory('project', 'a', 'b', { cwd: projectDir })).rejects.toThrow();
  });
});

describe('memoryTool (view / add / edit)', () => {
  it('is registered under the name "memory"', () => {
    expect(memoryTool.spec.name).toBe('memory');
    expect(memoryTool.spec.inputSchema).toMatchObject({ required: ['action'] });
  });

  it('view shows the project memory content (fresh from disk)', async () => {
    // Use a distinctive note so the assertion holds regardless of any real
    // ~/.mayac global memory on the dev machine (the tool reads the real global).
    await appendMemory('project', 'a-fact-worth-viewing-xyzzy', { cwd: projectDir });
    const res = await memoryTool.run({ action: 'view' }, ctx(projectDir));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('a-fact-worth-viewing-xyzzy');
  });

  it('view succeeds on an empty project (no throw)', async () => {
    const res = await memoryTool.run({ action: 'view' }, ctx(projectDir));
    expect(res.isError).toBeFalsy();
    expect(typeof res.content).toBe('string');
  });

  it('add appends a project note', async () => {
    const res = await memoryTool.run({ action: 'add', note: 'via tool' }, ctx(projectDir));
    expect(res.isError).toBeFalsy();
    expect(await readFile(join(projectDir, 'MAYAC.md'), 'utf8')).toContain('- via tool');
  });

  it('add errors on an empty note', async () => {
    const res = await memoryTool.run({ action: 'add', note: '  ' }, ctx(projectDir));
    expect(res.isError).toBe(true);
  });

  it('edit does a safe find→replace', async () => {
    await memoryTool.run({ action: 'add', note: 'draft note' }, ctx(projectDir));
    const res = await memoryTool.run(
      { action: 'edit', find: 'draft note', replace: 'final note' },
      ctx(projectDir),
    );
    expect(res.isError).toBeFalsy();
    const body = await readFile(join(projectDir, 'MAYAC.md'), 'utf8');
    expect(body).toContain('- final note');
    expect(body).not.toContain('draft note');
  });

  it('edit errors when `find` is absent from the file', async () => {
    await memoryTool.run({ action: 'add', note: 'present' }, ctx(projectDir));
    const res = await memoryTool.run(
      { action: 'edit', find: 'missing', replace: 'x' },
      ctx(projectDir),
    );
    expect(res.isError).toBe(true);
  });

  it('edit errors without a `find`', async () => {
    const res = await memoryTool.run({ action: 'edit', replace: 'x' }, ctx(projectDir));
    expect(res.isError).toBe(true);
  });

  it('errors on an unknown action', async () => {
    const res = await memoryTool.run({ action: 'delete' }, ctx(projectDir));
    expect(res.isError).toBe(true);
  });
});
