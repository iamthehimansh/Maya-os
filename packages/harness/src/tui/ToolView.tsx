/**
 * ToolView — renders one tool invocation: a header line with the tool name and
 * a compact argument summary, then (once the tool runs) a trimmed result block
 * colored by success/error.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

export interface ToolEntry {
  kind: 'tool';
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  done: boolean;
}

/** One-line, human-friendly summary of a tool's arguments. */
export function summarizeInput(name: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  // Prefer the most salient field per tool.
  const primary =
    (typeof o.command === 'string' && o.command) ||
    (typeof o.path === 'string' && o.path) ||
    (typeof o.pattern === 'string' && o.pattern) ||
    (typeof o.file_path === 'string' && o.file_path) ||
    '';
  if (primary) return String(primary);
  // Fallback: compact JSON, truncated.
  try {
    const j = JSON.stringify(o);
    return j.length > 80 ? j.slice(0, 77) + '…' : j;
  } catch {
    return '';
  }
}

/** Trim a tool result for display: cap lines and total length. */
function trimOutput(text: string, maxLines = 12, maxChars = 1600): string {
  let out = text.replace(/\s+$/, '');
  const lines = out.split('\n');
  let clipped = false;
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join('\n');
    clipped = true;
  }
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    clipped = true;
  }
  const extra = lines.length > maxLines ? lines.length - maxLines : 0;
  return clipped ? `${out}\n… (+${extra || 'more'} lines)` : out;
}

export function ToolView({ entry }: { entry: ToolEntry }): React.ReactElement {
  const summary = summarizeInput(entry.name, entry.input);
  const marker = !entry.done ? '⋯' : entry.isError ? '✗' : '✓';
  const markerColor = !entry.done ? theme.muted : entry.isError ? theme.error : theme.ok;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={markerColor}>{marker} </Text>
        <Text color={theme.tool} bold>
          {entry.name}
        </Text>
        {summary ? <Text color={theme.muted}> {summary}</Text> : null}
      </Box>
      {entry.done && entry.output ? (
        <Box marginLeft={2} flexDirection="column">
          <Text color={entry.isError ? theme.error : theme.muted}>
            {trimOutput(entry.output)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
