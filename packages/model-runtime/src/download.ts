import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ModelId, RuntimeEvent } from "@maya-ai/core";
import { quantFromFilename, readModelMeta, writeModelMeta } from "./registry.js";

export interface PullRequest {
  /** "hf:<owner>/<repo>[/<file>.gguf]" or a direct https URL to a .gguf. */
  source: string;
  /** Local name → becomes ModelId "local/<name>". Defaults from repo/file. */
  name?: string;
}

export interface PullProgress {
  (ev: RuntimeEvent & { type: "pull_progress" }): void;
}

interface HfFile {
  rfilename: string;
  size?: number;
  lfs?: { sha256?: string };
}

/**
 * Pull a GGUF into modelsDir/<name>/. Resumable (HTTP Range onto a .part
 * file), sha256-verified when HuggingFace advertises one, disk-space
 * preflighted. Returns the ModelId.
 */
export async function pullModel(
  modelsDir: string,
  req: PullRequest,
  onProgress?: PullProgress,
): Promise<ModelId> {
  const resolved = await resolveSource(req.source);
  const name = req.name ?? resolved.suggestedName;
  const model: ModelId = `local/${name}`;
  const dir = path.join(modelsDir, name);
  fs.mkdirSync(dir, { recursive: true });

  // Total-size disk preflight across every part.
  const totalBytes = resolved.parts.reduce((n, p) => n + (p.size ?? 0), 0);
  if (totalBytes > 0) {
    const { bavail, bsize } = fs.statfsSync(modelsDir);
    const free = bavail * bsize;
    if (totalBytes * 1.05 > free) {
      throw new Error(`not enough disk: need ~${gb(totalBytes)}, have ${gb(free)} free`);
    }
  }

  // Download each part (resumable, checksum-verified), reporting cumulative %.
  let doneBytes = 0;
  for (const partSpec of resolved.parts) {
    const dest = path.join(dir, partSpec.filename);
    if (fs.existsSync(dest)) {
      doneBytes += partSpec.size ?? fs.statSync(dest).size;
      continue; // this part already pulled
    }
    const part = dest + ".part";
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const headers: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {};
    const res = await fetch(partSpec.url, { headers, redirect: "follow" });
    if (!res.ok && res.status !== 206) throw new Error(`download failed: HTTP ${res.status} (${partSpec.filename})`);
    if (!res.body) throw new Error(`download failed: empty body (${partSpec.filename})`);

    const base = doneBytes;
    let lastPct = -1;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        doneBytes += chunk.byteLength;
        const pct = totalBytes ? Math.floor((doneBytes / totalBytes) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress?.({ type: "pull_progress", model, pct });
        }
        controller.enqueue(chunk);
      },
    });
    doneBytes = base + have;
    await pipeline(
      res.body.pipeThrough(counter) as unknown as NodeJS.ReadableStream,
      fs.createWriteStream(part, { flags: have > 0 && res.status === 206 ? "a" : "w" }),
    );
    if (partSpec.sha256) {
      const actual = await sha256File(part);
      if (actual !== partSpec.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error(`checksum mismatch for ${partSpec.filename} — removed; re-pull`);
      }
    }
    fs.renameSync(part, dest);
  }
  // contextLength 8192 is only the FIRST-pull default — pulling another quant
  // into an existing dir (or re-pulling) must not clobber a tuned/profiled ctx.
  const hasCtx = readModelMeta(modelsDir, name).contextLength !== undefined;
  writeModelMeta(modelsDir, name, { source: req.source, ...(hasCtx ? {} : { contextLength: 8192 }) });
  onProgress?.({ type: "pull_progress", model, pct: 100 });
  return model;
}

interface DownloadPart {
  url: string;
  filename: string;
  size?: number;
  sha256?: string;
}
interface ResolvedSource {
  parts: DownloadPart[]; // >1 for split/multi-part GGUFs (llama.cpp loads via part-1)
  suggestedName: string;
}

/** llama.cpp split-GGUF naming: name-00001-of-00003.gguf */
const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

async function resolveSource(source: string): Promise<ResolvedSource> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const filename = decodeURIComponent(source.split("/").pop() ?? "model.gguf");
    return { parts: [{ url: source, filename }], suggestedName: baseName(filename) };
  }
  if (!source.startsWith("hf:")) throw new Error(`unsupported source: ${source} (use hf:owner/repo[/file.gguf] or a URL)`);

  const spec = source.slice(3);
  const parts = spec.split("/");
  if (parts.length < 2) throw new Error(`bad hf source: ${source}`);
  const repo = `${parts[0]}/${parts[1]}`;
  let file = parts.slice(2).join("/");

  const api = `https://huggingface.co/api/models/${repo}?blobs=true`;
  const res = await fetch(api, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HuggingFace lookup failed for ${repo}: HTTP ${res.status}`);
  const info = (await res.json()) as { siblings?: HfFile[] };
  const ggufs = (info.siblings ?? []).filter((s) => s.rfilename.endsWith(".gguf"));
  if (!ggufs.length) throw new Error(`${repo} has no .gguf files`);

  if (!file) {
    // No file specified → prefer Q4_K_M (the sweet spot), else the smallest.
    const q4 = ggufs.find((g) => quantFromFilename(g.rfilename) === "Q4_K_M");
    const pick = q4 ?? ggufs.sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0]!;
    file = pick.rfilename;
  }
  const meta = ggufs.find((g) => g.rfilename === file);
  if (!meta) throw new Error(`${file} not found in ${repo}`);

  // Split GGUF? Gather every sibling part so the whole set downloads.
  const m = SPLIT_RE.exec(file);
  const partFiles = m
    ? ggufs
        .filter((g) => g.rfilename.replace(SPLIT_RE, "") === file.replace(SPLIT_RE, ""))
        .sort((a, b) => a.rfilename.localeCompare(b.rfilename))
    : [meta];
  const toUrl = (f: string): string => `https://huggingface.co/${repo}/resolve/main/${f}`;
  return {
    parts: partFiles.map((g) => ({
      url: toUrl(g.rfilename),
      filename: path.basename(g.rfilename),
      ...(g.size ? { size: g.size } : {}),
      ...(g.lfs?.sha256 ? { sha256: g.lfs.sha256 } : {}),
    })),
    // name from the base (drop the -NNNNN-of-NNNNN suffix for the dir name)
    suggestedName: baseName(path.basename(file).replace(SPLIT_RE, ".gguf")),
  };
}

/** "Qwen3-4B-Instruct-Q4_K_M.gguf" → "qwen3-4b-instruct" */
function baseName(filename: string): string {
  return filename
    .replace(/\.gguf$/i, "")
    .replace(/[-.](F16|Q8_0|Q6_K|Q5_K_M|Q4_K_M|Q3_K_M)/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function sha256File(p: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(p), async function* (src) {
    for await (const chunk of src) {
      hash.update(chunk as Buffer);
      yield;
    }
  });
  return hash.digest("hex");
}

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}
