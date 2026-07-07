import type { ModelCatalogEntry, ModelId, RuntimeEvent } from "@maya-ai/core";
import { type RuntimeManager, availableRam, pullModel, scanModels } from "@maya-ai/model-runtime";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface GatewayDeps {
  manager: RuntimeManager;
  modelsDir: string;
  port: number;
  /** Bearer for /api/*; unset = open on localhost (the server binds 127.0.0.1 only). */
  adminToken?: string;
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
      return oaiError(`cloud providers land in M2 — only local/* models are servable right now`, 501);
    }

    // On-demand start (Ollama-style): loading respects every guardrail.
    let port: number;
    try {
      const inst = deps.manager.instanceFor(model) ?? (await deps.manager.load(model));
      deps.manager.touch(model);
      port = inst.port;
    } catch (err) {
      return oaiError(err instanceof Error ? err.message : String(err), 503);
    }

    // Zero-copy passthrough — stream the upstream response body straight out.
    const upstream = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    deps.manager.touch(model);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
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
    void pullModel(deps.modelsDir, { source, ...(name ? { name } : {}) }, fanout).catch((err) =>
      fanout({ type: "pull_progress", model: `local/${name ?? source}` as ModelId, pct: -1 }) ??
      console.error("pull failed:", err),
    );
    return c.json({ started: true, source });
  });

  app.post("/api/models/:name/load", async (c) => {
    const model = `local/${c.req.param("name")}` as ModelId;
    const opts = await c.req.json<{ quant?: never; contextLength?: number }>().catch(() => ({}) as Record<string, never>);
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

function catalog(deps: GatewayDeps): ModelCatalogEntry[] {
  return scanModels(deps.modelsDir).map((m) => {
    const id = `local/${m.name}` as ModelId;
    const instance = deps.manager.instanceFor(id);
    return {
      id,
      displayName: m.name,
      kind: "local-gguf" as const,
      contextLength: m.contextLength,
      ...(instance ? { instance } : {}),
    };
  });
}

export function startGateway(deps: GatewayDeps): ServerType {
  const { app } = createGateway(deps);
  return serve({ fetch: app.fetch, port: deps.port, hostname: "127.0.0.1" });
}
