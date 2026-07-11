import { defaultGuardrails, ensureDirs, loadConfig, mayaHome } from "@maya-ai/core";
import type { ModelId } from "@maya-ai/core";
import { RuntimeManager, pullModel, scanModels, detectLlamaCpp, tuneModel, writeModelMeta } from "@maya-ai/model-runtime";
import type { DraftOption, TuneResult } from "@maya-ai/model-runtime";
import type { Quant } from "@maya-ai/core";
import { detectSwitchyard, provisionSwitchyard, startGateway, startSwitchyard, type SidecarHandle } from "@maya-ai/gateway";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { serveDashboard } from "./dashboard.js";
import { startBusServer } from "@maya-ai/bus";
import { startOrchestratorService } from "@maya-ai/orchestrator";
import { dbPath } from "@maya-ai/core";

const HELP = `maya — local-first AI OS for developers (Apple Silicon first)

Usage:
  maya serve                     boot the platform (gateway + runtime) — Ctrl-C stops everything
  maya status                    show configured ports, providers, home dir
  maya models ls                 installed local models (+ live instances)
  maya models pull <source>      hf:owner/repo[/file.gguf] or URL   [--name <n>]
  maya models run <name>         load a model (guardrails apply)
  maya models stop <name>        unload a model
  maya tune <name>               auto-search quant × ctx × draft for max tok/s within RAM
                                 [--min-ctx N] [--target-ctx N] [--quants Q,Q] [--draft [model]]
                                 [--gen N] [--save] [--json]
  maya loop "<goal>"             run an AI team on a goal (lead plans, workers execute, gates verify)
                                 [--worker <model>] [--lead <model>] [--cwd <dir>] [--tools Write,Edit] [--max-turns N]
  maya runs                      recent loop runs with outcomes + tokens
  maya team create <name>        standing team (run many loops on one fleet)
                                 [--worker <model>] [--cwd <dir>] [--tools T,T] [--budget N] [--max-turns N]
  maya team list                 live teams with budgets + token burn
  maya team drain <id>           stop a standing team
  maya remote                    control Maya from anywhere: bearer-guarded proxy (default :4500)
                                 to the orchestrator API + cloudflared public URL
                                 [--port N] [--no-tunnel]  — needs a running \`maya serve\`
  maya doctor                    check llama.cpp, claude CLI, RAM tier, ports
  maya --version

The gateway serves OpenAI-compatible /v1 at http://127.0.0.1:<gateway.port>.
\`maya serve\` also boots the dashboard (web UI), bus (agent channels) and orchestrator.`;

/** First positional in args at/after `from`, skipping --flag value pairs
 * (every flag on these subcommands takes a value — so `maya loop --team t_1
 * "goal"` finds "goal", not the team id). */
function positionalArg(args: string[], from: number): string | undefined {
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) return undefined;
    if (a.startsWith("--")) { i++; continue; } // skip the flag's value too
    return a;
  }
  return undefined;
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;

  if (cmd === "--version" || cmd === "-v") {
    // Resolve from the package itself (works from src/ and dist/ alike) so the
    // reported version never drifts from what was published.
    const { createRequire } = await import("node:module");
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
    console.log(`maya-os ${pkg.version}`);
    return;
  }

  // Hidden: stdio MCP server exposing Maya's control tools. The orchestrator
  // spawns `node <this bin> mcp-serve` for standing leads with
  // MAYA_ORCHESTRATOR_URL / MAYA_GATEWAY_URL / MAYA_TEAM_ID in env.
  if (cmd === "mcp-serve") {
    const { main: mcpMain } = await import("@maya-ai/mcp");
    await mcpMain();
    return; // transport keeps the process alive on stdin
  }

  if (cmd === "status" || cmd === undefined) {
    ensureDirs();
    const cfg = loadConfig();
    console.log("Maya");
    console.log(`  home       ${mayaHome()}`);
    console.log(`  gateway    :${cfg.gateway.port}   (OpenAI-compatible /v1 — \`maya serve\`)`);
    console.log(`  dashboard  :${cfg.dashboard.port}   (web UI — boots with \`maya serve\`)`);
    console.log(`  bus        :${cfg.bus.port}   (agent channels)`);
    console.log(`  models     ${cfg.modelsDir}`);
    console.log(`  providers  ${cfg.providers.filter((p) => p.enabled).map((p) => p.id).join(", ") || "none enabled yet"}`);
    return;
  }

  if (cmd === "serve") {
    ensureDirs();
    const cfg = loadConfig();
    const llama = await detectLlamaCpp();
    if (!llama.installed) {
      console.error(`llama-server not found — ${llama.installHint}`);
      process.exitCode = 1;
      return;
    }
    const holder = await portHolder(cfg.gateway.port);
    if (holder) {
      console.error(`maya serve is already running — gateway :${cfg.gateway.port} is held by pid ${holder}.`);
      console.error("Use the running instance, or stop it first (announce on the team channel before killing a shared serve).");
      process.exitCode = 1;
      return;
    }
    const manager = new RuntimeManager(cfg.modelsDir, cfg.guardrails, cfg.guardrails.autoDowngradeQuant ? 1800 : 1800);
    manager.on("event", (ev) => console.log(`[runtime] ${JSON.stringify(ev)}`));
    let sidecar: SidecarHandle | null = null;
    const server = startGateway({
      manager,
      modelsDir: cfg.modelsDir,
      port: cfg.gateway.port,
      anthropicSidecarPort: () => sidecar?.port,
      providers: cfg.providers,
      onCatalogChange: () => void sidecar?.refresh().catch((e) => console.error("[switchyard] refresh failed:", e)),
    });
    console.log(`maya gateway  → http://127.0.0.1:${cfg.gateway.port}/v1  (llama.cpp ${llama.version ?? "?"})`);
    console.log(`models        → ${scanModels(cfg.modelsDir).map((m) => `local/${m.name}`).join(", ") || "none — maya models pull hf:…"}`);
    sidecar = await startSwitchyard(cfg.modelsDir, cfg.gateway.port).catch((e) => {
      console.error("[switchyard] failed to start:", e instanceof Error ? e.message : e);
      return null;
    });
    if (sidecar) {
      console.log(`anthropic api → http://127.0.0.1:${cfg.gateway.port}/v1/messages  (Switchyard sidecar :${sidecar.port})`);
      console.log(`                point coding agents here: ANTHROPIC_BASE_URL=http://127.0.0.1:${cfg.gateway.port}`);
    } else {
      console.log("anthropic api → off (install: maya doctor --install-switchyard; needs ≥1 pulled model)");
    }
    // Maya bus (agent communication) — admin token persisted on first boot
    // (0600, localhost-only credential) so later boots and the dashboard
    // proxy can authenticate without re-minting.
    let busInfo: { port: number; adminToken: string } | undefined;
    let busServer: Awaited<ReturnType<typeof startBusServer>> | null = null;
    let orch: Awaited<ReturnType<typeof startOrchestratorService>> | null = null;
    try {
      const path3 = await import("node:path");
      busServer = await startBusServer({ port: cfg.bus.port, dbPath: path3.join(mayaHome(), "bus.db") });
      const tokenFile = path3.join(mayaHome(), "bus-admin.token");
      let adminToken = busServer.bootstrapAdminToken?.token ?? "";
      if (adminToken) fs.writeFileSync(tokenFile, adminToken, { mode: 0o600 });
      else {
        try {
          adminToken = fs.readFileSync(tokenFile, "utf8").trim();
        } catch {
          // bus.db exists (so no re-bootstrap) but the credential file is gone
          // — name the real problem instead of a generic "failed to start".
          throw new Error(`bus admin token missing (${tokenFile}) — delete ${path3.join(mayaHome(), "bus.db")} to re-bootstrap, then re-run \`maya serve\``);
        }
      }
      busInfo = { port: busServer.port, adminToken };
      console.log(`maya bus      → ws://127.0.0.1:${busServer.port}  (agent channels)`);
      // Orchestrator service (teams / tasks / loop runs) — agent plane.
      // mcpServe: standing LEAD agents get Maya's MCP tools — the orchestrator
      // writes ~/.maya/mcp/<teamId>.json pointing back at this CLI's hidden
      // `mcp-serve` stdio server (older orchestrators simply ignore the field).
      type OrchOptions = Parameters<typeof startOrchestratorService>[0] & { mcpServe?: { command: string; args: string[] } };
      const orchOpts: OrchOptions = {
        dbPath: dbPath(),
        gatewayBaseUrl: `http://127.0.0.1:${cfg.gateway.port}`,
        bus: { wsBase: `ws://127.0.0.1:${busServer.port}`, adminToken, httpBase: `http://127.0.0.1:${busServer.port}` },
        port: cfg.orchestrator.port,
        ...(process.argv[1] ? { mcpServe: { command: process.execPath, args: [process.argv[1], "mcp-serve"] } } : {}),
      };
      orch = await startOrchestratorService(orchOpts);
      console.log(`orchestrator  → http://127.0.0.1:${orch.port}/api  (teams · tasks · loop)`);
    } catch (e) {
      console.error("[serve] bus/orchestrator failed to start:", e instanceof Error ? e.message : e);
      console.error("        (gateway + dashboard continue; loop features off)");
    }
    // Dashboard SPA (same-origin proxy to the gateway — no CORS surface).
    const dashCandidates = [
      path.resolve(fileURLToPath(import.meta.url), "../../web"), // packaged: dist/../web
      path.resolve(fileURLToPath(import.meta.url), "../../../dashboard/dist"), // monorepo
    ];
    const dashDist = dashCandidates.find((c) => fs.existsSync(path.join(c, "index.html"))) ?? dashCandidates[0]!;
    let dashServer: ReturnType<typeof serveDashboard> | null = null;
    if (fs.existsSync(path.join(dashDist, "index.html"))) {
      dashServer = serveDashboard(dashDist, cfg.dashboard.port, cfg.gateway.port, orch?.port, busInfo);
      console.log(`dashboard     → http://127.0.0.1:${cfg.dashboard.port}`);
    } else {
      console.log("dashboard     → not built (pnpm --filter @maya-ai/dashboard build)");
    }
    console.log("Ctrl-C to stop (unloads every model instance).");
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) {
        console.log("\nforced exit.");
        process.exit(130);
      }
      shuttingDown = true;
      console.log("\nshutting down… (Ctrl-C again to force)");
      server.close();
      // Kill keep-alive + SSE sockets so close() resolves now, not when the
      // last open dashboard tab lets go (which is never).
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      dashServer?.close();
      dashServer?.closeAllConnections();
      void (async () => {
        const unload = Promise.allSettled([manager.unloadAll(), sidecar?.stop() ?? Promise.resolve()]);
        // Drain the orchestrator BEFORE the bus goes down — detach revokes each
        // agent's bus token over bus HTTP and posts the "team pausing" notice,
        // both of which need the bus alive.
        await orch?.close().catch(() => {});
        await busServer?.close().catch(() => {});
        await unload;
        process.exit(0);
      })();
      setTimeout(() => process.exit(0), 8_000).unref?.();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (cmd === "models") {
    ensureDirs();
    const cfg = loadConfig();
    if (sub === "ls" || sub === undefined) {
      const models = scanModels(cfg.modelsDir);
      if (!models.length) {
        console.log("no local models — try: maya models pull hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF");
        return;
      }
      for (const m of models) {
        const files = m.files.map((f) => `${f.quant} ${(f.bytes / 1024 ** 3).toFixed(1)}GB`).join(", ");
        console.log(`local/${m.name}  ctx:${m.contextLength}  [${files}]`);
      }
      return;
    }
    if (sub === "pull") {
      const source = rest.find((a) => !a.startsWith("--"));
      if (!source) return void console.error("usage: maya models pull <hf:owner/repo[/file.gguf] | url> [--name <n>]");
      const nameIdx = rest.indexOf("--name");
      const name = nameIdx !== -1 ? rest[nameIdx + 1] : undefined;
      let lastPct = -10;
      const model = await pullModel(cfg.modelsDir, { source, ...(name ? { name } : {}) }, (ev) => {
        if (ev.pct >= lastPct + 10) {
          lastPct = ev.pct;
          process.stdout.write(`\rpull ${ev.pct}%   `);
        }
      });
      console.log(`\npulled → ${model}`);
      return;
    }
    if (sub === "run" || sub === "stop") {
      // One-shot control against a running `maya serve` (errors if it's down).
      const name = rest[0];
      if (!name) return void console.error(`usage: maya models ${sub} <name>`);
      const model = (name.startsWith("local/") ? name : `local/${name}`) as ModelId;
      const url = `http://127.0.0.1:${cfg.gateway.port}/api/models/${model.slice("local/".length)}/${sub === "run" ? "load" : "unload"}`;
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const body = await res.json();
        if (!res.ok) throw new Error((body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`);
        console.log(sub === "run" ? `running: ${JSON.stringify(body)}` : "unloaded");
      } catch (err) {
        if ((err as Error).message.includes("fetch failed")) {
          console.error(`gateway not running on :${cfg.gateway.port} — start it with \`maya serve\``);
          process.exitCode = 1;
          return;
        }
        console.error((err as Error).message);
        process.exitCode = 1;
      }
      return;
    }
  }

  if (cmd === "team") {
    const cfg2 = loadConfig();
    const base = `http://127.0.0.1:${cfg2.orchestrator.port}/api`;
    const flag = (name: string): string | undefined => {
      const i = argv.indexOf(`--${name}`);
      return i !== -1 ? argv[i + 1] : undefined;
    };
    try {
      if (sub === "create") {
        const name = positionalArg(argv, 2);
        if (!name) return void console.error("usage: maya team create <name> [--worker <model>] [--cwd <dir>] [--tools Write,Edit] [--budget N] [--max-turns N]");
        let worker = flag("worker");
        if (!worker) {
          const catalog = (await (await fetch(`http://127.0.0.1:${cfg2.gateway.port}/api/models`)).json()) as Array<{ id: string; toolCalling?: boolean; quants?: Array<{ bytes: number }> }>;
          worker = catalog.filter((m) => m.toolCalling === true).sort((a, b) => (b.quants?.[0]?.bytes ?? 0) - (a.quants?.[0]?.bytes ?? 0))[0]?.id;
        }
        if (!worker) return void console.error("no measured tool-caller available — pull an Instruct model first");
        const body = {
          name,
          members: [{ adapter: "claude-code", model: worker, cwd: flag("cwd") ?? process.cwd(), allowedTools: (flag("tools") ?? "Write,Edit,Read").split(","), maxTurns: Number(flag("max-turns") ?? 4) }],
          ...(flag("budget") ? { tokenBudget: Number(flag("budget")) } : {}),
        };
        const res = await fetch(`${base}/teams`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const team = (await res.json()) as { id?: string; error?: string; channelId?: string };
        if (!res.ok || !team.id) throw new Error(team.error ?? `HTTP ${res.status}`);
        console.log(`team ${team.id} (${name}) — worker ${worker}`);
        console.log(`run loops on it:  maya loop "<goal>" --team ${team.id}`);
        return;
      }
      if (sub === "list" || sub === undefined) {
        // ?live=1 → server returns only live standing teams (per-run teams are
        // history). Belt-and-braces: honor the per-team `live` flag too, in
        // case the server ever returns a drained team.
        const teams = (await (await fetch(`${base}/teams?live=1`)).json()) as Array<{ id: string; name: string; state: string; live?: boolean; tokensUsed?: number; tokenBudget?: number | null }>;
        if (!teams.length) return void console.log("no live teams — maya team create <name>");
        for (const t of teams) console.log(`${t.id}  ${t.live === false ? "⚪" : "🟢"} ${t.name}  ${t.tokensUsed ?? 0}${t.tokenBudget ? `/${t.tokenBudget}` : ""} tok`);
        return;
      }
      if (sub === "drain") {
        const id = argv[2];
        if (!id) return void console.error("usage: maya team drain <id>");
        const res = await fetch(`${base}/teams/${encodeURIComponent(id)}/drain`, { method: "POST" });
        console.log(res.ok ? "drained" : `drain failed: HTTP ${res.status}`);
        return;
      }
      console.error("usage: maya team create|list|drain");
    } catch (err) {
      console.error(`team command failed: ${err instanceof Error ? err.message : err} — is \`maya serve\` running?`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "runs") {
    const cfg2 = loadConfig();
    try {
      const runs = (await (await fetch(`http://127.0.0.1:${cfg2.orchestrator.port}/api/runs`)).json()) as Array<{ runId: string; goal: string; state: string; report?: { outcome?: string; team?: { tokensUsed?: number } } }>;
      if (!runs.length) return void console.log("no loop runs yet — try: maya loop \"Create hello.txt containing exactly: hi\"");
      for (const r of runs.slice(0, 15)) {
        const rep = r.report ?? {};
        console.log(`${r.runId}  ${r.state === "running" ? "⏳ running" : rep.outcome === "success" ? "✅ success" : `◐ ${rep.outcome ?? r.state}`}  ${rep.team?.tokensUsed ?? "–"} tok  ${r.goal.slice(0, 60)}`);
      }
    } catch {
      console.error(`orchestrator not reachable on :${cfg2.orchestrator.port} — is \`maya serve\` running?`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "loop") {
    const cfg2 = loadConfig();
    const goal = positionalArg(argv, 1);
    if (!goal) return void console.error("usage: maya loop \"<goal>\" [--worker local/…] [--lead local/…] [--cwd dir] [--tools Write,Edit] [--max-turns N]");
    const flag = (name: string): string | undefined => {
      const i = argv.indexOf(`--${name}`);
      return i !== -1 ? argv[i + 1] : undefined;
    };
    // Default models: prefer a measured tool-caller for the worker.
    let worker = flag("worker");
    let lead = flag("lead");
    try {
      const catalog = (await (await fetch(`http://127.0.0.1:${cfg2.gateway.port}/api/models`)).json()) as Array<{ id: string; toolCalling?: boolean; quants?: Array<{ bytes: number }> }>;
      const toolCapable = catalog.filter((m) => m.toolCalling === true).sort((a, b) => (b.quants?.[0]?.bytes ?? 0) - (a.quants?.[0]?.bytes ?? 0));
      worker ??= toolCapable[0]?.id;
      lead ??= catalog.find((m) => m.id.includes("coder"))?.id ?? worker;
    } catch {
      // gateway down — error below
    }
    if (!worker || !lead) {
      console.error("no usable models — pull one (maya models pull hf:…) and ensure `maya serve` is running");
      process.exitCode = 1;
      return;
    }
    const cwd = flag("cwd") ?? process.cwd();
    const body = {
      goal,
      leadModel: lead,
      workerModel: worker,
      cwd,
      allowedTools: (flag("tools") ?? "Write,Edit,Read").split(","),
      maxTurns: Number(flag("max-turns") ?? 4),
      ...(flag("team") ? { teamId: flag("team") } : {}),
    };
    console.log(`goal    ${goal}`);
    console.log(`lead    ${lead}`);
    console.log(`worker  ${worker}  (measured tool-caller)`);
    console.log(`cwd     ${cwd}`);
    let runId: string;
    try {
      const res = await fetch(`http://127.0.0.1:${cfg2.orchestrator.port}/api/loop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !out.runId) throw new Error(out.error ?? `HTTP ${res.status}`);
      runId = out.runId;
    } catch (err) {
      console.error(`loop start failed: ${err instanceof Error ? err.message : err} — is \`maya serve\` running?`);
      process.exitCode = 1;
      return;
    }
    console.log(`run     ${runId}\n`);
    // Follow live via the orchestrator's SSE run-events (replay + real-time,
    // closes on the terminal report). Falls back to polling if SSE fails.
    try {
      const res2 = await fetch(`http://127.0.0.1:${cfg2.orchestrator.port}/api/runs/${runId}/events`);
      if (res2.ok && res2.body) {
        const reader = res2.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          const lines = buf.split("\n\n");
          buf = lines.pop() ?? "";
          for (const block of lines) {
            const data = block.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
            if (!data) continue;
            const e = JSON.parse(data) as { kind: string; detail?: string; outcome?: string; tokensUsed?: number };
            if (e.kind === "report") {
              console.log(`\n${e.outcome === "success" ? "✅ success" : `◐ ${e.outcome}`}  ·  ${e.tokensUsed ?? "?"} tokens`);
              if (e.outcome !== "success") process.exitCode = 2;
              done = true;
              break;
            }
            console.log(`  ${e.kind}${e.detail ? ` — ${e.detail.slice(0, 100)}` : ""}`);
          }
        }
        if (done) return;
      }
    } catch {
      // fall through to polling
    }
    let lastPrinted = 0;
    let pollFailures = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      let runs: Array<{ runId: string; state: string; report?: { outcome?: string; team?: { id?: string; channelId?: string; tokensUsed?: number }; tasks?: Array<{ state: string }> } }>;
      try {
        runs = (await (await fetch(`http://127.0.0.1:${cfg2.orchestrator.port}/api/runs`)).json()) as typeof runs;
        pollFailures = 0;
      } catch {
        // Transient orchestrator hiccup — the run keeps going server-side.
        if (++pollFailures >= 10) {
          console.error("\norchestrator unreachable for ~30s — stopped following (the run may still finish; check `maya runs`)");
          process.exitCode = 1;
          return;
        }
        continue;
      }
      const run = runs.find((r) => r.runId === runId);
      if (!run) continue;
      const chan = run.report?.team?.channelId;
      if (chan) {
        try {
          const hist = (await (
            await fetch(`http://127.0.0.1:${cfg2.dashboard.port}/api/channels/${encodeURIComponent(chan)}/history?after=${lastPrinted}&limit=50`)
          ).json()) as { messages?: Array<{ seq: number; from: string; body?: { text?: string; maya?: { kind?: string; taskId?: string } } }> };
          for (const m of hist.messages ?? []) {
            lastPrinted = Math.max(lastPrinted, m.seq);
            const maya = m.body?.maya;
            const line = maya?.kind ? `[${m.from}] ${maya.kind}${maya.taskId ? ` (${maya.taskId.slice(-6)})` : ""}` : `[${m.from}] ${(m.body?.text ?? "").slice(0, 100)}`;
            console.log(`  ${line}`);
          }
        } catch {
          // channel viewer optional — keep polling the run
        }
      }
      if (run.state !== "running") {
        const rep = run.report ?? {};
        console.log(`\n${rep.outcome === "success" ? "✅ success" : `◐ ${rep.outcome ?? run.state}`}  ·  ${rep.team?.tokensUsed ?? "?"} tokens`);
        if (rep.outcome !== "success") process.exitCode = 2;
        return;
      }
    }
  }

  if (cmd === "tune") {
    ensureDirs();
    const cfg = loadConfig();
    const name = sub && !sub.startsWith("--") ? sub : undefined;
    if (!name) {
      console.error("usage: maya tune <name> [--min-ctx N] [--target-ctx N] [--quants Q,Q] [--draft [model]] [--gen N] [--save] [--json]");
      process.exitCode = 1;
      return;
    }
    const flag = (n: string): string | undefined => {
      const i = argv.indexOf(`--${n}`);
      if (i === -1) return undefined;
      const v = argv[i + 1];
      return v && !v.startsWith("--") ? v : undefined;
    };
    const has = (n: string): boolean => argv.includes(`--${n}`);
    const json = has("json");

    const local = scanModels(cfg.modelsDir).find((m) => m.name === name.replace(/^local\//, ""));
    if (!local) {
      console.error(`model not installed: ${name} — maya models pull hf:… (see maya models ls)`);
      process.exitCode = 1;
      return;
    }
    const llama = await detectLlamaCpp();
    if (!llama.installed) {
      console.error(`llama-server not found — ${llama.installHint}`);
      process.exitCode = 1;
      return;
    }

    // Draft candidates for speculative decoding (--draft): a specific model, or
    // auto = the smallest OTHER installed model (≤35% of this model's weights).
    // The tuner MEASURES whether it actually helps — vocab-mismatch drafts just
    // fail to start and are reported as such, never silently skewing the pick.
    let drafts: DraftOption[] = [];
    if (has("draft")) {
      const all = scanModels(cfg.modelsDir);
      const mainBytes = local.files[local.files.length - 1]?.bytes ?? Infinity;
      const named = flag("draft");
      const pool = all
        .filter((m) => m.name !== local.name)
        .map((m) => ({ name: m.name, file: m.files[m.files.length - 1] }))
        .filter((m): m is { name: string; file: NonNullable<typeof m.file> } => Boolean(m.file));
      if (named) {
        const d = pool.find((m) => m.name === named.replace(/^local\//, ""));
        if (!d) return void console.error(`draft model not installed: ${named}`);
        drafts = [{ name: d.name, path: d.file.path, bytes: d.file.bytes }];
      } else {
        const auto = pool
          .filter((m) => m.file.bytes <= mainBytes * 0.35)
          .sort((a, b) => a.file.bytes - b.file.bytes)[0];
        if (auto) drafts = [{ name: auto.name, path: auto.file.path, bytes: auto.file.bytes }];
        else if (!json) console.log("no smaller model to use as a draft — testing without speculation");
      }
    }

    const quants = flag("quants")
      ?.split(",")
      .map((q) => q.trim().toUpperCase() as Quant);

    if (!json) {
      console.log(`tuning local/${local.name}  —  installed: ${local.files.map((f) => f.quant).join(", ")}`);
      console.log("measuring real tok/s per config (spawns a llama-server per candidate)…\n");
    }

    const report = await tuneModel(cfg.modelsDir, local, drafts, {
      ...(flag("min-ctx") ? { minCtx: Number(flag("min-ctx")) } : {}),
      ...(flag("target-ctx") ? { targetCtx: Number(flag("target-ctx")) } : {}),
      ...(quants ? { quants } : {}),
      ...(flag("gen") ? { genTokens: Number(flag("gen")) } : {}),
      minFreeRamBytes: cfg.guardrails.minFreeRamBytes,
      ...(json
        ? {}
        : {
          onProgress: (ev) => {
            if (ev.kind === "plan") {
              console.log(`${ev.candidates} configs fit the RAM budget — benching each\n`);
            }
            if (ev.kind === "bench") {
              process.stdout.write(
                `  [${ev.index + 1}/${ev.total}] ${ev.candidate.quant} @ ${ev.candidate.contextLength}` +
                  `${ev.candidate.draft ? ` +draft ${ev.candidate.draft}` : ""} … `,
              );
            }
            if (ev.kind === "result") {
              const r = ev.result;
              console.log(r.ok ? `${r.genTokPerSec} tok/s` : `failed (${r.error?.slice(0, 60)})`);
            }
          },
        }),
    });

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.best) process.exitCode = 2;
      return;
    }

    if (!report.best) {
      console.error("\nnothing fit — free RAM or lower --min-ctx (all candidates exceeded the budget or failed to serve).");
      process.exitCode = 2;
      return;
    }

    console.log("\nmeasured (fastest first):");
    printTuneTable(report.results);

    const b = report.best;
    console.log(`\noptimal → local/${local.name}  ${b.candidate.quant} @ ${b.candidate.contextLength}` +
      `${b.candidate.draft ? ` +draft ${b.candidate.draft}` : ""}  =  ${b.genTokPerSec} tok/s`);

    if (has("save")) {
      writeModelMeta(cfg.modelsDir, local.name, {
        contextLength: b.candidate.contextLength,
        tuned: {
          quant: b.candidate.quant,
          contextLength: b.candidate.contextLength,
          draft: b.candidate.draft ?? false,
          genTokPerSec: b.genTokPerSec,
          at: new Date().toISOString(),
        },
      });
      console.log(`saved → maya.json — \`maya models run ${local.name}\` now loads at ${b.candidate.contextLength} ctx`);
    } else {
      console.log("(re-run with --save to make this the model's default context)");
    }
    return;
  }

  if (cmd === "remote") {
    ensureDirs();
    const cfg = loadConfig();
    const portIdx = argv.indexOf("--port");
    const portRaw = portIdx !== -1 ? argv[portIdx + 1] : undefined;
    const portFlag = portRaw !== undefined ? Number(portRaw) : undefined;
    if (portFlag !== undefined && (!Number.isInteger(portFlag) || portFlag < 1 || portFlag > 65535)) {
      console.error("usage: maya remote [--port N] [--no-tunnel]  (N = 1–65535)");
      process.exitCode = 1;
      return;
    }
    // Remote is a window onto a RUNNING serve — probe the orchestrator first.
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.orchestrator.port}/api/orchestrator/health`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      console.error(`orchestrator not reachable on :${cfg.orchestrator.port} — start \`maya serve\` first, then run \`maya remote\`.`);
      process.exitCode = 1;
      return;
    }
    const { startRemoteProxy, startTunnel } = await import("./remote.js");
    let proxy: Awaited<ReturnType<typeof startRemoteProxy>>;
    try {
      proxy = await startRemoteProxy({ orchestratorPort: cfg.orchestrator.port, ...(portFlag !== undefined ? { port: portFlag } : {}) });
    } catch (err) {
      console.error(`remote proxy failed to start: ${err instanceof Error ? err.message : err} (is the port taken? try --port)`);
      process.exitCode = 1;
      return;
    }
    console.log(`maya remote   → http://127.0.0.1:${proxy.port}  (bearer-guarded proxy → orchestrator :${cfg.orchestrator.port}; gateway stays local-only)`);
    let shuttingDown = false;
    let tunnel: import("./remote.js").ActiveTunnel | null = null;
    if (!argv.includes("--no-tunnel")) {
      try {
        const t = await startTunnel(proxy.port);
        if (t.url === null) {
          console.log(`tunnel        → off (cloudflared not found — ${t.installHint}; or bring your own tunnel with --no-tunnel)`);
        } else {
          tunnel = t;
          console.log(`public url    → ${t.url}`);
          t.child.on("exit", (code) => {
            if (!shuttingDown) console.error(`[tunnel] cloudflared exited (code ${code ?? "?"}) — the public URL is dead; restart \`maya remote\``);
          });
        }
      } catch (err) {
        console.error(`tunnel failed: ${err instanceof Error ? err.message : err} — proxy still up on 127.0.0.1:${proxy.port}`);
      }
    }
    const base = tunnel?.url ?? `http://127.0.0.1:${proxy.port}`;
    // The ONE deliberate token print — this terminal is the owner's handoff.
    console.log(`\ntoken file    → ${proxy.tokenPath}  (0600; reused across runs — delete it to rotate)`);
    console.log(`token         → ${proxy.token}`);
    console.log(`\nuse it from anywhere:`);
    console.log(`  # list teams`);
    console.log(`  curl -H "Authorization: Bearer ${proxy.token}" ${base}/api/teams`);
    console.log(`  # start a loop (goal + leadModel + cwd required; teamId targets a standing team)`);
    console.log(`  curl -X POST -H "Authorization: Bearer ${proxy.token}" -H "content-type: application/json" \\`);
    console.log(`       ${base}/api/loop -d '{"goal":"…","leadModel":"local/<model>","cwd":"${process.cwd()}","teamId":"t_…"}'`);
    console.log("\nCtrl-C to stop (closes tunnel + proxy).");
    const shutdown = (): void => {
      if (shuttingDown) process.exit(130);
      shuttingDown = true;
      console.log("\nshutting down remote… (Ctrl-C again to force)");
      tunnel?.child.kill("SIGTERM");
      proxy.close();
      setTimeout(() => process.exit(0), 2_000);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (cmd === "doctor") {
    ensureDirs();
    const cfg = loadConfig();
    if (argv.includes("--install-switchyard")) {
      console.log("provisioning Switchyard venv (isolated, ~/.maya/runtimes/switchyard)…");
      const info = await provisionSwitchyard((line) => console.log(`  ${line}`));
      console.log(info.installed ? `✓ switchyard ${info.version} ready` : `✗ ${info.installHint}`);
      return;
    }
    const llama = await detectLlamaCpp();
    const { availableRam } = await import("@maya-ai/model-runtime");
    const ram = await availableRam();
    const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)}GB`;
    // Numeric semver compare — string compare says "v22.10" < "v22.5".
    const [nodeMaj = 0, nodeMin = 0] = process.versions.node.split(".").map(Number);
    const nodeOk = nodeMaj > 22 || (nodeMaj === 22 && nodeMin >= 5);
    console.log(`node          ${process.version}  ${nodeOk ? "✓" : "✗ need ≥22.5"}`);
    console.log(`llama-server  ${llama.installed ? `✓ ${llama.binPath} (${llama.version})` : `✗ ${llama.installHint}`}`);
    // Every team/agent flow spawns the claude CLI — surface its absence here
    // instead of at first spawn.
    const { execFile } = await import("node:child_process");
    const claudeVersion = await new Promise<string | null>((resolve) => {
      execFile("claude", ["--version"], { timeout: 10_000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim().split(/\s+/)[0] ?? "");
      });
    });
    console.log(`claude        ${claudeVersion !== null ? `✓ ${claudeVersion} (agents/teams enabled)` : "✗ npm install -g @anthropic-ai/claude-code (agents/teams need it)"}`);
    // maya code (mayac) — Maya's OWN harness, selectable as an agent type. Probe
    // with --help: mayac has no --version, and an unknown flag falls through to
    // the interactive TUI, which would hang doctor forever.
    const mayacOk = await new Promise<boolean>((resolve) => {
      execFile("mayac", ["--help"], { timeout: 10_000 }, (err, stdout) => resolve(!err && /mayac/i.test(stdout)));
    });
    console.log(`mayac         ${mayacOk ? "✓ installed (maya code agents enabled)" : "✗ npm install -g @maya-os/code (needed for \"maya code\" agents)"}`);
    console.log(`ram           ${gb(ram.availableBytes)} available of ${gb(ram.totalBytes)} (guardrail floor ${gb(defaultGuardrails().minFreeRamBytes)})`);
    console.log(`models dir    ${cfg.modelsDir} (${scanModels(cfg.modelsDir).length} installed)`);
    const sy = await detectSwitchyard();
    console.log(`switchyard    ${sy.installed ? `✓ ${sy.version} (Anthropic-API agents enabled)` : `✗ ${sy.installHint}`}`);
    // Port availability — held ports usually just mean `maya serve` is up.
    const portNames: Array<[string, number]> = [
      ["gateway", cfg.gateway.port],
      ["dashboard", cfg.dashboard.port],
      ["bus", cfg.bus.port],
      ["orchestrator", cfg.orchestrator.port],
    ];
    const holders = await Promise.all(portNames.map(async ([label, port]) => [label, port, await portHolder(port)] as const));
    const held = holders.filter(([, , pid]) => pid !== null);
    console.log(`ports         ${held.length === 0
      ? `✓ ${portNames.map(([, p]) => `:${p}`).join(" ")} free`
      : held.map(([label, port, pid]) => `:${port} (${label}) held by pid ${pid}`).join(", ") + " — a `maya serve` may already be running"}`);
    return;
  }

  console.log(HELP);
}

/** Render measured tune results as an aligned table (fastest first). */
function printTuneTable(results: TuneResult[]): void {
  const rows = results.map((r) => ({
    cfg: `${r.candidate.quant} @ ${r.candidate.contextLength}${r.candidate.draft ? ` +${r.candidate.draft}` : ""}`,
    gen: r.ok ? `${r.genTokPerSec}` : "—",
    prompt: r.ok ? `${r.promptTokPerSec}` : "—",
    load: r.ok ? `${(r.loadMs / 1000).toFixed(1)}s` : "—",
    note: r.ok ? "" : `failed: ${r.error?.slice(0, 40) ?? "?"}`,
  }));
  const w = (k: keyof (typeof rows)[number], head: string): number =>
    Math.max(head.length, ...rows.map((row) => row[k].length));
  const wc = w("cfg", "config");
  const wg = w("gen", "gen tok/s");
  const wp = w("prompt", "prompt tok/s");
  const wl = w("load", "load");
  const pad = (s: string, n: number): string => s.padEnd(n);
  console.log(`  ${pad("config", wc)}  ${pad("gen tok/s", wg)}  ${pad("prompt tok/s", wp)}  ${pad("load", wl)}`);
  for (const row of rows) {
    console.log(`  ${pad(row.cfg, wc)}  ${pad(row.gen, wg)}  ${pad(row.prompt, wp)}  ${pad(row.load, wl)}  ${row.note}`.trimEnd());
  }
}

/** Pid holding a local TCP port, or null when it's free (best-effort, macOS/Linux). */
async function portHolder(port: number): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("lsof", ["-ti", `:${port}`], { timeout: 3_000 });
    return stdout.trim().split("\n")[0] || null;
  } catch {
    return null; // lsof absent or port free
  }
}
