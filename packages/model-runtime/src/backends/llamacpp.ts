import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface LlamaCppInfo {
  installed: boolean;
  binPath?: string;
  version?: string;
  installHint?: string;
}

const CANDIDATES = [
  process.env.MAYA_LLAMA_SERVER, // explicit override wins
  "/opt/homebrew/bin/llama-server",
  "/usr/local/bin/llama-server",
  "llama-server", // PATH
].filter((p): p is string => Boolean(p));

let cached: LlamaCppInfo | null = null;

/**
 * Locate llama-server + version — powers `maya doctor` and spawn preflight.
 * The --version probe can take ~10s cold (dyld + Metal framework load under
 * disk pressure), so the timeout is generous and a success is memoized.
 */
export async function detectLlamaCpp(): Promise<LlamaCppInfo> {
  if (cached?.installed) return cached;
  for (const bin of CANDIDATES) {
    try {
      if (bin.includes("/") && !fs.existsSync(bin)) continue;
      const { stdout, stderr } = await execFileP(bin, ["--version"], { timeout: 30_000 });
      const version = /version: (\S+)/.exec(stdout + stderr)?.[1];
      cached = { installed: true, binPath: bin, ...(version ? { version } : {}) };
      return cached;
    } catch {
      // try next candidate
    }
  }
  return {
    installed: false,
    installHint: "brew install llama.cpp   (or set MAYA_LLAMA_SERVER=/path/to/llama-server)",
  };
}

export interface LlamaServerArgs {
  modelPath: string;
  port: number;
  contextLength: number;
  /** Extra raw args appended last (model profiles / power users). */
  extra?: string[];
}

/**
 * Argument builder for llama-server with Metal-sane defaults:
 * all layers on GPU, mmap on (default), no browser UI, metrics endpoint on.
 * Kept as a pure function so tests can assert exact argv.
 */
export function llamaServerArgs(a: LlamaServerArgs): string[] {
  return [
    "--model", a.modelPath,
    "--port", String(a.port),
    "--host", "127.0.0.1",
    "--ctx-size", String(a.contextLength),
    "--n-gpu-layers", "999",
    "--jinja", // chat-template engine: required for native tool-calling (agents send tools)
    "--no-webui",
    "--metrics",
    ...(a.extra ?? []),
  ];
}
