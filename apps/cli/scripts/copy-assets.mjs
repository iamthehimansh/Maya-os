// Bundle-adjacent assets: dashboard SPA + model-runtime chat templates.
import fs from "node:fs";
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
