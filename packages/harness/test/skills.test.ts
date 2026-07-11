/**
 * Skills system (item 1) — discovery (dir + bare file, project + global),
 * frontmatter parse, the `skill` tool loading a SKILL.md, and `/skills`
 * add/search/remove with a mocked fetch (no real network). OWNER: @skills.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFrontmatter,
  discoverSkills,
  SkillManager,
  renderSkillsSection,
  createSkillTool,
  createInstallSkillTool,
  installSkill,
  searchRegistry,
  parseOwnerRepo,
} from '../src/skills/index.js';
import type { ToolContext } from '../src/types.js';

const ctx = { cwd: process.cwd(), permission: { async request() { return true; } } } as ToolContext;

let root: string;
let cwd: string;
let globalDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mayac-skills-'));
  cwd = join(root, 'proj', 'sub'); // nested so upward discovery is exercised
  globalDir = join(root, 'global-skills');
  await mkdir(cwd, { recursive: true });
  await mkdir(globalDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a directory skill: `<base>/<name>/SKILL.md` (+ optional extra files). */
async function writeDirSkill(
  base: string,
  folder: string,
  fm: string,
  extras: Record<string, string> = {},
): Promise<void> {
  const dir = join(base, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), fm, 'utf8');
  for (const [rel, content] of Object.entries(extras)) {
    const p = join(dir, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, content, 'utf8');
  }
}

// ───────────────────────────────────────────────────────── frontmatter ──────

describe('parseFrontmatter', () => {
  it('parses name/description/when-to-use/license + nested metadata, splits body', () => {
    const text = `---
name: pdf-fill
description: "Fill and flatten PDF forms."
when-to-use: When the user has a PDF form to complete.
license: MIT
metadata:
  internal: false
---
# PDF Fill
Do the thing.`;
    const { data, body } = parseFrontmatter(text);
    expect(data.name).toBe('pdf-fill');
    expect(data.description).toBe('Fill and flatten PDF forms.');
    expect(data['when-to-use']).toBe('When the user has a PDF form to complete.');
    expect(data.license).toBe('MIT');
    expect((data.metadata as Record<string, unknown>).internal).toBe(false);
    expect(body.startsWith('# PDF Fill')).toBe(true);
  });

  it('returns the whole text as body when there is no frontmatter fence', () => {
    const { data, body } = parseFrontmatter('# Just markdown\nno fence');
    expect(Object.keys(data)).toHaveLength(0);
    expect(body).toBe('# Just markdown\nno fence');
  });
});

// ─────────────────────────────────────────────────────────── discovery ──────

describe('discoverSkills', () => {
  it('finds directory skills + bare files across project (cwd-upward) and global', async () => {
    // Project skill (dir) in a `.skills/` at the project root, discovered upward.
    await writeDirSkill(join(root, 'proj', '.skills'), 'brand-voice', `---
name: brand-voice
description: Write in the house voice.
---
Body.`);
    // Bare project skill file dropped directly in `.skills/`.
    await writeFile(
      join(root, 'proj', '.skills', 'quickref.md'),
      `---\nname: quickref\ndescription: A bare-file skill.\n---\nrefs`,
      'utf8',
    );
    // Global skill (dir).
    await writeDirSkill(globalDir, 'security-review', `---
name: security-review
description: Audit a diff for vulns.
---
Body.`);

    const skills = await discoverSkills({ cwd, globalDir });
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['brand-voice', 'quickref', 'security-review']);
    expect(byName['brand-voice'].scope).toBe('project');
    expect(byName['brand-voice'].bare).toBe(false);
    expect(byName['quickref'].bare).toBe(true);
    expect(byName['security-review'].scope).toBe('global');
  });

  it('nearest project skill overrides a farther/global one of the same name', async () => {
    await writeDirSkill(join(root, 'proj', '.skills'), 'dup', `---\nname: dup\ndescription: far.\n---\nx`);
    await writeDirSkill(join(cwd, '.skills'), 'dup', `---\nname: dup\ndescription: near.\n---\nx`);
    await writeDirSkill(globalDir, 'dup', `---\nname: dup\ndescription: global.\n---\nx`);
    const skills = await discoverSkills({ cwd, globalDir });
    const dup = skills.filter((s) => s.name === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.description).toBe('near.');
  });

  it('falls back to the folder name when frontmatter omits name', async () => {
    await writeDirSkill(join(cwd, '.skills'), 'no-name', `---\ndescription: nameless.\n---\nbody`);
    const skills = await discoverSkills({ cwd, globalDir });
    expect(skills.find((s) => s.name === 'no-name')?.description).toBe('nameless.');
  });
});

// ──────────────────────────────────────────────────── manager + section ─────

describe('SkillManager', () => {
  it('renders a system-prompt section and loads a skill by name (with file list)', async () => {
    await writeDirSkill(
      join(cwd, '.skills'),
      'brand-voice',
      `---\nname: brand-voice\ndescription: House voice.\nwhen-to-use: On marketing copy.\n---\n# Brand voice\nBe warm.`,
      { 'examples/hello.txt': 'hi', 'reference.md': 'ref' },
    );
    const mgr = new SkillManager({ cwd, globalDir });
    await mgr.reload();

    const section = mgr.section();
    expect(section).toContain('# Available skills');
    expect(section).toContain('brand-voice');
    expect(section).toContain('House voice.');
    expect(section).toContain('use when: On marketing copy.');

    const loaded = await mgr.load('brand-voice');
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toContain('# Brand voice');
    expect(loaded!.files.sort()).toEqual(['examples/hello.txt', 'reference.md']);
  });

  it('empty skill set renders no section', () => {
    expect(renderSkillsSection([])).toBe('');
  });
});

// ──────────────────────────────────────────────────────── skill tool ────────

describe('skill tool', () => {
  it('loads a named skill into context; errors (isError) on an unknown name', async () => {
    await writeDirSkill(join(cwd, '.skills'), 'greeter', `---\nname: greeter\ndescription: Say hi.\n---\n# Greeter\nSay hello nicely.`);
    const mgr = new SkillManager({ cwd, globalDir });
    await mgr.reload();
    const tool = createSkillTool(mgr);

    const ok = await tool.run({ name: 'greeter' }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toContain('# Skill: greeter');
    expect(ok.content).toContain('Say hello nicely.');

    const bad = await tool.run({ name: 'nope' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('No skill named "nope"');
  });
});

// ──────────────────────────────────────────── install (mocked fetch) ────────

/** A fake fetch that serves a repo tree + raw file contents from a map. */
function fakeGithubFetch(tree: { path: string; type: string }[], raw: Record<string, string>) {
  return async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u.includes('/git/trees/')) {
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
    for (const [path, content] of Object.entries(raw)) {
      if (u.endsWith(`/${path}`)) return new Response(content, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
}

describe('installSkill / /skills add', () => {
  it('parses owner/repo tolerantly', () => {
    expect(parseOwnerRepo('vercel-labs/skills')).toEqual({ owner: 'vercel-labs', repo: 'skills' });
    expect(parseOwnerRepo('https://github.com/foo/bar.git/')).toEqual({ owner: 'foo', repo: 'bar' });
    expect(parseOwnerRepo('nope')).toBeNull();
  });

  it('fetches the repo tree + raw files and writes them into .skills/', async () => {
    const tree = [
      { path: 'skills/pdf-fill/SKILL.md', type: 'blob' },
      { path: 'skills/pdf-fill/helper.py', type: 'blob' },
      { path: 'README.md', type: 'blob' },
    ];
    const raw = {
      'skills/pdf-fill/SKILL.md': `---\nname: pdf-fill\ndescription: Fill PDFs.\n---\n# PDF`,
      'skills/pdf-fill/helper.py': 'print(1)',
    };
    const installDir = join(cwd, '.skills');
    const res = await installSkill('owner/repo', installDir, { fetchImpl: fakeGithubFetch(tree, raw) as typeof fetch });
    expect(res.ok).toBe(true);
    expect(res.installed).toContain('pdf-fill');
    // The SKILL.md + supporting file landed under .skills/pdf-fill/.
    const skillMd = await readFile(join(installDir, 'pdf-fill', 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('name: pdf-fill');
    const helper = await readFile(join(installDir, 'pdf-fill', 'helper.py'), 'utf8');
    expect(helper).toBe('print(1)');
  });

  it('manager.add installs then the skill is discoverable + loadable', async () => {
    const tree = [{ path: 'SKILL.md', type: 'blob' }];
    const raw = { 'SKILL.md': `---\nname: root-skill\ndescription: At repo root.\n---\n# Root skill\nDo it.` };
    const mgr = new SkillManager({ cwd, globalDir, fetchImpl: fakeGithubFetch(tree, raw) as typeof fetch });
    await mgr.reload();
    expect(mgr.list()).toHaveLength(0);

    const msg = await mgr.add('acme/root-skill');
    expect(msg).toContain('Installed');
    // Root SKILL.md installs under the repo name folder.
    expect(mgr.get('root-skill')).toBeTruthy();
    const loaded = await mgr.load('root-skill');
    expect(loaded!.content).toContain('Do it.');
  });

  it('names the GitHub rate limit (not "private repo") when anonymously throttled', async () => {
    // GitHub answers an exhausted anonymous budget with 403 + remaining: 0.
    // Reporting that as "not found (or private)" sent users chasing ghosts.
    const reset = String(Math.floor(Date.now() / 1000) + 600); // ~10 min out
    const fetchLimited = (async () =>
      new Response('rate limited', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      })) as typeof fetch;
    const res = await installSkill('acme/t', join(cwd, '.skills'), { fetchImpl: fetchLimited });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('rate-limited');
    expect(res.message).toContain('GITHUB_TOKEN');
    expect(res.message).not.toContain('private');
  });

  it('reports a friendly message on a 404 repo (no throw)', async () => {
    const fetch404 = (async () => new Response('no', { status: 404 })) as typeof fetch;
    const res = await installSkill('ghost/repo', join(cwd, '.skills'), { fetchImpl: fetch404 });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not found');
  });
});

// ─────────────────────────────────────────── search (mocked fetch) ──────────

describe('searchRegistry / /skills search', () => {
  // The registry's PUBLIC surface is `/api/search` — the one the official CLI
  // calls with a bare fetch. `/api/v1/*` is the authenticated surface and 401s;
  // hitting it was the "login required" bug. Guard both facts.
  it('hits the public no-auth /api/search endpoint, with NO auth headers', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      expect(u).toContain('https://skills.sh/api/search?');
      expect(u).toContain('q=pdf');
      expect(u).toContain('limit=10');
      expect(u).not.toContain('/api/v1'); // never the authenticated surface
      seenInit = init;
      return new Response(
        JSON.stringify({
          skills: [
            { id: 'acme/kit/pdf-fill', skillId: 'pdf-fill', name: 'pdf-fill', source: 'acme/kit', installs: 42 },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const hits = await searchRegistry('pdf', { fetchImpl });
    // A bare fetch: no Authorization / token / cookie of any kind.
    const headers = (seenInit?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers)).toHaveLength(0);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('acme/kit/pdf-fill');
    expect(hits[0]!.source).toBe('acme/kit'); // the /skills add spec
    expect(hits[0]!.installs).toBe(42);

    // The rendered listing tells you exactly how to install it.
    const mgr = new SkillManager({ cwd, globalDir, fetchImpl });
    const out = await mgr.search('pdf');
    expect(out).toContain('acme/kit/pdf-fill');
    expect(out).toContain('/skills add acme/kit');
  });

  it('orders hits most-installed first', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          skills: [
            { id: 'a/b/low', source: 'a/b', installs: 3 },
            { id: 'a/b/high', source: 'a/b', installs: 900 },
            { id: 'a/b/mid', source: 'a/b', installs: 50 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const hits = await searchRegistry('x', { fetchImpl });
    expect(hits.map((h) => h.id)).toEqual(['a/b/high', 'a/b/mid', 'a/b/low']);
  });

  it('reports a friendly (non-throwing) message when the registry errors', async () => {
    const fetch500 = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const mgr = new SkillManager({ cwd, globalDir, fetchImpl: fetch500 });
    const out = await mgr.search('anything');
    expect(out).toContain('HTTP 500');
    // The old bug told users to log in. Search is public — never say that again.
    expect(out.toLowerCase()).not.toContain('authentication');
  });
});

// ──────────────────────────────────────────── install_skill tool ────────────

describe('install_skill tool', () => {
  it('routes add + search actions through the manager', async () => {
    const tree = [{ path: 'SKILL.md', type: 'blob' }];
    const raw = { 'SKILL.md': `---\nname: t\ndescription: d.\n---\nbody` };
    const searchBody = JSON.stringify({ skills: [{ id: 'a/b', description: 'x' }] });
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/search?')) return new Response(searchBody, { status: 200 });
      if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree }), { status: 200 });
      if (u.endsWith('/SKILL.md')) return new Response(raw['SKILL.md'], { status: 200 });
      return new Response('nf', { status: 404 });
    }) as typeof fetch;

    const mgr = new SkillManager({ cwd, globalDir, fetchImpl });
    await mgr.reload();
    const tool = createInstallSkillTool(mgr);

    const added = await tool.run({ action: 'add', query: 'acme/t' }, ctx);
    expect(added.content).toContain('Installed');

    const searched = await tool.run({ action: 'search', query: 'q' }, ctx);
    expect(searched.content).toContain('a/b');

    const bad = await tool.run({ action: 'nope', query: 'q' }, ctx);
    expect(bad.isError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────── remove ─────────

describe('/skills remove', () => {
  it('removes an installed skill by name and it disappears from discovery', async () => {
    await writeDirSkill(join(cwd, '.skills'), 'temp', `---\nname: temp\ndescription: tmp.\n---\nbody`);
    const mgr = new SkillManager({ cwd, globalDir });
    await mgr.reload();
    expect(mgr.get('temp')).toBeTruthy();

    const msg = await mgr.remove('temp');
    expect(msg).toContain('Removed');
    expect(mgr.get('temp')).toBeUndefined();

    const gone = await mgr.remove('temp');
    expect(gone).toContain('No installed skill');
  });
});
