/**
 * attach.ts — attachment model for the TUI input (drag & paste).
 *
 * Terminals paste a *file path* when you drag a file onto them, and a *large
 * multi-line blob* when you paste text. Both become an `Attachment` chip above
 * the prompt instead of dumping raw path/lines into the input, and both fold
 * into the outgoing message on submit: text files inline as fenced content,
 * images ride as vision `ImageBlock`s, big pastes inline as a labeled block.
 *
 * Pure + injectable fs so the whole thing is unit-testable offline.
 */
import type { RunInput, UserContentBlock } from '../types.js';

export interface FileAttachment {
  kind: 'file';
  /** Absolute or cwd-relative path as dropped. */
  path: string;
  name: string;
  bytes: number;
  isImage: boolean;
  /** MIME type for images (e.g. "image/png"). */
  mediaType?: string;
  /** Line count for inlined text files (chip label). */
  lines?: number;
  /** UTF-8 content for text files — inlined into the prompt. */
  content?: string;
  /** Base64 bytes for images — sent as an ImageBlock. */
  data?: string;
  /** True when a text file was too big and `content` is truncated. */
  truncated?: boolean;
}

export interface PasteAttachment {
  kind: 'paste';
  lines: number;
  text: string;
}

export type Attachment = FileAttachment | PasteAttachment;

/** Minimal fs surface (injectable for tests). */
export interface FsLike {
  statSync(path: string): { isFile(): boolean; size: number };
  readFileSync(path: string): Buffer;
}

/** A multi-line paste of at least this many lines collapses to a chip. */
export const LARGE_PASTE_LINES = 4;
/** Read at most this many bytes of a text file for inlining. */
export const TEXT_READ_CAP = 256 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

const CODE_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', json: 'json', md: 'md', py: 'py',
  rs: 'rs', go: 'go', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml',
  yaml: 'yaml', toml: 'toml', css: 'css', html: 'html', sql: 'sql', c: 'c',
  cpp: 'cpp', h: 'c', java: 'java', rb: 'ruby', php: 'php',
};

function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function baseName(p: string): string {
  const clean = p.replace(/[/\\]+$/, '');
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

/** Human byte size, e.g. "1.2 MB", "340 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Extract candidate file paths from a pasted/dropped chunk. Terminals wrap the
 * path in quotes and/or backslash-escape spaces; several dragged files come
 * space-separated. Returns cleaned candidates — existence is checked by the
 * caller, so non-path prose simply yields tokens that won't resolve.
 */
export function parseDroppedPaths(chunk: string): string[] {
  const raw = chunk.trim();
  if (!raw) return [];
  // A single quoted path.
  const quoted = raw.match(/^(['"])(.*)\1$/);
  if (quoted) return [quoted[2]!];
  // If the chunk has newlines it's a text paste, not a drag.
  if (/\n/.test(raw)) return [];
  // Split on spaces that are NOT backslash-escaped, then unescape.
  const tokens = raw.split(/(?<!\\) /).map((t) => t.replace(/\\(.)/g, '$1').trim());
  return tokens.filter((t) => t.length > 0);
}

/** True if `chunk` looks like a text paste worth collapsing to a chip. */
export function isLargePaste(chunk: string): boolean {
  return chunk.split('\n').length >= LARGE_PASTE_LINES;
}

export function makePasteAttachment(chunk: string): PasteAttachment {
  return { kind: 'paste', lines: chunk.split('\n').length, text: chunk };
}

/**
 * Stat + read a dropped path into a `FileAttachment`, or `null` if it isn't a
 * regular file. Images are captured as base64; text files as UTF-8 (capped);
 * binary non-images are attached by name only.
 */
export function readAttachment(path: string, fs: FsLike): FileAttachment | null {
  let stat: { isFile(): boolean; size: number };
  try {
    stat = fs.statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const name = baseName(path);
  const e = ext(name);
  const bytes = stat.size;
  const mediaType = IMAGE_MIME[e];
  if (mediaType) {
    try {
      const buf = fs.readFileSync(path);
      return { kind: 'file', path, name, bytes, isImage: true, mediaType, data: buf.toString('base64') };
    } catch {
      // couldn't read the bytes — degrade to a name-only chip
      return { kind: 'file', path, name, bytes, isImage: true, mediaType };
    }
  }
  // text (or binary) file
  try {
    const buf = fs.readFileSync(path);
    const slice = buf.length > TEXT_READ_CAP ? buf.subarray(0, TEXT_READ_CAP) : buf;
    if (slice.includes(0)) {
      // binary — don't inline garbage
      return { kind: 'file', path, name, bytes, isImage: false };
    }
    const content = slice.toString('utf8');
    const truncated = buf.length > TEXT_READ_CAP;
    return {
      kind: 'file',
      path,
      name,
      bytes,
      isImage: false,
      lines: content.split('\n').length,
      content,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch {
    return { kind: 'file', path, name, bytes, isImage: false };
  }
}

/** The chip label shown above the prompt and echoed in the transcript. */
export function chipLabel(att: Attachment): string {
  if (att.kind === 'paste') return `⏎ pasted ${att.lines} lines`;
  if (att.isImage) return `📎 ${att.name} · ${formatBytes(att.bytes)}`;
  if (att.content !== undefined) {
    const n = att.lines ?? att.content.split('\n').length;
    return `📄 ${att.name} · ${n} line${n === 1 ? '' : 's'}${att.truncated ? ' (truncated)' : ''}`;
  }
  return `📎 ${att.name} · ${formatBytes(att.bytes)}`;
}

/**
 * Compose the outgoing message from the typed text + attachments. Returns a
 * plain string when there are no images (so the string path stays hot), else a
 * `UserContentBlock[]` with the composed text followed by one image block each.
 */
export function buildRunInput(text: string, atts: readonly Attachment[]): RunInput {
  const parts: string[] = [];
  const t = text.trim();
  if (t) parts.push(t);
  for (const a of atts) {
    if (a.kind === 'paste') {
      parts.push(`[Pasted ${a.lines} lines]\n${a.text}`);
    } else if (a.isImage) {
      parts.push(`[Attached image: ${a.name}]`);
    } else if (a.content !== undefined) {
      const lang = CODE_LANG[ext(a.name)] ?? '';
      const note = a.truncated ? ` (first ${TEXT_READ_CAP / 1024} KB shown)` : '';
      parts.push(`[Attached file: ${a.name}${note}]\n\`\`\`${lang}\n${a.content}\n\`\`\``);
    } else {
      parts.push(`[Attached file: ${a.name} · ${formatBytes(a.bytes)} — binary, not inlined]`);
    }
  }
  const composed = parts.join('\n\n');

  const images = atts.filter((a): a is FileAttachment => a.kind === 'file' && a.isImage && !!a.data);
  if (images.length === 0) return composed;

  const blocks: UserContentBlock[] = [];
  if (composed) blocks.push({ type: 'text', text: composed });
  for (const img of images) blocks.push({ type: 'image', mediaType: img.mediaType ?? 'image/png', data: img.data! });
  return blocks;
}
