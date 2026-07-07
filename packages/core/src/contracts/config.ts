/**
 * Maya contract: platform config & persistence (core). Owner: shared (02 scaffolds, 01 reviews).
 */

import type { GuardrailPolicy, ModelProvider } from "./models.js";

/** Cloud providers configurable in ~/.maya/config.json (local runtime is built in). */
export type CloudProvider = Exclude<ModelProvider, "local">;

export interface ProviderConfig {
  id: CloudProvider | (string & {}); // open for plugin providers
  baseUrl?: string; // override / proxy (e.g. NVIDIA's OpenAI-compat proxy)
  apiKeyEnv?: string; // name of the env var holding the key — NEVER the key itself
  enabled: boolean;
}

/** Shape of ~/.maya/config.json (defaults + loader live in @maya-ai/core/config). */
export interface PlatformConfig {
  gateway: { port: number }; // default 4100
  dashboard: { port: number }; // default 4200
  bus: { port: number }; // Maya's own bus (packages/bus), default 4300
  orchestrator: { port: number }; // agent-plane service (packages/orchestrator), default 4400
  modelsDir: string; // default ~/.maya/models
  providers: ProviderConfig[];
  guardrails: GuardrailPolicy;
}

/**
 * SQLite (~/.maya/maya.db) — core owns the schema; packages access it only
 * through core's repo layer, never raw SQL:
 *   projects(id, name, root, created_at)
 *   teams(id, project_id, name, topology, channel_id)
 *   agents(id, team_id, adapter, model_id, state, cwd, pid, created_at)
 *   tasks(id, team_id, parent_id, spec, state, assignee_agent_id, result, created_at, updated_at)
 *   model_profiles(model_id, quant, context_length, guardrail_overrides_json)   ← model plane
 *   runtime_samples(ts, model_id, rss_bytes, tokens_per_sec)                    ← model plane
 */
