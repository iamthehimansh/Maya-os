#!/usr/bin/env node
/**
 * End-to-end reply-execution test (the "does a spawned agent actually talk back"
 * check). Spawns a worker via the MCP client, @mentions it on the team channel,
 * and watches the bus for its reply. Exits 0 on PONG, 1 on timeout.
 *
 *   node scripts/pong-test.mjs [model] [timeoutSec]
 *
 * Deliberately self-contained: creates its own team + cwd, cleans up the agent.
 * Re-runnable — used to confirm the wake-execution loop after the bridge fix.
 */
import { MayaClient } from "../packages/mcp/dist/client.js";
import os from "node:os";
import { mkdirSync, rmSync } from "node:fs";

const MODEL = process.argv[2] ?? "local/qwen2.5-7b-instruct";
const TIMEOUT_S = Number(process.argv[3] ?? 180);
const ORCH = process.env.MAYA_ORCHESTRATOR_URL ?? "http://127.0.0.1:4400";
const GW = process.env.MAYA_GATEWAY_URL ?? "http://127.0.0.1:4100";
const DASH = process.env.MAYA_DASHBOARD_URL ?? "http://127.0.0.1:4200";
const HANDLE = "@ponger";
const cwd = os.homedir() + "/maya-demo";

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

  // 1. team + channel
  const team = await j(`${ORCH}/api/teams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "pong-test", members: [{ model: MODEL, cwd }] }),
  });
  const teamId = team.id ?? team.teamId;
  const channelId = team.channelId ?? team.channel_id ?? `maya/team/${teamId}`;
  console.log(`team=${teamId} channel=${channelId} model=${MODEL}`);

  // 2. spawn @ponger via the MCP client (the lead's real path)
  const client = new MayaClient({ orchestratorUrl: ORCH, gatewayUrl: GW, teamId });
  const spawned = await client.spawnAgent({
    handle: HANDLE,
    type: "claude-code",
    model: MODEL,
    cwd,
    allowedTools: ["Read"],
    systemPrompt: "You are @ponger. Reply to any message with exactly: PONG. Nothing else.",
  });
  console.log(`spawned ${HANDLE}: ${JSON.stringify(spawned).slice(0, 120)}`);
  await sleep(2500); // let the bridge join the channel

  // 3. @mention it (tests the real wake-on-@tag path, not directed routing)
  await j(`${ORCH}/api/teams/${encodeURIComponent(teamId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `${HANDLE} reply with exactly: PONG` }),
  });
  console.log(`posted @mention — watching for reply (${TIMEOUT_S}s)…`);

  // 4. watch the channel history for @ponger's reply
  const enc = encodeURIComponent(channelId);
  const ticks = Math.ceil(TIMEOUT_S / 5);
  let got = false;
  for (let i = 0; i < ticks; i++) {
    await sleep(5000);
    let hist;
    try {
      hist = await j(`${DASH}/api/channels/${enc}/history?limit=40`);
    } catch {
      continue;
    }
    for (const m of hist.messages ?? []) {
      const from = String(m.from ?? "");
      const text = String((m.body ?? {}).text ?? "");
      // \bpong\b avoids matching "pong" inside the handle "@ponger".
      if ((from === HANDLE || from.includes("ponger")) && /\bpong\b/i.test(text)) {
        console.log(`\n✅ PONG at t≈${(i + 1) * 5}s: ${from} :: ${text.slice(0, 80)}`);
        got = true;
        break;
      }
    }
    if (got) break;
    if (i % 3 === 2) console.log(`  …still waiting (${(i + 1) * 5}s)`);
  }

  // 5. clean up
  await client.stopAgent(HANDLE).catch(() => {});
  if (!got) console.log(`\n❌ no PONG in ${TIMEOUT_S}s — reply-execution still broken`);
  process.exit(got ? 0 : 1);
}

main().catch((e) => {
  console.error("test error:", e.message);
  process.exit(2);
});
