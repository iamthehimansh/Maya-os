/**
 * e2e smoke: drive the whole loop with the REAL built-in tools against a temp
 * directory, using a scripted provider (no network). Proves the loop wires
 * provider → tool-call → permission gate → tool execution → result-feedback end
 * to end. Auto-activates once builtinTools() is populated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/loop/index.js';
import { builtinTools } from '../src/tools/index.js';
import type { LoopEvent, PermissionGate, Provider, StreamEvent, StreamRequest } from '../src/types.js';

const tools = builtinTools();
const hasTool = (name: string) => tools.some((t) => t.spec.name === name);
const allowAll: PermissionGate = { request: async () => true };

function scripted(turns: StreamEvent[][]): Provider {
  let i = 0;
  return {
    id: 'anthropic',
    models: ['claude-opus-4-8'],
    async *stream(_req: StreamRequest): AsyncIterable<StreamEvent> {
      for (const ev of turns[i++] ?? []) yield ev;
    },
  };
}

async function collect(session: ReturnType<typeof createSession>, prompt: string): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const ev of session.run(prompt)) out.push(ev);
  return out;
}

describe('e2e smoke (real tools + loop)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-e2e-'));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!(hasTool('write') && hasTool('read')))(
    'model writes a file then reads it back through the tools',
    async () => {
      const provider = scripted([
        // turn 1: write hello.txt
        [
          { type: 'tool_call', id: 'w1', name: 'write', input: { path: 'hello.txt', content: 'hi there' } },
          { type: 'done', stopReason: 'tool_use' },
        ],
        // turn 2: read it back
        [
          { type: 'tool_call', id: 'r1', name: 'read', input: { path: 'hello.txt' } },
          { type: 'done', stopReason: 'tool_use' },
        ],
        // turn 3: finish
        [
          { type: 'text_delta', text: 'created and verified hello.txt' },
          { type: 'done', stopReason: 'end_turn' },
        ],
      ]);
      const session = createSession({
        provider,
        providerId: 'anthropic',
        model: 'claude-opus-4-8',
        systemPrompt: 'test',
        tools,
        cwd: dir,
        permission: allowAll,
        authMode: 'api',
        authSource: 'test',
      });

      const events = await collect(session, 'make hello.txt then read it');

      // The write tool actually created the file on disk.
      const onDisk = await readFile(join(dir, 'hello.txt'), 'utf8');
      expect(onDisk).toBe('hi there');

      // The read tool fed the contents back.
      const readResult = events.find((e) => e.type === 'tool_result' && e.id === 'r1');
      expect(readResult && 'output' in readResult && readResult.output).toContain('hi there');

      expect(events.at(-1)?.type).toBe('turn_end');
    },
  );
});
