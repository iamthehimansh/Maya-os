import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Read-only filesystem browsing for the dashboard's file explorer + directory
 * picker. Localhost-only (the gateway binds 127.0.0.1), read-only (list + a
 * bounded text preview — never write/delete), and every path is resolved +
 * normalized so a caller can't do anything the listing API doesn't intend.
 */

export interface FsEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

/** List a directory (defaults to home). Hidden entries included; errors surfaced per-entry-safe. */
export function listDir(reqPath?: string): FsListing {
  const dir = path.resolve(reqPath && reqPath.trim() ? reqPath : os.homedir());
  const stat = fs.statSync(dir); // throws → 400 upstream
  if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
  const entries: FsEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      const isDir = st.isDirectory() || (st.isSymbolicLink() && safeIsDir(full));
      entries.push({
        name,
        path: full,
        type: isDir ? "dir" : "file",
        ...(isDir ? {} : { size: st.size }),
      });
    } catch {
      // unreadable entry (permission) — skip it rather than fail the whole listing
    }
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}

/** Bounded text preview of a file (first N bytes; refuses binary-looking content). */
export function readTextPreview(reqPath: string, maxBytes = 64 * 1024): { path: string; text: string; truncated: boolean } {
  const file = path.resolve(reqPath);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`not a file: ${file}`);
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    if (buf.subarray(0, Math.min(len, 8000)).includes(0)) throw new Error("binary file — no text preview");
    return { path: file, text: buf.toString("utf8"), truncated: st.size > maxBytes };
  } finally {
    fs.closeSync(fd);
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
