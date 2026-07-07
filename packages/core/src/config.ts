import fs from "node:fs";
import path from "node:path";
import type { CloudProvider, GuardrailPolicy, PlatformConfig } from "./contracts/index.js";
import { configPath, mayaHome, modelsDir } from "./paths.js";

const GIB = 1024 ** 3;

/** Conservative defaults — must be safe on an 8GB M1 (all M-series is the target). */
export const defaultGuardrails = (): GuardrailPolicy => ({
  minFreeRamBytes: 2 * GIB,
  autoDowngradeQuant: true,
  autoShrinkContext: true,
  healthCheckIntervalMs: 5_000,
  hungProcessTimeoutMs: 120_000,
  maxRestarts: 3,
  restartWindowMs: 600_000,
});

const CLOUD_PROVIDERS: CloudProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "together",
  "deepseek",
  "nvidia",
];

export const defaultConfig = (): PlatformConfig => ({
  gateway: { port: 4100 },
  dashboard: { port: 4200 },
  bus: { port: 4300 },
  modelsDir: modelsDir(),
  providers: CLOUD_PROVIDERS.map((id) => ({
    id,
    apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
    enabled: false,
  })),
  guardrails: defaultGuardrails(),
});

/** Deep-merge a partial user config over defaults; unknown keys are preserved. */
function merge<T extends Record<string, unknown>>(base: T, over: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (v && cur && typeof v === "object" && typeof cur === "object" && !Array.isArray(v) && !Array.isArray(cur)) {
      out[k] = merge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** Load ~/.maya/config.json merged over defaults. Missing/invalid file → defaults (never throws). */
export function loadConfig(): PlatformConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const user = JSON.parse(raw) as Partial<PlatformConfig>;
    return merge(defaultConfig() as unknown as Record<string, unknown>, user as Record<string, unknown>) as unknown as PlatformConfig;
  } catch {
    return defaultConfig();
  }
}

/** Persist the config (creates ~/.maya on first write). */
export function saveConfig(cfg: PlatformConfig): void {
  fs.mkdirSync(mayaHome(), { recursive: true });
  const tmp = configPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, configPath());
}

export const ensureDirs = (): void => {
  for (const d of [mayaHome(), modelsDir(), path.join(mayaHome(), "logs")]) {
    fs.mkdirSync(d, { recursive: true });
  }
};
