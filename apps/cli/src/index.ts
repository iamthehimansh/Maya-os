import { defaultGuardrails, ensureDirs, loadConfig, mayaHome } from "@maya-ai/core";
import type { ModelId } from "@maya-ai/core";
import { RuntimeManager, pullModel, scanModels, detectLlamaCpp } from "@maya-ai/model-runtime";
import { detectSwitchyard, provisionSwitchyard, startGateway, startSwitchyard, type SidecarHandle } from "@maya-ai/gateway";

const HELP = `maya — local-first AI OS for developers (Apple Silicon first)

Usage:
  maya serve                     boot the platform (gateway + runtime) — Ctrl-C stops everything
  maya status                    show configured ports, providers, home dir
  maya models ls                 installed local models (+ live instances)
  maya models pull <source>      hf:owner/repo[/file.gguf] or URL   [--name <n>]
  maya models run <name>         load a model (guardrails apply)
  maya models stop <name>        unload a model
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
    console.log("Ctrl-C to stop (unloads every model instance).");
    const shutdown = (): void => {
      console.log("\nshutting down…");
      server.close();
      void Promise.allSettled([manager.unloadAll(), sidecar?.stop() ?? Promise.resolve()]).then(() => process.exit(0));
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
