/**
 * Live mid-turn steering probe (NOT part of `pnpm test` — run manually with real
 * creds, it makes real API calls). Proves the two things unit tests CANNOT:
 *   1. the real API ACCEPTS the injected message shape (a steer riding in the same
 *      user message as the tool_result blocks) — no 400 on tool_use pairing;
 *   2. the real model OBEYS it mid-turn — it abandons the path it was on.
 *
 * The model is told to call `ping` five times. After the FIRST tool result we
 * inject "stop calling ping; reply exactly STEERED". If steering works, it stops
 * early and says STEERED. If the steer only landed after the turn (today's bug),
 * it would call ping all five times first.
 *
 * Usage: node test/live-steer.mjs <anthropic-sub|openai-sub|anthropic-api|openai-api>
 * Prints only shapes/behavior, never tokens.
 */
import { resolveAuth } from '../dist/auth/index.js';
import { createProvider } from '../dist/providers/index.js';
import { createSession } from '../dist/loop/index.js';

const MAP = {
  'anthropic-sub': ['anthropic', 'subscription'],
  'anthropic-api': ['anthropic', 'api'],
  'openai-sub': ['openai', 'subscription'],
  'openai-api': ['openai', 'api'],
};
const [providerId, mode] = MAP[process.argv[2]] ?? [];
if (!providerId) {
  console.error('usage: node test/live-steer.mjs <anthropic-sub|openai-sub|anthropic-api|openai-api>');
  process.exit(2);
}

const cred = await resolveAuth(providerId, mode);
const provider = createProvider(providerId, cred);
const model = provider.models[0];
console.log(`\n▶ ${providerId} (${cred.kind}, ${cred.source}) · ${model}\n`);

let pings = 0;
let session;

const ping = {
  spec: { name: 'ping', description: 'Ping once. Returns pong.', inputSchema: { type: 'object', properties: {} } },
  async run() {
    pings++;
    // THE MOMENT THAT MATTERS: the user types while the tool is running.
    if (pings === 1) {
      session.inject('STOP. Do not call ping again. Reply with exactly: STEERED');
      console.log('  ⌨️  [user typed a steer mid-turn, during ping #1]');
    }
    return { content: 'pong' };
  },
};

session = createSession({
  provider,
  providerId,
  model,
  systemPrompt: 'You are a test agent. Follow the user instructions exactly.',
  tools: [ping],
  cwd: process.cwd(),
  permission: { request: async () => true },
  authMode: mode,
  authSource: cred.source,
  maxTurns: 12,
});

let text = '';
for await (const ev of session.run('Call the ping tool 5 times, one at a time, then say ALLDONE.')) {
  if (ev.type === 'tool_call') console.log(`  → tool_call: ${ev.name} (#${pings + 1})`);
  else if (ev.type === 'tool_result') console.log(`  ← tool_result: ${ev.output}`);
  else if (ev.type === 'injected') console.log(`  ⚡ INJECTED at:${ev.at} → "${ev.text}"`);
  else if (ev.type === 'text_delta') text += ev.text;
  else if (ev.type === 'error') console.log(`  ✖ error: ${ev.message}`);
  else if (ev.type === 'turn_end') console.log(`  ■ turn_end: ${ev.stopReason}`);
}

// The steer must ride in the SAME user message as the tool_result blocks.
const boundary = session.messages.find(
  (m) => m.content.some((b) => b.type === 'tool_result') && m.content.some((b) => b.type === 'text'),
);

console.log(`\n  final text: ${JSON.stringify(text.trim().slice(0, 120))}`);
console.log(`  ping calls: ${pings}  (5 = steer was IGNORED; 1–2 = steer LANDED mid-turn)`);

const obeyed = /STEERED/i.test(text) && !/ALLDONE/i.test(text);
const landedEarly = pings < 5;
const shapeOk = !!boundary;

console.log(`\n  ${shapeOk ? '✅' : '❌'} API accepted the injected shape (steer in the tool_result message)`);
console.log(`  ${landedEarly ? '✅' : '❌'} model stopped early (${pings}/5 pings) — steer reached it MID-turn`);
console.log(`  ${obeyed ? '✅' : '❌'} model obeyed the steer (said STEERED, not ALLDONE)`);
const pass = shapeOk && landedEarly && obeyed;
console.log(`\n${pass ? '✅ LIVE PASS' : '❌ LIVE FAIL'} — ${providerId}\n`);
process.exit(pass ? 0 : 1);
