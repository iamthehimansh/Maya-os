import { defaultGuardrails, ensureDirs, loadConfig, mayaHome } from "@maya-ai/core";
import type { ModelId } from "@maya-ai/core";
import { RuntimeManager, pullModel, scanModels, detectLlamaCpp } from "@maya-ai/model-runtime";
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
  maya loop "<goal>"             run an AI team on a goal (lead plans, workers execute, gates verify)
                                 [--worker <model>] [--lead <model>] [--cwd <dir>] [--tools Write,Edit] [--max-turns N]
  maya runs                      recent loop runs with outcomes + tokens
  maya team create <name>        standing team (run many loops on one fleet)
                                 [--worker <model>] [--cwd <dir>] [--tools T,T] [--budget N]
  maya team list                 live teams with budgets + token burn
  maya team drain <id>           stop a standing team
  maya doctor                    check llama.cpp, RAM tier, ports
  maya --version

The gateway serves OpenAI-compatible /v1 at http://127.0.0.1:<gateway.port>.
Bus / agents / teams / dashboard commands land with Phases 3–8.`;

export async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;

  if (cmd === "--version" || cmd === "-v") {
    console.log("maya-os 0.0.1");
    return;
  }

  if (cmd === "status" || cmd === undefined) {
    ensureDirs();
    const cfg = loadConfig();
    console.log("Maya");
    console.log(`  home       ${mayaHome()}`);
    console.log(`  gateway    :${cfg.gateway.port}   (OpenAI-compatible /v1 — \`maya serve\`)`);
    console.log(`  dashboard  :${cfg.dashboard.port}   (web UI — Phase 8)`);
    console.log(`  bus        :${cfg.bus.port}   (Maya bus — Phase 3)`);
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
      else adminToken = fs.readFileSync(tokenFile, "utf8").trim();
      busInfo = { port: busServer.port, adminToken };
      console.log(`maya bus      → ws://127.0.0.1:${busServer.port}  (agent channels)`);
      // Orchestrator service (teams / tasks / loop runs) — agent plane.
      orch = await startOrchestratorService({
        dbPath: dbPath(),
        gatewayBaseUrl: `http://127.0.0.1:${cfg.gateway.port}`,
        bus: { wsBase: `ws://127.0.0.1:${busServer.port}`, adminToken, httpBase: `http://127.0.0.1:${busServer.port}` },
        port: cfg.orchestrator.port,
      });
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
    const shutdown = (): void => {
      console.log("\nshutting down…");
      server.close();
      dashServer?.close();
      void Promise.allSettled([
        manager.unloadAll(),
        sidecar?.stop() ?? Promise.resolve(),
        orch?.close() ?? Promise.resolve(),
        busServer?.close() ?? Promise.resolve(),
      ]).then(() => process.exit(0));
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
      // One-shot control against a running `maya serve`, else direct.
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
        const name = argv.slice(2).find((a) => !a.startsWith("--"));
        if (!name) return void console.error("usage: maya team create <name> [--worker <model>] [--cwd <dir>] [--tools Write,Edit] [--budget N]");
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
        const all = (await (await fetch(`${base}/teams`)).json()) as Array<{ id: string; name: string; state: string; tokensUsed?: number; tokenBudget?: number | null }>;
        // Standing teams only — per-run teams close on completion and are history.
        const teams = all.filter((t) => t.state === "active");
        if (!teams.length) return void console.log("no live teams — maya team create <name>");
        for (const t of teams) console.log(`${t.id}  🟢 ${t.name}  ${t.tokensUsed ?? 0}${t.tokenBudget ? `/${t.tokenBudget}` : ""} tok`);
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
    const goal = argv.slice(1).find((a) => !a.startsWith("--"));
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
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const runs = (await (await fetch(`http://127.0.0.1:${cfg2.orchestrator.port}/api/runs`)).json()) as Array<{ runId: string; state: string; report?: { outcome?: string; team?: { id?: string; channelId?: string; tokensUsed?: number }; tasks?: Array<{ state: string }> } }>;
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
    console.log(`node          ${process.version}  ${process.version >= "v22.5" ? "✓" : "✗ need ≥22.5"}`);
    console.log(`llama-server  ${llama.installed ? `✓ ${llama.binPath} (${llama.version})` : `✗ ${llama.installHint}`}`);
    console.log(`ram           ${gb(ram.availableBytes)} available of ${gb(ram.totalBytes)} (guardrail floor ${gb(defaultGuardrails().minFreeRamBytes)})`);
    console.log(`models dir    ${cfg.modelsDir} (${scanModels(cfg.modelsDir).length} installed)`);
    const sy = await detectSwitchyard();
    console.log(`switchyard    ${sy.installed ? `✓ ${sy.version} (Anthropic-API agents enabled)` : `✗ ${sy.installHint}`}`);
    return;
  }

  console.log(HELP);
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
