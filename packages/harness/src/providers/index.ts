/**
 * Provider registry + factory. OWNER: @architect (registry shape) + @providers
 * (the two adapters). Adding a 3rd provider later = one new file + one catalog
 * entry here.
 */
import type { Credential, ModelPricing, Provider, ProviderId, ProviderInfo } from '../types.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';

/**
 * Static model catalog + pricing ($/1M tokens) for the cost meter.
 * @providers: confirm/adjust model ids + prices against the live SDKs.
 */
export const PROVIDER_CATALOG: Record<ProviderId, ProviderInfo & { pricing: Record<string, ModelPricing> }> = {
  anthropic: {
    id: 'anthropic',
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-opus-4-8',
    pricing: {
      'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  },
  openai: {
    id: 'openai',
    models: ['gpt-5.5', 'gpt-5.1', 'gpt-5-codex'],
    defaultModel: 'gpt-5.5',
    pricing: {
      'gpt-5.5': { input: 1.25, output: 10 },
      'gpt-5.1': { input: 1.25, output: 10 },
      'gpt-5-codex': { input: 1.25, output: 10 },
    },
  },
};

export function listProviders(): ProviderInfo[] {
  return Object.values(PROVIDER_CATALOG).map(({ id, models, defaultModel }) => ({ id, models, defaultModel }));
}

export function pricingFor(provider: ProviderId, model: string): ModelPricing | undefined {
  return PROVIDER_CATALOG[provider]?.pricing[model];
}

/** Instantiate a provider adapter bound to a resolved credential. */
export function createProvider(id: ProviderId, cred: Credential): Provider {
  switch (id) {
    case 'anthropic':
      return createAnthropicProvider(cred);
    case 'openai':
      return createOpenAIProvider(cred);
    default:
      throw new Error(`Unknown provider: ${id}`);
  }
}
