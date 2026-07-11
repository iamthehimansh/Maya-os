/**
 * Tasks tool (agent-facing) — list + kill background tasks. OWNER: @tools.
 *
 * The `/tasks` slash view lets the USER see and kill background jobs; this gives
 * the MODEL the same reach over the jobs it started itself (a `spawn_agent
 * background:true` sub-agent, or a `bash background:true` command). It is backed
 * by the SAME `TaskRunner` the TUI reads — it takes the runner from
 * `ctx.tasks`, so no wiring beyond registering the tool. When the loop runs
 * without a runner (bare unit contexts) the tool reports that cleanly rather
 * than throwing.
 *
 *   tasks { action: "list" }            → every task, oldest first
 *   tasks { action: "kill", id: "bg2" } → SIGTERM a running task
 */
import type { BgStatus, BgTask } from '../tasks/index.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { errResult, optString, reqString } from './util.js';

/** Icon per status, mirroring the /tasks view's vocabulary. */
function icon(s: BgStatus): string {
  return s === 'running' ? '▶' : s === 'exited' ? '✓' : s === 'killed' ? '■' : '✗';
}

/** One-line summary of a task for the model. Never echoes full output (can be huge). */
function describe(t: BgTask): string {
  const dur = t.endedAt ? `${Math.max(0, Math.round((t.endedAt - t.startedAt) / 1000))}s` : 'running';
  const exit =
    t.status === 'exited' && t.exitCode !== null
      ? ` exit=${t.exitCode}`
      : t.signal
        ? ` signal=${t.signal}`
        : '';
  const cmd = t.command.length > 120 ? `${t.command.slice(0, 117)}…` : t.command;
  return `${icon(t.status)} ${t.id} [${t.status}${exit}] ${dur} — ${cmd}`;
}

export const tasksTool: Tool = {
  spec: {
    name: 'tasks',
    description:
      'View and kill your background tasks — the jobs YOU started via `spawn_agent background:true` or a backgrounded `bash` command. ' +
      'Actions: "list" shows every background task (id, status, exit/signal, elapsed, command); ' +
      '"kill" terminates a running task by id (SIGTERM, escalating to SIGKILL). ' +
      'Use it to check on long-running sub-agents/commands and stop ones you no longer need.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'kill'], description: 'What to do.' },
        id: { type: 'string', description: 'For "kill": the task id to terminate (e.g. "bg2").' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const runner = ctx.tasks;
      if (!runner) {
        return { content: 'No background task runner is available in this context.', isError: true };
      }
      const action = optString(input, 'action') ?? 'list';

      if (action === 'list') {
        const all = runner.list();
        if (all.length === 0) return { content: '(no background tasks)' };
        const running = runner.runningCount();
        const header = `${all.length} task${all.length === 1 ? '' : 's'} (${running} running):`;
        return { content: `${header}\n${all.map(describe).join('\n')}` };
      }

      if (action === 'kill') {
        const id = reqString(input, 'id');
        const task = runner.get(id);
        if (!task) return { content: `No task with id ${id}.`, isError: true };
        if (task.status !== 'running') {
          return { content: `Task ${id} is not running (status: ${task.status}); nothing to kill.` };
        }
        const killed = runner.kill(id);
        return { content: killed ? `Killed ${id}.` : `Could not kill ${id} (it may have just finished).` };
      }

      return errResult(new Error(`unknown action "${action}"`));
    } catch (e) {
      return errResult(e);
    }
  },
};
