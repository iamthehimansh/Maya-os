/**
 * Agent ⇄ bus bridge (Phase 4 → 6/7 plumbing).
 *
 * Coding agents (Claude Code, Codex, …) don't speak the Maya bus natively —
 * the RUNTIME joins on each agent's behalf and bridges:
 *
 *   agent events  → channel:  state → workstatus · question → loop Question
 *                             artifact → loop ArtifactMsg (logs stay local)
 *   channel       → agent:    loop Answer{qid} or a message addressed to the
 *                             agent's handle → adapter.send()
 *
 * Each attached agent gets its OWN least-capability token (receive+send,
 * scoped to exactly its channel), minted via the bus REST admin API and
 * revoked on detach. Tokens never touch argv or logs.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import type { AgentAdapter, AgentHandle, LoopBody } from '@maya-ai/core';
import { BusClient } from '@maya-ai/bus-client';

export interface BusBridgeOptions {
  /** e.g. "ws://127.0.0.1:4300" */
  wsBase: string;
  /** Admin bearer used ONLY to mint/revoke per-agent tokens. */
  adminToken: string;
  /** REST base; derived from wsBase (ws→http) when omitted. */
  httpBase?: string;
}

export interface AttachOptions {
  channelId: string;
  /** Bus handle label; defaults to the agent id. */
  label?: string;
  /** Sender handles whose messages NEVER wake this agent (e.g. the team
   * manager's system announcements — "➕ @x joined" mentions @x but must not
   * make @x act on its own join notice). */
  ignoreFrom?: string[];
  /**
   * Walkie-talkie file I/O (himansh's proactive-agent vision — docs/agent-io.md).
   * When set, the bridge APPENDS every incoming channel message to `inboxPath`
   * (JSON lines, for the agent to read its history) and WATCHES `outboxPath`,
   * posting each COMPLETE new line the agent writes to the channel on its behalf.
   * The agent runs like the walkie-talkie client: read inbox, write outbox,
   * message on its own initiative (e.g. 5 lines with sleeps between).
   */
  inboxPath?: string;
  outboxPath?: string;
}

interface Attachment {
  client: BusClient;
  tokenId: string;
  channelId: string;
  stop: () => void;
}

export class AgentBusBridge {
  private readonly attachments = new Map<string, Attachment>();

  constructor(private readonly opts: BusBridgeOptions) {}

  private httpBase(): string {
    return (this.opts.httpBase ?? this.opts.wsBase.replace(/^ws/, 'http')).replace(/\/$/, '');
  }

  /** Agents currently bridged. */
  attached(): string[] {
    return [...this.attachments.keys()];
  }

  async attach(adapter: AgentAdapter, handle: AgentHandle, opts: AttachOptions): Promise<{ busHandle: string }> {
    if (this.attachments.has(handle.id)) throw new Error(`agent ${handle.id} already attached`);

    // Mint a least-capability token scoped to exactly this channel.
    const res = await fetch(`${this.httpBase()}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.adminToken}` },
      body: JSON.stringify({
        label: opts.label ?? handle.id,
        role: 'member',
        caps: ['receive', 'send'],
        scopes: [opts.channelId],
      }),
    });
    if (!res.ok) throw new Error(`token mint failed: HTTP ${res.status}`);
    const minted = (await res.json()) as { id: string; token: string };

    const client = new BusClient({
      wsBase: this.opts.wsBase,
      channelId: opts.channelId,
      token: minted.token,
    });

    const joined = new Promise<string>((resolve) => client.on('joined', (j) => resolve(j.handle)));
    client.connect();
    const busHandle = await joined;

    // Wake-on-@tag: the agent acts on a message when it's addressed to its bus
    // handle (m.to) OR its @handle is @mentioned in the text — himansh's "a
    // monitor wakes whoever's tagged." The `(?![a-z0-9-])` guard stops @qa from
    // matching @qa-2. Other channel traffic is context the agent doesn't act on.
    const tag = `@${(opts.label ?? handle.id).replace(/^@/, '')}`;
    const mentionRe = new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9-])', 'i');
    const ignoreFrom = new Set(opts.ignoreFrom ?? []);
    client.on('message', (m) => {
      if (m.from === busHandle) return; // our own bridge traffic
      if (ignoreFrom.has(m.from)) return; // system/manager announcements never wake us
      const maya = m.body.maya as LoopBody | undefined;
      const text = typeof m.body.text === 'string' ? m.body.text : '';
      // Walkie-talkie inbox: record every incoming message so the agent can read
      // its channel history from the file. (It's still woken via stdin below.)
      if (opts.inboxPath && text) {
        try {
          appendFileSync(opts.inboxPath, JSON.stringify({ seq: m.seq, from: m.from, ts: m.ts, text, ...(m.to ? { to: m.to } : {}) }) + '\n');
        } catch {
          /* inbox is best-effort */
        }
      }
      const directed = m.to === busHandle || mentionRe.test(text);
      if (maya && maya.kind === 'answer' && directed) {
        const answerText = maya.text ?? (maya.optionId !== undefined ? `answer: ${maya.optionId}` : '');
        void adapter.send(handle.id, answerText).catch(() => {});
        return;
      }
      if (directed && text.length > 0) {
        void adapter.send(handle.id, text).catch(() => {});
      }
    });

    // agent → channel: pump structured events until terminal.
    let stopped = false;
    const pump = (async () => {
      for await (const ev of adapter.events(handle.id)) {
        if (stopped) break;
        switch (ev.kind) {
          case 'state':
            if (ev.state === 'running') {
              client.workStatus({ action: 'set', taskId: handle.id, state: 'working', task: `agent ${handle.id}` });
            } else if (ev.state === 'paused' || ev.state === 'waiting_input') {
              client.workStatus({ action: 'update', taskId: handle.id, state: 'paused' });
            } else if (ev.state === 'exited') {
              client.workStatus({ action: 'clear', taskId: handle.id, state: 'done' });
            } else if (ev.state === 'failed' || ev.state === 'killed') {
              client.workStatus({ action: 'clear', taskId: handle.id, state: 'failed' });
            }
            break;
          case 'question': {
            const q: LoopBody = { kind: 'question', qid: `${handle.id}-${Date.now().toString(36)}`, prompt: ev.text };
            client.sendMessage({ body: { text: `❓ ${ev.text}`, maya: q } });
            break;
          }
          case 'artifact': {
            const a: LoopBody = {
              kind: 'artifact',
              ref: { id: `${handle.id}-art`, kind: 'file', path: ev.path, title: ev.note ?? ev.path },
            };
            client.sendMessage({ body: { text: `📎 ${ev.path}`, maya: a } });
            break;
          }
          case 'error':
            client.sendMessage({ body: { text: `⚠️ agent ${handle.id}: ${ev.message.slice(0, 200)}` } });
            break;
          case 'say':
            // The agent completed a turn — post its reply to the channel (@mention
            // → send → turn → result → say → channel). We ALSO post outbox lines,
            // so an agent that both writes its outbox AND says the same text can
            // double-post — but suppressing `say` for outbox agents silenced any
            // agent that replies normally instead of writing its outbox, which made
            // debugging blind. Visibility wins; the double-post is cosmetic. (A
            // clean fix later: suppress `say` only if the agent wrote its outbox
            // THAT turn — needs per-turn tracking.)
            if (ev.text.trim()) client.sendMessage({ body: { text: ev.text } });
            break;
          default:
            break; // logs/tokens stay local — the channel is for signal, not noise
        }
      }
    })();

    // Walkie-talkie outbox: watch the file the agent writes to, and post each
    // COMPLETE new line to the channel on its behalf. Offset-tracked (chars) and
    // only lines up to the last '\n' are posted — a partial line still being
    // written waits. Plain text → broadcast; a JSON line {text,to} → directed.
    let outboxTimer: ReturnType<typeof setInterval> | undefined;
    if (opts.outboxPath) {
      const outbox = opts.outboxPath;
      let offset = 0;
      outboxTimer = setInterval(() => {
        let content: string;
        try {
          content = readFileSync(outbox, 'utf8');
        } catch {
          return; // not there yet / transient read error
        }
        if (content.length <= offset) return;
        const chunk = content.slice(offset);
        const lastNl = chunk.lastIndexOf('\n');
        if (lastNl === -1) return; // no complete line yet — a write may be in progress
        for (const raw of chunk.slice(0, lastNl).split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          let out: { text: string; to?: string } = { text: line };
          if (line.startsWith('{')) {
            try {
              const parsed = JSON.parse(line) as { text?: string; to?: string };
              if (typeof parsed.text === 'string') out = { text: parsed.text, ...(parsed.to ? { to: parsed.to } : {}) };
            } catch {
              /* not JSON — treat the whole line as text */
            }
          }
          if (out.text) client.sendMessage({ ...(out.to ? { to: out.to } : {}), body: { text: out.text } });
        }
        offset += lastNl + 1; // advance past the newline of the last posted line
      }, 1000);
      outboxTimer.unref?.();
    }

    const attachment: Attachment = {
      client,
      tokenId: minted.id,
      channelId: opts.channelId,
      stop: () => {
        stopped = true;
        if (outboxTimer) clearInterval(outboxTimer);
      },
    };
    this.attachments.set(handle.id, attachment);
    void pump.finally(() => {
      // Event stream closed (agent terminal) — leave the socket briefly for
      // final frames to flush, then tidy up if still attached.
      setTimeout(() => void this.detach(handle.id).catch(() => {}), 1500).unref?.();
    });

    return { busHandle };
  }

  /** Disconnect and revoke the agent's token. Idempotent. */
  async detach(agentId: string): Promise<void> {
    const att = this.attachments.get(agentId);
    if (!att) return;
    this.attachments.delete(agentId);
    att.stop();
    att.client.close();
    await fetch(`${this.httpBase()}/api/tokens/${att.tokenId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.opts.adminToken}` },
    }).catch(() => {});
  }

  async detachAll(): Promise<void> {
    await Promise.all(this.attached().map((id) => this.detach(id)));
  }
}
