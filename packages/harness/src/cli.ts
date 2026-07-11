#!/usr/bin/env node
/**
 * maya-harness CLI. OWNER: @architect.
 *
 * TUI by default; `-p/--print "<prompt>"` runs headless. Resolves auth, builds a
 * provider + session, and dispatches. Flags:
 *   --provider <anthropic|openai>   pick provider (default: anthropic)
 *   --model <id>                    override model
 *   --auth <api|subscription>       force auth mode (default: auto-detect)
 *   --cwd <dir>                     working directory (default: process.cwd())
 *   -p, --print "<prompt>"          headless: run one prompt, print, exit
 *   --yolo                          auto-allow all gated actions (write/bash)
 *   -h, --help                      usage
 */
import { PROVIDER_CATALOG, createProvider } from './providers/index.js';
import { resolveAuth } from './auth/index.js';
import { createSession } from './loop/index.js';
import { builtinTools, createToolRegistry } from './tools/index.js';
import { fileMonitorTool } from './tools/monitor.js';
import { tasksTool } from './tools/tasks-tool.js';
import { createCronScheduler, fileCronStore, cronTool } from './tools/cron.js';
import { createMcpHub, formatMcpServers, mcpConnectTool, mcpAddHandler, mcpRemoveHandler } from './mcp/index.js';
import { createContextManager, createCompactTool } from './context/index.js';
import { rememberTool, memoryTool, editMemory } from './memory/index.js';
import { createAgentTools, subAgentRegistry } from './agents/index.js';
import {
  createSkillManager,
  createSkillTool,
  createInstallSkillTool,
  skillsStatusHandler,
  skillsAddHandler,
  skillsSearchHandler,
  skillsRemoveHandler,
} from './skills/index.js';
import { runWorkflowFile, makeWorkflowAgent } from './workflow/index.js';
import type { SubSessionFactory } from './agents/sub-agent.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { runTui } from './tui/index.js';
import { TuiPermissionGate } from './tui/permission.js';
import { messagesToEntries } from './tui/transcript.js';
import { createTaskRunner } from './tasks/index.js';
import { createSessionStore, createCommandHistory, type SessionRecord } from './session/index.js';
import type { AuthMode, PermissionGate, PermissionRequest, ProviderId, Tool, ToolRegistry } from './types.js';

interface Args {
  provider: ProviderId;
  model?: string;
  auth?: AuthMode;
  cwd: string;
  print?: string;
  yolo: boolean;
  help: boolean;
  /** Reload a specific session id, or open the resume picker when `true`. */
  resume?: string | true;
  /** Continue the most recently updated session. */
  continue: boolean;
  /** Run a workflow script that orchestrates sub-agents, then exit. */
  workflow?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { provider: 'anthropic', cwd: process.cwd(), yolo: false, help: false, continue: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--provider': { const v = next(); if (v) a.provider = v as ProviderId; break; }
      case '--model': { const v = next(); if (v) a.model = v; break; }
      case '--auth': { const v = next(); if (v) a.auth = v as AuthMode; break; }
      case '--cwd': { const v = next(); if (v) a.cwd = v; break; }
      case '-p': case '--print': { const v = next(); if (v !== undefined) a.print = v; break; }
      case '--yolo': a.yolo = true; break;
      case '--resume': {
        // Optional id: `--resume <id>` reloads it; bare `--resume` opens the picker.
        const peek = argv[i + 1];
        if (peek && !peek.startsWith('-')) { a.resume = peek; i++; } else a.resume = true;
        break;
      }
      case '--continue': case '-c': a.continue = true; break;
      case '--workflow': { const v = next(); if (v) a.workflow = v; break; }
      case '-h': case '--help': a.help = true; break;
      default:
        if (arg && !arg.startsWith('-') && a.print === undefined) a.print = arg;
    }
  }
  return a;
}

const USAGE = `mayac — maya code, Maya's coding-agent harness

Usage:
  mayac [options]                 start the interactive TUI
  mayac -p "<prompt>" [options]   run one prompt headless

Options:
  --provider <anthropic|openai>   provider (default: anthropic)
  --model <id>                    model override
  --auth <api|subscription>       auth mode (default: auto-detect)
  --cwd <dir>                     working directory
  -p, --print "<prompt>"          headless one-shot
  --workflow <script.js>          run a sub-agent workflow script, then exit
  --resume [id]                   reload a past session (no id = picker)
  -c, --continue                  continue the most recent session
  --yolo                          auto-allow writes/bash (no prompts)
  -h, --help                      show this help`;

/** Headless gate: allow reads, deny gated actions unless --yolo. */
function headlessGate(yolo: boolean): PermissionGate {
  return {
    async request(req: PermissionRequest) {
      if (yolo) return true;
      process.stderr.write(`[permission] denied ${req.tool}: ${req.summary} (pass --yolo to allow)\n`);
      return false;
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }

  const info = PROVIDER_CATALOG[args.provider];
  if (!info) { console.error(`Unknown provider: ${args.provider}`); process.exitCode = 1; return; }

  const headless = args.print !== undefined;

  // Resolve a session to reload for --continue / --resume <id> (picker handled in-TUI).
  const store = createSessionStore();
  let preload: SessionRecord | null = null;
  if (!headless && args.continue) preload = await store.latest();
  else if (!headless && typeof args.resume === 'string') preload = await store.load(args.resume);

  // A reloaded session may carry a provider that isn't in this build's catalog —
  // validate the EFFECTIVE provider, not just `--provider`, before we use it.
  const providerId = preload?.provider ?? args.provider;
  const providerInfo = PROVIDER_CATALOG[providerId];
  if (!providerInfo) { console.error(`Unknown provider: ${providerId}`); process.exitCode = 1; return; }
  const model = args.model ?? preload?.model ?? providerInfo.defaultModel;

  const cred = await resolveAuth(providerId, args.auth);
  const provider = createProvider(providerId, cred);
  const authMode: AuthMode = cred.kind === 'api' ? 'api' : 'subscription';
  // The TUI drives permission prompts interactively; headless allows reads and
  // denies gated actions unless --yolo.
  const gate = headless ? null : new TuiPermissionGate({ autoAllow: args.yolo });
  const permission: PermissionGate = gate ?? headlessGate(args.yolo);

  // One runner for the whole process: the bash tool backgrounds into it and the
  // TUI's /tasks view reads from it. Created before the session so tools can use it.
  const tasks = createTaskRunner(args.cwd);

  // Context/memory hook (items 7-8): base prompt + global (~/.mayac) & per-project
  // (MAYAC.md, discovered cwd-upward) memory, plus auto-compaction near the token
  // limit. The loop calls assembleSystem()/assembleContext() every turn.
  const context = createContextManager({ basePrompt: SYSTEM_PROMPT, cwd: args.cwd });
  await context.load();

  // Skills (Agent Skills, skills.sh-compatible): discover from `./.skills/`
  // (cwd-upward) + `~/.maya/.skills/`, surface each skill's name+description in the
  // system prompt, and give the agent `skill` (load) + `install_skill` (add/search)
  // tools. Discovery is at startup; a runtime `/skills add` becomes loadable
  // immediately via the `skill` tool (which re-scans). The section rides on the
  // SESSION's systemPrompt (the loop passes that as the base to assembleSystem),
  // so memory still folds in on top.
  const skills = await createSkillManager({ cwd: args.cwd });
  const skillsSection = skills.section();
  const systemPrompt = skillsSection ? `${SYSTEM_PROMPT}\n\n${skillsSection}` : SYSTEM_PROMPT;

  // Shared, live tool registry: built-ins + memory's `remember` tool + the skill
  // tools. MCP, cron, file-monitor, and spawn_agent register into this SAME
  // instance below; the loop reads registry.list() on every turn so late arrivals
  // (MCP) are picked up.
  const registry = createToolRegistry([
    ...builtinTools(),
    rememberTool,
    memoryTool,
    createSkillTool(skills),
    createInstallSkillTool(skills),
  ]);

  const session = createSession({
    provider,
    providerId,
    model,
    systemPrompt,
    tools: registry.list(),
    registry,
    context,
    cwd: args.cwd,
    permission,
    authMode,
    authSource: cred.source,
    tasks,
  });

  // The agent-side `compact` tool drives the SAME compaction as `/compact`
  // (session.compact()), returning before/after token counts. Registered after
  // the session exists so it can close over it.
  registry.register(createCompactTool(session));

  // A live view of the shared registry MINUS spawn_agent: sub-agents pick up
  // tools registered after they start (e.g. a late-connecting MCP server) yet can
  // never see/call spawn_agent, so they can't recurse. (@agents' shared helper.)
  // Also hide `compact`: it's bound to the MAIN session, so a sub-agent must not
  // reach it and compact its parent's transcript (composed exclude → both hidden).
  const NO_SPAWN = 'spawn_agent';
  const subRegistry: ToolRegistry = subAgentRegistry(subAgentRegistry(registry, 'compact'));

  // ── Sub-agents (item 9): a fresh session sharing provider/model/auth, with the
  // full toolset MINUS spawn_agent so a sub-agent can't recurse. A caller-supplied
  // `tools` snapshot wins; otherwise the sub-session reads the live subRegistry. ──
  const makeSubSession: SubSessionFactory = (opts) => {
    const cfg = {
      provider,
      providerId,
      model,
      systemPrompt: opts?.systemPrompt ?? systemPrompt,
      context,
      cwd: args.cwd,
      permission,
      authMode,
      authSource: cred.source,
      tasks,
    };
    if (opts?.tools) {
      const subTools: Tool[] = opts.tools.filter((t) => t.spec.name !== NO_SPAWN);
      return createSession({ ...cfg, tools: subTools });
    }
    // No explicit toolset → live-filtered shared registry (picks up late MCP tools).
    return createSession({ ...cfg, tools: subRegistry.list(), registry: subRegistry });
  };
  const agentTools = createAgentTools({
    makeSubSession,
    // Background sub-agents run as in-process TaskRunner jobs → visible in /tasks.
    startBackground: (prompt, job, o) => ({
      id: tasks.register(o?.label ?? prompt, async (s) => (await job(s)).text).id,
    }),
  });
  registry.registerAll(agentTools.tools);

  // File-monitor (item 12) + cron/schedule (item 13). Registering cronTool doesn't
  // arm timers — cron.start() (below, non-workflow only) does.
  registry.register(fileMonitorTool);
  // Tasks tool: lets the model list/kill its own background jobs (reads ctx.tasks).
  registry.register(tasksTool);
  const cron = createCronScheduler({ store: fileCronStore(), onFire: (msg) => session.inject(msg) });
  registry.register(cronTool(cron));

  // ── Workflow mode (item 10): run a script that orchestrates sub-agents, then
  // exit. Timers/MCP are NOT armed here so the process can exit cleanly. ──
  if (args.workflow) {
    const result = await runWorkflowFile(args.workflow, {
      agent: makeWorkflowAgent(makeSubSession),
      log: (m) => process.stderr.write(`[workflow] ${m}\n`),
    });
    if (result !== undefined) {
      process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`);
    }
    return;
  }

  // Arm persisted cron schedules (fires overdue ones → session.inject).
  await cron.start();

  // ── MCP client (item 11): bridge configured servers' tools in. Fire-and-forget
  // connect so a slow/unreachable server never blocks startup; each server's tools
  // register live via onTools as it connects. `onRemoveTools` unregisters a
  // server's tools when it's disconnected at runtime (/mcp remove, mcp_connect). ──
  const hub = await createMcpHub({
    cwd: args.cwd,
    onTools: (ts) => registry.registerAll(ts),
    onRemoveTools: (names) => { for (const n of names) registry.unregister(n); },
  });
  void hub.connect();
  // Agent-side runtime MCP control (connect/list/disconnect servers mid-session).
  registry.register(mcpConnectTool(hub));
  // Slash handlers the TUI consumes as props (/mcp add <spec>, /mcp remove <name>).
  const mcpAdd = mcpAddHandler(hub);
  const mcpRemove = mcpRemoveHandler(hub);

  // Tear down timers + MCP sockets on exit so the process doesn't hang.
  const cleanup = async () => {
    cron.stop();
    await hub.close().catch(() => {});
  };

  if (preload) session.loadMessages(preload.messages);

  if (headless) {
    // Headless: stream one turn to stdout, then exit.
    for await (const ev of session.run(args.print ?? '')) {
      if (ev.type === 'text_delta') process.stdout.write(ev.text);
      else if (ev.type === 'tool_call') process.stderr.write(`\n[tool] ${ev.name} ${JSON.stringify(ev.input)}\n`);
      else if (ev.type === 'tool_result') process.stderr.write(`[tool:done]${ev.isError ? ' (error)' : ''}\n`);
      else if (ev.type === 'error') process.stderr.write(`\n[error] ${ev.message}\n`);
      else if (ev.type === 'turn_end') {
        process.stdout.write('\n');
        const { inputTokens, outputTokens } = ev.usage;
        process.stderr.write(`[usage] in=${inputTokens} out=${outputTokens} $${ev.costUsd.toFixed(4)}\n`);
      }
    }
    await cleanup();
    return;
  }

  // Build the runtime services the full-screen TUI consumes.
  const history = createCommandHistory();
  await history.load();
  const rec = preload ?? store.create({ provider: providerId, model, cwd: args.cwd });
  const initialEntries = preload ? messagesToEntries(preload.messages) : undefined;

  await runTui({
    session,
    gate: gate!,
    tasks,
    store,
    history,
    sessionId: rec.id,
    cwd: args.cwd,
    // Memory + compaction manager powers `/memory`, `/compact`, and the context meter.
    context,
    // Slash-command handles: /agent runs a foreground sub-agent, /workflow runs a
    // script, /mcp shows the MCP server status.
    runAgent: agentTools.runForeground,
    runWorkflow: (file) =>
      runWorkflowFile(file, { agent: makeWorkflowAgent(makeSubSession), log: () => {} }),
    mcpStatus: () => formatMcpServers(hub.servers()),
    // `/mcp add <spec>` connects+persists a server live; `/mcp remove <name>` drops it.
    mcpAdd,
    mcpRemove,
    // `/skills` — list installed, add <owner/repo>, search <query>, remove <name>.
    skillsStatus: skillsStatusHandler(skills),
    skillsAdd: skillsAddHandler(skills),
    skillsSearch: skillsSearchHandler(skills),
    skillsRemove: skillsRemoveHandler(skills),
    // `/memory edit <old> => <new>` — safe find→replace on project memory (App reloads after).
    editMemory: async (find, replace) => {
      const path = await editMemory('project', find, replace, { cwd: args.cwd });
      return `memory updated (${path})`;
    },
    ...(args.print !== undefined ? { initialPrompt: args.print } : {}),
    ...(initialEntries ? { initialEntries } : {}),
    ...(args.resume === true ? { autoResume: true } : {}),
  });
  await cleanup();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
