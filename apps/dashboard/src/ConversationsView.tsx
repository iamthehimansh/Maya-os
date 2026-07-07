import { useEffect, useState } from "react";

/**
 * Conversations tab (lane 01): bus channel viewer — pick a room, read its
 * public history with loop-protocol frames rendered as chips. Read-only by
 * construction (the proxy blocks non-GET bus routes and injects the bearer
 * server-side). Private DMs never appear — the bus API excludes them even
 * for admins. Poll-based (2s); live WS lands with the read-receipts slice.
 */

interface Channel {
  id: string;
  policyVersion: string;
  participants: Array<{ handle: string; role: string }>;
}

interface Message {
  seq: number;
  from: string;
  fromRole?: string;
  to?: string | null;
  ts: string;
  body: { text?: string; maya?: { kind?: string; taskId?: string; prompt?: string } };
}

const KIND_BADGE: Record<string, string> = {
  task_assign: "📋 assign",
  task_accept: "🤝 accept",
  task_progress: "⏳ progress",
  task_done: "✅ done",
  task_failed: "❌ failed",
  question: "❓ question",
  answer: "💬 answer",
  artifact: "📎 artifact",
};

export function ConversationsView(): React.JSX.Element {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const chans = (await (await fetch("/api/channels")).json()) as Channel[];
        if (!alive) return;
        setChannels(chans);
        setError(null);
        const target = selected ?? chans[chans.length - 1]?.id ?? null;
        if (target !== null && selected === null) setSelected(target);
        if (target !== null) {
          const hist = (await (await fetch(`/api/channels/${encodeURIComponent(target)}/history?limit=200`)).json()) as {
            messages: Message[];
          };
          if (alive) setMessages(hist.messages);
        }
      } catch {
        if (alive) setError("Can't reach the bus — is `maya serve` running with the agent plane?");
      }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selected]);

  return (
    <section className="models" aria-label="Conversations">
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="panel">
        <h2>Channels</h2>
        {channels === null ? (
          <p className="empty">loading…</p>
        ) : channels.length === 0 ? (
          <p className="empty">No channels yet — teams and loop runs create their own rooms.</p>
        ) : (
          <div className="tabs" role="tablist" aria-label="channels">
            {channels.map((c) => (
              <button key={c.id} className="tab" role="tab" aria-selected={selected === c.id} onClick={() => setSelected(c.id)}>
                {c.id} <span className="soon">{c.participants.length} live</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected !== null && (
        <div className="panel">
          <h2>
            <code>{selected}</code>
          </h2>
          {messages.length === 0 ? (
            <p className="empty">No public messages in this room yet.</p>
          ) : (
            <div className="convo">
              {messages.map((m) => {
                const kind = m.body.maya?.kind;
                return (
                  <div className="convo-msg" key={m.seq}>
                    <span className="convo-meta">
                      <code>#{m.seq}</code> <strong>{m.from}</strong>
                      {m.fromRole && <span className="chip">{m.fromRole}</span>}
                      {m.to && <span className="chip">→ {m.to}</span>}
                      {kind && <span className="chip">{KIND_BADGE[kind] ?? kind}</span>}
                    </span>
                    <span className="convo-text">{m.body.text ?? m.body.maya?.prompt ?? "(structured frame)"}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
