import fs from "node:fs";
import path from "node:path";
import type { LocalModel, ModelId, Quant } from "@maya-ai/core";

const QUANT_LADDER: Quant[] = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M"];

/** Best → smallest, starting at (and including) `from`. */
export function quantLadderFrom(from: Quant): Quant[] {
  const i = QUANT_LADDER.indexOf(from);
  return QUANT_LADDER.slice(i === -1 ? 0 : i);
}

/** "qwen3-4b-Q4_K_M.gguf" → Q4_K_M (llama.cpp naming conventions). */
export function quantFromFilename(file: string): Quant | undefined {
  const m = /(F16|Q8_0|Q6_K|Q5_K_M|Q4_K_M|Q3_K_M)/i.exec(file);
  return m ? (m[1]!.toUpperCase() as Quant) : undefined;
}

interface ModelMeta {
  source?: string;
  contextLength?: number;
  chatTemplate?: string;
  draftModel?: string | false;
  toolCalling?: boolean;
}

/**
 * Disk layout under modelsDir:
 *   <name>/<anything>-<QUANT>.gguf     (one dir per model, one file per quant)
 *   <name>/maya.json                   (optional ModelMeta)
 * The registry is a pure directory scan — no database; the filesystem is the
 * source of truth so users can drop GGUFs in manually and they just appear.
 */
export function scanModels(modelsDir: string): LocalModel[] {
  if (!fs.existsSync(modelsDir)) return [];
  const out: LocalModel[] = [];
  for (const entry of fs.readdirSync(modelsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(modelsDir, entry.name);
    const files: LocalModel["files"] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".gguf")) continue;
      const quant = quantFromFilename(f) ?? "Q4_K_M";
      files.push({ quant, path: path.join(dir, f), bytes: fs.statSync(path.join(dir, f)).size });
    }
    if (!files.length) continue;
    let meta: ModelMeta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "maya.json"), "utf8")) as ModelMeta;
    } catch {
      // optional
    }
    out.push({
      name: entry.name,
      source: meta.source ?? "manual",
      files: files.sort((a, b) => b.bytes - a.bytes),
      contextLength: meta.contextLength ?? 8192,
      ...(meta.chatTemplate ? { chatTemplate: meta.chatTemplate } : {}),
      ...(meta.draftModel !== undefined ? { draftModel: meta.draftModel } : {}),
      ...(meta.toolCalling !== undefined ? { toolCalling: meta.toolCalling } : {}),
    });
  }
  return out;
}

export function findModel(modelsDir: string, id: ModelId): LocalModel | undefined {
  const name = id.startsWith("local/") ? id.slice("local/".length) : id;
  return scanModels(modelsDir).find((m) => m.name === name);
}

export function writeModelMeta(modelsDir: string, name: string, meta: ModelMeta): void {
  const dir = path.join(modelsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  // Merge over any existing meta so independent writers (pull, probes,
  // profile edits) never clobber each other's fields.
  let existing: ModelMeta = {};
  try {
    existing = JSON.parse(fs.readFileSync(path.join(dir, "maya.json"), "utf8")) as ModelMeta;
  } catch {
    // first write
  }
  fs.writeFileSync(path.join(dir, "maya.json"), JSON.stringify({ ...existing, ...meta }, null, 2) + "\n");
}
