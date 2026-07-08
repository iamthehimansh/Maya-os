/** Thin client over the gateway control API (same origin in prod; vite proxy in dev). */

export interface Instance {
  id: string;
  model: string;
  state: "starting" | "ready" | "degraded" | "unhealthy" | "stopping" | "stopped";
  port: number;
  pid: number;
  quant?: string;
  contextLength: number;
  memoryBytes: number;
  startedAt: string;
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  kind: "local-gguf" | "cloud";
  contextLength?: number;
  quants?: Array<{ quant: string; quality: number; bytes: number }>;
  instance?: Instance;
  /** Measured on first load — only tool-callers are valid loop WORKERS. */
  capabilities?: { toolCalling?: boolean };
}

export interface Health {
  ramFreeBytes: number;
  ramTotalBytes: number;
  instances: Instance[];
}

export type RuntimeEvent =
  | { type: "instance_state"; instanceId: string; model: string; state: Instance["state"]; reason?: string }
  | { type: "model_degraded"; model: string; from: string; to: string; reason: string }
  | { type: "instance_restarted"; instanceId: string; model: string; attempt: number }
  | { type: "ram_pressure"; freeBytes: number; action: string }
  | { type: "pull_progress"; model: string; pct: number }
  | { type: "pull_failed"; model: string; error: string };

export const getModels = (): Promise<CatalogEntry[]> => fetch("/api/models").then((r) => r.json());
export const getHealth = (): Promise<Health> => fetch("/api/runtime/health").then((r) => r.json());

/** A cldz auth profile (safe view — no secrets) for the "run as" agent picker. */
export interface CldzProfile {
  name: string;
  type: "apiKey" | "oauth" | "gateway" | "bedrock" | "vertex";
  isDefault: boolean;
  auth: "subscription" | "api-key" | "gateway" | "cloud-vendor";
}
export const getCldzProfiles = (): Promise<{ available: boolean; profiles: CldzProfile[] }> =>
  fetch("/api/cldz-profiles").then((r) => r.json());

export const loadModel = (name: string, force = false): Promise<Response> =>
  fetch(`/api/models/${encodeURIComponent(name)}/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(force ? { force: true } : {}),
  });

export const unloadModel = (name: string): Promise<Response> =>
  fetch(`/api/models/${encodeURIComponent(name)}/unload`, { method: "POST" });

export const pullModel = (source: string): Promise<Response> =>
  fetch("/api/models/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });

/** Subscribe to the gateway's SSE runtime-event stream. Returns an unsubscribe. */
export function onRuntimeEvents(handler: (ev: RuntimeEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      handler(JSON.parse(m.data) as RuntimeEvent);
    } catch {
      // ignore malformed frames
    }
  };
  return () => es.close();
}

export const setModelProfile = (name: string, patch: { contextLength?: number; draftModel?: string | false }): Promise<Response> =>
  fetch(`/api/models/${encodeURIComponent(name)}/profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
