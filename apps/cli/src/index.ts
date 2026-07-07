import { ensureDirs, loadConfig, mayaHome } from "@maya-ai/core";

const HELP = `maya — local-first AI OS for developers (Apple Silicon first)

Usage:
  maya            boot the platform (gateway + bus + dashboard)   [M1 — not wired yet]
  maya status     show configured ports, providers, and home dir
  maya --version  print version

M0 scaffold: commands below \`status\` land with milestone M1.`;

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "";

  if (cmd === "--version" || cmd === "-v") {
    console.log("maya-os 0.0.1");
    return;
  }

  if (cmd === "status" || cmd === "") {
    ensureDirs();
    const cfg = loadConfig();
    console.log("Maya (M0 scaffold)");
    console.log(`  home       ${mayaHome()}`);
    console.log(`  gateway    :${cfg.gateway.port}   (OpenAI + Anthropic compatible — M1)`);
    console.log(`  dashboard  :${cfg.dashboard.port}   (web UI — M4)`);
    console.log(`  bus        :${cfg.bus.port}   (Maya bus — agent plane)`);
    console.log(`  models     ${cfg.modelsDir}`);
    console.log(`  providers  ${cfg.providers.filter((p) => p.enabled).map((p) => p.id).join(", ") || "none enabled yet"}`);
    if (cmd === "") {
      console.log("\nBoot supervisor lands in M1 — run `maya status` meanwhile.");
    }
    return;
  }

  console.log(HELP);
}
