/**
 * Agent-facing skill tools. OWNER: @skills.
 *
 *   • `skill`         — load a named skill's full SKILL.md (+ its file list) into
 *                       context. The model calls this when a task matches a skill
 *                       surfaced in the "Available skills" prompt section.
 *   • `install_skill` — add a skill from skills.sh/GitHub (`owner/repo`) or search
 *                       the registry, so the agent can pull knowledge it needs.
 *
 * Both are auto-allowed: `skill` only READS declared skill files (knowledge, not
 * code — never executed), and `install_skill` writes only into `.skills/`.
 */
import { shortenPath } from '../memory/index.js';
import type { Tool, ToolResult } from '../types.js';
import type { SkillManager } from './manager.js';

/** `skill` — load a named skill's SKILL.md + supporting-file list into context. */
export function createSkillTool(mgr: SkillManager): Tool {
  return {
    spec: {
      name: 'skill',
      description:
        'Load an Agent Skill by name: returns its full SKILL.md instructions plus a ' +
        'list of its supporting files. Call this when a task matches one of the skills ' +
        'listed in "Available skills" — read the returned instructions and follow them. ' +
        'A skill is knowledge you read, never code that runs. Use the exact `name` shown.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The exact skill name to load (from "Available skills").' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    async run(input: unknown): Promise<ToolResult> {
      const rec = (input ?? {}) as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!name) return { content: 'missing required string "name"', isError: true };
      const loaded = await mgr.load(name);
      if (!loaded) {
        const avail = mgr.list().map((s) => s.name);
        return {
          content:
            `No skill named "${name}".` +
            (avail.length ? ` Available: ${avail.join(', ')}.` : ' No skills are installed.'),
          isError: true,
        };
      }
      const { skill, content, files } = loaded;
      const header = `# Skill: ${skill.name} (${shortenPath(skill.path)})`;
      const filesNote =
        files.length > 0
          ? `\n\n---\nSupporting files in this skill (read with the \`read\` tool relative to ${shortenPath(skill.dir)}):\n${files.map((f) => `  - ${f}`).join('\n')}`
          : '';
      return { content: `${header}\n\n${content}${filesNote}` };
    },
  };
}

/** `install_skill` — add (`owner/repo`) or search skills from the skills.sh registry. */
export function createInstallSkillTool(mgr: SkillManager): Tool {
  return {
    spec: {
      name: 'install_skill',
      description:
        'Install or find Agent Skills. action="add" installs a skill from GitHub/skills.sh ' +
        '(query = "owner/repo") into ./.skills/ so it becomes available to load. ' +
        'action="search" searches the skills.sh registry (query = keywords) and returns ' +
        'installable results. Use when you need procedural knowledge you do not yet have.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'search'], description: 'add | search' },
          query: { type: 'string', description: 'For add: "owner/repo". For search: keywords.' },
        },
        required: ['action', 'query'],
        additionalProperties: false,
      },
    },
    async run(input: unknown): Promise<ToolResult> {
      const rec = (input ?? {}) as Record<string, unknown>;
      const action = typeof rec.action === 'string' ? rec.action : '';
      const query = typeof rec.query === 'string' ? rec.query.trim() : '';
      if (!query) return { content: 'missing required string "query"', isError: true };
      if (action === 'add') return { content: await mgr.add(query) };
      if (action === 'search') return { content: await mgr.search(query) };
      return { content: `Unknown action "${action}". Use add | search.`, isError: true };
    },
  };
}
