/**
 * Skills — barrel + `/skills` command handlers. OWNER: @skills.
 *
 * The system:
 *   • discovery.ts — find skills in `./.skills/` (cwd-upward) + `~/.maya/.skills/`.
 *   • frontmatter.ts — parse SKILL.md YAML frontmatter.
 *   • manager.ts   — the live SkillManager + system-prompt section rendering.
 *   • install.ts   — install from GitHub / search the skills.sh registry.
 *   • tools.ts     — the agent's `skill` + `install_skill` tools.
 *
 * The `/skills` command handlers below mirror the `/mcp` wiring (each closes over
 * the manager) so the TUI consumes them as `skillsStatus/Add/Search/Remove` props.
 */
import { SkillManager, formatSkills } from './manager.js';

export type { Skill, LoadedSkill, SkillScope } from './types.js';
export type { Frontmatter } from './frontmatter.js';
export { parseFrontmatter } from './frontmatter.js';
export {
  discoverSkills,
  listSkillFiles,
  projectSkillsRoots,
  SKILLS_DIR,
  GLOBAL_SKILLS_DIR,
} from './discovery.js';
export { installSkill, searchRegistry, parseOwnerRepo, SKILLS_REGISTRY } from './install.js';
export type { InstallResult, SearchHit, FetchImpl } from './install.js';
export { SkillManager, renderSkillsSection, formatSkills } from './manager.js';
export type { SkillManagerOptions } from './manager.js';
export { createSkillTool, createInstallSkillTool } from './tools.js';

/**
 * Build + preload a SkillManager (discovers skills up front). The CLI passes the
 * result's `section()` into the system prompt and its tools into the registry.
 */
export async function createSkillManager(
  opts: import('./manager.js').SkillManagerOptions = {},
): Promise<SkillManager> {
  const mgr = new SkillManager(opts);
  await mgr.reload();
  return mgr;
}

// ───────────────────────────────────── /skills command handlers (TUI props) ──

/** `/skills` (no arg) — list installed skills. */
export function skillsStatusHandler(mgr: SkillManager): () => string {
  return () => formatSkills(mgr);
}

/** `/skills add <owner/repo>`. */
export function skillsAddHandler(mgr: SkillManager): (arg: string) => Promise<string> {
  return (arg: string) => mgr.add(arg);
}

/** `/skills search <query>`. */
export function skillsSearchHandler(mgr: SkillManager): (q: string) => Promise<string> {
  return (q: string) => mgr.search(q);
}

/** `/skills remove <name>`. */
export function skillsRemoveHandler(mgr: SkillManager): (name: string) => Promise<string> {
  return (name: string) => mgr.remove(name);
}
