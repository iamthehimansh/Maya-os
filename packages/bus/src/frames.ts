/**
 * Runtime validation of client → server frames. The TypeScript contract
 * (`@maya-ai/core` contracts/bus.ts) types the wire; these schemas enforce it
 * against untrusted input, with size caps so one client can't blow up the
 * channel (text ≤ 64 KiB, workstatus task line ≤ 120 chars).
 */

import { z } from 'zod';

const bodySchema = z
  .object({
    text: z.string().max(64 * 1024).optional(),
    maya: z.unknown().optional(),
    attachments: z
      .array(z.object({ id: z.string().max(128), filename: z.string().max(256) }))
      .max(16)
      .optional(),
  })
  .strict();

export const sendFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('message'),
    cid: z.string().min(1).max(64).optional(),
    to: z.string().max(128).optional(),
    private: z.boolean().optional(),
    body: bodySchema,
  })
  .strict();

export const workStatusFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('workstatus'),
    action: z.enum(['set', 'update', 'clear']),
    taskId: z.string().min(1).max(64),
    state: z.enum(['working', 'paused', 'done', 'failed', 'stale']).optional(),
    task: z.string().max(120).optional(),
    forWhom: z.string().max(128).optional(),
    since: z.number().int().nonnegative().optional(),
  })
  .strict();

export const cancelFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('cancel'),
    seq: z.number().int().positive(),
  })
  .strict();

export const policyAckFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('policy_ack'),
    policyVersion: z.string().max(32),
  })
  .strict();

export const pingFrameSchema = z.object({ v: z.literal(1), type: z.literal('ping') }).strict();

export const clientFrameSchema = z.discriminatedUnion('type', [
  sendFrameSchema,
  workStatusFrameSchema,
  cancelFrameSchema,
  policyAckFrameSchema,
  pingFrameSchema,
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

/** Parse one raw WS payload. Returns null (with a reason) instead of throwing. */
export function parseClientFrame(raw: unknown): { frame: ClientFrame } | { error: string } {
  if (typeof raw !== 'string' && !(raw instanceof Buffer)) return { error: 'binary frames unsupported' };
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > 256 * 1024) return { error: 'frame too large' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'invalid JSON' };
  }
  const parsed = clientFrameSchema.safeParse(json);
  if (!parsed.success) return { error: 'unsupported frame type or shape' };
  return { frame: parsed.data };
}
