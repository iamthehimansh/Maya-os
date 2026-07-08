#!/usr/bin/env node
/**
 * End-to-end WORK test — proves a spawned agent does real tool-use, not just
 * chat. Spawns a worker with file tools, @mentions it with a write task, and
 * verifies BOTH: (a) the file exists on disk with EXACT required content, and
 * (b) the agent reported back on the bus.
 *
 *   node scripts/work-test.mjs [model] [timeoutSec]
 *
 * HONEST GATE: the file's whole content must EQUAL the required string — never
 * a substring match (a buried marker is not success). Exits 0 only if the file
 * is exactly right AND the agent spoke on the channel.
 */
import { MayaClient } from "../packages/mcp/dist/client.js";
import os from "node:os";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MODEL = process.argv[2] ?? "local/qwen2.5-7b-instruct";
const TIMEOUT_S = Number(process.argv[3] ?? 180);
const ORCH = process.env.MAYA_ORCHESTRATOR_URL ?? "http://127.0.0.1:4400";
const GW = process.env.MAYA_GATEWAY_URL ?? "http://127.0.0.1:4100";
const DASH = process.env.MAYA_DASHBOARD_URL ?? "http://127.0.0.1:4200";
const HANDLE = "@builder";
const cwd = join(os.homedir(), "maya-worktest");
const FILE = "NOTE.md";
const MARKER = `MAYA_WORKS_${Date.now().toString(36)}`; // unique per run

const j = async (url, init) => {
  const r = await fetch(url, init);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b).slice(0, 200)}`);
  return b;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });

  const team = await j(`${ORCH}/api/teams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "work-test", members: [{ model: MODEL, cwd }] }),
  });
  const teamId = team.id ?? team.teamId;
  const channelId = team.channelId ?? `maya/team/${teamId}`;
  console.log(`team=${teamId}  cwd=${cwd}  marker=${MARKER}`);

  const client = new MayaClient({ orchestratorUrl: ORCH, gatewayUrl: GW, teamId });
  await client.spawnAgent({
    handle: HANDLE,
    type: "claude-code",
    model: MODEL,
    cwd,
    // Real work tools — enough to write a file, small enough to stay fast.
    allowedTools: ["Write", "Edit", "Read"],
    systemPrompt:
      "You are @builder, a worker. When given a task, DO it with your tools, then reply with one short line reporting what you did. Be terse.",
  });
  console.log(`spawned ${HANDLE}`);
  await sleep(2500);

  const task = `${HANDLE} Create a file named ${FILE} in your working directory whose entire content is exactly this one line and nothing else:\n${MARKER}\nThen reply: DONE`;
  await j(`${ORCH}/api/teams/${encodeURIComponent(teamId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: task }),
  });
  console.log(`posted write task — watching disk + bus (${TIMEOUT_S}s)…`);

  const enc = encodeURIComponent(channelId);
  const path = join(cwd, FILE);
  let fileOk = false;
  let agentSpoke = false;
  const ticks = Math.ceil(TIMEOUT_S / 5);
  for (let i = 0; i < ticks; i++) {
    await sleep(5000);
    // (a) disk — HONEST exact-content gate
    if (!fileOk && existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      fileOk = content === MARKER; // whole-file equality, NOT includes()
      if (existsSync(path) && !fileOk) console.log(`  file exists but content mismatch: "${content.slice(0, 40)}"`);
    }
    // (b) bus — did the agent report?
    try {
      const hist = await j(`${DASH}/api/channels/${enc}/history?limit=40`);
      agentSpoke = (hist.messages ?? []).some((m) => String(m.from ?? "") === HANDLE);
    } catch {
      /* dashboard blip */
    }
    if (fileOk && agentSpoke) {
      console.log(`\n✅ WORK DONE at t≈${(i + 1) * 5}s — file exact + agent reported on the bus`);
      break;
    }
    if (i % 3 === 2) console.log(`  …t=${(i + 1) * 5}s  file=${fileOk ? "✓" : "…"} spoke=${agentSpoke ? "✓" : "…"}`);
  }

  await client.stopAgent(HANDLE).catch(() => {});
  if (!(fileOk && agentSpoke)) {
    console.log(`\n❌ incomplete — file=${fileOk} agentSpoke=${agentSpoke}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("test error:", e.message);
  process.exit(2);
});
