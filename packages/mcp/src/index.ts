import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MayaClient, type MayaClientConfig } from "./client.js";

/**
 * Maya's MCP server — the tools the loop Lead (a Claude Code agent) calls to
 * grow + steer its team. Injected into the lead's `--mcp-config`. Config comes
 * from env when the lead is spawned: MAYA_ORCHESTRATOR_URL / MAYA_GATEWAY_URL /
 * MAYA_TEAM_ID. Each tool is a thin proxy to Maya's own HTTP APIs.
 */

const AGENT_TYPES = ["claude-code", "codex", "opencode"] as const;

const text = (s: string): { content: Array<{ type: "text"; text: string }> } => ({ content: [{ type: "text", text: s }] });

export function buildServer(client: MayaClient): McpServer {
  const server = new McpServer({ name: "maya", version: "0.0.1" });

  server.tool(
    "spawn_agent",
    "Spawn a new agent into your team. Pick a tool-capable model for workers that must edit files.",
    {
      handle: z.string().describe("addressable handle, e.g. @backend"),
      type: z.enum(AGENT_TYPES).describe("coding-agent type"),
      model: z.string().describe('gateway ModelId, e.g. "local/qwen2.5-7b-instruct"'),
      cwd: z.string().describe("working directory for the agent"),
      role: z.enum(["lead", "worker"]).optional(),
      systemPrompt: z.string().optional().describe("persona/instructions"),
      allowedTools: z.array(z.string()).optional().describe("tool scope YOU grant this agent, e.g. [\"Write\",\"Edit\",\"Bash\"]"),
      allowAllTools: z.boolean().optional().describe("give the agent ALL tools (full freedom) — overrides allowedTools"),
    },
    async (args) => {
      try {
        const agent = {
          handle: args.handle,
          type: args.type,
          model: args.model,
          cwd: args.cwd,
          ...(args.role ? { role: args.role } : {}),
          ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
          ...(args.allowAllTools ? { allowedTools: ["*"] } : args.allowedTools ? { allowedTools: args.allowedTools } : {}),
        };
        const r = await client.spawnAgent(agent);
        return text(`spawned ${args.handle} (${args.type} on ${args.model}) — ${JSON.stringify(r)}`);
      } catch (e) {
        return text(`spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool("list_agents", "List the agents currently in your team.", {}, async () => {
    try {
      return text(JSON.stringify(await client.listAgents()));
    } catch (e) {
      return text(`list failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  server.tool("list_models", "List models you can assign to agents (prefer toolCalling=true for workers).", {}, async () => {
    try {
      const models = await client.listModels();
      return text(JSON.stringify(models.map((m) => ({ id: m.id, toolCalling: m.toolCalling ?? null }))));
    } catch (e) {
      return text(`list failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  server.tool("stop_agent", "Retire a worker from your team.", { handle: z.string() }, async ({ handle }) => {
    try {
      await client.stopAgent(handle);
      return text(`stopped ${handle}`);
    } catch (e) {
      return text(`stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  server.tool(
    "send_to",
    "Send a direct message to a teammate agent (wakes it on the bus).",
    { handle: z.string(), text: z.string() },
    async ({ handle, text: msg }) => {
      try {
        await client.sendTo(handle, msg);
        return text(`sent to ${handle}`);
      } catch (e) {
        // Graceful: if direct-send isn't wired, the lead just @mentions in the
        // shared channel (the primary wake mechanism anyway).
        return text(`direct send unavailable (${e instanceof Error ? e.message : e}). Instead, @mention ${handle} in the team channel — the monitor wakes them.`);
      }
    },
  );

  server.tool(
    "send_message",
    "Post a message to your team channel NOW — everyone (including the human) sees it. Use this to talk to the human on your own initiative, report progress, or send several messages in a row (sleep between them with your Bash tool for timed sends, e.g. 'hello' every 5s).",
    { text: z.string() },
    async ({ text: msg }) => {
      try {
        await client.sendMessage(msg);
        return text("posted to the channel");
      } catch (e) {
        return text(`post failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    "schedule_message",
    "Schedule a message to post to your team channel AFTER a delay (seconds). Use this to ping the human PROACTIVELY later or set a reminder — the orchestrator holds the timer, so it fires even after your current turn ends. `to` optionally directs it at a handle.",
    { delaySeconds: z.number().min(1).max(86400), text: z.string(), to: z.string().optional() },
    async ({ delaySeconds, text: msg, to }) => {
      try {
        await client.scheduleMessage(delaySeconds, msg, to);
        return text(`scheduled in ${delaySeconds}s`);
      } catch (e) {
        return text(`schedule unavailable (${e instanceof Error ? e.message : e}) — post now with send_message instead.`);
      }
    },
  );

  return server;
}

/** Read config from env (set by the orchestrator when it spawns the lead). */
export function configFromEnv(): MayaClientConfig {
  return {
    orchestratorUrl: process.env.MAYA_ORCHESTRATOR_URL ?? "http://127.0.0.1:4400",
    gatewayUrl: process.env.MAYA_GATEWAY_URL ?? "http://127.0.0.1:4100",
    teamId: process.env.MAYA_TEAM_ID ?? "",
  };
}

export async function main(): Promise<void> {
  const server = buildServer(new MayaClient(configFromEnv()));
  await server.connect(new StdioServerTransport());
}

export { MayaClient } from "./client.js";
