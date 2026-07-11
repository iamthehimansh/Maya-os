import type { CatalogModel, SystemInfo } from "../src/types.js";

/**
 * Machines under test. Pinned literals, never `detectHardware()` — a test that
 * probed the host would pass on the author's laptop and fail in CI, and the
 * whole point of the engine being pure is that we can assert against an exact
 * machine.
 */

/** himansh's actual machine — the one the brief's definition of done names. */
export const M2_PRO_16: SystemInfo = {
  platform: "darwin",
  chip: "Apple M2 Pro",
  isAppleSilicon: true,
  cpuCores: 10,
  gpuCores: 16,
  totalRamGb: 16,
  availableRamGb: 4.9,
  memoryBandwidthGbs: 200,
  backend: "metal",
};

/** Same silicon generation, 4× the bandwidth and 4× the RAM. */
export const M2_ULTRA_64: SystemInfo = {
  platform: "darwin",
  chip: "Apple M2 Ultra",
  isAppleSilicon: true,
  cpuCores: 24,
  gpuCores: 60,
  totalRamGb: 64,
  availableRamGb: 40,
  memoryBandwidthGbs: 800,
  backend: "metal",
};

/** Discrete GPU: VRAM is the budget, and overspill means `hybrid`, not `gpu`. */
export const RTX_4070_12: SystemInfo = {
  platform: "linux",
  chip: "NVIDIA GeForce RTX 4070",
  isAppleSilicon: false,
  cpuCores: 16,
  totalRamGb: 32,
  availableRamGb: 24,
  memoryBandwidthGbs: 500,
  backend: "cuda",
  vramGb: 12,
};

export const CPU_BOX_8: SystemInfo = {
  platform: "linux",
  chip: "Intel Xeon",
  isAppleSilicon: false,
  cpuCores: 8,
  totalRamGb: 8,
  availableRamGb: 6,
  memoryBandwidthGbs: 50,
  backend: "cpu",
};

/**
 * A catalog model with sane defaults; override just what a test cares about.
 *
 * `verified: true` by default — it stands in for a seed model, i.e. one whose
 * lineage we've vouched for. Tests that care about the unverified path (a repo
 * from a stranger claiming to be Qwen) must opt in with `verified: false`.
 */
export function model(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    name: "test-7b",
    displayName: "Test 7B",
    provider: "qwen",
    paramsB: 7,
    isMoe: false,
    arch: "qwen2.5",
    contextLength: 32768,
    coding: true,
    verified: true,
    hfRepo: "Test/Test-7B-GGUF",
    ggufFiles: {
      Q8_0: "test-7b-q8_0.gguf",
      Q4_K_M: "test-7b-q4_k_m.gguf",
      Q3_K_M: "test-7b-q3_k_m.gguf",
    },
    ...over,
  };
}
