/**
 * @maya-ai/model-runtime — the Runtime Manager (Layers 1–2, model plane / 02).
 *
 * Node supervises native inference processes (llama-server now, MLX later);
 * JS never sits in the token path. Guardrail stance: degrade quant/context
 * under RAM pressure — never crash the host; kill + restart hung processes.
 */
export { detectLlamaCpp, llamaServerArgs } from "./backends/llamacpp.js";
export { pullModel, type PullRequest } from "./download.js";
export { estimateLoadBytes, planFit, type FitPlan } from "./estimate.js";
export { RuntimeManager, type LoadOpts } from "./manager.js";
export { availableRam, processRss, sampleRam, type RamSnapshot } from "./ram.js";
export { findModel, quantFromFilename, quantLadderFrom, scanModels, writeModelMeta } from "./registry.js";
export { InstanceSupervisor, type SupervisorEvent, type SupervisorOpts } from "./supervisor.js";
