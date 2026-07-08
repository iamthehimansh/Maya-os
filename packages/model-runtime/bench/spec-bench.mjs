// Speculative-decoding benchmark for Maya's runtime.
//
// Measures decode throughput (tok/s) and greedy correctness for a target model
// alone vs. target + draft under several spec-decode configs. Everything is
// greedy (temp 0, fixed seed) so outputs are comparable byte-for-byte: with the
// target sampled at argmax, llama.cpp accepts a draft token only when it equals
// the target's argmax, so a correct speculative run is IDENTICAL to target-alone
// greedy. We assert that here rather than trusting the theory.
//
// Usage:
//   node bench/spec-bench.mjs
//   MAYA_LLAMA_SERVER=/path/to/llama-server node bench/spec-bench.mjs
//
// Env overrides:
//   BENCH_TARGET  path to the 7B GGUF   (default: qwen2.5-7b-instruct Q4_K_M)
//   BENCH_DRAFT   path to the 0.5B GGUF (default: qwen2.5-0.5b-instruct Q4_K_M)
//   BENCH_NPREDICT  tokens to generate per prompt (default 256)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN =
  process.env.MAYA_LLAMA_SERVER ||
  ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"].find((p) => fs.existsSync(p)) ||
  "llama-server";

const MODELS = path.join(os.homedir(), ".maya", "models");
const TARGET =
  process.env.BENCH_TARGET || path.join(MODELS, "qwen2.5-7b-instruct", "Qwen2.5-7B-Instruct-Q4_K_M.gguf");
const DRAFT =
  process.env.BENCH_DRAFT || path.join(MODELS, "qwen2.5-0.5b-instruct", "qwen2.5-0.5b-instruct-q4_k_m.gguf");
const N_PREDICT = Number(process.env.BENCH_NPREDICT || 256);
const PORT = 41815;
const CTX = 4096;

// Base argv mirrors Maya's llamaServerArgs() Metal defaults (llamacpp.ts) so the
// benchmark measures what Maya actually serves, not a bespoke config.
const baseArgs = (extra) => [
  "--model", TARGET,
  "--port", String(PORT),
  "--host", "127.0.0.1",
  "--ctx-size", String(CTX),
  "--n-gpu-layers", "999",
  "--flash-attn", "on",
  "--cache-type-k", "q8_0",
  "--cache-type-v", "q8_0",
  "--no-webui",
  ...extra,
];

// Draft flags for a config. `spec` is a partial: { nMax, nMin, pMin, type }.
// NOTE (build 9890): `--model-draft` alone is a NO-OP — the draft model is not
// even loaded unless `--spec-type` selects an algorithm. `draft-simple` is
// classic draft-model speculation; `ngram-*` needs no draft model at all.
const draftArgs = (spec) => {
  const type = spec.type ?? "draft-simple";
  const a = ["--spec-type", type];
  if (type.startsWith("draft")) {
    a.push(
      "--model-draft", DRAFT,
      "--gpu-layers-draft", "999",
      "--cache-type-k-draft", "q8_0",
      "--cache-type-v-draft", "q8_0",
    );
  }
  if (spec.nMax != null) a.push("--spec-draft-n-max", String(spec.nMax));
  if (spec.nMin != null) a.push("--spec-draft-n-min", String(spec.nMin));
  if (spec.pMin != null) a.push("--spec-draft-p-min", String(spec.pMin));
  return a;
};

// Prompts span the range an agent runtime actually sees: structured code (where
// a small draft aligns well) and free prose (the adversarial case).
const PROMPTS = [
  {
    name: "code",
    text:
      "Write a complete TypeScript function `debounce<T extends (...a:any[])=>void>(fn:T, ms:number)` " +
      "with a leading/trailing option, full JSDoc, and three usage examples. Output only code.",
  },
  {
    name: "prose",
    text: "Explain how a CPU branch predictor works, in three detailed paragraphs for a systems programmer.",
  },
];

function waitHealth(port, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error("server never became healthy"));
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function complete(port, prompt) {
  const r = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt,
      n_predict: N_PREDICT,
      temperature: 0, // greedy → deterministic, argmax
      top_k: 1,
      seed: 42,
      cache_prompt: false,
    }),
  });
  if (!r.ok) throw new Error(`completion ${r.status}: ${await r.text()}`);
  return r.json();
}

async function runServer(args, fn) {
  const proc = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const logBuf = { text: "" };
  proc.stdout.on("data", (d) => (logBuf.text += d));
  proc.stderr.on("data", (d) => (logBuf.text += d));
  const exited = new Promise((_, rej) =>
    proc.on("exit", (code) => rej(new Error(`llama-server exited early (${code})\n${logBuf.text.slice(-2000)}`))),
  );
  try {
    await Promise.race([waitHealth(PORT), exited]);
    return await fn(logBuf);
  } finally {
    proc.kill("SIGKILL");
    await new Promise((r) => proc.on("exit", r));
    await new Promise((r) => setTimeout(r, 500)); // let the port drain
  }
}

// Sum draft acceptance across all "draft acceptance = .. ( A accepted / G generated )"
// lines llama-server prints per task (there is no API field for it in 9890).
function parseAcceptance(log) {
  let accepted = 0;
  let generated = 0;
  const re = /draft acceptance = [\d.]+ \(\s*(\d+) accepted \/\s*(\d+) generated\)/g;
  let m;
  while ((m = re.exec(log))) {
    accepted += Number(m[1]);
    generated += Number(m[2]);
  }
  return { accepted, generated };
}

// Measure one server config across all prompts. Returns per-prompt rows and the
// generated texts (for byte-identical comparison against baseline).
async function measure(label, args) {
  return runServer(args, async (logBuf) => {
    const rows = [];
    const texts = {};
    // one warm-up (model + Metal pipeline) that we don't score
    await complete(PORT, "warm up").catch(() => {});
    const acceptBefore = parseAcceptance(logBuf.text);
    for (const p of PROMPTS) {
      const res = await complete(PORT, p.text);
      const t = res.timings;
      texts[p.name] = res.content;
      rows.push({ label, prompt: p.name, tps: t.predicted_per_second, predicted: t.predicted_n });
    }
    const acceptAfter = parseAcceptance(logBuf.text);
    const dn = acceptAfter.generated - acceptBefore.generated;
    const da = acceptAfter.accepted - acceptBefore.accepted;
    for (const r of rows) {
      r.draftN = dn;
      r.draftAccepted = da;
    }
    return { rows, texts };
  });
}

async function main() {
  for (const f of [TARGET, DRAFT]) {
    if (!fs.existsSync(f)) throw new Error(`missing GGUF: ${f}`);
  }
  console.error(`# spec-bench  target=${path.basename(TARGET)}  draft=${path.basename(DRAFT)}  n_predict=${N_PREDICT}`);
  console.error(`# bin=${BIN}\n`);

  const configs = [
    { label: "baseline (no draft)", args: baseArgs([]) },
    { label: "draft n=16 p=0 (untuned)", args: baseArgs(draftArgs({ nMax: 16, pMin: 0 })) },
    { label: "draft n=8 p=0.6", args: baseArgs(draftArgs({ nMax: 8, pMin: 0.6 })) },
    { label: "draft n=8 p=0.75", args: baseArgs(draftArgs({ nMax: 8, pMin: 0.75 })) },
    { label: "draft n=6 p=0.8", args: baseArgs(draftArgs({ nMax: 6, pMin: 0.8 })) },
    { label: "draft n=4 p=0.8", args: baseArgs(draftArgs({ nMax: 4, pMin: 0.8 })) },
    { label: "draft n=10 p=0.9", args: baseArgs(draftArgs({ nMax: 10, pMin: 0.9 })) },
    { label: "ngram-simple (no draft)", args: baseArgs(draftArgs({ type: "ngram-simple" })) },
  ];

  const all = [];
  let baseTexts = null;
  for (const c of configs) {
    process.stderr.write(`running: ${c.label} … `);
    try {
      const { rows, texts } = await measure(c.label, c.args);
      all.push(...rows);
      if (c.label.startsWith("baseline")) baseTexts = texts;
      else if (baseTexts) {
        for (const p of PROMPTS) {
          rows.find((r) => r.prompt === p.name).identical = texts[p.name] === baseTexts[p.name];
        }
      }
      process.stderr.write("ok\n");
    } catch (e) {
      process.stderr.write(`FAILED: ${e.message}\n`);
    }
  }

  // ---- results table (aggregate tok/s = mean across prompts) ----
  const baseTps = mean(all.filter((r) => r.label.startsWith("baseline")).map((r) => r.tps));
  const byLabel = new Map();
  for (const r of all) {
    if (!byLabel.has(r.label)) byLabel.set(r.label, []);
    byLabel.get(r.label).push(r);
  }
  console.log(`\n## spec-bench results (mean over ${PROMPTS.length} prompts, n_predict=${N_PREDICT})\n`);
  console.log("| config | tok/s | speedup | accept% | identical |");
  console.log("|---|---:|---:|---:|:---:|");
  for (const [label, rows] of byLabel) {
    const tps = mean(rows.map((r) => r.tps));
    const speedup = tps / baseTps;
    const dn = sum(rows.map((r) => r.draftN || 0));
    const da = sum(rows.map((r) => r.draftAccepted || 0));
    const accept = dn > 0 ? ((da / dn) * 100).toFixed(0) + "%" : "—";
    const ident = rows.every((r) => r.identical !== false);
    const identStr = label.startsWith("baseline") ? "—" : ident ? "✅" : "❌";
    console.log(
      `| ${label} | ${tps.toFixed(1)} | ${speedup.toFixed(2)}× | ${accept} | ${identStr} |`,
    );
  }
  console.log(`\nbaseline = ${baseTps.toFixed(1)} tok/s\n`);
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
