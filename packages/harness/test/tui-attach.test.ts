import { describe, it, expect } from 'vitest';
import {
  parseDroppedPaths,
  readAttachment,
  chipLabel,
  buildRunInput,
  isLargePaste,
  makePasteAttachment,
  formatBytes,
  type FsLike,
  type Attachment,
} from '../src/tui/attach.js';

/** A fake fs backed by an in-memory map of path → contents (Buffer or string). */
function fakeFs(files: Record<string, Buffer | string>, dirs: string[] = []): FsLike {
  return {
    statSync(p) {
      if (dirs.includes(p)) return { isFile: () => false, size: 0 };
      const f = files[p];
      if (f === undefined) throw new Error('ENOENT');
      const buf = typeof f === 'string' ? Buffer.from(f) : f;
      return { isFile: () => true, size: buf.length };
    },
    readFileSync(p) {
      const f = files[p];
      if (f === undefined) throw new Error('ENOENT');
      return typeof f === 'string' ? Buffer.from(f) : f;
    },
  };
}

describe('parseDroppedPaths', () => {
  it('unwraps a single quoted path', () => {
    expect(parseDroppedPaths("'/tmp/my file.png'")).toEqual(['/tmp/my file.png']);
    expect(parseDroppedPaths('"/tmp/a.md"')).toEqual(['/tmp/a.md']);
  });
  it('unescapes backslash-escaped spaces', () => {
    expect(parseDroppedPaths('/tmp/my\\ file.png')).toEqual(['/tmp/my file.png']);
  });
  it('splits several space-separated dragged files', () => {
    expect(parseDroppedPaths('/a/one.png /b/two.md')).toEqual(['/a/one.png', '/b/two.md']);
  });
  it('returns no paths for a multi-line text paste', () => {
    expect(parseDroppedPaths('line one\nline two')).toEqual([]);
  });
});

describe('isLargePaste / makePasteAttachment', () => {
  it('flags a 4+ line paste as large', () => {
    expect(isLargePaste('a\nb\nc\nd')).toBe(true);
    expect(isLargePaste('a\nb')).toBe(false);
  });
  it('captures the line count and text', () => {
    const p = makePasteAttachment('a\nb\nc\nd\ne');
    expect(p).toEqual({ kind: 'paste', lines: 5, text: 'a\nb\nc\nd\ne' });
  });
});

describe('readAttachment', () => {
  it('reads a text file with a line count and content', () => {
    const fs = fakeFs({ '/repo/notes.md': 'a\nb\nc' });
    const att = readAttachment('/repo/notes.md', fs);
    expect(att).toMatchObject({ kind: 'file', name: 'notes.md', isImage: false, lines: 3, content: 'a\nb\nc' });
  });

  it('reads an image file as base64 with a media type', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fs = fakeFs({ '/repo/diagram.png': bytes });
    const att = readAttachment('/repo/diagram.png', fs) as Extract<Attachment, { kind: 'file' }>;
    expect(att.isImage).toBe(true);
    expect(att.mediaType).toBe('image/png');
    expect(att.data).toBe(bytes.toString('base64'));
  });

  it('does not inline a binary (NUL-containing) non-image file', () => {
    const fs = fakeFs({ '/repo/blob.bin': Buffer.from([0x01, 0x00, 0x02]) });
    const att = readAttachment('/repo/blob.bin', fs) as Extract<Attachment, { kind: 'file' }>;
    expect(att.content).toBeUndefined();
    expect(att.isImage).toBe(false);
  });

  it('returns null for a missing path or a directory', () => {
    const fs = fakeFs({ '/repo/x.md': 'hi' }, ['/repo/dir']);
    expect(readAttachment('/repo/nope.md', fs)).toBeNull();
    expect(readAttachment('/repo/dir', fs)).toBeNull();
  });
});

describe('chipLabel', () => {
  it('labels a text file with its line count', () => {
    const fs = fakeFs({ '/r/a.md': 'x\ny' });
    expect(chipLabel(readAttachment('/r/a.md', fs)!)).toBe('📄 a.md · 2 lines');
  });
  it('labels an image with a human byte size', () => {
    const fs = fakeFs({ '/r/pic.png': Buffer.alloc(2048) });
    expect(chipLabel(readAttachment('/r/pic.png', fs)!)).toBe('📎 pic.png · 2.0 KB');
  });
  it('labels a paste with its line count', () => {
    expect(chipLabel(makePasteAttachment('a\nb\nc\nd'))).toBe('⏎ pasted 4 lines');
  });
});

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('buildRunInput', () => {
  const fs = fakeFs({
    '/r/notes.md': 'hello\nworld',
    '/r/pic.png': Buffer.from([1, 2, 3, 4]),
  });

  it('returns a plain string when there are no images, inlining text files', () => {
    const att = readAttachment('/r/notes.md', fs)!;
    const out = buildRunInput('please review', [att]);
    expect(typeof out).toBe('string');
    expect(out as string).toContain('please review');
    expect(out as string).toContain('[Attached file: notes.md]');
    expect(out as string).toContain('hello\nworld');
  });

  it('inlines a large paste as a labeled block', () => {
    const out = buildRunInput('', [makePasteAttachment('l1\nl2\nl3\nl4')]) as string;
    expect(out).toContain('[Pasted 4 lines]');
    expect(out).toContain('l1\nl2\nl3\nl4');
  });

  it('returns content blocks with an image block when an image is attached', () => {
    const img = readAttachment('/r/pic.png', fs)!;
    const out = buildRunInput('what is this', [img]);
    expect(Array.isArray(out)).toBe(true);
    const blocks = out as Array<{ type: string }>;
    expect(blocks[0]).toMatchObject({ type: 'text' });
    const image = blocks.find((b) => b.type === 'image') as { type: string; mediaType: string; data: string };
    expect(image.mediaType).toBe('image/png');
    expect(image.data).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  it('mixes a text file (inlined) and an image (block) in one turn', () => {
    const md = readAttachment('/r/notes.md', fs)!;
    const img = readAttachment('/r/pic.png', fs)!;
    const out = buildRunInput('compare', [md, img]) as Array<{ type: string; text?: string }>;
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]!.text).toContain('[Attached file: notes.md]');
    expect(out.some((b) => b.type === 'image')).toBe(true);
  });
});
