/**
 * Dynamic model discovery (src/models). Pure fetch mapping — no real network:
 * every test injects a fake `fetch` via `opts.fetchImpl`. Covers Anthropic +
 * OpenAI live fetch, OpenAI chat-filtering, subscription-has-no-endpoint,
 * pagination, fallback on failure, and session caching.
 */
import { describe, expect, it, vi } from 'vitest';
import { clearModelCache, fetchModels, listModels } from '../src/models/index.js';
import type { Credential } from '../src/types.js';

const anthKey: Credential = {
  provider: 'anthropic',
  kind: 'api',
  source: 'test',
  token: 'sk-ant-test',
};
const anthOAuth: Credential = {
  provider: 'anthropic',
  kind: 'oauth',
  source: 'test',
  token: 'oauth-anth',
  headers: { 'anthropic-beta': 'oauth-2025-04-20' },
};
const oaiKey: Credential = { provider: 'openai', kind: 'api', source: 'test', token: 'sk-oai' };
const oaiOAuth: Credential = {
  provider: 'openai',
  kind: 'oauth',
  source: 'test',
  token: 'oauth-oai',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  headers: { originator: 'codex_cli_rs' },
};

/** A fetch stub that returns `body` as JSON with `status`. */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response,
  ) as unknown as typeof fetch;
}

describe('listModels — anthropic', () => {
  it('maps /v1/models rows to Model[] with label + created, sorted newest-first', async () => {
    const fetchImpl = jsonFetch({
      data: [
        { type: 'model', id: 'claude-haiku-4-5', display_name: 'Haiku', created_at: '2025-01-01T00:00:00Z' },
        { type: 'model', id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-05-01T00:00:00Z' },
      ],
      has_more: false,
    });
    const models = await listModels('anthropic', anthKey, { fetchImpl, force: true });
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    expect(models[0]).toMatchObject({ id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic' });
    expect(models[0]!.created).toBeGreaterThan(models[1]!.created!);
  });

  it('sends x-api-key for api creds and Bearer + beta header for oauth', async () => {
    const keyFetch = jsonFetch({ data: [{ id: 'claude-opus-4-8' }], has_more: false });
    await listModels('anthropic', anthKey, { fetchImpl: keyFetch, force: true });
    const keyHeaders = (keyFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(keyHeaders['x-api-key']).toBe('sk-ant-test');
    expect(keyHeaders['authorization']).toBeUndefined();

    const oauthFetch = jsonFetch({ data: [{ id: 'claude-opus-4-8' }], has_more: false });
    await listModels('anthropic', anthOAuth, { fetchImpl: oauthFetch, force: true });
    const oauthHeaders = (oauthFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(oauthHeaders['authorization']).toBe('Bearer oauth-anth');
    expect(oauthHeaders['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(oauthHeaders['x-api-key']).toBeUndefined();
  });

  it('follows pagination via has_more/last_id', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      call++;
      if (call === 1) {
        expect(url).not.toContain('after_id');
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }], has_more: true, last_id: 'm1' }) } as Response;
      }
      expect(url).toContain('after_id=m1');
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm2' }], has_more: false }) } as Response;
    }) as unknown as typeof fetch;
    const models = await listModels('anthropic', anthKey, { fetchImpl, force: true });
    expect(models.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    expect(call).toBe(2);
  });
});

describe('listModels — openai', () => {
  it('filters to chat/codex models and drops embeddings/tts/image', async () => {
    const fetchImpl = jsonFetch({
      object: 'list',
      data: [
        { id: 'gpt-5.5', created: 100 },
        { id: 'o4-mini', created: 90 },
        { id: 'gpt-5-codex', created: 80 },
        { id: 'text-embedding-3-large', created: 70 },
        { id: 'whisper-1', created: 60 },
        { id: 'gpt-image-1', created: 50 },
        { id: 'tts-1', created: 40 },
      ],
    });
    const models = await listModels('openai', oaiKey, { fetchImpl, force: true });
    expect(models.map((m) => m.id)).toEqual(['gpt-5.5', 'o4-mini', 'gpt-5-codex']);
  });

  it('subscription (codex backend) lists real models with version:1.0.0 header + client_version query', async () => {
    const fetchImpl = jsonFetch({
      models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
      ],
    });
    const res = await fetchModels('openai', oaiOAuth, { fetchImpl, force: true });
    expect(res.source).toBe('api');
    // slug → id, display_name → label; backend order preserved; hidden model dropped.
    expect(res.models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
    expect(res.models[0]).toMatchObject({ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', provider: 'openai' });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call[0] as string;
    const headers = call[1].headers as Record<string, string>;
    // Hits the ChatGPT/Codex backend, NOT api.openai.com.
    expect(url).toContain('chatgpt.com/backend-api/codex/models');
    expect(url).toContain('client_version=1.0.0');
    // The version:1.0.0 header the owner called out — required to get the list.
    expect(headers['version']).toBe('1.0.0');
    expect(headers['authorization']).toBe('Bearer oauth-oai');
    // Carries the codex identity headers from the credential.
    expect(headers['originator']).toBe('codex_cli_rs');
  });

  it('subscription falls back to the built-in list when the codex backend fails', async () => {
    const fetchImpl = jsonFetch({ error: 'bad' }, 400);
    const res = await fetchModels('openai', oaiOAuth, { fetchImpl, force: true });
    expect(res.source).toBe('fallback');
    expect(res.models.length).toBeGreaterThan(0);
    expect(res.models.every((m) => m.provider === 'openai')).toBe(true);
  });
});

describe('fallback + source', () => {
  it('reports source:api on a good fetch', async () => {
    const fetchImpl = jsonFetch({ data: [{ id: 'claude-opus-4-8' }], has_more: false });
    const res = await fetchModels('anthropic', anthKey, { fetchImpl });
    expect(res.source).toBe('api');
  });

  it('falls back to the built-in list when the fetch errors (non-2xx)', async () => {
    const fetchImpl = jsonFetch({ error: 'nope' }, 401);
    const res = await fetchModels('anthropic', anthKey, { fetchImpl });
    expect(res.source).toBe('fallback');
    expect(res.models.map((m) => m.id)).toContain('claude-opus-4-8');
  });

  it('falls back when fetch throws / times out', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await fetchModels('openai', oaiKey, { fetchImpl });
    expect(res.source).toBe('fallback');
    expect(res.models.length).toBeGreaterThan(0);
  });

  it('falls back when the API returns an empty list', async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const res = await fetchModels('anthropic', anthKey, { fetchImpl });
    expect(res.source).toBe('fallback');
  });
});

describe('session cache', () => {
  it('caches a successful fetch and reuses it without a second network call', async () => {
    clearModelCache();
    const fetchImpl = jsonFetch({ data: [{ id: 'claude-opus-4-8' }], has_more: false });
    await listModels('anthropic', anthKey, { fetchImpl });
    await listModels('anthropic', anthKey, { fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('force:true bypasses the cache and re-fetches', async () => {
    clearModelCache();
    const fetchImpl = jsonFetch({ data: [{ id: 'claude-opus-4-8' }], has_more: false });
    await listModels('anthropic', anthKey, { fetchImpl });
    await listModels('anthropic', anthKey, { fetchImpl, force: true });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('does NOT cache a fallback result (transient failure stays retryable)', async () => {
    clearModelCache();
    const failing = jsonFetch({}, 500);
    await listModels('anthropic', anthKey, { fetchImpl: failing });
    const good = jsonFetch({ data: [{ id: 'claude-opus-4-8', display_name: 'Opus' }], has_more: false });
    const models = await listModels('anthropic', anthKey, { fetchImpl: good });
    expect(models[0]!.label).toBe('Opus'); // came from the live fetch, not the pinned fallback
  });

  it('keys the cache by provider — openai and anthropic do not collide', async () => {
    clearModelCache();
    const anth = jsonFetch({ data: [{ id: 'claude-opus-4-8' }], has_more: false });
    const oai = jsonFetch({ data: [{ id: 'gpt-5.5', created: 1 }] });
    const a = await listModels('anthropic', anthKey, { fetchImpl: anth });
    const o = await listModels('openai', oaiKey, { fetchImpl: oai });
    expect(a[0]!.id).toBe('claude-opus-4-8');
    expect(o[0]!.id).toBe('gpt-5.5');
  });
});
