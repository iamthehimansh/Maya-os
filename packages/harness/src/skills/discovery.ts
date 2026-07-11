/**
 * Skill discovery — find skills on disk. OWNER: @skills.
 *
 * Two roots, both the open `.skills/` convention so anything installed by
 * `npx skills add` (or dropped in by hand) is found automatically:
 *   • PROJECT — a `.skills/` directory discovered by walking from `cwd` UPWARD
 *               to the filesystem root (nearer wins on a name clash).
 *   • GLOBAL  — `~/.maya/.skills/`.
 *
 * Inside a skills root a skill is EITHER:
 *   • a DIRECTORY containing `SKILL.md`/`skill.md` (+ optional supporting files),
 *     possibly nested one or two levels for catalog layouts
 *     (`.skills/<repo>/<name>/SKILL.md`); OR
 *   • a BARE `SKILL.md`/`skill.md`/`*.md` file sitting directly in the root.
 *
 * We read + parse each file's frontmatter; a skill with no `name` falls back to
 * its folder (or file) name so it is still discoverable.
 */
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse as parsePath } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import type { Skill, SkillScope } from './types.js';

/** The per-project skills directory name discovered up the tree. */
export const SKILLS_DIR = '.skills';
/** Global skills live under Maya's home. */
export const GLOBAL_SKILLS_DIR = join(homedir(), '.maya', '.skills');

/** How deep inside a skills root we hunt for a nested `SKILL.md`. */
const MAX_DEPTH = 3;

const SKILL_FILE = /^skill\.md$/i;

export interface DiscoverOptions {
  /** Roots project-scope discovery (walks upward from here). Default process.cwd(). */
  cwd?: string;
  /** Override the global skills dir (tests). Default `~/.maya/.skills`. */
  globalDir?: string;
}

interface DirEntryLite {
  name: string;
  isDir: boolean;
}

async function listDir(dir: string): Promise<DirEntryLite[] | null> {
  try {
    const ents = await readdir(dir, { withFileTypes: true });
    return ents.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return null;
  }
}

/** Build a Skill from a resolved SKILL.md path. `bare` when it sits in the root. */
async function readSkill(
  filePath: string,
  scope: SkillScope,
  rootDir: string,
): Promise<Skill | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const { data } = parseFrontmatter(raw);
  const dir = dirname(filePath);
  const bare = dir === rootDir;
  // Name falls back to the folder name (dir skills) or the file basename (bare).
  const fallback = bare
    ? basename(filePath).replace(/\.md$/i, '')
    : basename(dir);
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallback;
  const description =
    typeof data.description === 'string' ? data.description.trim() : '';
  const whenToUse =
    typeof data['when-to-use'] === 'string'
      ? (data['when-to-use'] as string).trim()
      : typeof data.whenToUse === 'string'
        ? (data.whenToUse as string).trim()
        : undefined;
  const license = typeof data.license === 'string' ? data.license.trim() : undefined;
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    ...(license ? { license } : {}),
    scope,
    path: filePath,
    dir,
    bare,
  };
}

/**
 * Scan one skills root: bare top-level `*.md` files become skills, and every
 * `SKILL.md`/`skill.md` found up to `MAX_DEPTH` deep becomes a folder skill.
 */
async function scanRoot(root: string, scope: SkillScope): Promise<Skill[]> {
  const out: Skill[] = [];

  // Walk the tree, collecting SKILL.md files and top-level bare .md files.
  async function walk(dir: string, depth: number): Promise<void> {
    const ents = await listDir(dir);
    if (!ents) return;
    for (const e of ents.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue; // skip hidden (e.g. .git in an installed repo)
      const full = join(dir, e.name);
      if (e.isDir) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (SKILL_FILE.test(e.name)) {
        const skill = await readSkill(full, scope, root);
        if (skill) out.push(skill);
      } else if (depth === 0 && e.name.toLowerCase().endsWith('.md')) {
        // A bare skill file dropped directly in the root (not named SKILL.md).
        const skill = await readSkill(full, scope, root);
        if (skill) out.push(skill);
      }
    }
  }

  await walk(root, 0);
  return out;
}

/** The project `.skills/` roots, from cwd UPWARD (nearest first). */
export function projectSkillsRoots(cwd: string): string[] {
  const roots: string[] = [];
  let dir = cwd;
  const fsRoot = parsePath(dir).root;
  for (let i = 0; i < 64; i++) {
    roots.push(join(dir, SKILLS_DIR));
    if (dir === fsRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/**
 * Discover all skills: project (`.skills/` up the tree, nearest wins) + global
 * (`~/.maya/.skills/`). Deduped by name — a nearer project skill overrides a
 * farther one, and any project skill overrides a global of the same name.
 * Returns a stable, name-sorted list.
 */
export async function discoverSkills(opts: DiscoverOptions = {}): Promise<Skill[]> {
  const cwd = opts.cwd ?? process.cwd();
  const globalDir = opts.globalDir ?? GLOBAL_SKILLS_DIR;

  const projectRoots = projectSkillsRoots(cwd);
  // Nearest-first: scan in order and let the FIRST occurrence of a name win.
  const projectLists = await Promise.all(projectRoots.map((r) => scanRoot(r, 'project')));
  const globalList = await scanRoot(globalDir, 'global');

  const byName = new Map<string, Skill>();
  // Project first (nearest→farthest), then global — first writer wins.
  for (const list of projectLists) {
    for (const s of list) if (!byName.has(s.name)) byName.set(s.name, s);
  }
  for (const s of globalList) if (!byName.has(s.name)) byName.set(s.name, s);

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** List a folder skill's supporting files (relative paths), excluding SKILL.md itself. */
export async function listSkillFiles(skill: Skill): Promise<string[]> {
  if (skill.bare) return [];
  const out: string[] = [];
  const skillFile = basename(skill.path).toLowerCase();

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    const ents = await listDir(dir);
    if (!ents) return;
    for (const e of ents.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDir) {
        if (depth < MAX_DEPTH) await walk(join(dir, e.name), rel, depth + 1);
      } else if (!(depth === 0 && e.name.toLowerCase() === skillFile)) {
        out.push(rel);
      }
    }
  }

  await walk(skill.dir, '', 0);
  return out;
}
