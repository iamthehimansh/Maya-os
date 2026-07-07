// Live smoke: spawn a REAL Claude Code one-shot agent on a local GGUF through
// the Maya gateway via the adapter. Gated: needs `maya serve` on :4100 and the
// claude CLI. Run: node test/smoke.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../dist/adapters/claude-code.js';

const GATEWAY = process.env.MAYA_GATEWAY ?? 'http://127.0.0.1:4100';
const MODEL = process.env.MAYA_SMOKE_MODEL ?? 'local/qwen2.5-0.5b-instruct';

const health = await fetch(`${GATEWAY}/api/runtime/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
if (!health?.ok) {
  console.log(`SKIP — gateway not reachable at ${GATEWAY} (start \`maya serve\` first)`);
  process.exit(0);
}

const adapter = new ClaudeCodeAdapter({ gatewayBaseUrl: GATEWAY });
const detect = await adapter.detect();
console.log('1) detect:', JSON.stringify(detect));
if (!detect.installed) {
  console.log('SKIP — claude CLI not installed');
  process.exit(0);
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-agent-smoke-'));
console.log('2) spawn one-shot agent on', MODEL, 'cwd', cwd);
const handle = await adapter.spawn({
  adapter: 'claude-code',
  model: MODEL,
  cwd,
  prompt: 'Use the Write tool to create hello.txt with exactly this content: MAYA-AGENT-OK',
  permissionMode: 'auto',
  // Scoped like a real Loop worker: tiny tool surface + turn cap so a 0.5B
  // model cannot wander into tool-hallucination loops.
  options: { allowedTools: ['Write'], maxTurns: 4 },
});
assert(handle.pid, 'agent has a pid');
console.log('   handle:', handle.id, 'pid', handle.pid, 'state', handle.state);

console.log('3) tail events until terminal');
let sawTokens = false;
const deadline = setTimeout(() => {
  console.error('TIMEOUT waiting for agent to finish');
  adapter.kill(handle.id).finally(() => process.exit(1));
}, 300_000);
for await (const ev of adapter.events(handle.id)) {
  if (ev.kind === 'log') console.log(`   [${ev.stream}] ${ev.line.slice(0, 120)}`);
  if (ev.kind === 'tokens') {
    sawTokens = true;
    console.log(`   [tokens] in=${ev.input} out=${ev.output}`);
  }
  if (ev.kind === 'state') console.log(`   [state] ${ev.state}`);
}
clearTimeout(deadline);

const final = await adapter.status(handle.id);
console.log('4) final state:', final.state, 'exitCode:', final.exitCode);
assert(final.state === 'exited', `agent exited cleanly (got ${final.state})`);
assert(sawTokens, 'token usage reported');

const produced = fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8').trim();
console.log('5) artifact check: hello.txt =', JSON.stringify(produced));
assert(produced.includes('MAYA-AGENT-OK'), 'agent actually created the file with the right content');

const logs = await adapter.logs(handle.id, { tail: 5 });
assert(logs.length > 0, 'logs retrievable');

console.log('\nAGENT SMOKE PASS ✅ (real Claude Code on local GGUF via the adapter)');
process.exit(0);
