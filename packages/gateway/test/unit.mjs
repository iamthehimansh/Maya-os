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

// ── provider resolution (pure) ───────────────────────────────────────────────
const { resolveProvider, PROVIDERS } = await import("../dist/providers.js");
assert.equal(PROVIDERS.length, 7, "7 cloud providers");
delete process.env.OPENAI_API_KEY;
let r = resolveProvider("openai/gpt-4o", []);
assert(r.error?.includes("OPENAI_API_KEY") && r.status === 503, "no key → 503 naming the env var");
process.env.OPENAI_API_KEY = "sk-test";
r = resolveProvider("openai/gpt-4o", []);
assert.equal(r.upstreamModel, "gpt-4o", "prefix stripped");
assert.equal(r.baseUrl, "https://api.openai.com/v1");
r = resolveProvider("openai/gpt-4o", [{ id: "openai", baseUrl: "http://proxy:9/v1/", enabled: true }]);
assert.equal(r.baseUrl, "http://proxy:9/v1", "user baseUrl override + trailing slash trimmed");
r = resolveProvider("openai/gpt-4o", [{ id: "openai", apiKeyEnv: "MY_KEY", enabled: true }]);
assert(r.error?.includes("MY_KEY"), "custom keyEnv respected");
r = resolveProvider("nope/x", []);
assert(r.status === 400 && r.error.includes("known:"), "unknown provider lists known ids");
delete process.env.OPENAI_API_KEY;
console.log("PROVIDER UNIT PASS ✅");

// responses route present (Codex >=0.142 requirement)
assert(serverSrc.includes("/v1/responses"), "responses route present");
console.log("RESPONSES ROUTE GUARD PASS ✅");
