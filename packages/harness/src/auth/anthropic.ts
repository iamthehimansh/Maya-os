/**
 * Anthropic auth resolver — two independent paths, auto-detected:
 *
 *   api          → ANTHROPIC_API_KEY env var (x-api-key header, handled by SDK).
 *   subscription → Claude Code OAuth login. The access token lives in either
 *                  ~/.claude/.credentials.json (Linux/older) OR the macOS login
 *                  keychain item "Claude Code-credentials" (current darwin). We
 *                  try the file first, then the keychain.
 *
 * Calling the Messages API with a subscription (OAuth) token has three quirks,
 * enforced downstream by the Anthropic provider adapter:
 *   1. Authorization: Bearer <token>   (NOT x-api-key)
 *   2. header  anthropic-beta: oauth-2025-04-20
 *   3. the system prompt must begin with the Claude Code identity block.
 *
 * We surface (1) and (2) here via Credential.kind/headers; (3) is applied in the
 * adapter. NEVER log the token.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthMode, AuthResolver, Credential } from '../types.js';
import { readKeychainSecret } from './keychain.js';

/** anthropic-beta value that unlocks OAuth (Claude Code subscription) tokens. */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDS_FILE = join(homedir(), '.claude', '.credentials.json');

interface ClaudeOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** Parse the `{ claudeAiOauth: {...} }` blob Claude Code persists. */
function parseOAuthBlob(raw: string): ClaudeOAuth | null {
  try {
    const obj = JSON.parse(raw) as { claudeAiOauth?: ClaudeOAuth };
    const o = obj.claudeAiOauth;
    if (o && typeof o.accessToken === 'string' && o.accessToken.length > 0) return o;
  } catch {
    /* not JSON / not our shape */
  }
  return null;
}

/** Locate the OAuth blob: file first, then keychain. Returns creds + source. */
async function findOAuth(): Promise<{ oauth: ClaudeOAuth; source: string } | null> {
  try {
    const raw = await readFile(CREDS_FILE, 'utf8');
    const oauth = parseOAuthBlob(raw);
    if (oauth) return { oauth, source: '~/.claude/.credentials.json' };
  } catch {
    /* no file — fall through to keychain */
  }
  const secret = await readKeychainSecret(KEYCHAIN_SERVICE);
  if (secret) {
    const oauth = parseOAuthBlob(secret);
    if (oauth) return { oauth, source: 'macOS keychain (Claude Code-credentials)' };
  }
  return null;
}

export class AnthropicAuth implements AuthResolver {
  readonly provider = 'anthropic' as const;

  async detect(): Promise<AuthMode[]> {
    const modes: AuthMode[] = [];
    if (process.env['ANTHROPIC_API_KEY']) modes.push('api');
    if (await findOAuth()) modes.push('subscription');
    return modes;
  }

  async resolve(mode?: AuthMode): Promise<Credential> {
    const apiKey = process.env['ANTHROPIC_API_KEY'];

    // Explicit api, or auto-detect preferring the API key when present.
    if (mode === 'api' || (mode === undefined && apiKey)) {
      if (!apiKey) throw new Error('Anthropic: --auth api requested but ANTHROPIC_API_KEY is not set.');
      return {
        provider: 'anthropic',
        kind: 'api',
        source: 'ANTHROPIC_API_KEY env',
        token: apiKey,
      };
    }

    // subscription (explicit) or auto-detect fallback.
    const found = await findOAuth();
    if (found) {
      return {
        provider: 'anthropic',
        kind: 'oauth',
        source: found.source,
        token: found.oauth.accessToken,
        headers: { 'anthropic-beta': ANTHROPIC_OAUTH_BETA },
        ...(found.oauth.expiresAt !== undefined ? { expiresAt: found.oauth.expiresAt } : {}),
      };
    }

    if (mode === 'subscription') {
      throw new Error(
        'Anthropic: --auth subscription requested but no Claude Code login found ' +
          '(checked ~/.claude/.credentials.json and macOS keychain). Run `claude` to log in.',
      );
    }
    throw new Error(
      'Anthropic: no credentials found. Set ANTHROPIC_API_KEY or log in with Claude Code.',
    );
  }
}
