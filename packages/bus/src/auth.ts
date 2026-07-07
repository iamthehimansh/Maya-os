/**
 * Token auth. Tokens are `mbt_<48 hex>`; only the SHA-256 hash is stored, so
 * a leaked bus.db cannot be replayed into live credentials. Tokens travel in
 * the WebSocket subprotocol (`mbt.<token>`) or an Authorization bearer —
 * never in URLs, argv, or logs.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BusCapability, BusRole } from '@maya-ai/core';
import type { BusDb, TokenRow } from './db.js';

export const TOKEN_PREFIX = 'mbt_';
export const SUBPROTOCOL_PREFIX = 'mbt.';

export interface MintOptions {
  label: string;
  role?: BusRole;
  caps?: BusCapability[];
  /** Channel ids the token may join; `['*']` = any channel. */
  scopes?: string[];
}

export interface MintedToken {
  id: string;
  /** The secret. Shown exactly once — only the hash is stored. */
  token: string;
  label: string;
  role: BusRole;
  caps: BusCapability[];
  scopes: string[];
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function mintToken(db: BusDb, opts: MintOptions): MintedToken {
  const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
  const row: MintedToken = {
    id: 'tok_' + randomUUID().replaceAll('-', '').slice(0, 20),
    token,
    label: opts.label,
    role: opts.role ?? 'member',
    caps: opts.caps ?? ['receive', 'send'],
    scopes: opts.scopes ?? ['*'],
  };
  db.insertToken({ ...row, hash: hash(token), revoked: false });
  return row;
}

/** Resolve a presented secret to its token row (null = unknown or revoked). */
export function verifyToken(db: BusDb, token: string): TokenRow | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = db.tokenByHash(hash(token));
  return row && !row.revoked ? row : null;
}

export function tokenAllowsChannel(row: TokenRow, channelId: string): boolean {
  return row.scopes.includes('*') || row.scopes.includes(channelId);
}
