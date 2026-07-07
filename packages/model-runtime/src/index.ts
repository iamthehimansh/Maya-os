/**
 * @maya-ai/model-runtime — the Runtime Manager (Layers 1–2, model plane / 02).
 *
 * Node supervises native inference processes (llama-server now, MLX later);
 * JS never sits in the token path. M1 lands: instance lifecycle, GGUF pulls,
 * health checks, and GuardrailPolicy enforcement (degrade quant/context under
 * RAM pressure — never crash the host; kill + restart hung processes).
 */
export const MODEL_RUNTIME_MILESTONE = "M1";
