# Research memo: big models, fast + accurate, on low resources

Owner ask (2026-07-08): "load big models fast with accuracy, good context, low
resources — pull recent papers to build it." Curated set below, each mapped to
a concrete Maya lever. Levers marked **shipped** already exist on `main`.

## The papers

| # | Paper | What it shows | Maya lever |
|---|-------|---------------|-----------|
| 1 | [EAGLE-3 (NeurIPS 2025)](https://arxiv.org/pdf/2503.01840) | Draft-head speculative decoding: 2–6.5× decode speedup, output-identical | Biggest single speed win. llama.cpp lacks EAGLE-3 ([#15902](https://github.com/ggml-org/llama.cpp/discussions/15902)) but supports classic draft-model speculation today → ship draft-pairing now (0.5B drafts for 7–12B targets), EAGLE-3 via MLX later |
| 2 | [SpecExec (2024)](https://arxiv.org/pdf/2406.02532) | Speculative decoding tuned for consumer devices with RAM offloading — interactive 70B on a desktop | Confirms speculation works *with* offloading; informs draft-pair defaults per RAM tier |
| 3 | [KV cache compression review (2025)](https://arxiv.org/pdf/2508.06297) | Survey: quantized/evicted/compressed KV — memory is the context bottleneck | **shipped**: q8_0 K/V + flash-attn defaults (halves KV). Next: eviction policies |
| 4 | [MixKVQ (2025)](https://arxiv.org/pdf/2512.19206) | Query-aware mixed-precision KV for long-context reasoning — low bits without reasoning collapse | Phase 11: per-layer KV precision ladder (q8 → mixed q4) = 2× more context in the same RAM |
| 5 | [VecInfer (2025)](https://arxiv.org/pdf/2510.06175) | Outlier-suppressed vector quantization gets KV to very low bits | Same lever as #4, stronger compression point |
| 6 | [KV Pareto (2025)](https://arxiv.org/pdf/2512.01953) | Jointly tuning weight-quant × KV-quant × context beats tuning each alone | Exactly our fit planner's job: make the guardrail solver 2-D (weights × KV) instead of 1-D |
| 7 | [Low-bit QAT for reasoning — systematic study (2026)](https://arxiv.org/pdf/2601.14888) | Official QAT checkpoints keep reasoning accuracy at 4-bit far better than post-hoc quant | Catalog policy: **prefer official QAT GGUFs** when they exist (e.g. Gemma QAT) + imatrix/AWQ-scaled quants otherwise — accuracy per GB is a ranking, not luck |
| 8 | [Prima.cpp (2025)](https://arxiv.org/html/2504.08791v2) | 30–70B on low-resource home machines: layer-window offload (VRAM→RAM→disk via mmap) + pipelined ring | Phase 14 lever: run models *bigger than RAM* by paging layer windows; also validates multi-Mac distribution |
| 9 | [PowerInfer (2023)](https://arxiv.org/pdf/2312.12456) | Hot/cold neuron split: keep hot activations resident, stream cold — consumer-GPU speedups | Same family as #8; activation locality is the reason layer paging isn't catastrophically slow |
| 10 | [MCAP (2026)](https://arxiv.org/pdf/2604.21026) | Deployment-time layer profiling → per-layer precision dispatch under a memory cap | Refines #8: not all layers deserve equal bits; pairs with our model profiles |
| 11 | [MoE-SpeQ (2025)](https://arxiv.org/pdf/2511.14102) | Speculative quantized decoding + proactive expert prefetch for MoE offloading | Future: MoE GGUFs (Mixtral/Qwen-MoE class) on 16GB via expert paging |
| 12 | [Taming the Titans — serving survey (2025)](https://arxiv.org/pdf/2504.19720) | Systems map of the whole serving space | Grounding reference for Phase 11/13 planning |

## What this means for Maya, ordered by value ÷ effort

1. **Draft-model speculation now** (llama-server `--model-draft`): pair every
   7–12B catalog entry with a compatible 0.5–1B draft; expect ~1.5–2.5× decode
   speedup, zero accuracy change (speculation is verify-then-accept).
2. **Quant-quality ranking in the catalog** (#7): prefer official QAT > imatrix
   > plain quants at equal bits; surface "accuracy per GB" in the picker.
3. **2-D fit planner** (#6): solve weights-quant × KV-quant × context jointly —
   the guardrail stops being a ladder and becomes a small optimizer.
4. **Mixed-precision KV** (#4/#5): next context doubling after q8.
5. **Layer-window offload** (#8/#9/#10): the "run 30B on 16GB" moonshot —
   Phase 14, prototype behind a flag.
6. **Loading speed**: llama.cpp already mmaps lazily (load ≈ instant; the cost
   is first-token page-in). Lever = keep-alive + warm-up policy + predictive
   preload of the user's daily-driver model, not a new loader.

Fast + accurate + long context on low resources isn't one trick — it's these
levers composed, chosen per machine by the fit planner. That composition IS
Maya's runtime-manager moat.
