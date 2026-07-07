# @maya-ai/model-runtime

Runtime Manager (model plane, lane 02). Supervises `llama-server` (Metal) child
processes — spawn, health, RAM guardrails (degrade before refusing, never crash
the host), GGUF pulls from HuggingFace. MLX backend is phase 2 behind the same
`RuntimeBackend` seam. Contracts: `@maya-ai/core/contracts` (`models.ts`).
