import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { availableRam } from "@maya-ai/model-runtime";
import type { SystemInfo } from "./types.js";

const execFileP = promisify(execFile);
const GB = 1024 ** 3;

/**
 * Memory bandwidth per Apple Silicon chip, GB/s (Apple's published figures).
 *
 * This table is the single most load-bearing constant in the package. Local
 * decode is memory-bound: each generated token reads the entire active weight
 * set out of RAM, so tok/s ≈ bandwidth ÷ model-GB. An M2 (100 GB/s) and an
 * M2 Max (400 GB/s) run the same 7B model at a 4× difference in speed while
 * having identical "will it fit" answers — bandwidth is what separates a model
 * that *fits* from one that's actually pleasant to use.
 */
const APPLE_BANDWIDTH: Record<string, number> = {
  m1: 68,
  "m1 pro": 200,
  "m1 max": 400,
  "m1 ultra": 800,
  m2: 100,
  "m2 pro": 200,
  "m2 max": 400,
  "m2 ultra": 800,
  m3: 100,
  "m3 pro": 150,
  "m3 max": 400, // 300 on the 30-core-GPU bin; disambiguated by GPU cores below
  "m3 ultra": 800,
  m4: 120,
  "m4 pro": 273,
  "m4 max": 546, // 410 on the 32-core-GPU bin
  "m4 ultra": 1092,
  m5: 153,
  "m5 pro": 300,
  "m5 max": 600,
};

/**
 * Binned Max variants: Apple ships the same chip name at two different memory
 * configs, and the cheaper bin is ~25% slower. GPU-core count is what tells
 * them apart, so when we can read it we correct the table's optimistic default.
 */
const MAX_BINS: Record<string, Array<{ maxGpuCores: number; gbs: number }>> = {
  "m3 max": [{ maxGpuCores: 30, gbs: 300 }],
  "m4 max": [{ maxGpuCores: 32, gbs: 410 }],
};

/** Fallback when the chip name is unknown: Apple's GPU-core count tracks bandwidth. */
function bandwidthFromGpuCores(gpuCores: number): number {
  if (gpuCores <= 10) return 100;
  if (gpuCores <= 20) return 200;
  if (gpuCores <= 40) return 400;
  return 800;
}

/**
 * Resolve bandwidth for an Apple chip. Exported so the scoring tests can pin
 * the M2 Pro = 200 GB/s expectation without spawning `sysctl`.
 */
export function appleBandwidthGbs(chip: string, gpuCores?: number): number {
  const key = chip.toLowerCase().replace(/^apple\s+/, "").trim();
  const base = APPLE_BANDWIDTH[key];
  if (base === undefined) {
    return gpuCores ? bandwidthFromGpuCores(gpuCores) : 100;
  }
  if (gpuCores !== undefined) {
    for (const bin of MAX_BINS[key] ?? []) {
      if (gpuCores <= bin.maxGpuCores) return bin.gbs;
    }
  }
  return base;
}

async function sysctl(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("sysctl", ["-n", key], { timeout: 3_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** GPU core count via system_profiler. Best-effort: it's slow and can be absent. */
async function appleGpuCores(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP("system_profiler", ["SPDisplaysDataType"], {
      timeout: 8_000,
    });
    const m = /Total Number of Cores:\s*(\d+)/.exec(stdout);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** NVIDIA VRAM + name, when nvidia-smi is on PATH. */
async function nvidia(): Promise<{ name: string; vramGb: number } | undefined> {
  try {
    const { stdout } = await execFileP(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5_000 },
    );
    const line = stdout.trim().split("\n")[0];
    if (!line) return undefined;
    const [name, mib] = line.split(",").map((s) => s.trim());
    if (!name || !mib) return undefined;
    return { name, vramGb: round1(Number(mib) / 1024) };
  } catch {
    return undefined;
  }
}

/**
 * Probe the host. Async because it shells out (`sysctl`, `system_profiler`,
 * `nvidia-smi`); the ranking engine itself stays pure and synchronous, so a
 * server can detect once, cache, and rank per request.
 *
 * `MAYA_FAKE_*` env overrides let tests and the chaos suite pin a machine.
 */
export async function detectHardware(): Promise<SystemInfo> {
  const platform = process.platform;
  const totalRamGb = round1(os.totalmem() / GB);
  const ram = await availableRam();
  const availableRamGb = round1(ram.availableBytes / GB);
  const cpuCores = os.cpus().length || 1;

  const isAppleSilicon = platform === "darwin" && process.arch === "arm64";

  if (isAppleSilicon) {
    const chip = (await sysctl("machdep.cpu.brand_string")) ?? "Apple Silicon";
    const gpuCores = await appleGpuCores();
    return {
      platform,
      chip,
      isAppleSilicon: true,
      cpuCores,
      ...(gpuCores !== undefined ? { gpuCores } : {}),
      totalRamGb,
      availableRamGb,
      memoryBandwidthGbs: appleBandwidthGbs(chip, gpuCores),
      // Unified memory: RAM *is* VRAM, so vramGb is deliberately left unset.
      backend: "metal",
    };
  }

  const gpu = await nvidia();
  if (gpu) {
    return {
      platform,
      chip: gpu.name,
      isAppleSilicon: false,
      cpuCores,
      totalRamGb,
      availableRamGb,
      // Discrete GPUs read weights from VRAM (GDDR6/HBM), which is far faster
      // than system DDR. A precise per-card table is out of scope; this is a
      // conservative mid-range GDDR6 figure.
      memoryBandwidthGbs: 500,
      backend: "cuda",
      vramGb: gpu.vramGb,
    };
  }

  const chip = os.cpus()[0]?.model?.trim() || `${platform}/${process.arch}`;
  return {
    platform,
    chip,
    isAppleSilicon: false,
    cpuCores,
    totalRamGb,
    availableRamGb,
    // Dual-channel DDR4/DDR5 — why CPU-only inference is slow no matter the core count.
    memoryBandwidthGbs: 50,
    backend: "cpu",
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
