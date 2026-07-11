/**
 * macOS login-keychain reader.
 *
 * Claude Code stores its OAuth credentials as a generic-password item named
 * "Claude Code-credentials" (the `-w` flag prints just the secret payload,
 * which is a JSON blob). On non-darwin platforms this always returns null.
 */

import { execFile } from 'node:child_process';

/** Read a generic-password secret from the login keychain, or null if absent. */
export async function readKeychainSecret(service: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const s = stdout.toString().trim();
        resolve(s.length ? s : null);
      },
    );
  });
}
