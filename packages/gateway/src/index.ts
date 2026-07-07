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
