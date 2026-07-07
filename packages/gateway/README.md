# @maya-ai/gateway

One port (default 4100), every model (model plane, lane 02): OpenAI-compatible
`/v1/*` + Anthropic-compatible `/v1/messages`, routed by `ModelId` to local
llama-server instances or cloud providers, plus the admin control API
(`/api/models`, pull/load/unload, health, SSE runtime events).
Contracts: `@maya-ai/core/contracts` (`models.ts`).
