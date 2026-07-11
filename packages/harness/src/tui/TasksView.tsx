/**
 * TasksView — the `/tasks` overlay: list background tasks, show the selected
 * task's tail output, and kill the selected one. Its own modal key handling
 * (↑/↓ select · k kill · esc close), so the App suppresses its keymap while open.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { BgTask } from '../tasks/index.js';
import { theme } from './theme.js';

export interface TasksViewProps {
  tasks: readonly BgTask[];
  onKill(id: string): void;
  onClose(): void;
  active?: boolean;
}

const statusColor: Record<string, string> = {
  running: theme.warn,
  exited: theme.ok,
  killed: theme.muted,
  error: theme.error,
};

export function TasksView({ tasks, onKill, onClose, active = true }: TasksViewProps): React.ReactElement {
  const [idx, setIdx] = useState(0);
  const sel = tasks[Math.min(idx, tasks.length - 1)];

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') return onClose();
      if (tasks.length === 0) return;
      if (key.upArrow || input === 'k') setIdx((i) => (i - 1 + tasks.length) % tasks.length);
      else if (key.downArrow || input === 'j') setIdx((i) => (i + 1) % tasks.length);
      else if (input === 'x' || key.delete) {
        if (sel) onKill(sel.id);
      }
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        Background tasks ({tasks.length})
      </Text>
      {tasks.length === 0 ? (
        <Text color={theme.muted}>none — start one with /bg &lt;cmd&gt;</Text>
      ) : (
        tasks.map((t, i) => {
          const selected = i === Math.min(idx, tasks.length - 1);
          const status = t.status === 'running' ? 'running' : `${t.status}${t.exitCode != null ? ` ${t.exitCode}` : ''}`;
          return (
            <Text key={t.id} {...(selected ? { color: theme.accent, bold: true } : {})}>
              {selected ? '❯ ' : '  '}
              {t.id} <Text color={statusColor[t.status] ?? theme.muted}>[{status}]</Text> <Text color={theme.muted}>{t.command}</Text>
            </Text>
          );
        })
      )}
      {sel ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={theme.muted} paddingX={1}>
          <Text color={theme.muted} dimColor>
            output · {sel.id}
          </Text>
          <Text>{tailLines(sel.output, 10) || '(no output yet)'}</Text>
        </Box>
      ) : null}
      <Text color={theme.muted}>↑/↓ select · x kill · esc close</Text>
    </Box>
  );
}

function tailLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}
