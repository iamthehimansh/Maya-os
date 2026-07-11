/**
 * Transcript entry model — the flat, render-ready list the App maintains as
 * LoopEvents stream in. Text and tool calls interleave within an assistant turn,
 * so entries are granular rather than one-per-message.
 */
import type { ToolEntry } from './ToolView.js';

export interface UserEntry {
  kind: 'user';
  text: string;
  /** Chip labels for attachments sent with this turn (drag/paste). */
  attachments?: string[];
}

export interface AssistantEntry {
  kind: 'assistant';
  text: string;
  /** True until `turn_end` — drives the streaming caret. */
  streaming: boolean;
}

export type NoticeTone = 'info' | 'ok' | 'warn' | 'error';

export interface NoticeEntry {
  kind: 'notice';
  tone: NoticeTone;
  text: string;
}

export type Entry = UserEntry | AssistantEntry | NoticeEntry | ToolEntry;

let idc = 0;
/** Monotonic key for React lists (avoids Date.now/random). */
export function nextKey(): string {
  return `e${++idc}`;
}
