// Bundle-adjacent assets: dashboard SPA + model-runtime chat templates.
import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// apps/dashboard/dist is gitignored — on a fresh clone (or after a clean) it
// doesn't exist. Build it here rather than fail with ENOENT or, worse,
// silently pack a stale/missing web UI into the npm tarball.
const dashIndex = new URL("../../dashboard/dist/index.html", import.meta.url);
if (!fs.existsSync(dashIndex)) {
  console.log("dashboard not built — running `pnpm --filter @maya-ai/dashboard build`…");
  execSync("pnpm --filter @maya-ai/dashboard build", {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    stdio: "inherit",
  });
  if (!fs.existsSync(dashIndex)) {
    console.error("dashboard build produced no dist/index.html — refusing to package a broken web UI");
    process.exit(1);
  }
}

const cp = (src, dst) => { fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); };
cp(new URL("../../dashboard/dist", import.meta.url), new URL("../web", import.meta.url));
cp(new URL("../../../packages/model-runtime/templates", import.meta.url), new URL("../templates", import.meta.url));
console.log("assets copied: web/, templates/");

// esbuild's builtin list predates node:sqlite — it strips the prefix on the
// external import. Restore it so the runtime resolves the real builtin.
import path from "node:path";
const dist = new URL("../dist", import.meta.url).pathname;
for (const f of fs.readdirSync(dist)) {
  if (!f.endsWith(".js")) continue;
  const p = path.join(dist, f);
  const src = fs.readFileSync(p, "utf8");
  const out = src.replace(/from\s*"sqlite"/g, 'from "node:sqlite"');
  if (out !== src) { fs.writeFileSync(p, out); console.log("restored node:sqlite in", f); }
}
