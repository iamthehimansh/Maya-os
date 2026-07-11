/**
 * Header — a one-line status bar: provider · model · auth, plus a live
 * token/cost meter and a context-usage indicator that turns amber near the
 * compaction threshold.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SessionState } from '../types.js';
import { theme } from './theme.js';

export interface HeaderProps {
  state: SessionState;
  /** Token budget at which the loop auto-compacts, for the context gauge. */
  contextLimit?: number;
  /** Auto-approve indicator (`--yolo` / `/yolo`). */
  yolo?: boolean;
  /** Count of running background tasks, for the `⚙ N bg` chip. */
  bgCount?: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function Header({ state, contextLimit, yolo, bgCount = 0 }: HeaderProps): React.ReactElement {
  const { provider, model, authMode, authSource, usage, costUsd, contextTokens } = state;
  const total = usage.inputTokens + usage.outputTokens;

  // Context gauge: fraction of the compaction limit currently held.
  let ctx: React.ReactElement | null = null;
  if (contextLimit && contextLimit > 0) {
    const frac = Math.min(1, contextTokens / contextLimit);
    const pct = Math.round(frac * 100);
    const tone = frac >= 0.85 ? theme.error : frac >= 0.6 ? theme.warn : theme.muted;
    ctx = (
      <Text color={tone}>
        {' · '}ctx {pct}%
      </Text>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.muted}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text color={theme.accent} bold>
          maya code
        </Text>
        <Text color={theme.muted}> · </Text>
        <Text bold>{provider}</Text>
        <Text color={theme.muted}>/</Text>
        <Text>{model}</Text>
        <Text color={theme.muted}> · </Text>
        <Text color={authMode === 'subscription' ? theme.ok : theme.user}>
          {authMode === 'subscription' ? 'sub' : 'api'}
        </Text>
        <Text color={theme.muted}> ({authSource})</Text>
        {yolo ? <Text color={theme.error} bold> · YOLO</Text> : null}
        {bgCount > 0 ? <Text color={theme.warn}> · ⚙ {bgCount} bg</Text> : null}
      </Box>
      <Box>
        <Text color={theme.muted}>
          {fmtTokens(usage.inputTokens)}↑ {fmtTokens(usage.outputTokens)}↓
        </Text>
        <Text color={theme.muted}> ({fmtTokens(total)}) · </Text>
        <Text color={theme.ok}>{fmtCost(costUsd)}</Text>
        {ctx}
      </Box>
    </Box>
  );
}
