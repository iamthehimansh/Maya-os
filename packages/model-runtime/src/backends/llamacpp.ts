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
  /** Model name reported in /v1 responses (the ModelId) — without it llama-server echoes the absolute GGUF path, leaking local paths into agent logs. */
  alias?: string;
  /** Draft model GGUF for speculative decoding (same tokenizer family required — llama-server validates at startup). */
  draftPath?: string;
  /** Override the GGUF's embedded chat template (--chat-template-file) — see TEMPLATE_QUIRKS. */
  chatTemplateFile?: string;
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
    ...(a.alias ? ["--alias", a.alias] : []),
    "--port", String(a.port),
    "--host", "127.0.0.1",
    "--ctx-size", String(a.contextLength),
    "--n-gpu-layers", "999",
    "--jinja", // chat-template engine: required for native tool-calling (agents send tools)
    // q8 KV cache: halves context RAM for negligible accuracy loss — the
    // difference between 16k and 32k context on the same low-RAM Mac.
    // V-quantization requires flash attention, so pin it on (Metal supports it).
    "--flash-attn", "on",
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
    ...(a.chatTemplateFile ? ["--chat-template-file", a.chatTemplateFile] : []),
    ...(a.draftPath
      ? ["--model-draft", a.draftPath, "--gpu-layers-draft", "999", "--cache-type-k-draft", "q8_0", "--cache-type-v-draft", "q8_0"]
      : []),
    "--no-webui",
    "--metrics",
    ...(a.extra ?? []),
  ];
}
