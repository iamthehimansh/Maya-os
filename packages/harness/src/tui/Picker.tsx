/**
 * Picker — a modal single-select list used by `/model`, `/provider`, `/auth`.
 * Up/down (or j/k) to move, enter to select, esc to cancel.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';

export interface PickerOption {
  label: string;
  value: string;
  /** Optional trailing hint, e.g. "(current)". */
  hint?: string;
}

export interface PickerProps {
  title: string;
  options: readonly PickerOption[];
  /** Index to start highlighted (e.g. the current value). */
  initialIndex?: number;
  /** Key hint under the list. Defaults to the select/cancel line. */
  footer?: string;
  onSelect(value: string): void;
  onCancel(): void;
  active?: boolean;
}

export function Picker({
  title,
  options,
  initialIndex = 0,
  footer = '↑/↓ move · enter select · esc cancel',
  onSelect,
  onCancel,
  active = true,
}: PickerProps): React.ReactElement {
  const [idx, setIdx] = useState(Math.max(0, Math.min(initialIndex, options.length - 1)));

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setIdx((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow || input === 'j') setIdx((i) => (i + 1) % options.length);
      else if (key.return) {
        const opt = options[idx];
        if (opt) onSelect(opt.value);
      } else if (key.escape) onCancel();
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {title}
      </Text>
      {options.map((opt, i) => {
        const selected = i === idx;
        // Keyed by index, not value: a registry can return two skills that share
        // one `owner/repo`, and duplicate keys would drop rows.
        return (
          <Text key={i} {...(selected ? { color: theme.accent } : {})}>
            {selected ? '❯ ' : '  '}
            {opt.label}
            {opt.hint ? <Text color={theme.muted}> {opt.hint}</Text> : null}
          </Text>
        );
      })}
      <Text color={theme.muted}>{footer}</Text>
    </Box>
  );
}
