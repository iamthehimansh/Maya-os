/**
 * Skills — shared types. OWNER: @skills.
 *
 * A `Skill` is a piece of reusable procedural knowledge (an Agent Skill, à la
 * Anthropic Skills / skills.sh). It is discovered on disk, its metadata is
 * surfaced to the model in the system prompt, and its full `SKILL.md` is loaded
 * on demand via the `skill` tool. A skill is NEVER executed as code.
 */

export type SkillScope = 'project' | 'global';

export interface Skill {
  /** Unique identifier from frontmatter `name` (falls back to the folder/file name). */
  name: string;
  /** One-line description from frontmatter — surfaced to the model for discovery. */
  description: string;
  /** Optional extra trigger guidance (`when-to-use` frontmatter). */
  whenToUse?: string;
  /** Optional SPDX-ish license string from frontmatter. */
  license?: string;
  /** project (`./.skills/`) or global (`~/.maya/.skills/`). */
  scope: SkillScope;
  /** Absolute path to the skill's `SKILL.md` (or bare `.md`) file. */
  path: string;
  /** Directory the skill lives in (its own folder, or the skills root for a bare file). */
  dir: string;
  /**
   * True for a bare `SKILL.md`/`*.md` sitting directly in a skills root (no own
   * folder). Bare skills have no supporting files; folder skills may.
   */
  bare: boolean;
}

/** A skill loaded into context: its full SKILL.md body + supporting file list. */
export interface LoadedSkill {
  skill: Skill;
  /** Full SKILL.md text (frontmatter included, so the model sees name/description). */
  content: string;
  /** Supporting files bundled with the skill, relative to its dir (folder skills only). */
  files: string[];
}
