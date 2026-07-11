/**
 * ScrollView — renders a fixed-height window over a flat `Line[]` buffer.
 *
 * It is deliberately dumb: the App owns the `ScrollState` (see viewport.ts) and
 * the rendered lines (see lines.ts); this component just paints the visible
 * slice, pads to `height` content rows so the input box stays anchored, and adds
 * exactly ONE status row (▲ above / ▼ N new below) so the region height is
 * always `height + 1` — no overflow, no flicker.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { Line } from './lines.js';
import type { ScrollState } from './viewport.js';
import { windowSlice, hasMoreAbove, hasMoreBelow } from './viewport.js';
import { theme } from './theme.js';

export interface ScrollViewProps {
  lines: readonly Line[];
  /** Number of CONTENT rows (the status row is rendered in addition). */
  height: number;
  scroll: ScrollState;
}

function LineRow({ line }: { line: Line }): React.ReactElement {
  const joined = line.segs.map((s) => s.text).join('');
  if (joined.length === 0) return <Text> </Text>;
  return (
    <Text>
      {line.segs.map((s, i) => (
        <Text
          key={i}
          {...(s.color ? { color: s.color } : {})}
          {...(s.bold ? { bold: true } : {})}
          {...(s.italic ? { italic: true } : {})}
          {...(s.dim ? { dimColor: true } : {})}
          {...(s.inverse ? { inverse: true } : {})}
          {...(s.underline ? { underline: true } : {})}
        >
          {s.text.length ? s.text : ' '}
        </Text>
      ))}
    </Text>
  );
}

export function ScrollView({ lines, height, scroll }: ScrollViewProps): React.ReactElement {
  const h = Math.max(1, height);
  const visible = windowSlice(lines, scroll, h);
  const pad = Math.max(0, h - visible.length);
  const above = hasMoreAbove(scroll);
  const below = hasMoreBelow(scroll, lines.length, h);
  const newBelow = below ? lines.length - h - scroll.top : 0;

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <LineRow key={scroll.top + i} line={line} />
      ))}
      {Array.from({ length: pad }, (_, i) => (
        <Text key={`pad${i}`}> </Text>
      ))}
      <StatusRow above={above} below={below} newBelow={newBelow} />
    </Box>
  );
}

function StatusRow({ above, below, newBelow }: { above: boolean; below: boolean; newBelow: number }): React.ReactElement {
  if (below) {
    return (
      <Text color={theme.accent}>
        ▼ {newBelow > 0 ? `${newBelow} new below` : 'more below'} (PgDn/End){above ? <Text color={theme.muted} dimColor> · ▲ more above</Text> : null}
      </Text>
    );
  }
  if (above) {
    return (
      <Text color={theme.muted} dimColor>
        ▲ more above (PgUp) · ▼ at latest
      </Text>
    );
  }
  return <Text> </Text>;
}
