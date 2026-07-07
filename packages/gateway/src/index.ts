/**
 * @maya-ai/gateway — one endpoint for every model (model plane / 02).
 *
 * OpenAI-compatible /v1 + Anthropic-compatible /v1/messages over local GGUF
 * instances and enabled cloud providers, addressed by ModelId
 * ("local/…", "anthropic/…"). Coding agents point ANTHROPIC_BASE_URL here to
 * run on ANY configured model. M1 lands: chat completions passthrough +
 * control API (/api/models, pull, load/unload, health, SSE events).
 */
export const GATEWAY_MILESTONE = "M1";
