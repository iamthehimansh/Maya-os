import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Normalize an agent's working directory before spawn.
 *
 * Node's `child_process.spawn` passes `cwd` straight to the OS with no shell, so
 * a leading `~` is NOT expanded and a missing directory makes spawn fail with a
 * misleading `spawn <cmd> ENOENT` (it reads as "the command wasn't found" but is
 * really "the cwd doesn't exist"). The dashboard forms default cwd to
 * `~/maya-demo`, so without this every dashboard-spawned agent would ENOENT.
 *
 * This expands a leading `~` to the user's home and creates the directory if
 * missing, so any user-typed cwd just works.
 */
export function resolveCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  let dir = cwd.trim();
  if (!dir) return undefined;
  if (dir === '~') dir = homedir();
  else if (dir.startsWith('~/')) dir = join(homedir(), dir.slice(2));
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // If we can't create it (permissions, a file in the way), let spawn surface
    // the real error rather than masking it here.
  }
  return dir;
}
