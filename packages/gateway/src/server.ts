import type { ModelCatalogEntry, ModelId, ProviderConfig, RuntimeEvent } from "@maya-ai/core";
import { QUANT_QUALITY, type RuntimeManager, availableRam, detectLlamaCpp, pullModel, scanModels, writeModelMeta } from "@maya-ai/model-runtime";
import { type PlatformConfig, defaultConfig, loadConfig, saveConfig } from "@maya-ai/core";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolveProvider } from "./providers.js";

export interface GatewayDeps {
  manager: RuntimeManager;
  modelsDir: string;
  port: number;
  /** Bearer for /api/*; unset = open on localhost (the server binds 127.0.0.1 only). */
  adminToken?: string;
  /** Port of the supervised Switchyard sidecar (translation); unset = 501 on /v1/messages. */
  anthropicSidecarPort?: () => number | undefined;
  /** Invoked after a successful model pull (e.g. to refresh the sidecar catalog). */
  onCatalogChange?: () => void;
  /** User provider overrides from ~/.maya/config.json (env vars stay the on/off switch). */
  providers?: ProviderConfig[];
}

interface EventSub {
  (ev: RuntimeEvent): void;
}

/**
 * The Maya gateway: OpenAI-compatible /v1 over local instances (cloud
 * providers arrive with M2), plus the admin control API. Local chat requests
 * are a zero-copy stream passthrough — the gateway never parses token deltas.
 */
export function createGateway(deps: GatewayDeps): { app: Hono; subscribers: Set<EventSub> } {
  const app = new Hono();
  const subscribers = new Set<EventSub>();
  const fanout = (ev: RuntimeEvent): void => {
    for (const s of subscribers) s(ev);
  };
  deps.manager.on("event", fanout);

  const oaiError = (message: string, status: 400 | 401 | 404 | 501 | 503) =>
    Response.json({ error: { message, type: "maya_gateway_error" } }, { status });

  // ── OpenAI-compatible surface ─────────────────────────────────────────────
  app.post("/v1/chat/completions", async (c) => {
    let body: { model?: string };
    const raw = await c.req.arrayBuffer();
    try {
      body = JSON.parse(Buffer.from(raw).toString());
    } catch {
      return oaiError("invalid JSON body", 400);
    }
    const model = body.model as ModelId | undefined;
    if (!model?.includes("/")) {
      return oaiError(`model must be a Maya ModelId like "local/qwen…" (got: ${body.model})`, 400);
    }
    if (!model.startsWith("local/")) {
      if (model.startsWith("anthropic/")) {
        return oaiError(`use the Anthropic-compatible endpoint (/v1/messages) for ${model}, or a local/openai-compat model here`, 400);
      }
      const resolved = resolveProvider(model, deps.providers ?? []);
      if ("error" in resolved) return oaiError(resolved.error, resolved.status);
      // Rewrite the model field to the provider-native name, then stream through.
      const rewritten = JSON.stringify({ ...(body as Record<string, unknown>), model: resolved.upstreamModel });
      const upstream = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${resolved.apiKey}` },
        body: rewritten,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }

    // On-demand start (Ollama-style): loading respects every guardrail.
    let port: number;
    try {
      // Agent clients (Claude Code, Codex) send 20k+ token prompts — on-demand
      // loads default to a large context; the fit planner shrinks it under RAM
      // pressure, so small machines still work (with a degraded event).
      const inst = deps.manager.instanceFor(model) ?? (await deps.manager.load(model, { contextLength: 32768 }));
      deps.manager.touch(model);
      port = inst.port;
    } catch (err) {
      return oaiError(err instanceof Error ? err.message : String(err), 503);
    }

    let payload: ArrayBuffer | string = raw;
    if ((body as { tools?: unknown[] }).tools?.length) {
      const parsed = body as Parameters<typeof sanitizeToolSchemas>[0];
      if (sanitizeToolSchemas(parsed)) payload = JSON.stringify(parsed);
    }
    if (process.env.MAYA_DEBUG_DUMP_DIR) {
      // Debug aid (env-gated): dump request bodies to diagnose upstream 4xx.
      const fs = await import("node:fs");
      fs.writeFileSync(`${process.env.MAYA_DEBUG_DUMP_DIR}/req-${Date.now()}.json`, typeof payload === "string" ? payload : Buffer.from(payload));
    }
    // Zero-copy passthrough — stream the upstream response body straight out.
    const upstream = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    deps.manager.touch(model);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  });

  // Anthropic-compatible surface: proxied verbatim to the Switchyard sidecar,
  // which translates to OpenAI format and calls back into our /v1. Streaming
  // is a zero-copy passthrough both ways.
  app.post("/v1/messages", async (c) => {
    const raw = await c.req.arrayBuffer();
    let model = "";
    try {
      model = String((JSON.parse(Buffer.from(raw).toString()) as { model?: string }).model ?? "");
    } catch {
      return oaiError("invalid JSON body", 400);
    }
    if (model.startsWith("anthropic/")) {
      // Native passthrough to the real Anthropic API with the real key.
      const resolved = resolveProvider(model as ModelId, deps.providers ?? []);
      if ("error" in resolved) return oaiError(resolved.error, resolved.status);
      const rewritten = JSON.stringify({ ...(JSON.parse(Buffer.from(raw).toString()) as Record<string, unknown>), model: resolved.upstreamModel });
      const upstream = await fetch(`${resolved.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": resolved.apiKey,
          "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
        },
        body: rewritten,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }
    const port = deps.anthropicSidecarPort?.();
    if (!port) {
      return oaiError("Anthropic-compatible endpoint needs the Switchyard sidecar — run `maya doctor --install-switchyard`, then restart `maya serve`", 501);
    }
    const upstream = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": c.req.header("content-type") ?? "application/json",
        ...(c.req.header("anthropic-version") ? { "anthropic-version": c.req.header("anthropic-version")! } : {}),
        "x-api-key": "maya",
      },
      body: raw,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  });

  // OpenAI Responses API (Codex >=0.142 speaks ONLY this): openai/* models
  // pass through natively; everything else translates via the sidecar, which
  // calls back into our /v1 (same pattern as /v1/messages).
  app.post("/v1/responses", async (c) => {
    const raw = await c.req.arrayBuffer();
    let model = "";
    try {
      model = String((JSON.parse(Buffer.from(raw).toString()) as { model?: string }).model ?? "");
    } catch {
      return oaiError("invalid JSON body", 400);
    }
    if (model.startsWith("openai/")) {
      const resolved = resolveProvider(model as ModelId, deps.providers ?? []);
      if ("error" in resolved) return oaiError(resolved.error, resolved.status);
      const rewritten = JSON.stringify({ ...(JSON.parse(Buffer.from(raw).toString()) as Record<string, unknown>), model: resolved.upstreamModel });
      const upstream = await fetch(`${resolved.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${resolved.apiKey}` },
        body: rewritten,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }
    const port = deps.anthropicSidecarPort?.();
    if (!port) {
      return oaiError("Responses API needs the Switchyard sidecar — run `maya doctor --install-switchyard`, then restart `maya serve`", 501);
    }
    const upstream = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": c.req.header("content-type") ?? "application/json" },
      body: raw,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  });

  app.get("/v1/models", (c) => {
    const data = catalog(deps).map((m) => ({
      id: m.id,
      object: "model" as const,
      owned_by: m.kind === "local-gguf" ? "maya-local" : "maya-cloud",
    }));
    return c.json({ object: "list", data });
  });

  // ── Control API (admin) ───────────────────────────────────────────────────
  app.use("/api/*", async (c, next) => {
    if (deps.adminToken) {
      const auth = c.req.header("authorization");
      if (auth !== `Bearer ${deps.adminToken}`) {
        return oaiError("missing/invalid admin bearer", 401);
      }
    }
    await next();
  });

  app.get("/api/models", (c) => c.json(catalog(deps)));

  app.post("/api/models/pull", async (c) => {
    const { source, name } = await c.req.json<{ source?: string; name?: string }>();
    if (!source) return oaiError("source required (hf:owner/repo[/file.gguf] or URL)", 400);
    // Async job; progress flows over /api/events as pull_progress.
    void pullModel(deps.modelsDir, { source, ...(name ? { name } : {}) }, fanout)
      .then(() => deps.onCatalogChange?.())
      .catch((err) => {
        // Surface the failure to every UI (dashboard events feed) — a pull
        // that dies only in the server console looks like a silent hang.
        fanout({
          type: "pull_failed",
          model: `local/${name ?? source}` as ModelId,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error("pull failed:", err);
      });
    return c.json({ started: true, source });
  });

  app.post("/api/models/:name/load", async (c) => {
    const model = `local/${c.req.param("name")}` as ModelId;
    const opts = await c.req.json<{ quant?: never; contextLength?: number; force?: boolean }>().catch(() => ({}) as Record<string, never>);
    try {
      const inst = await deps.manager.load(model, opts);
      return c.json(inst);
    } catch (err) {
      return oaiError(err instanceof Error ? err.message : String(err), 503);
    }
  });

  app.post("/api/models/:name/unload", async (c) => {
    await deps.manager.unload(`local/${c.req.param("name")}` as ModelId);
    return c.json({ ok: true });
  });

  // ── System health (maya doctor, in the browser) ─────────────────────────
  app.get("/api/system", async (c) => {
    const cfg = loadConfig();
    const [ram, llama] = await Promise.all([availableRam(), detectLlamaCpp()]);
    const sidecarPort = deps.anthropicSidecarPort?.();
    return c.json({
      node: process.version,
      platform: process.platform,
      llamaCpp: { installed: llama.installed, version: llama.version ?? null, path: llama.binPath ?? null, hint: llama.installHint ?? null },
      switchyard: { running: Boolean(sidecarPort), port: sidecarPort ?? null },
      ram: { availableBytes: ram.availableBytes, totalBytes: ram.totalBytes, guardrailFloorBytes: cfg.guardrails.minFreeRamBytes },
      models: { installed: scanModels(deps.modelsDir).length, dir: deps.modelsDir },
      ports: { gateway: cfg.gateway.port, dashboard: cfg.dashboard.port, bus: cfg.bus.port, orchestrator: cfg.orchestrator.port },
      liveInstances: deps.manager.instances().length,
    });
  });

  // ── Config (edit ALL platform settings from the web) ─────────────────────
  // GET is REDACTED: providers expose only their env-var NAME + whether it's
  // currently set — never a key value (keys live in env, never in config/db).
  app.get("/api/config", (c) => {
    const cfg = loadConfig();
    return c.json({
      ...cfg,
      providers: cfg.providers.map((p) => ({
        id: p.id,
        baseUrl: p.baseUrl ?? "",
        apiKeyEnv: p.apiKeyEnv ?? "",
        enabled: p.enabled,
        keyPresent: Boolean(p.apiKeyEnv && process.env[p.apiKeyEnv]), // presence only
      })),
    });
  });

  // PUT validates + persists, and reports which changes need a `maya serve`
  // restart (ports/dirs) vs. take effect on next use (providers/guardrails).
  app.put("/api/config", async (c) => {
    let body: Partial<PlatformConfig>;
    try {
      body = (await c.req.json()) as Partial<PlatformConfig>;
    } catch {
      return oaiError("invalid JSON body", 400);
    }
    const cur = loadConfig();
    const d = defaultConfig();
    // Merge conservatively; reject a provider object that tries to smuggle a raw
    // key (config must reference an env var name, never hold a secret).
    const providers = Array.isArray(body.providers) ? body.providers : cur.providers;
    for (const p of providers as unknown as Array<Record<string, unknown>>) {
      if ("apiKey" in p || "key" in p || "token" in p) {
        return oaiError("providers must use apiKeyEnv (an env var NAME), never a raw key", 400);
      }
    }
    const next: PlatformConfig = {
      gateway: { port: Number(body.gateway?.port ?? cur.gateway.port) },
      dashboard: { port: Number(body.dashboard?.port ?? cur.dashboard.port) },
      bus: { port: Number(body.bus?.port ?? cur.bus.port) },
      orchestrator: { port: Number(body.orchestrator?.port ?? cur.orchestrator.port) },
      modelsDir: String(body.modelsDir ?? cur.modelsDir),
      providers: providers.map((p) => ({
        id: String((p as { id?: string }).id ?? "custom"),
        ...((p as { baseUrl?: string }).baseUrl ? { baseUrl: String((p as { baseUrl?: string }).baseUrl) } : {}),
        ...((p as { apiKeyEnv?: string }).apiKeyEnv ? { apiKeyEnv: String((p as { apiKeyEnv?: string }).apiKeyEnv) } : {}),
        enabled: Boolean((p as { enabled?: boolean }).enabled),
      })),
      guardrails: { ...cur.guardrails, ...(body.guardrails ?? {}) },
    };
    // Sanity floors so a bad edit can't brick the runtime.
    if (next.guardrails.minFreeRamBytes < 256 * 1024 * 1024) next.guardrails.minFreeRamBytes = d.guardrails.minFreeRamBytes;
    if (next.guardrails.maxRestarts < 0) next.guardrails.maxRestarts = d.guardrails.maxRestarts;
    saveConfig(next);
    const needsRestart =
      next.gateway.port !== cur.gateway.port ||
      next.dashboard.port !== cur.dashboard.port ||
      next.bus.port !== cur.bus.port ||
      next.orchestrator.port !== cur.orchestrator.port ||
      next.modelsDir !== cur.modelsDir;
    return c.json({ ok: true, needsRestart, appliesOnNextUse: !needsRestart });
  });

  // Per-model profile: default quant / context / speculation draft (maya.json).
  app.post("/api/models/:name/profile", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { contextLength?: number; draftModel?: string | false };
    const patch: Record<string, unknown> = {};
    if (typeof body.contextLength === "number" && body.contextLength >= 512) patch["contextLength"] = Math.floor(body.contextLength);
    if (body.draftModel === false || typeof body.draftModel === "string") patch["draftModel"] = body.draftModel;
    if (!Object.keys(patch).length) return oaiError("nothing to update (contextLength or draftModel)", 400);
    try {
      writeModelMeta(deps.modelsDir, name, patch);
      return c.json({ ok: true, applied: patch, note: "takes effect on next load of this model" });
    } catch (err) {
      return oaiError(err instanceof Error ? err.message : String(err), 400);
    }
  });

  app.get("/api/runtime/health", async (c) => {
    const ram = await availableRam();
    return c.json({
      ramFreeBytes: ram.availableBytes,
      ramTotalBytes: ram.totalBytes,
      instances: deps.manager.instances(),
    });
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const sub: EventSub = (ev) => void stream.writeSSE({ data: JSON.stringify(ev) });
      subscribers.add(sub);
      stream.onAbort(() => {
        subscribers.delete(sub);
      });
      // keepalive comment every 15s so proxies don't drop us
      while (!stream.aborted) {
        await stream.sleep(15_000);
        await stream.write(": keepalive\n\n");
      }
    }),
  );

  return { app, subscribers };
}


/**
 * llama.cpp compiles JSON-schema string bounds into grammar repetition counts;
 * a large maxLength (Claude Code sends 524288) explodes the compiler with
 * "failed to parse grammar". Strip length bounds above a sane cap from tool
 * schemas on local routes — constrained decoding doesn't need them (max_tokens
 * bounds output) and the caller still validates its own tool args.
 */
const GRAMMAR_SAFE_MAX_LENGTH = 1024;
function sanitizeToolSchemas(body: { tools?: Array<{ function?: { parameters?: unknown } }> }): boolean {
  let changed = false;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const key of ["maxLength", "minLength"]) {
      if (typeof obj[key] === "number" && (obj[key] as number) > GRAMMAR_SAFE_MAX_LENGTH) {
        delete obj[key];
        changed = true;
      }
    }
    for (const v of Object.values(obj)) walk(v);
  };
  for (const t of body.tools ?? []) walk(t.function?.parameters);
  return changed;
}

function catalog(deps: GatewayDeps): ModelCatalogEntry[] {
  return scanModels(deps.modelsDir).map((m) => {
    const id = `local/${m.name}` as ModelId;
    const instance = deps.manager.instanceFor(id);
    return {
      id,
      displayName: m.name,
      kind: "local-gguf" as const,
      contextLength: m.contextLength,
      quants: m.files.map((f) => ({ quant: f.quant, quality: QUANT_QUALITY[f.quant] ?? 0.9, bytes: f.bytes })),
      ...(m.toolCalling !== undefined ? { toolCalling: m.toolCalling } : {}),
      ...(instance ? { instance } : {}),
    };
  });
}

export function startGateway(deps: GatewayDeps): ServerType {
  const { app } = createGateway(deps);
  return serve({ fetch: app.fetch, port: deps.port, hostname: "127.0.0.1" });
}
