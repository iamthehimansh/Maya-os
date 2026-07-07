// LIVE M3 DEMO: the full Maya loop, no test doubles anywhere —
//   LoopLead (LLM planner+verifier on a LOCAL model via Maya's gateway)
//     → TeamManager → REAL Claude Code workers on a LOCAL model
//     → bus visibility → verified artifacts on disk.
// Gated: needs the shared gateway on :4100 and the claude CLI.
// Run: node test/loop-live.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MayaDb } from '../../core/dist/index.js';
import { AgentBusBridge, AgentRuntime } from '../../agent-runtime/dist/index.js';
import { startBusServer } from '../../bus/dist/index.js';
import { LlmClient, LoopLead, TeamManager, makePlanner, makeVerifier } from '../dist/index.js';

const GATEWAY = process.env.MAYA_GATEWAY ?? 'http://127.0.0.1:4100';
const LEAD_MODEL = process.env.MAYA_LEAD_MODEL ?? 'local/qwen2.5-coder-3b';
// Workers share the lead's model (and its loaded instance) — the 0.5B proved
// too weak to follow exact-filename instructions in the first live run.
const WORKER_MODEL = process.env.MAYA_WORKER_MODEL ?? "local/qwen2.5-0.5b-instruct"; // tools work on the 0.5B (boot-time sidecar config); 3B pending 002 fix

const health = await fetch(`${GATEWAY}/api/runtime/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
if (!health?.ok) {
  console.log(`SKIP — gateway not reachable at ${GATEWAY}`);
  process.exit(0);
}

console.log(`M3 LIVE: lead=${LEAD_MODEL} · workers=claude-code on ${WORKER_MODEL}`);

// In-process bus on an ephemeral port (never touches shared services).
const bus = await startBusServer({ dbPath: ':memory:', port: 0 });
const wsBase = `ws://127.0.0.1:${bus.port}`;
const adminToken = bus.bootstrapAdminToken.token;

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-m3-'));
console.log('workspace:', cwd);

const db = new MayaDb(':memory:');
const runtime = new AgentRuntime({ gatewayBaseUrl: GATEWAY });
const bridge = new AgentBusBridge({ wsBase, adminToken });
const teams = new TeamManager({ db, runtime, bridge, bus: { wsBase, adminToken } });
const llm = new LlmClient({ gatewayBaseUrl: GATEWAY, model: LEAD_MODEL });

const lead = new LoopLead({
  db,
  teams,
  team: {
    topology: 'manager-tree',
    members: [
      {
        adapter: 'claude-code',
        model: WORKER_MODEL,
        cwd,
        allowedTools: ['Write'],
        maxTurns: 4,
      },
    ],
    tokenBudget: 400_000,
  },
  planner: makePlanner(llm),
  verifier: makeVerifier(llm, { workspaceDir: cwd }), // judge REALITY, not worker claims
  bus: { wsBase, adminToken },
  questionTimeoutMs: 30_000,
  maxRework: 2, // weak workers get two sharpened retries — the verification gate at work
});

const GOAL =
  'Create exactly two files in the current directory: (1) slugify.mjs exporting `export function slugify(s)` that lowercases the string, trims it, and replaces runs of spaces with single dashes; (2) NOTES.md containing a one-line description of slugify and one usage example. Keep both files tiny.';

const started = Date.now();
const report = await lead.run(GOAL, { name: 'm3-demo' });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log('\n—— REPORT ——');
console.log('outcome:', report.outcome, `(${seconds}s, ${report.questionsAsked} question(s))`);
for (const t of report.tasks) console.log(` - [${t.state}${t.verified ? '·verified' : ''}] ${t.spec.slice(0, 70)}`);

const files = fs.readdirSync(cwd);
console.log('artifacts:', files.join(', ') || '(none)');

assert(report.outcome === 'success', `loop outcome ${report.outcome}`);
assert(files.includes('slugify.mjs'), 'slugify.mjs created');
const slug = fs.readFileSync(path.join(cwd, 'slugify.mjs'), 'utf8');
assert(/export\s+function\s+slugify/.test(slug), 'slugify.mjs exports the function');

await bus.close();
console.log(`\nM3 LIVE PASS ✅ — lead + workers, all local, ${seconds}s end-to-end`);
process.exit(0);
