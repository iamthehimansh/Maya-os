/**
 * SkillManager — the live handle the CLI/TUI/tools share. OWNER: @skills.
 *
 * Holds the discovered skill set (project + global), re-discovers on demand, and
 * exposes everything the rest of the harness needs:
 *   • `section()`  → the "Available skills" block folded into the system prompt.
 *   • `load(name)` → a named skill's full SKILL.md + supporting-file list (the
 *                    `skill` tool's payload).
 *   • `add/search/remove` → the `/skills` command + `install_skill` tool actions.
 *
 * A skill is knowledge, never code: `load()` returns text, and nothing here ever
 * executes a skill's contents.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GLOBAL_SKILLS_DIR,
  SKILLS_DIR,
  discoverSkills,
  listSkillFiles,
} from './discovery.js';
import { installSkill, searchRegistry, type FetchImpl } from './install.js';
import type { LoadedSkill, Skill } from './types.js';

export interface SkillManagerOptions {
  /** Working directory — roots project `.skills/` discovery + installs. */
  cwd?: string;
  /** Override the global skills dir (tests). */
  globalDir?: string;
  /** Injected fetch for install/search (tests). */
  fetchImpl?: FetchImpl;
  /** Where `/skills add` writes. Default `<cwd>/.skills`. */
  installDir?: string;
}

export class SkillManager {
  private readonly cwd: string;
  private readonly globalDir: string;
  private readonly fetchImpl: FetchImpl | undefined;
  private readonly installDir: string;
  private skills: Skill[] = [];

  constructor(opts: SkillManagerOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.globalDir = opts.globalDir ?? GLOBAL_SKILLS_DIR;
    this.fetchImpl = opts.fetchImpl;
    this.installDir = opts.installDir ?? join(this.cwd, SKILLS_DIR);
  }

  /** Re-scan disk. Call at startup and after any add/remove. */
  async reload(): Promise<Skill[]> {
    this.skills = await discoverSkills({ cwd: this.cwd, globalDir: this.globalDir });
    return this.skills;
  }

  list(): Skill[] {
    return this.skills;
  }

  get(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  /** The "Available skills" system-prompt section (empty string when none). */
  section(): string {
    return renderSkillsSection(this.skills);
  }

  /** Load a named skill's full SKILL.md + supporting files. Re-scans first so a
   *  just-installed skill is loadable immediately. */
  async load(name: string): Promise<LoadedSkill | null> {
    let skill = this.get(name);
    if (!skill) {
      await this.reload();
      skill = this.get(name);
    }
    if (!skill) return null;
    let content: string;
    try {
      content = await readFile(skill.path, 'utf8');
    } catch {
      return null;
    }
    const files = await listSkillFiles(skill);
    return { skill, content, files };
  }

  /** Install `<owner/repo>` into the project `.skills/`, then re-discover. */
  async add(spec: string): Promise<string> {
    const res = await installSkill(spec, this.installDir, this.fetchImpl ? { fetchImpl: this.fetchImpl } : {});
    if (res.ok) await this.reload();
    return res.message;
  }

  /** Search the skills.sh registry; returns a formatted, installable listing. */
  async search(query: string): Promise<string> {
    const q = query.trim();
    if (!q) return 'Usage: /skills search <query>';
    try {
      const hits = await searchRegistry(q, this.fetchImpl ? { fetchImpl: this.fetchImpl } : {});
      if (hits.length === 0) return `No skills found for "${q}".`;
      const lines = [`Skills matching "${q}":`];
      for (const h of hits) {
        const installs = h.installs !== undefined ? `  ↓${h.installs}` : '';
        // `source` is the owner/repo that `/skills add` takes; fall back to id.
        const add = h.source || h.id;
        lines.push(`  • ${h.id}${installs}`);
        if (h.description) lines.push(`      ${h.description}`);
        lines.push(`      /skills add ${add}`);
      }
      return lines.join('\n');
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** Remove an installed skill by name (its folder or bare file). Re-discovers. */
  async remove(name: string): Promise<string> {
    const skill = this.get(name) ?? (await this.reload(), this.get(name));
    if (!skill) return `No installed skill named "${name}".`;
    // Delete the skill's own folder (dir skills) or just its file (bare skills).
    const target = skill.bare ? skill.path : skill.dir;
    try {
      await rm(target, { recursive: true, force: true });
    } catch (e) {
      return `Could not remove "${name}": ${e instanceof Error ? e.message : String(e)}`;
    }
    await this.reload();
    return `Removed skill "${name}".`;
  }
}

/**
 * Render the "Available skills" section injected into the system prompt. Lists
 * each skill's name + description (+ scope) so the model can decide when one
 * applies, and tells it to load the full instructions via the `skill` tool.
 * Empty skill set → '' (no section, no noise).
 */
export function renderSkillsSection(skills: readonly Skill[]): string {
  if (skills.length === 0) return '';
  const lines: string[] = [
    '# Available skills',
    'You have Agent Skills — reusable procedural knowledge you can pull in on demand. ' +
      'When a task matches a skill below, call the `skill` tool with its `name` to load ' +
      'the full instructions BEFORE proceeding. Install more with the `install_skill` tool.',
    '',
  ];
  for (const s of skills) {
    const when = s.whenToUse ? ` (use when: ${s.whenToUse})` : '';
    lines.push(`- **${s.name}** [${s.scope}]: ${s.description || '(no description)'}${when}`);
  }
  return lines.join('\n');
}

/** Human-readable listing for the `/skills` command (no arg). */
export function formatSkills(mgr: SkillManager): string {
  const skills = mgr.list();
  if (skills.length === 0) {
    return [
      'Skills — reusable procedural knowledge (Agent Skills, skills.sh-compatible).',
      '',
      '(none installed)',
      '',
      `Drop a skill in  ./${SKILLS_DIR}/<name>/SKILL.md  or  ~/.maya/.skills/`,
      'Install one:  /skills add <owner/repo>   ·   Search:  /skills search <query>',
    ].join('\n');
  }
  const lines = ['Skills — loaded into this session (the agent can `skill`-load any of these):', ''];
  for (const s of skills) {
    const icon = s.scope === 'global' ? '🌐' : '📁';
    lines.push(`  ${icon} ${s.name}  — ${s.description || '(no description)'}`);
  }
  lines.push('');
  lines.push(`Total: ${skills.length} skill(s).  /skills add <owner/repo> · search <q> · remove <name>`);
  return lines.join('\n');
}
