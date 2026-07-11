/**
 * Live provider probe (NOT part of `pnpm test` — run manually with real creds).
 * Drives each provider adapter through one streamed turn with a tool available,
 * asserting we get text and/or a tool_call + usage + done. Prints only shapes,
 * never tokens. Usage:
 *   node test/live-probe.mjs anthropic-api
 *   node test/live-probe.mjs anthropic-sub
 *   node test/live-probe.mjs openai-api
 *   node test/live-probe.mjs openai-sub
 */
import { resolveAuth, describeCredential } from '../dist/auth/index.js';
import { createProvider, PROVIDER_CATALOG } from '../dist/providers/index.js';

const target = process.argv[2];
const MAP = {
  'anthropic-api': ['anthropic', 'api'],
  'anthropic-sub': ['anthropic', 'subscription'],
  'openai-api': ['openai', 'api'],
  'openai-sub': ['openai', 'subscription'],
};
const [provider, mode] = MAP[target] ?? [];
if (!provider) {
  console.error('usage: node test/live-probe.mjs <anthropic-api|anthropic-sub|openai-api|openai-sub>');
  process.exit(2);
}

const weatherTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
};

const cred = await resolveAuth(provider, mode);
console.log('auth:', JSON.stringify(describeCredential(cred)));
const p = createProvider(provider, cred);
const model = PROVIDER_CATALOG[provider].defaultModel;
console.log('model:', model);

let text = '';
let toolCalls = [];
let usage = null;
let done = null;
const req = {
  model,
  system: 'You are a terse assistant. When asked about weather, call get_weather.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Paris? Use the tool.' }] }],
  tools: [weatherTool],
  maxTokens: 1024,
};
for await (const ev of p.stream(req)) {
  if (ev.type === 'text_delta') text += ev.text;
  else if (ev.type === 'tool_call') toolCalls.push({ name: ev.name, input: ev.input });
  else if (ev.type === 'usage') usage = ev.usage;
  else if (ev.type === 'done') done = ev.stopReason;
}
console.log('text:', JSON.stringify(text.slice(0, 120)));
console.log('toolCalls:', JSON.stringify(toolCalls));
console.log('usage:', JSON.stringify(usage));
console.log('done:', done);
const ok = (text.length > 0 || toolCalls.length > 0) && usage && done;
console.log(ok ? `\nPROBE OK (${target})` : `\nPROBE FAILED (${target})`);
process.exit(ok ? 0 : 1);
