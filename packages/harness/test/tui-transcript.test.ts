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
});
