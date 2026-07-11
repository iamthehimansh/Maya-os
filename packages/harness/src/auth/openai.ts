/**
 * OpenAI auth resolver — two independent paths, auto-detected:
 *
 *   api          → OPENAI_API_KEY env var (standard api.openai.com, Bearer key).
 *   subscription → Codex / ChatGPT login in ~/.codex/auth.json. The access token
 *                  (tokens.access_token) is a ChatGPT OAuth token that is NOT
 *                  valid against api.openai.com — it authenticates against the
 *                  Codex backend `https://chatgpt.com/backend-api/codex`. We
 *                  surface the account id + originator as extra headers and the
 *                  base URL via Credential.baseUrl so the provider adapter can
 *                  point the SDK at the right endpoint.
 *
 * Confirmed empirically: Bearer <access_token> + ChatGPT-Account-Id + originator
 * against .../codex/responses returns 200 with a standard Responses SSE stream.
 * NEVER log the token.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthMode, AuthResolver, Credential } from '../types.js';

/** Base URL the ChatGPT/Codex subscription token authenticates against. */
export const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const AUTH_FILE = join(homedir(), '.codex', 'auth.json');

interface CodexAuth {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

async function readCodexAuth(): Promise<CodexAuth | null> {
  try {
    return JSON.parse(await readFile(AUTH_FILE, 'utf8')) as CodexAuth;
  } catch {
    return null;
  }
}

export class OpenAIAuth implements AuthResolver {
  readonly provider = 'openai' as const;

  async detect(): Promise<AuthMode[]> {
    const modes: AuthMode[] = [];
    const auth = await readCodexAuth();
    // An API key can come from the env OR from a file that stored one.
    if (process.env['OPENAI_API_KEY'] || auth?.OPENAI_API_KEY) modes.push('api');
    if (auth?.tokens?.access_token) modes.push('subscription');
    return modes;
  }

  async resolve(mode?: AuthMode): Promise<Credential> {
    const auth = await readCodexAuth();
    const envKey = process.env['OPENAI_API_KEY'];
    const fileKey = auth?.OPENAI_API_KEY ?? undefined;
    const apiKey = envKey || fileKey;

    if (mode === 'api' || (mode === undefined && apiKey)) {
      if (!apiKey) throw new Error('OpenAI: --auth api requested but no OPENAI_API_KEY found.');
      return {
        provider: 'openai',
        kind: 'api',
        source: envKey ? 'OPENAI_API_KEY env' : '~/.codex/auth.json (OPENAI_API_KEY)',
        token: apiKey,
      };
    }

    const tokens = auth?.tokens;
    if (tokens?.access_token) {
      const headers: Record<string, string> = { originator: 'codex_cli_rs' };
      if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
      return {
        provider: 'openai',
        kind: 'oauth',
        source: '~/.codex/auth.json (ChatGPT subscription)',
        token: tokens.access_token,
        baseUrl: CODEX_BACKEND_BASE_URL,
        headers,
      };
    }

    if (mode === 'subscription') {
      throw new Error(
        'OpenAI: --auth subscription requested but no Codex/ChatGPT login found in ' +
          '~/.codex/auth.json. Run `codex` to log in.',
      );
    }
    throw new Error('OpenAI: no credentials found. Set OPENAI_API_KEY or log in with Codex.');
  }
}
