import { describe, it, expect } from 'vitest';
import { messagesToEntries } from '../src/tui/transcript.js';
import type { ModelMessage } from '../src/types.js';

describe('messagesToEntries', () => {
  it('rebuilds user/assistant/tool entries and pairs tool results', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'run ls' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'a\nb', isError: false }] },
      { role: 'assistant', content: [{ type: 'text', text: 'there are two files' }] },
    ];

    const entries = messagesToEntries(messages);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    const toolEntry = entries.find((e) => e.kind === 'tool');
    expect(toolEntry).toMatchObject({ kind: 'tool', id: 't1', name: 'bash', done: true, output: 'a\nb' });

    // The tool-result-only user message is not shown as a user turn.
    expect(entries.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('skips empty text blocks', () => {
    const entries = messagesToEntries([{ role: 'assistant', content: [{ type: 'text', text: '   ' }] }]);
    expect(entries).toHaveLength(0);
  });

  it('rebuilds a mid-turn steer, which rides in the same user message as the tool results', () => {
    // This is the shape `inject()` produces on the Anthropic path: the steer is a
    // text block appended AFTER the tool_result blocks in one user message. On
    // /resume that message must come back as a visible user turn sitting right
    // after the tool it landed behind — the tool-result-only skip must not eat it.
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'Read', input: { path: 'a.ts' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 't1', content: 'contents', isError: false },
          { type: 'text', text: 'no, use b.ts' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'switching to b.ts' }] },
    ];

    const entries = messagesToEntries(messages);
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toEqual(['user', 'tool', 'user', 'assistant']);

    // The steer survives resume as its own user turn, in the position it landed.
    const users = entries.filter((e) => e.kind === 'user');
    expect(users[1]).toMatchObject({ kind: 'user', text: 'no, use b.ts' });
    // ...and the tool result it rode in with still pairs onto its call.
    expect(entries[1]).toMatchObject({ kind: 'tool', id: 't1', output: 'contents', done: true });
  });
});
