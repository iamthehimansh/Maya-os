/**
 * Maya cross-plane contracts.
 *
 * Plane ownership: MODEL PLANE = agent 02 · AGENT PLANE = agent 01 · CORE = shared (02 scaffolds, 01 reviews).
 * Everything above the gateway sees ONLY OpenAI-compatible HTTP. Everything below never knows who's calling.
 * The bus is Maya's OWN implementation (packages/bus, agent plane) — wire-protocol inspired by
 * walkie-talkie, but no external bus dependency. `~/work/colate/cana-web` is read-only reference.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. MODEL PLANE (02 builds, everyone consumes via the gateway)
// ─────────────────────────────────────────────────────────────────────────────

/** Namespaced model reference — the ONLY way any layer names a model. */
export type ModelRef = string; // "local/qwen3-14b-q4" | "anthropic/claude-sonnet-5" | "openai/gpt-5.2" | "groq/…" | "nvidia/…"

export type ModelKind = "local-gguf" | "cloud";
export type ModelState = "stopped" | "loading" | "running" | "degraded" | "failed";

export interface ModelInfo {
  ref: ModelRef;
  kind: ModelKind;
  state: ModelState; // cloud models are always "running"
  displayName: string;
  contextLength?: number;
  /** local only ↓ */
  quant?: string; // "Q4_K_M" — may differ from requested after auto-degrade
  requestedQuant?: string;
  memoryBytesEst?: number; // planning estimate
  memoryBytesRss?: number; // live RSS of llama-server
  port?: number; // upstream llama-server port (internal)
  tokensPerSec?: number; // rolling perf sample
}

/**
 * Gateway HTTP surface (one port, default 4100):
 *   OpenAI-compat:    POST /v1/chat/completions · GET /v1/models · (later) /v1/embeddings
 *   Anthropic-compat: POST /v1/messages   ← coding agents point ANTHROPIC_BASE_URL here,
 *                     model field = ModelRef, so Claude Code can run on ANY model incl. local GGUF
 *   Control (admin bearer; used by CLI/dashboard/orchestrator):
 *     GET    /api/models                     → ModelInfo[]
 *     POST   /api/models/pull                { source: "hf:<repo>/<file>.gguf" | url, ref }  → job id (SSE progress)
 *     POST   /api/models/:ref/load           { quant?, contextLength? }   idempotent
 *     POST   /api/models/:ref/unload
 *     GET    /api/runtime/health             → { ramFreeBytes, ramTotalBytes, models: ModelInfo[] }
 *     GET    /api/events (SSE)               → RuntimeEvent stream
 */
export type RuntimeEvent =
  | { type: "model_state"; ref: ModelRef; state: ModelState; reason?: string }
  | { type: "model_degraded"; ref: ModelRef; from: string; to: string; reason: "ram_pressure" | "load_failure" }
  | { type: "model_restarted"; ref: ModelRef; attempt: number }
  | { type: "ram_pressure"; freeBytes: number; action: "none" | "degrade" | "unload_lru" }
  | { type: "pull_progress"; ref: ModelRef; pct: number };

/** Guardrail policy knobs (config, enforced by the runtime manager). No shortcuts: degrade, never crash. */
export interface GuardrailPolicy {
  minFreeRamBytes: number; // never load past this floor (default: 2 GiB)
  autoDegradeQuant: boolean; // Q8→Q6→Q4… instead of failing (default: true)
  autoUnloadLruAfterSec: number; // idle model eviction (default: 1800)
  maxRestartAttempts: number; // crashed llama-server (default: 3, then state=failed)
  hungTimeoutSec: number; // no token progress → kill (default: 120)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. AGENT PLANE (01 builds — dashboard/orchestrator consume)
// ─────────────────────────────────────────────────────────────────────────────

export type AdapterId = "claude-code" | "codex" | "opencode" | (string & {});
export type AgentState = "spawning" | "running" | "paused" | "waiting_input" | "exited" | "failed";

export interface AgentSpawnOpts {
  adapter: AdapterId;
  model: ModelRef; // resolved via gateway; adapter maps to its native env (e.g. ANTHROPIC_BASE_URL → gateway)
  cwd: string; // workspace dir for this agent
  task?: string; // initial prompt/instruction
  env?: Record<string, string>;
  bus?: { wsBase: string; channelId: string; token: string; handle?: string }; // auto-join the Maya bus
  permissionMode?: "ask" | "auto"; // maps to e.g. --dangerously-skip-permissions
}

export interface AgentLogEvent {
  ts: number;
  stream: "stdout" | "stderr" | "system";
  line: string;
}

export interface AgentHandle {
  id: string; // "ag_<nanoid>"
  adapter: AdapterId;
  pid?: number;
  state(): AgentState;
  pause(): Promise<void>; // SIGSTOP or adapter-native
  resume(): Promise<void>;
  kill(graceMs?: number): Promise<void>;
  send(input: string): Promise<void>; // write to agent stdin/PTY
  logs(opts?: { tail?: number }): AsyncIterable<AgentLogEvent>;
  on(ev: "state" | "log" | "exit", fn: (e: unknown) => void): void;
}

export interface AgentAdapter {
  id: AdapterId;
  detect(): Promise<{ installed: boolean; version?: string; installHint?: string }>;
  spawn(opts: AgentSpawnOpts): Promise<AgentHandle>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. LOOP PROTOCOL (01 builds — structured bodies over the Maya bus)
//    Envelope = bus message frame; body.kind discriminates. Transport-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

export interface ArtifactRef {
  id: string;
  kind: "file" | "diff" | "url" | "report";
  path?: string;
  url?: string;
  title: string;
}

export type LoopBody =
  | { kind: "task_assign"; taskId: string; spec: string; deps?: string[]; deadlineTs?: number }
  | { kind: "task_accept"; taskId: string }
  | { kind: "task_progress"; taskId: string; pct?: number; note: string }
  | { kind: "task_done"; taskId: string; summary: string; artifacts?: ArtifactRef[] }
  | { kind: "task_failed"; taskId: string; error: string; retryable: boolean }
  | { kind: "question"; qid: string; prompt: string; options?: { id: string; label: string }[] } // lead→human only when it truly must
  | { kind: "answer"; qid: string; optionId?: string; text?: string }
  | { kind: "artifact"; ref: ArtifactRef };

// ─────────────────────────────────────────────────────────────────────────────
// 4. CORE / PERSISTENCE (shared)
// ─────────────────────────────────────────────────────────────────────────────

/** ~/.maya/config.json */
export interface PlatformConfig {
  gateway: { port: number }; // default 4100
  bus: { port: number }; // Maya's own bus (packages/bus), default 4300
  dashboard: { port: number }; // default 4200
  modelsDir: string; // default ~/.maya/models
  providers: ProviderConfig[];
  guardrails: GuardrailPolicy;
}

export interface ProviderConfig {
  id: "openai" | "anthropic" | "gemini" | "deepseek" | "groq" | "together" | "nvidia" | (string & {});
  baseUrl?: string; // override / proxy
  apiKeyEnv?: string; // name of the env var — NEVER the key itself
  enabled: boolean;
}

/**
 * SQLite (~/.maya/maya.db) — core owns the schema; planes own their tables:
 *   projects(id, name, root, created_at)
 *   teams(id, project_id, name, topology, channel_id)
 *   agents(id, team_id, adapter, model_ref, state, cwd, pid, created_at)
 *   tasks(id, team_id, parent_id, spec, state, assignee_agent_id, result, created_at, updated_at)
 *   model_profiles(ref, quant, context_length, guardrail_overrides_json)   ← model plane
 *   runtime_samples(ts, ref, rss_bytes, tokens_per_sec)                    ← model plane
 */
