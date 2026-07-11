import type { ModelCatalogEntry, ModelId, ProviderConfig, Quant, RuntimeEvent } from "@maya-ai/core";
import { QUANT_QUALITY, type RuntimeManager, availableRam, detectLlamaCpp, pullModel, scanModels, writeModelMeta } from "@maya-ai/model-runtime";
import { type PlatformConfig, defaultConfig, loadConfig, saveConfig } from "@maya-ai/core";
import { TunnelManager } from "./tunnel.js";
import { listDir, readTextPreview } from "./fsbrowse.js";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolveProvider } from "./providers.js";
import { buildSuggestions, newSuggestCache, parseSuggestQuery, type HwfitEngine } from "./suggest.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /**
   * The hardware-aware model recommender (@maya-ai/hwfit), injected by the
   * composition root. Unset = /api/models/suggest reports 501 rather than
   * pretending; the gateway itself never imports the engine, so it stays
   * decoupled and the route is testable against a fake.
   */
  hwfit?: HwfitEngine;
}

interface EventSub {
  (ev: RuntimeEvent): void;
}

/**
 * The Maya gateway: OpenAI-compatible /v1 over local instances (cloud
 * providers arrive with M2), plus the admin control API. Local chat requests
 * are a zero-copy stream passthrough — the gateway never parses token deltas.
 */
const tunnels = new TunnelManager();

export function createGateway(deps: GatewayDeps): { app: Hono; subscribers: Set<EventSub> } {
  const app = new Hono();
  const subscribers = new Set<EventSub>();
  const fanout = (ev: RuntimeEvent): void => {
    for (const s of subscribers) s(ev);
  };
  deps.manager.on("event", fanout);

  const oaiError = (message: string, status: 400 | 401 | 403 | 404 | 501 | 503) =>
    Response.json({ error: { message, type: "maya_gateway_error" } }, { status });

  // beginRequest/endRequest ship with the current model-runtime; optional-call
  // so the gateway still typechecks/runs against an older runtime build.
  const track = deps.manager as RuntimeManager & {
    beginRequest?: (m: ModelId) => void;
    endRequest?: (m: ModelId) => void;
  };

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
      let upstream: Response;
      try {
        upstream = await fetch(`${resolved.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${resolved.apiKey}` },
          body: rewritten,
        });
      } catch (err) {
        // Network failure to the provider must come back in the OpenAI error
        // shape clients parse, not Hono's bare 500.
        return oaiError(`upstream provider unreachable: ${err instanceof Error ? err.message : String(err)}`, 503);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }

    // On-demand start (Ollama-style): loading respects every guardrail.
    let port: number;
    try {
      // Agent clients (Claude Code, Codex) send 20k+ token prompts — untuned
      // models default to a large context; the fit planner shrinks it under
      // RAM pressure, so small machines still work (with a degraded event).
      // A tuned/profiled contextLength (anything but the 8192 pull default)
      // is a deliberate, host-measured choice and wins — smaller or larger.
      // manager.load is idempotent + serialized: it reuses a matching live
      // instance, waits out a concurrent cold start instead of handing back a
      // dead port, and reloads when the requested context genuinely differs.
      const local = scanModels(deps.modelsDir).find((m) => `local/${m.name}` === model);
      const configuredCtx = local && local.contextLength !== 8192 ? local.contextLength : undefined;
      const inst = await deps.manager.load(model, { contextLength: configuredCtx ?? 32768 });
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
    // The in-flight count keeps idle eviction off a >60s generation; it drops
    // when the body finishes, errors, or the client cancels.
    track.beginRequest?.(model);
    const requestDone = (): void => {
      track.endRequest?.(model);
      deps.manager.touch(model);
    };
    let upstream: Response;
    try {
      upstream = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
    } catch (err) {
      requestDone();
      return oaiError(`model instance unreachable: ${err instanceof Error ? err.message : String(err)}`, 503);
    }
    deps.manager.touch(model);
    return new Response(trackBody(upstream.body, requestDone), {
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
    // catalog() is local-only today; cloud catalog entries (owned_by
    // "maya-cloud", listed from live providers' remote catalogs) land in M2.
    const data = catalog(deps).map((m) => ({
      id: m.id,
      object: "model" as const,
      owned_by: "maya-local",
    }));
    return c.json({ object: "list", data });
  });

  // ── Control API (admin) ───────────────────────────────────────────────────
  // SECURITY: the admin plane (/api/* — fs read, config, tunnels, model
  // control) must never be reachable through a shared tunnel. The server
  // binds 127.0.0.1, but a cloudflared tunnel (our own /api/tunnels feature,
  // or one the user runs by hand) forwards public traffic straight to
  // localhost — and /api/fs/read can hand out ~/.cldz credentials. Tunneled
  // requests arrive with the public hostname in Host plus proxy headers;
  // refuse both, so a tunnel only ever exposes the inference surface (/v1/*).
  const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    const proxied = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-host");
    if (!LOCAL_HOST_RE.test(host) || proxied) {
      return oaiError("admin API is local-only — it is never served through tunnels or proxies", 403);
    }
    if (deps.adminToken) {
      const auth = c.req.header("authorization");
      if (auth !== `Bearer ${deps.adminToken}`) {
        return oaiError("missing/invalid admin bearer", 401);
      }
    }
    await next();
  });

  app.get("/api/models", (c) => c.json(catalog(deps)));

  // ── "Suggested for your machine" ─────────────────────────────────────────
  // Rank local models by how well they FIT and RUN on this exact host. The
  // engine (hwfit) does the detection + math; the gateway adds `installed`
  // (only it can see modelsDir) and validates the query. A pick is directly
  // actionable: sources[format] feeds POST /api/models/pull, then :name/load.
  const hwfitCache = newSuggestCache();
  app.get("/api/models/suggest", async (c) => {
    if (!deps.hwfit) {
      return oaiError("model recommendations need the hwfit engine — it is not wired into this gateway", 501);
    }
    const parsed = parseSuggestQuery(c.req.query());
    if ("error" in parsed) return oaiError(parsed.error, 400);
    try {
      return c.json(
        await buildSuggestions(
          {
            hwfit: deps.hwfit,
            installedIds: () => new Set(scanModels(deps.modelsDir).map((m) => `local/${m.name}`)),
            cache: hwfitCache,
          },
          parsed,
        ),
      );
    } catch (err) {
      // Reached only when there is nothing truthful to serve (no hardware
      // read, or a cold catalog that never loaded). A failed refresh over a
      // warm cache degrades to catalog.stale inside buildSuggestions.
      return oaiError(`could not rank models: ${err instanceof Error ? err.message : String(err)}`, 503);
    }
  });

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
    type LoadBody = { quant?: Quant; contextLength?: number; force?: boolean };
    const body = await c.req.json<LoadBody>().catch(() => ({}) as LoadBody);
    try {
      // Whitelist the fields we document — the raw body goes nowhere near load.
      const inst = await deps.manager.load(model, {
        ...(body.quant !== undefined ? { quant: body.quant } : {}),
        ...(body.contextLength !== undefined ? { contextLength: Number(body.contextLength) } : {}),
        ...(body.force !== undefined ? { force: Boolean(body.force) } : {}),
      });
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

  // ── Cloud model list for a cldz profile (himansh: list real models via the
  // provider's API using the profile's credential — apiKey→x-api-key, oauth→
  // Bearer). Credential is read + used SERVER-SIDE ONLY; the response carries
  // model ids, never the secret. Falls back to [] on any error (UI keeps a
  // static list). Anthropic today; other providers key off profile shape later.
  app.get("/api/cloud-models", async (c) => {
    const profile = c.req.query("profile");
    if (!profile) return c.json({ models: [] });
    let cred: { type?: string; apiKey?: string; oauthToken?: string } | undefined;
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".cldz", "config.json"), "utf8")) as {
        profiles?: Record<string, { type?: string; apiKey?: string; oauthToken?: string }>;
      };
      cred = cfg.profiles?.[profile];
    } catch {
      return c.json({ models: [] });
    }
    if (!cred) return c.json({ models: [] });
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (cred.type === "apiKey" && cred.apiKey) headers["x-api-key"] = cred.apiKey;
    else if (cred.type === "oauth" && cred.oauthToken) { headers["authorization"] = `Bearer ${cred.oauthToken}`; headers["anthropic-beta"] = "oauth-2025-04-20"; }
    else return c.json({ models: [] });
    try {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers });
      if (!res.ok) return c.json({ models: [], error: `HTTP ${res.status}` });
      const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
      return c.json({ models: (data.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id })) });
    } catch (e) {
      return c.json({ models: [], error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Filesystem browse (read-only file explorer + dir picker) ─────────────
  app.get("/api/fs", (c) => {
    try {
      return c.json(listDir(c.req.query("path")));
    } catch (err) {
      return oaiError(err instanceof Error ? err.message : String(err), 400);
    }
  });
  app.get("/api/fs/read", (c) => {
    const p = c.req.query("path");
    if (!p) return oaiError("path required", 400);
    try {
      return c.json(readTextPreview(p));
    } catch (err) {
      return oaiError(err instanceof Error ? err.message : String(err), 400);
    }
  });

  // ── Cloudflare port-forward tunnels ──────────────────────────────────────
  app.get("/api/tunnels", async (c) => c.json({ ...(await tunnels.detect()), tunnels: tunnels.list() }));
  app.post("/api/tunnels", async (c) => {
    const { port } = await c.req.json<{ port?: number }>().catch(() => ({}) as { port?: number });
    if (!port) return oaiError("port required", 400);
    // Never tunnel the admin plane: dashboard/orchestrator/bus have no
    // tunnel-aware guard of their own (the dashboard proxies /api/* through).
    // The gateway port itself is fine — its /api/* rejects proxied traffic
    // above, so a shared gateway tunnel exposes exactly the /v1 surface.
    const cfg = loadConfig();
    const blocked: Array<[number, string]> = [
      [cfg.dashboard.port, "dashboard"],
      [cfg.orchestrator.port, "orchestrator"],
      [cfg.bus.port, "bus"],
    ];
    const hit = blocked.find(([p]) => p === Number(port));
    if (hit) {
      return oaiError(
        `refusing to tunnel port ${port}: it serves the ${hit[1]} (admin plane). Only the inference surface may go public — tunnel the gateway port (${cfg.gateway.port}) instead.`,
        400,
      );
    }
    try {
      return c.json(await tunnels.open(Number(port)));
    } catch (err) {
      return oaiError(err instanceof Error ? err.message : String(err), 400);
    }
  });
  app.delete("/api/tunnels/:id", async (c) => {
    await tunnels.close(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── Config (edit ALL platform settings from the web) ─────────────────────
  // GET is REDACTED: providers expose only their env-var NAME + whether it's
  // currently set — never a key value (keys live in env, never in config/db).
  app.get("/api/config", (c) => {
    const cfg = loadConfig();
    return c.json({
      ...cfg,
      user: cfg.user ?? { handle: "@me" },
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
    // A cleared/garbage port field must never persist (port 0 bricks the next
    // boot) — clamp to a real port or keep the current value.
    const port = (v: unknown, fallback: number): number => {
      const n = Number(v ?? fallback);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
    };
    const next: PlatformConfig = {
      ...(body.user?.handle || cur.user ? { user: { handle: String(body.user?.handle ?? cur.user?.handle ?? "@me").trim() || "@me" } } : {}),
      gateway: { port: port(body.gateway?.port, cur.gateway.port) },
      dashboard: { port: port(body.dashboard?.port, cur.dashboard.port) },
      bus: { port: port(body.bus?.port, cur.bus.port) },
      orchestrator: { port: port(body.orchestrator?.port, cur.orchestrator.port) },
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

/**
 * Pass an upstream body through unchanged, invoking `onDone` exactly once when
 * it ends, errors, or the client cancels — so the manager knows when a
 * generation actually finished (SSE bodies outlive the fetch by minutes).
 */
function trackBody(body: ReadableStream<Uint8Array> | null, onDone: () => void): ReadableStream<Uint8Array> | null {
  let called = false;
  const finish = (): void => {
    if (!called) {
      called = true;
      onDone();
    }
  };
  if (!body) {
    finish();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done || value === undefined) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
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
