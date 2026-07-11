/**
 * Dynamic model discovery. OWNER: @models.
 *
 * `listModels(provider, cred)` fetches the live model list from the provider's
 * `GET /v1/models` endpoint using the ACTIVE credential (the same Credential the
 * providers/ adapters use), normalizes it into `Model[]`, caches per session, and
 * falls back to a small built-in list ONLY if the fetch fails or returns nothing.
 *
 *   Anthropic → GET {base}/v1/models   (x-api-key OR Bearer + anthropic-beta)
 *   OpenAI (api key)      → GET {base}/v1/models   (Bearer).
 *   OpenAI (subscription) → GET {codexBase}/models?client_version=1.0.0 against the
 *               ChatGPT/Codex backend (cred.baseUrl) with the subscription Bearer +
 *               cred.headers (originator, ChatGPT-Account-Id) AND a `version: 1.0.0`
 *               header — the same request the `codex` CLI makes. The public
 *               api.openai.com `/v1/models` does NOT accept a ChatGPT token, so this
 *               is the only way to list a subscription's real models. Falls back to
 *               the built-in list if it fails.
 *
 * NO TUI / SDK deps — plain `fetch`, so it stays cheap to import and easy to test
 * (inject `fetchImpl`, or stub `globalThis.fetch`). NEVER log or store cred.token;
 * the cache key uses a non-reversible fingerprint of the token, never the token.
 */
import type { Credential, ProviderId } from '../types.js';

// ─────────────────────────────────────────────────────────────── types ─────

/** A model the `/model` picker can offer. `id` is what you pass to the API. */
export interface Model {
  id: string;
  provider: ProviderId;
  /** Friendly label when the provider supplies one (Anthropic display_name);
   *  absent → the picker shows `id`. */
  label?: string;
  /** Creation time (epoch seconds) when the provider reports it — used to sort. */
  created?: number;
}

export interface ListModelsResult {
  models: Model[];
  /** `api` = live from the provider; `fallback` = built-in list (fetch failed). */
  source: 'api' | 'fallback';
  provider: ProviderId;
}

export interface ListModelsOptions {
  /** Caller cancel signal (composed with the internal timeout). */
  signal?: AbortSignal;
  /** Per-request timeout. Default 6000ms. */
  timeoutMs?: number;
  /** Bypass the session cache and re-fetch. */
  force?: boolean;
  /** Inject a fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

// ────────────────────────────────────────────────────────── fallbacks ──────
//
// Small, self-contained lists so models/ never imports providers/. Only used
// when the live fetch fails — kept in sync with the provider catalog by hand.

const FALLBACK_MODELS: Record<string, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5.5', 'gpt-5.1', 'gpt-5-codex'],
};

function fallbackResult(provider: ProviderId): ListModelsResult {
  const ids = FALLBACK_MODELS[provider] ?? [];
  return {
    provider,
    source: 'fallback',
    models: ids.map((id) => ({ id, provider })),
  };
}

// ─────────────────────────────────────────────────── openai model filter ────
//
// api.openai.com/v1/models returns everything (embeddings, tts, whisper, image,
// moderation…). A chat-model picker should only show text/chat-capable models,
// so we drop ids that clearly aren't. Conservative deny-list — when unsure, keep.

const OPENAI_NON_CHAT = [
  'embedding',
  'tts',
  'whisper',
  'audio',
  'realtime',
  'dall-e',
  'moderation',
  'transcribe',
  'image',
  'search',
];

function isOpenAIChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (OPENAI_NON_CHAT.some((tok) => lower.includes(tok))) return false;
  // Keep the recognizable chat/codex families.
  return /^(gpt|o\d|chatgpt|codex)/.test(lower);
}

// ─────────────────────────────────────────────────────────── fetching ──────

const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const OPENAI_DEFAULT_BASE = 'https://api.openai.com';
const CODEX_BACKEND_BASE = 'https://chatgpt.com/backend-api/codex';
const ANTHROPIC_VERSION = '2023-06-01';
/** The ChatGPT/Codex backend requires this on both the `version` header and the
 *  `client_version` query param to return the model list (matches the codex CLI). */
const CODEX_CLIENT_VERSION = '1.0.0';
const MAX_PAGES = 8; // safety cap on Anthropic pagination

/** Strip a trailing slash so we can join paths predictably. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  opts: ListModelsOptions,
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (!doFetch) throw new Error('no fetch implementation available');
  const timeoutMs = opts.timeoutMs ?? 6000;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { method: 'GET', headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

interface AnthropicModel {
  type?: string;
  id: string;
  display_name?: string;
  created_at?: string;
}
interface AnthropicModelsPage {
  data: AnthropicModel[];
  has_more?: boolean;
  last_id?: string | null;
}

async function fetchAnthropicModels(cred: Credential, opts: ListModelsOptions): Promise<Model[]> {
  const base = trimBase(cred.baseUrl ?? ANTHROPIC_DEFAULT_BASE);
  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
    ...(cred.headers ?? {}),
  };
  if (cred.kind === 'oauth') headers['authorization'] = `Bearer ${cred.token}`;
  else headers['x-api-key'] = cred.token;

  const out: Model[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ limit: '1000' });
    if (afterId) q.set('after_id', afterId);
    const json = (await fetchJson(`${base}/v1/models?${q}`, headers, opts)) as AnthropicModelsPage;
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const m of rows) {
      if (!m?.id) continue;
      const created = m.created_at ? Math.floor(Date.parse(m.created_at) / 1000) : undefined;
      out.push({
        id: m.id,
        provider: 'anthropic',
        ...(m.display_name ? { label: m.display_name } : {}),
        ...(created !== undefined && !Number.isNaN(created) ? { created } : {}),
      });
    }
    if (!json?.has_more || !json.last_id) break;
    afterId = json.last_id;
  }
  return out;
}

interface OpenAIModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}
interface OpenAIModelsList {
  object?: string;
  data: OpenAIModel[];
}

/** One entry of the ChatGPT/Codex backend `/models` response. */
interface CodexModel {
  slug: string;
  display_name?: string;
  /** 'list' = offered in the picker; 'hide' = internal (e.g. auto-review). */
  visibility?: string;
}
interface CodexModelsList {
  models: CodexModel[];
}

/**
 * List the models a ChatGPT/Codex subscription can use, via the same backend
 * request the `codex` CLI makes: `GET {codexBase}/models?client_version=1.0.0`
 * with the subscription Bearer, `originator`/`ChatGPT-Account-Id` (from
 * cred.headers) and a `version: 1.0.0` header. Drops non-listed models
 * (visibility !== 'list'); uses `slug` as the id and `display_name` as the label.
 */
async function fetchCodexSubscriptionModels(
  cred: Credential,
  opts: ListModelsOptions,
): Promise<Model[]> {
  const base = trimBase(cred.baseUrl ?? CODEX_BACKEND_BASE);
  const headers: Record<string, string> = {
    authorization: `Bearer ${cred.token}`,
    version: CODEX_CLIENT_VERSION,
    ...(cred.headers ?? {}),
  };
  const q = new URLSearchParams({ client_version: CODEX_CLIENT_VERSION });
  const json = (await fetchJson(`${base}/models?${q}`, headers, opts)) as CodexModelsList;
  const rows = Array.isArray(json?.models) ? json.models : [];
  const out: Model[] = [];
  // Preserve the backend's order (newest/most-preferred first) through the
  // shared `normalize()` sort by stamping a descending synthetic `created`.
  let rank = rows.length;
  for (const m of rows) {
    if (!m?.slug) continue;
    if (m.visibility && m.visibility !== 'list') continue;
    out.push({
      id: m.slug,
      provider: 'openai',
      ...(m.display_name ? { label: m.display_name } : {}),
      created: rank,
    });
    rank--;
  }
  return out;
}

async function fetchOpenAIModels(cred: Credential, opts: ListModelsOptions): Promise<Model[]> {
  // A ChatGPT/Codex subscription token isn't valid on api.openai.com — list its
  // models from the ChatGPT backend instead (same request the codex CLI makes).
  if (cred.kind === 'oauth') return fetchCodexSubscriptionModels(cred, opts);
  const base = trimBase(cred.baseUrl ?? OPENAI_DEFAULT_BASE);
  const headers: Record<string, string> = {
    authorization: `Bearer ${cred.token}`,
    ...(cred.headers ?? {}),
  };
  const json = (await fetchJson(`${base}/v1/models`, headers, opts)) as OpenAIModelsList;
  const rows = Array.isArray(json?.data) ? json.data : [];
  const out: Model[] = [];
  for (const m of rows) {
    if (!m?.id || !isOpenAIChatModel(m.id)) continue;
    out.push({
      id: m.id,
      provider: 'openai',
      ...(typeof m.created === 'number' ? { created: m.created } : {}),
    });
  }
  return out;
}

/** Dedupe by id and sort newest-first (by `created`), then alphabetically. */
function normalize(models: Model[]): Model[] {
  const byId = new Map<string, Model>();
  for (const m of models) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => {
    if (a.created !== undefined && b.created !== undefined && a.created !== b.created)
      return b.created - a.created;
    if (a.created !== undefined && b.created === undefined) return -1;
    if (a.created === undefined && b.created !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });
}

// ────────────────────────────────────────────────── public: uncached ───────

/**
 * Fetch the live model list for `provider` using `cred`. Returns `source:'api'`
 * on success (with ≥1 model), or `source:'fallback'` if the fetch fails / returns
 * nothing. Never throws — a failed fetch degrades to the built-in list.
 */
export async function fetchModels(
  provider: ProviderId,
  cred: Credential,
  opts: ListModelsOptions = {},
): Promise<ListModelsResult> {
  try {
    let models: Model[];
    if (provider === 'anthropic') models = await fetchAnthropicModels(cred, opts);
    else if (provider === 'openai') models = await fetchOpenAIModels(cred, opts);
    else models = [];
    models = normalize(models);
    if (models.length === 0) return fallbackResult(provider);
    return { provider, source: 'api', models };
  } catch {
    return fallbackResult(provider);
  }
}

// ──────────────────────────────────────────────── public: cached ───────────

const cache = new Map<string, ListModelsResult>();

/** Non-reversible fingerprint of the token so the cache key never holds a secret. */
function tokenFingerprint(token: string): string {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(provider: ProviderId, cred: Credential): string {
  return `${provider}:${cred.kind}:${tokenFingerprint(cred.token)}`;
}

/**
 * List models for the current provider/credential — the function the TUI's
 * `/model` picker consumes. Cached per session (keyed by provider + auth kind +
 * token fingerprint); pass `{ force: true }` after a `/provider` switch or to
 * refresh. Returns `Model[]` (fetched or fallback); never throws.
 */
export async function listModels(
  provider: ProviderId,
  cred: Credential,
  opts: ListModelsOptions = {},
): Promise<Model[]> {
  const key = cacheKey(provider, cred);
  if (!opts.force) {
    const hit = cache.get(key);
    if (hit) return hit.models;
  }
  const result = await fetchModels(provider, cred, opts);
  // Only cache a successful live fetch — a transient failure shouldn't pin the
  // fallback list for the whole session.
  if (result.source === 'api') cache.set(key, result);
  return result.models;
}

/** Clear the session model cache (e.g. on auth change or for tests). */
export function clearModelCache(): void {
  cache.clear();
}
