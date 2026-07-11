/**
 * @maya-ai/harness — public barrel.
 *
 * Everything downstream (CLI, TUI, embedders) imports from here.
 */
export * from './types.js';
export { PROVIDER_CATALOG, createProvider, listProviders } from './providers/index.js';
export { resolveAuth, detectAuth } from './auth/index.js';
export { createSession } from './loop/index.js';
export { listModels, fetchModels, clearModelCache } from './models/index.js';
export type { Model, ListModelsResult, ListModelsOptions } from './models/index.js';
export { builtinTools } from './tools/index.js';
export { SYSTEM_PROMPT } from './prompt.js';
