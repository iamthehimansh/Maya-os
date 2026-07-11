/**
 * Sub-agents — public surface. OWNER: @agents.
 *
 * Two features live here:
 *   9.  Sub-agents — a `spawn_agent` tool + `/agent` command (foreground wait or
 *       background handle, several at once, labeled "sub-agent").
 *   10. Workflow scripting — see `../workflow`.
 *
 * @core integration (cli.ts / loop wiring):
 *   1. Build a `SubSessionFactory` from the base loop config whose toolset is the
 *      full merged set MINUS `spawn_agent` (so sub-agents can't recurse):
 *        const subTools = registry.list().filter(t => t.spec.name !== 'spawn_agent');
 *        const makeSubSession = (o) => createSession({ ...base, tools: o?.tools ?? subTools });
 *   2. const { tools, registry, runForeground } = createAgentTools({
 *        makeSubSession,
 *        startBackground: (prompt, job, o) =>            // wire background → /tasks
 *          ({ id: tasks.register(o?.label ?? prompt, async (s) => (await job(s)).text).id }),
 *      });
 *      toolRegistry.registerAll(tools);                  // adds spawn_agent
 *   3. `/agent <prompt>` → runForeground(prompt) and print the result.
 *   4. `mayac --workflow <file>` → runWorkflowFile(file, { agent: makeWorkflowAgent(makeSubSession), log }).
 *
 * If `startBackground` is omitted, background sub-agents use the internal
 * `AgentRegistry` returned above (inspectable, but not in the bash `/tasks` view).
 */
export {
  runSubAgent,
  promptPreview,
  type SubAgentResult,
  type SubSessionFactory,
} from './sub-agent.js';
export {
  createAgentTools,
  type AgentTools,
  type AgentToolsConfig,
  type StartBackground,
} from './spawn-tool.js';
export {
  createAgentRegistry,
  type AgentRegistry,
  type AgentTask,
  type AgentStatus,
  type AgentJob,
} from './registry.js';
export { subAgentRegistry } from './sub-registry.js';
