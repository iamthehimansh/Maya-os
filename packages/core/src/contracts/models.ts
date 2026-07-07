/**
 * Maya contract: models & the gateway (Layer 1–2).
 *
 * Rule 1 of the platform: agents and every other layer consume models ONLY
 * through the gateway, addressed by ModelId. Nothing above the gateway may
 * know (or care) which runtime serves a request.
 */

/** Where a model is served from. `local` = our own GGUF runtime. */
export type ModelProvider =
  | 'local'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'together'
  | 'deepseek'
  | 'nvidia';

/** e.g. "local/qwen3-32b", "anthropic/claude-sonnet-5", "openai/gpt-5". */
export type ModelId = `${ModelProvider}/${string}`;

/** Quantization ladder for local GGUF models, best → smallest. */
export type Quant = 'F16' | 'Q8_0' | 'Q6_K' | 'Q5_K_M' | 'Q4_K_M' | 'Q3_K_M';

/** A locally installed GGUF model (one file may exist in several quants). */
export interface LocalModel {
  /** Stable name half of the ModelId: `local/<name>`. */
  name: string;
  /** HuggingFace repo or URL it was pulled from. */
  source: string;
  /** Quants present on disk, with file paths + sizes. */
  files: Array<{ quant: Quant; path: string; bytes: number }>;
  contextLength: number;
  /** Chat template family (llama.cpp `--chat-template` value) if known. */
  chatTemplate?: string;
}

export type RuntimeBackend = 'llama.cpp' | 'mlx';

/** Lifecycle of one serving process (one model instance on one port). */
export type InstanceState =
  | 'starting'
  | 'ready'
  | 'degraded'   // running, but the manager downgraded quant/context to fit RAM
  | 'unhealthy'  // failing health checks; manager will restart or kill
  | 'stopping'
  | 'stopped';

export interface ModelInstance {
  id: string;
  model: ModelId;
  backend: RuntimeBackend;
  state: InstanceState;
  port: number;
  pid: number;
  /** Quant actually being served (manager may have chosen lower than asked). */
  quant?: Quant;
  contextLength: number;
  /** RSS bytes as last sampled by the manager. */
  memoryBytes: number;
  startedAt: string; // ISO 8601
}

/**
 * Guardrails the Runtime Manager enforces so a model can never brick the Mac.
 * Defaults live in core config; every field overridable per model profile.
 */
export interface GuardrailPolicy {
  /** Never let free system RAM drop below this many bytes; degrade first. */
  minFreeRamBytes: number;
  /** Prefer degrading quant (Q8→Q4) over refusing to load. */
  autoDowngradeQuant: boolean;
  /** Shrink context window before refusing to load. */
  autoShrinkContext: boolean;
  /** Health-check cadence + how long a hung process gets before SIGKILL. */
  healthCheckIntervalMs: number;
  hungProcessTimeoutMs: number;
  /** Max automatic restarts within `restartWindowMs` before giving up. */
  maxRestarts: number;
  restartWindowMs: number;
}

/** What the gateway exposes. Paths are fixed contracts, versioned by /v1. */
export interface GatewaySurface {
  /** OpenAI-compatible: POST /v1/chat/completions, GET /v1/models, … */
  openaiBaseUrl: string;
  /** Anthropic-compatible: POST /v1/messages — lets Claude Code target any ModelId. */
  anthropicBaseUrl: string;
}
