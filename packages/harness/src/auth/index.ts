/**
 * Auth resolution. OWNER: @providers.
 *
 * Registry mapping a provider id → resolver, plus a single `resolveAuth`
 * entry point. Auto-detect order (mode omitted): API key first, then
 * subscription. Pass mode='api'|'subscription' to force one path.
 *
 * Anthropic:
 *   api          → ANTHROPIC_API_KEY env → { kind:'api', token }
 *   subscription → ~/.claude/.credentials.json, else (darwin) macOS keychain
 *                  `security find-generic-password -s "Claude Code-credentials" -w`
 *                  → OAuth token → { kind:'oauth', token, headers:{'anthropic-beta': …} }
 * OpenAI:
 *   api          → OPENAI_API_KEY env (or ~/.codex/auth.json OPENAI_API_KEY)
 *   subscription → ~/.codex/auth.json tokens.access_token → { kind:'oauth', token,
 *                  headers:{ base-url, ChatGPT-Account-Id, originator } }
 *
 * Never log or print cred.token.
 */
import type { AuthMode, AuthResolver, Credential, ProviderId } from '../types.js';
import { AnthropicAuth } from './anthropic.js';
import { OpenAIAuth } from './openai.js';

export { AnthropicAuth, ANTHROPIC_OAUTH_BETA } from './anthropic.js';
export { OpenAIAuth, CODEX_BACKEND_BASE_URL } from './openai.js';

const RESOLVERS: Record<string, AuthResolver> = {
  anthropic: new AnthropicAuth(),
  openai: new OpenAIAuth(),
};

export function authResolver(provider: ProviderId): AuthResolver {
  const r = RESOLVERS[provider];
  if (!r) throw new Error(`No auth resolver for provider "${provider}".`);
  return r;
}

/** Which auth modes are available for a provider on this machine, preferred first. */
export function detectAuth(provider: ProviderId): Promise<AuthMode[]> {
  return authResolver(provider).detect();
}

/** Resolve a usable credential; omitted mode = auto (api-env → subscription). */
export function resolveAuth(provider: ProviderId, mode?: AuthMode): Promise<Credential> {
  return authResolver(provider).resolve(mode);
}

/** Redact a credential for logging/UI — never exposes the token. */
export function describeCredential(cred: Credential): {
  provider: ProviderId;
  kind: 'api' | 'oauth';
  source: string;
  expiresAt?: number;
} {
  return {
    provider: cred.provider,
    kind: cred.kind,
    source: cred.source,
    ...(cred.expiresAt !== undefined ? { expiresAt: cred.expiresAt } : {}),
  };
}
