import { useEffect, useMemo, useRef, useState } from "react";
import { getModels, getCldzProfiles, type CatalogEntry, type CldzProfile } from "./api";
import { renderMarkdown } from "./md";
import { AgentSetupForm, newAgentDraft, toSpawnInput, draftReady, type AgentDraft } from "./AgentSetupForm";
import { TeamBuilder } from "./TeamBuilder";
import { TerminalPanel } from "./TerminalPanel";
import {
  answerRun,
  createTeam,
  getChannelHistory,
  getTeamAgents,
  getTeams,
  sendTeamMessage,
  spawnTeamAgent,
  startLoop,
  streamRun,
  type AgentStatus,
  type ChannelMessage,
  type LoopEvent,
  type OpenTeam,
  type SpawnAgentInput,
  type Team,
} from "./orchestratorApi";

/**
 * Chat — Maya's front door AND the place you watch/talk to any team.
 *
 * Two modes, one view:
 *  • Front door (no team open): message the Loop Agent — it plans, spawns real
 *    Claude Code workers, verifies against the files, and streams the work back.
 *  • Team open (from the Teams page's 💬 Chat button, or the switcher up top):
 *    the center stream mirrors that team's bus channel live; the right rail shows
 *    its agents. A LIVE team you can talk to (your message posts to the channel,
 *    the agents wake on @mentions); a finished team opens read-only so you can
 *    review exactly what the agents did.
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

interface ChatViewProps {
  openTeam: OpenTeam | null;
  onOpenChat: (t: OpenTeam) => void;
  onNewChat: () => void;
}

export function ChatView({ openTeam, onOpenChat, onNewChat }: ChatViewProps): React.JSX.Element {
  const [models, setModels] = useState<CatalogEntry[]>([]);
  const [teamList, setTeamList] = useState<Team[]>([]);
  const [profiles, setProfiles] = useState<CldzProfile[]>([]);
  // Rich "add an agent to this team" draft (when a team is connected).
  const [addDraft, setAddDraft] = useState<AgentDraft>(() => newAgentDraft("@member"));
  const [creating, setCreating] = useState(false); // building a whole team
  const [adding, setAdding] = useState(false); // spawning one agent into a team
  const [lead, setLead] = useState("");
  const [worker, setWorker] = useState("");
  const [cwd] = useState("~/maya-demo"); // front-door quick-loop cwd (team-builder sets its own)
  const [showSetup, setShowSetup] = useState(false);
  const [termAgent, setTermAgent] = useState<string | null>(null); // agent whose live terminal is open
  const [draft, setDraft] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [busy, setBusy] = useState(false); // front-door: a loop is running
  const [sending, setSending] = useState(false); // team mode: posting a message
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("All");
  const [showRail, setShowRail] = useState(true);
  const nextId = useRef(1);
  const unsub = useRef<() => void>(() => {});
  const agentPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const chanPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  // Texts the user sent this session — so their own messages (which relay through
  // the manager, losing the human sender identity) render as "You", not "manager".
  const sentRef = useRef<Set<string>>(new Set());
  const stream = useRef<HTMLDivElement>(null);

  // Mount: model catalog (for the front-door setup) + the team list (for the switcher).
  useEffect(() => {
    void getModels().then((m) => {
      setModels(m);
      const local = m.filter((x) => x.kind === "local-gguf");
      const caller = local.find((x) => x.capabilities?.toolCalling) ?? local[0] ?? m[0];
      setLead((p) => p || caller?.id || "");
      setWorker((p) => p || caller?.id || "");
    });
    void getCldzProfiles().then(setProfiles).catch(() => {});
    const loadTeams = (): void => void getTeams().then(setTeamList).catch(() => {});
    loadTeams();
    const t = setInterval(loadTeams, 5000);
    return () => {
      clearInterval(t);
      unsub.current();
      if (agentPoll.current) clearInterval(agentPoll.current);
      if (chanPoll.current) clearInterval(chanPoll.current);
    };
  }, []);

  // Switching between front door and a team (or between teams): tear down the old
  // context and, in team mode, start mirroring that channel + watching its agents.
  useEffect(() => {
    unsub.current(); // stop any front-door loop stream
    setMsgs([]);
    setBusy(false);
    setError(null);
    if (chanPoll.current) {
      clearInterval(chanPoll.current);
      chanPoll.current = null;
    }
    if (!openTeam) {
      setAgents([]);
      if (agentPoll.current) clearInterval(agentPoll.current);
      return;
    }
    watchAgents(openTeam.id);
    let alive = true;
    const tick = (): void =>
      void getChannelHistory(openTeam.channelId, 200)
        .then(({ messages }) => {
          if (alive) setMsgs(messages.map((cm) => channelToMsg(cm, sentRef.current)));
        })
        .catch(() => {});
    tick();
    chanPoll.current = setInterval(tick, 2000);
    return () => {
      alive = false;
      if (chanPoll.current) {
        clearInterval(chanPoll.current);
        chanPoll.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTeam?.channelId]);

  useEffect(() => {
    stream.current?.scrollTo({ top: stream.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);


  // Distinct handles seen in the stream drive the filter chips (like @lead/@builder).
  const handles = useMemo(() => {
    const set = new Set<string>();
    for (const m of msgs) if (m.who === "agent") set.add(m.handle);
    return [...set];
  }, [msgs]);

  const shown = msgs.filter((m) => {
    if (m.who === "system") return false; // manager housekeeping — not part of the conversation
    if (filter === "All") return true;
    if (filter === "@Me") return m.who === "you";
    return m.handle === filter;
  });

  const online = 1 + agents.filter((a) => a.state === "live" || a.state === "working").length;
  const liveTeams = teamList.filter((t) => t.state !== "closed");
  const closedTeams = teamList.filter((t) => t.state === "closed");

  function push(m: Omit<Msg, "id">): void {
    setMsgs((prev) => [...prev, { ...m, id: nextId.current++ }]);
  }

  function watchAgents(teamId: string): void {
    const tick = (): void => void getTeamAgents(teamId).then(setAgents).catch(() => {});
    void tick();
    if (agentPoll.current) clearInterval(agentPoll.current);
    agentPoll.current = setInterval(tick, 3000);
  }

  function switchTeam(id: string): void {
    if (!id) {
      onNewChat();
      return;
    }
    const t = teamList.find((x) => x.id === id);
    if (t) onOpenChat({ id: t.id, channelId: t.channelId, name: t.name, live: t.state !== "closed" });
  }

  // Rich team creation: make the team, spawn the lead + each member (full Solo-
  // style config), then open the new team's chat.
  async function createFullTeam(name: string, lead: SpawnAgentInput, members: SpawnAgentInput[]): Promise<void> {
    setCreating(true);
    setError(null);
    try {
      const team = await createTeam({ name, workerModel: lead.model, cwd: lead.cwd });
      await spawnTeamAgent(team.id, lead);
      for (const m of members) await spawnTeamAgent(team.id, m);
      setShowSetup(false);
      onOpenChat({ id: team.id, channelId: team.channelId, name: team.name, live: true });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
    }
  }

  // Add one fully-configured agent into the currently-open team's channel.
  async function addAgent(): Promise<void> {
    if (!openTeam || !draftReady(addDraft) || adding) return;
    setAdding(true);
    setError(null);
    try {
      await spawnTeamAgent(openTeam.id, toSpawnInput(addDraft));
      setAddDraft(newAgentDraft("@member"));
      setShowSetup(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setAdding(false);
    }
  }

  function send(): void {
    const text = draft.trim();
    if (!text) return;

    // Team mode: post to the team's channel. Agents wake on an @mention or a
    // message directed at them — so if the user didn't @mention anyone, DIRECT
    // the message to the lead (or the first agent) so a plain "hello" gets a
    // reply instead of silence. Explicit @mentions still route themselves.
    if (openTeam) {
      if (!openTeam.live || sending) return;
      setDraft("");
      setError(null);
      setSending(true);
      const mentionsSomeone = /@[a-z0-9][a-z0-9-]/i.test(text);
      const wake = mentionsSomeone ? undefined : (agents.find((a) => a.role === "lead") ?? agents[0])?.handle;
      sentRef.current.add(text); // so the manager-relayed echo renders as "You"
      void sendTeamMessage(openTeam.id, text, wake, true)
        .catch((e) => setError(String(e instanceof Error ? e.message : e)))
        .finally(() => setSending(false));
      return; // the 2s channel poll reflects it + any replies
    }

    // Front-door mode: each message runs a fresh loop.
    if (busy || !cwd.trim()) return;
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

  const composerDisabled = openTeam ? !openTeam.live : false;
  const sendDisabled = !draft.trim() || (openTeam ? !openTeam.live || sending : busy || !cwd.trim());
  const placeholder = openTeam
    ? openTeam.live
      ? `Message ${openTeam.name}… (type @handle to wake an agent)`
      : "This team is finished — read-only"
    : "Message the channel…";

  return (
    <section className="cchat" aria-label="Team chat">
      <div className="cchat-main">
        <header className="cchat-head">
          <div className="cchat-title">
            <select
              className="cchat-switch"
              value={openTeam?.id ?? ""}
              onChange={(e) => switchTeam(e.target.value)}
              title="Switch between the front door and any team"
            >
              <option value="">＋ New chat (front door)</option>
              {liveTeams.length > 0 && (
                <optgroup label="Live teams">
                  {liveTeams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {closedTeams.length > 0 && (
                <optgroup label="Finished teams">
                  {closedTeams.slice(0, 40).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {openTeam ? (
              <>
                <strong>{openTeam.name}</strong>
                {openTeam.live ? <span className="cchat-live">● LIVE</span> : <span className="chip">read-only</span>}
              </>
            ) : (
              <>
                <strong>Maya</strong>
                <span className="cchat-live">● front door</span>
              </>
            )}
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
          {(!openTeam || openTeam.live) && (
            <button className="cchat-setup disclosure" onClick={() => setShowSetup((v) => !v)}>
              {showSetup ? "hide" : openTeam ? "＋ add agent" : "＋ create a team"}
            </button>
          )}
        </div>

        {showSetup && !openTeam && (
          <div className="cchat-setup-row">
            <TeamBuilder models={models} profiles={profiles} busy={creating} onSubmit={createFullTeam} defaultModel={worker || lead} />
          </div>
        )}
        {showSetup && openTeam && openTeam.live && (
          <div className="cchat-setup-row cchat-addagent">
            <AgentSetupForm title={`Add an agent to ${openTeam.name}`} value={addDraft} onChange={setAddDraft} models={models} profiles={profiles} />
            <button className="act primary" onClick={() => void addAgent()} disabled={!draftReady(addDraft) || adding}>
              {adding ? "Adding…" : "Add agent to this channel"}
            </button>
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
              {openTeam ? (
                <>
                  <p>👀 Watching <strong>{openTeam.name}</strong> — loading its conversation…</p>
                  <p className="muted">{openTeam.live ? "Send a message below to talk to the team." : "This team has finished — read-only."}</p>
                </>
              ) : (
                <>
                  <p>👋 Message the team. The Loop Agent plans, spawns real Claude Code workers, verifies against the real files, and reports back — asking you if it gets stuck.</p>
                  <p className="muted">Try: "Create a file named NOTES.md containing exactly: hello from Maya"</p>
                </>
              )}
            </div>
          ) : (
            shown.map((m) =>
              m.who === "you" ? (
                <div className="cmsg you" key={m.id}>
                  <div className="cmsg-body">
                    <span className="cmsg-head">
                      <span className="cavatar you">You</span>
                    </span>
                    <div className="cmsg-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
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
                    <div className="cmsg-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
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
          {(busy || sending) && (
            <div className="cmsg agent">
              <span className="cavatar h-2">✷</span>
              <div className="cmsg-body">
                <div className="cmsg-text typing">{sending ? "sending…" : "the team is working…"}</div>
              </div>
            </div>
          )}
        </div>

        <div className="cchat-composer">
          <textarea
            rows={1}
            value={draft}
            disabled={composerDisabled}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="cchat-composer-foot">
            <span className="muted">📎 Tip: type @ to tag an agent, or attach a file</span>
            <button className="csend" onClick={send} disabled={sendDisabled} aria-label="Send">
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
            <p className="empty">{openTeam ? "No agents on this team." : "No agents yet — send a message and the Lead spins up the team."}</p>
          ) : (
            agents.map((a) => (
              <div className="crail-agent" key={a.handle}>
                <div className="crail-agent-head">
                  <span className={`cavatar h-${hashColor(a.handle)}`}>{initials(a.handle)}</span>
                  <strong>{a.handle}</strong>
                  <span className="chip">{a.type}</span>
                  <span className={`chip state-${a.state}`}>{a.state}</span>
                  <button
                    className="crail-term"
                    onClick={() => setTermAgent(a.handle)}
                    title="Open this agent's live terminal"
                  >
                    🖥️
                  </button>
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
      {termAgent && openTeam && (
        <TerminalPanel teamId={openTeam.id} handle={termAgent} onClose={() => setTermAgent(null)} />
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

/** Manager housekeeping (join/leave/ready/stop) — Maya plumbing, not conversation. */
const SYSTEM_LINE = /^\s*[🧭➕➖🛑]/u;

/**
 * A bus channel message → a stream bubble.
 *  • Manager housekeeping ("➕ @x joined", "🧭 team ready") → 'system' (hidden).
 *  • A message whose text the user just sent → "You" (it relayed through the
 *    manager, which drops the human identity — matching on text recovers it).
 *  • No fromTokenId also means a human sender.
 */
function channelToMsg(cm: ChannelMessage, sent: Set<string>): Msg {
  const text = cm.body?.text ?? "(structured frame)";
  const system = SYSTEM_LINE.test(text);
  const human = !cm.fromTokenId || cm.body?.human === true || sent.has(text.trim());
  return {
    id: cm.seq,
    who: system ? "system" : human ? "you" : "agent",
    handle: system ? "system" : human ? "You" : cm.from,
    text,
  };
}

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
