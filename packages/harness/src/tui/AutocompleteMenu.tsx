/**
 * Autocomplete — the non-intrusive menu that floats above the input.
 *
 * Pure display: the App computes the `CompletionResult` (autocomplete.ts) and
 * owns the highlighted index + key handling. Empty results render nothing.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { CompletionResult } from './autocomplete.js';
import { theme } from './theme.js';

const KIND_LABEL: Record<string, string> = {
  slash: 'commands',
  file: 'files',
  history: 'history',
};

export interface AutocompleteProps {
  result: CompletionResult;
  index: number;
}

export function AutocompleteMenu({ result, index }: AutocompleteProps): React.ReactElement | null {
  if (result.items.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text color={theme.muted} dimColor>
        {KIND_LABEL[result.kind] ?? result.kind} · tab accept · esc dismiss
      </Text>
      {result.items.map((item, i) => {
        const selected = i === index;
        return (
          <Text key={item.value} {...(selected ? { color: theme.accent, bold: true } : {})}>
            {selected ? '❯ ' : '  '}
            {item.label}
            {item.hint ? <Text color={theme.muted} dimColor> — {item.hint}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
