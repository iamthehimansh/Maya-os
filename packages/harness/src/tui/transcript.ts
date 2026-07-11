/**
 * transcript.ts — rebuild render-ready `Entry[]` from a stored `ModelMessage[]`.
 *
 * Used by `/resume` and `--continue`: the session reloads the raw messages for
 * the model, and the TUI reconstructs the visible transcript (user/assistant
 * text + tool blocks with their results) so a resumed session looks like it
 * never left. Pure + tested.
 */
import type { ModelMessage } from '../types.js';
import type { Entry } from './entries.js';
import type { ToolEntry } from './ToolView.js';

export function messagesToEntries(messages: readonly ModelMessage[]): Entry[] {
  // First pass: index tool results (they ride inside the *next* user message).
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        results.set(b.toolCallId, { content: b.content, isError: b.isError ?? false });
      }
    }
  }

  const out: Entry[] = [];
  for (const m of messages) {
    // A user message that is purely tool_results is not shown as a user turn.
    const isToolResultOnly =
      m.role === 'user' && m.content.length > 0 && m.content.every((b) => b.type === 'tool_result');
    if (isToolResultOnly) continue;

    for (const b of m.content) {
      if (b.type === 'text') {
        if (!b.text.trim()) continue;
        out.push(
          m.role === 'user'
            ? { kind: 'user', text: b.text }
            : { kind: 'assistant', text: b.text, streaming: false },
        );
      } else if (b.type === 'tool_call') {
        const res = results.get(b.id);
        const entry: ToolEntry = {
          kind: 'tool',
          id: b.id,
          name: b.name,
          input: b.input,
          done: true,
          isError: res?.isError ?? false,
          ...(res ? { output: res.content } : {}),
        };
        out.push(entry);
      }
    }
  }
  return out;
}
