/**
 * node-pty loader with a self-heal for the `spawn-helper` executable bit.
 *
 * WHY: node-pty shells out to a prebuilt `spawn-helper` binary to fork a pty
 * (posix_spawnp). npm can land that file WITHOUT the executable bit — a global
 * `npm i -g maya-os` produced `-rw-r--r--` where the workspace (pnpm) had
 * `-rwxr-xr-x`. The symptom is brutal and opaque: EVERY pty agent spawn
 * (claude-code, mayac, codex) fails with a bare `posix_spawnp failed.` and no
 * hint of why. The file is fine; only its mode is wrong.
 *
 * So: before we import node-pty, chmod the helper for THIS platform if it isn't
 * executable. Idempotent, best-effort — a failure here must never take the
 * runtime down, since node-pty may still work (built from source, or a platform
 * without the helper).
 */

import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Make node-pty's `spawn-helper` executable if npm stripped the mode bit. */
export function ensurePtyHelperExecutable(): void {
  try {
    const require_ = createRequire(import.meta.url);
    const root = dirname(require_.resolve('node-pty/package.json'));
    const candidates = [
      join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(root, 'build', 'Release', 'spawn-helper'), // built from source
    ];
    for (const helper of candidates) {
      if (!existsSync(helper)) continue;
      // 0o111 = any execute bit. Already set → nothing to do.
      if ((statSync(helper).mode & 0o111) !== 0) continue;
      chmodSync(helper, 0o755);
    }
  } catch {
    /* best-effort: never block a spawn on this */
  }
}

/** `await loadPty()` instead of `await import('node-pty')` — heals, then loads. */
export async function loadPty(): Promise<typeof import('node-pty')> {
  ensurePtyHelperExecutable();
  return await import('node-pty');
}
