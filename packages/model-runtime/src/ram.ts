import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface RamSnapshot {
  totalBytes: number;
  /** Reclaimable-for-us memory: free + inactive + purgeable + file-backed. */
  availableBytes: number;
  at: number;
}

/**
 * macOS "free RAM" is misleading (compressed memory, file cache). What matters
 * for "can a model load without swapping the host to death" is memory the
 * kernel can hand us quickly: free + inactive + purgeable + file-backed pages.
 * Parsed from `vm_stat` (no native deps). Falls back to os.freemem() elsewhere.
 */
export async function sampleRam(): Promise<RamSnapshot> {
  const totalBytes = os.totalmem();
  if (process.platform !== "darwin") {
    return { totalBytes, availableBytes: os.freemem(), at: Date.now() };
  }
  try {
    const { stdout } = await execFileP("vm_stat", [], { timeout: 3_000 });
    const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 16384);
    const page = (name: string): number =>
      Number(new RegExp(`${name}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
    const pages =
      page("Pages free") +
      page("Pages inactive") +
      page("Pages purgeable") +
      page("File-backed pages");
    return { totalBytes, availableBytes: pages * pageSize, at: Date.now() };
  } catch {
    return { totalBytes, availableBytes: os.freemem(), at: Date.now() };
  }
}

/** Test hook: MAYA_FAKE_AVAILABLE_RAM (bytes) lets the chaos suite simulate pressure. */
export async function availableRam(): Promise<RamSnapshot> {
  const fake = process.env.MAYA_FAKE_AVAILABLE_RAM;
  if (fake) {
    return { totalBytes: os.totalmem(), availableBytes: Number(fake), at: Date.now() };
  }
  return sampleRam();
}

/** Live RSS of a process in bytes (0 if unreadable/dead). */
export async function processRss(pid: number): Promise<number> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 3_000 });
    return Number(stdout.trim() || 0) * 1024;
  } catch {
    return 0;
  }
}
