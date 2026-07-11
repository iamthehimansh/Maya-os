/**
 * PermissionPrompt — modal shown when the loop requests permission for a gated
 * action (write/bash). Resolves the pending request with the user's choice.
 *
 * Keys: y / enter = allow once · a = allow + don't ask again (yolo) · n / esc = deny.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingPermission } from './permission.js';
import { theme } from './theme.js';

export interface PermissionPromptProps {
  pending: PendingPermission;
  /** Allow all future gated actions this session (flip the gate to yolo). */
  onAlwaysAllow(): void;
  active?: boolean;
}

export function PermissionPrompt({
  pending,
  onAlwaysAllow,
  active = true,
}: PermissionPromptProps): React.ReactElement {
  const { req, resolve } = pending;

  useInput(
    (input, key) => {
      const ch = input.toLowerCase();
      if (key.return || ch === 'y') resolve(true);
      else if (ch === 'a') {
        onAlwaysAllow();
        resolve(true);
      } else if (key.escape || ch === 'n') resolve(false);
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn} bold>
        ⚠ permission needed · {req.tool}
      </Text>
      <Text>{req.summary}</Text>
      {req.detail ? <Text color={theme.muted}>{req.detail}</Text> : null}
      <Text color={theme.muted}>
        <Text color={theme.ok}>y</Text>/enter allow · <Text color={theme.accent}>a</Text> always ·{' '}
        <Text color={theme.error}>n</Text>/esc deny
      </Text>
    </Box>
  );
}
