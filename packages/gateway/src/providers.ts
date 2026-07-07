import type { ModelId, ProviderConfig } from "@maya-ai/core";

/**
 * Cloud provider registry (model plane). A provider is LIVE when its API-key
 * env var is set (or a ProviderConfig enables it with a custom baseUrl) —
 * zero-config for the common case, keys never stored, only env names.
 * All of these speak OpenAI chat-completions natively except Anthropic,
 * which is served natively on /v1/messages (and via Switchyard for /v1).
 */
export interface ProviderDef {
  id: string;
  kind: "openai-compat" | "anthropic";
  defaultBaseUrl: string;
  defaultKeyEnv: string;
}

export const PROVIDERS: ProviderDef[] = [
  { id: "openai", kind: "openai-compat", defaultBaseUrl: "https://api.openai.com/v1", defaultKeyEnv: "OPENAI_API_KEY" },
  { id: "groq", kind: "openai-compat", defaultBaseUrl: "https://api.groq.com/openai/v1", defaultKeyEnv: "GROQ_API_KEY" },
  { id: "together", kind: "openai-compat", defaultBaseUrl: "https://api.together.xyz/v1", defaultKeyEnv: "TOGETHER_API_KEY" },
  { id: "deepseek", kind: "openai-compat", defaultBaseUrl: "https://api.deepseek.com/v1", defaultKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "nvidia", kind: "openai-compat", defaultBaseUrl: "https://integrate.api.nvidia.com/v1", defaultKeyEnv: "NVIDIA_API_KEY" },
  { id: "gemini", kind: "openai-compat", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultKeyEnv: "GEMINI_API_KEY" },
  { id: "anthropic", kind: "anthropic", defaultBaseUrl: "https://api.anthropic.com", defaultKeyEnv: "ANTHROPIC_API_KEY" },
];

export interface ResolvedProvider {
  def: ProviderDef;
  baseUrl: string;
  apiKey: string;
  /** The provider-native model name (ModelId with the prefix stripped). */
  upstreamModel: string;
}

/**
 * Resolve a cloud ModelId ("openai/gpt-5.2") to a callable upstream, or a
 * typed reason string when it can't be served. User ProviderConfig entries
 * override baseUrl/keyEnv; the env var itself is the on/off switch.
 */
export function resolveProvider(
  model: ModelId,
  userConfigs: ProviderConfig[],
): ResolvedProvider | { error: string; status: 400 | 503 } {
  const slash = model.indexOf("/");
  if (slash === -1) return { error: `model must be a Maya ModelId like "openai/gpt-5.2" (got: ${model})`, status: 400 };
  const providerId = model.slice(0, slash);
  const upstreamModel = model.slice(slash + 1);
  if (!upstreamModel) return { error: `empty model name in ${model}`, status: 400 };

  const def = PROVIDERS.find((p) => p.id === providerId);
  if (!def) {
    const known = ["local", ...PROVIDERS.map((p) => p.id)].join(", ");
    return { error: `unknown provider "${providerId}" — known: ${known}`, status: 400 };
  }
  const user = userConfigs.find((c) => c.id === providerId);
  const keyEnv = user?.apiKeyEnv ?? def.defaultKeyEnv;
  const apiKey = process.env[keyEnv] ?? "";
  if (!apiKey) {
    return {
      error: `provider "${providerId}" is not configured — export ${keyEnv} in the environment running \`maya serve\``,
      status: 503,
    };
  }
  return { def, baseUrl: (user?.baseUrl ?? def.defaultBaseUrl).replace(/\/+$/, ""), apiKey, upstreamModel };
}
