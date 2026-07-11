import { describe, it, expect } from 'vitest';
import { isSlash, parseSlash, SLASH_COMMANDS } from '../src/tui/slash.js';
import { TuiPermissionGate } from '../src/tui/permission.js';
import type { PendingPermission } from '../src/tui/permission.js';
import type { PermissionRequest } from '../src/types.js';

describe('slash parsing', () => {
  it('detects slash lines (and ignores plain text / bare slash)', () => {
    expect(isSlash('/model')).toBe(true);
    expect(isSlash('  /help')).toBe(true);
    expect(isSlash('/?')).toBe(true);
    expect(isSlash('hello /model')).toBe(false);
    expect(isSlash('/')).toBe(false);
    expect(isSlash('/ ')).toBe(false);
  });

  it('parses a bare command', () => {
    expect(parseSlash('/clear')).toEqual({ name: 'clear', arg: '' });
  });

  it('parses a command with an argument', () => {
    expect(parseSlash('/model claude-opus-4-8')).toEqual({
      name: 'model',
      arg: 'claude-opus-4-8',
    });
    // Extra whitespace is trimmed.
    expect(parseSlash('/provider   openai  ')).toEqual({ name: 'provider', arg: 'openai' });
  });

  it('resolves aliases and is case-insensitive', () => {
    expect(parseSlash('/EXIT')).toEqual({ name: 'quit', arg: '' });
    expect(parseSlash('/q')).toEqual({ name: 'quit', arg: '' });
    expect(parseSlash('/?')).toEqual({ name: 'help', arg: '' });
  });

  it('flags unknown commands', () => {
    expect(parseSlash('/frobnicate now')).toEqual({ unknown: 'frobnicate' });
  });

  it('returns null for non-slash input', () => {
    expect(parseSlash('just a message')).toBeNull();
  });

  it('every command has a description', () => {
    for (const c of SLASH_COMMANDS) expect(c.description.length).toBeGreaterThan(0);
  });
});

describe('TuiPermissionGate', () => {
  const req = (summary: string): PermissionRequest => ({ tool: 'bash', summary });

  it('queues a request and resolves it with the user decision', async () => {
    const gate = new TuiPermissionGate();
    let seen: PendingPermission | null = null;
    gate.subscribe((p) => (seen = p));

    const decision = gate.request(req('rm -rf build'));
    expect(seen).not.toBeNull();
    expect(seen!.req.summary).toBe('rm -rf build');

    seen!.resolve(true);
    expect(await decision).toBe(true);
    // Queue drained → subscriber notified with null.
    expect(seen).toBeNull();
  });

  it('serves requests FIFO', async () => {
    const gate = new TuiPermissionGate();
    let current: PendingPermission | null = null;
    gate.subscribe((p) => (current = p));

    const d1 = gate.request(req('first'));
    const d2 = gate.request(req('second'));
    // Head of queue is the first request.
    expect(current!.req.summary).toBe('first');

    current!.resolve(false);
    expect(await d1).toBe(false);
    // Now the second surfaces.
    expect(current!.req.summary).toBe('second');
    current!.resolve(true);
    expect(await d2).toBe(true);
  });

  it('auto-allows when constructed with autoAllow', async () => {
    const gate = new TuiPermissionGate({ autoAllow: true });
    let notified = false;
    gate.subscribe((p) => (notified = notified || p !== null));
    expect(await gate.request(req('write x'))).toBe(true);
    // No prompt should ever surface.
    expect(notified).toBe(false);
    expect(gate.autoAllow).toBe(true);
  });

  it('setAutoAllow(true) flushes the pending queue as allowed', async () => {
    const gate = new TuiPermissionGate();
    const d = gate.request(req('bash ls'));
    gate.setAutoAllow(true);
    expect(await d).toBe(true);
    expect(gate.current()).toBeNull();
  });
});
