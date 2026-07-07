// Gateway unit tests — pure logic, no processes.  node test/unit.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSwitchyardConfig } from "../dist/switchyard.js";

// ── switchyard config generation ─────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maya-gwtest-"));
assert.equal(generateSwitchyardConfig(tmp, 4100), null, "no models → null (skip sidecar)");

fs.mkdirSync(path.join(tmp, "my-model"));
fs.writeFileSync(path.join(tmp, "my-model", "my-model-Q4_K_M.gguf"), "x");
fs.mkdirSync(path.join(tmp, "other.model"));
fs.writeFileSync(path.join(tmp, "other.model", "w-Q8_0.gguf"), "x");

const cfg = generateSwitchyardConfig(tmp, 4100);
assert(cfg.includes("base_url: http://127.0.0.1:4100/v1"), "points at gateway");
assert(cfg.includes("model: local/my-model"), "target per model");
assert(cfg.includes("t-other-model:"), "unsafe chars sanitized in target key");
assert(cfg.includes("type: passthrough"), "passthrough profile");
assert(!cfg.includes("api_key: sk"), "no real keys ever");
fs.rmSync(tmp, { recursive: true, force: true });

// ── tool-schema sanitizer (via the exported app is heavy; test the shape rule) ──
// The sanitizer strips maxLength/minLength > 1024 recursively; verified live by
// bisecting Claude Code's 27-tool payload (Workflow's maxLength: 524288 was the
// grammar-breaker). Here: guard the cap constant hasn't drifted.
const serverSrc = fs.readFileSync(new URL("../dist/server.js", import.meta.url), "utf8");
assert(serverSrc.includes("GRAMMAR_SAFE_MAX_LENGTH = 1024"), "sanitizer cap present");
assert(serverSrc.includes("/v1/messages"), "anthropic route present");

console.log("GATEWAY UNIT PASS ✅");
