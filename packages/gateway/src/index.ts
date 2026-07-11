/**
 * @maya-ai/gateway — one endpoint for every model (model plane / 02).
 *
 * OpenAI-compatible /v1 over local GGUF instances (cloud providers + the
 * Anthropic-compatible surface arrive with M2), plus the admin control API
 * (/api/models, pull, load/unload, health, SSE runtime events). Local chat is
 * a zero-copy stream passthrough — JS never parses token deltas.
 */
export { createGateway, startGateway, type GatewayDeps } from "./server.js";
export { detectSwitchyard, provisionSwitchyard, generateSwitchyardConfig, startSwitchyard, SWITCHYARD_PORT, type SidecarHandle, type SwitchyardInfo } from "./switchyard.js";
export { PROVIDERS, resolveProvider, type ProviderDef, type ResolvedProvider } from "./providers.js";
export {
  buildSuggestions,
  parseSuggestQuery,
  enrich,
  SORT_BY,
  USE_CASES,
  type HwfitEngine,
  type Recommendation,
  type SortBy,
  type SuggestQuery,
  type SuggestResponse,
  type Suggestion,
  type SystemInfo,
  type UseCase,
} from "./suggest.js";
