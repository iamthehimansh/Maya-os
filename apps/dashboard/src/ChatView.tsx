import { useEffect, useMemo, useRef, useState } from "react";
import { getModels, type CatalogEntry } from "./api";
import { answerRun, getTeamAgents, startLoop, streamRun, type AgentStatus, type LoopEvent } from "./orchestratorApi";

/**
 * Chat — Maya's front door, in the team-channel layout: a center message stream,
 * a right rail of the agents (Lead + workers) with their models/state + who's
 * online, and a composer. You message the team; the Loop Agent plans, spawns
 * real Claude Code workers, and streams the work back as a group conversation,
 * asking you tap-able questions when it's stuck.
 *
 * This is the visible container for the persistent multi-agent team: today the
 * stream is loop-driven (each message runs the loop); the right rail already
 * shows the live team, and the persistent bus agents + @wake land underneath it.
 */

interface Msg {
  id: number;
  who: "you" | "agent" | "system";
  handle: string;
  text: string;
  kind?: LoopEvent["kind"];
  runId?: string;
  event?: LoopEvent;
}

const LEAD = "@lead";

export function ChatView(): React.JSX.Element {
  const [models, setModels] = useState<CatalogEntry[]>([]);
  const [lead, setLead] = useState("");
  const [worker, setWorker] = useState("");
  const [cwd, setCwd] = useState("~/maya-demo");
  const [showSetup, setShowSetup] = useState(false);
  const [draft, setDraft] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("All");
  const [showRail, setShowRail] = useState(true);
  const nextId = useRef(1);
  const unsub = useRef<() => void>(() => {});
  const agentPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const stream = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getModels().then((m) => {
      setModels(m);
      const local = m.filter((x) => x.kind === "local-gguf");
      const caller = local.find((x) => x.capabilities?.toolCalling) ?? local[0] ?? m[0];
      setLead((p) => p || caller?.id || "");
      setWorker((p) => p || caller?.id || "");
    });
    return () => {
      unsub.current();
      if (agentPoll.current) clearInterval(agentPoll.current);
    };
  }, []);

  useEffect(() => {
    stream.current?.scrollTo({ top: stream.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const workerOptions = useMemo(() => models.filter((m) => m.capabilities?.toolCalling !== false), [models]);

  // Distinct handles seen in the stream drive the filter chips (like @001/@002).
  const handles = useMemo(() => {
    const set = new Set<string>();
    for (const m of msgs) if (m.who === "agent") set.add(m.handle);
    return [...set];
  }, [msgs]);

  const shown = msgs.filter((m) => {
    if (filter === "All") return true;
    if (filter === "@Me") return m.who === "you";
    return m.handle === filter;
  });

  const online = 1 + agents.filter((a) => a.state === "live" || a.state === "working").length;

  function push(m: Omit<Msg, "id">): void {
    setMsgs((prev) => [...prev, { ...m, id: nextId.current++ }]);
  }

  function watchAgents(teamId: string): void {
    const tick = (): void => void getTeamAgents(teamId).then(setAgents).catch(() => {});
    void tick();
    if (agentPoll.current) clearInterval(agentPoll.current);
    agentPoll.current = setInterval(tick, 3000);
  }

  function send(): void {
    const text = draft.trim();
    if (!text || busy || !cwd.trim()) return;
    setDraft("");
    setError(null);
    setBusy(true);
    push({ who: "you", handle: "You", text });
    unsub.current();
    void startLoop({ goal: text, cwd: cwd.trim(), leadModel: lead, workerModel: worker, allowedTools: ["Write", "Edit"] })
      .then(({ runId }) => {
        unsub.current = streamRun(runId, (e) => {
          if (e.kind === "started" && e.channelId) {
            const teamId = e.channelId.replace(/^maya\/team\//, "");
            watchAgents(teamId);
          }
          push({ who: "agent", handle: LEAD, text: renderEvent(e), kind: e.kind, runId, event: e });
          if (e.kind === "report") setBusy(false);
        });
      })
      .catch((e) => {
        setError(String(e instanceof Error ? e.message : e));
        setBusy(false);
      });
  }

  function answer(runId: string | undefined, qid: string | undefined, optionId: string, label: string): void {
    if (!runId) return;
    push({ who: "you", handle: "You", text: label });
    void answerRun(runId, { ...(qid ? { qid } : {}), optionId }).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }

  return (
    <section className="cchat" aria-label="Team chat">
      <div className="cchat-main">
        <header className="cchat-head">
          <div className="cchat-title">
            <span className="cchat-back">‹ Channels /</span> <strong>Maya</strong>
            <span className="cchat-live">● LIVE</span>
            <span className="muted">
              · {agents.length || "no"} agent{agents.length === 1 ? "" : "s"} · {online} online
            </span>
          </div>
          <button className="cchat-railtoggle" onClick={() => setShowRail((v) => !v)} title="Toggle panel" aria-label="Toggle side panel">
            ▧
          </button>
        </header>

        <div className="cchat-filters" role="tablist">
          {["All", "@Me", ...handles].map((f) => (
            <button key={f} className={`cchip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)} role="tab" aria-selected={filter === f}>
              {f}
            </button>
          ))}
          <button className="cchat-setup disclosure" onClick={() => setShowSetup((v) => !v)}>
            {showSetup ? "hide setup" : "setup"}
          </button>
        </div>

        {showSetup && (
          <div className="cchat-setup-row">
            <label className="field grow">
              <span>Directory</span>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/any/dir" />
            </label>
            <label className="field">
              <span>Lead</span>
              <select value={lead} onChange={(e) => setLead(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Worker</span>
              <select value={worker} onChange={(e) => setWorker(e.target.value)}>
                {workerOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.capabilities?.toolCalling ? " ✓tools" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        <div className="cchat-stream" ref={stream}>
          {shown.length === 0 ? (
            <div className="cchat-empty">
              <p>👋 Message the team. The Loop Agent plans, spawns real Claude Code workers, verifies against the real files, and reports back — asking you if it gets stuck.</p>
              <p className="muted">Try: "Create a file named NOTES.md containing exactly: hello from Maya"</p>
            </div>
          ) : (
            shown.map((m) =>
              m.who === "you" ? (
                <div className="cmsg you" key={m.id}>
                  <div className="cmsg-body">
                    <span className="cmsg-head">
                      <span className="cavatar you">You</span>
                    </span>
                    <div className="cmsg-text">{m.text}</div>
                  </div>
                </div>
              ) : (
                <div className={`cmsg agent ${m.kind ?? ""}`} key={m.id}>
                  <span className={`cavatar h-${hashColor(m.handle)}`}>{initials(m.handle)}</span>
                  <div className="cmsg-body">
                    <span className="cmsg-head">
                      <span className={`chandle h-${hashColor(m.handle)}`}>{m.handle}</span>
                      {m.kind && <span className="ckind">{ICON[m.kind]}</span>}
                    </span>
                    <div className="cmsg-text">{m.text}</div>
                    {m.kind === "question" && (m.event?.options?.length ?? 0) > 0 && (
                      <div className="q-options">
                        {m.event!.options!.map((o) => (
                          <button key={o.id} className="act" onClick={() => answer(m.runId, m.event?.qid, o.id, o.label)}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )
          )}
          {busy && (
            <div className="cmsg agent">
              <span className="cavatar h-2">✷</span>
              <div className="cmsg-body">
                <div className="cmsg-text typing">the team is working…</div>
              </div>
            </div>
          )}
        </div>

        <div className="cchat-composer">
          <textarea
            rows={1}
            value={draft}
            placeholder="Message the channel…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="cchat-composer-foot">
            <span className="muted">📎 Tip: type @ to tag, or attach a file</span>
            <button className="csend" onClick={send} disabled={busy || !draft.trim() || !cwd.trim()} aria-label="Send">
              ↑
            </button>
          </div>
        </div>
      </div>

      {showRail && (
        <aside className="cchat-rail">
          <div className="crail-tabs">
            <span className="crail-tab active">Agents ({agents.length})</span>
            <span className="crail-tab muted">Queue</span>
          </div>

          <div className="crail-card crail-dm">
            <span>🔒 Private agent DMs</span>
            <span className="muted">Let your agents DM each other on this channel.</span>
          </div>

          {agents.length === 0 ? (
            <p className="empty">No agents yet — send a message and the Lead spins up the team.</p>
          ) : (
            agents.map((a) => (
              <div className="crail-agent" key={a.handle}>
                <div className="crail-agent-head">
                  <span className={`cavatar h-${hashColor(a.handle)}`}>{initials(a.handle)}</span>
                  <strong>{a.handle}</strong>
                  <span className="chip">{a.type}</span>
                  <span className={`chip state-${a.state}`}>{a.state}</span>
                </div>
                <code className="crail-model">{a.model}</code>
              </div>
            ))
          )}

          <div className="crail-section">
            <h4>People online (1)</h4>
            <div className="crail-person">👤 you (owner)</div>
          </div>

          <div className="crail-section">
            <h4>Members (1)</h4>
            <div className="crail-person">
              you <span className="chip owner">OWNER</span>
            </div>
          </div>
        </aside>
      )}
    </section>
  );
}

const ICON: Record<LoopEvent["kind"], string> = {
  started: "🏁",
  planned: "🧠",
  question: "❓",
  verified: "✅",
  rework: "🔧",
  goal_check: "🎯",
  report: "🏁",
};

function renderEvent(e: LoopEvent): string {
  switch (e.kind) {
    case "started":
      return "On it — starting the loop.";
    case "planned":
      return `Planned ${e.tasks ?? ""} task${e.tasks === 1 ? "" : "s"}. Delegating to worker agents.`;
    case "question":
      return e.prompt ?? "I need a decision from you.";
    case "verified":
      return e.ok ? "Verified a task against the real files." : `A task didn't pass: ${e.feedback ?? "reworking"}.`;
    case "rework":
      return `Re-instructing the worker: ${e.feedback ?? e.taskId ?? "finish the task"}.`;
    case "goal_check":
      return e.met ? "Goal met — checked against the actual workspace." : `Not there yet — still missing: ${(e.missing ?? []).join(", ")}.`;
    case "report":
      return e.outcome === "success"
        ? `Done ✅ — ${e.summary ?? "goal met"}${e.tokensUsed ? ` (${e.tokensUsed.toLocaleString()} tokens)` : ""}.`
        : `${e.outcome === "partial" ? "Partial" : "Failed"} — ${e.summary ?? ""}. I won't claim success I can't verify.`;
  }
}

function initials(handle: string): string {
  const s = handle.replace(/^@/, "").replace(/^claude-code$/, "cc").replace(/^opencode$/, "oc");
  return s.slice(0, 2).toUpperCase();
}
// Stable 0-5 bucket per handle → a color class, so each agent keeps its color.
function hashColor(handle: string): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) & 0xffff;
  return h % 6;
}
