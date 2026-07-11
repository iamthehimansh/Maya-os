import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getModels, getCldzProfiles, type CatalogEntry, type CldzProfile } from "./api";
import { renderMarkdown } from "./md";
import { AgentSetupForm, newAgentDraft, toSpawnInput, draftReady, type AgentDraft } from "./AgentSetupForm";
import { TeamBuilder } from "./TeamBuilder";
import { TerminalPanel } from "./TerminalPanel";
import {
  answerRun,
  attachmentUrl,
  createTeam,
  deleteTeam,
  drainTeam,
  getChannelHistory,
  getTeamAgents,
  getTeams,
  sendTeamMessage,
  spawnTeamAgent,
  startLoop,
  stopTeamAgent,
  streamRun,
  uploadAttachment,
  type AgentStatus,
  type AttachmentRef,
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
  attachments?: AttachmentRef[];
}

/** One composer attachment chip: uploads immediately on pick; `ref` lands when
 * the server confirms the stored file. */
interface PendingAtt {
  key: number;
  filename: string;
  uploading: boolean;
  ref?: AttachmentRef;
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
  const [killConfirm, setKillConfirm] = useState<string | null>(null); // rail: agent awaiting inline kill-confirm
  const [killing, setKilling] = useState<string | null>(null); // rail: kill request in flight
  const [pendingAtts, setPendingAtts] = useState<PendingAtt[]>([]); // composer attachment chips
  const attKey = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const unsub = useRef<() => void>(() => {});
  const agentPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const chanPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSeq = useRef(0); // channel poll cursor — only fetch messages newer than this
  const pinnedToBottom = useRef(true); // is the reader at (or near) the end of the stream?
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
    refreshTeams();
    const t = setInterval(refreshTeams, 5000);
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
    setFilter("All"); // a handle from the old team would silently blank the new stream
    setKillConfirm(null);
    setKilling(null);
    setPendingAtts([]); // uploads belong to the OLD team's store — don't carry them over
    lastSeq.current = 0;
    pinnedToBottom.current = true;
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
    // Cursor poll: fetch only messages newer than the last seen seq and APPEND —
    // a fixed window would freeze the chat once the channel outgrows it.
    const tick = (): void =>
      void getChannelHistory(openTeam.channelId, 1000, lastSeq.current)
        .then(({ messages }) => {
          if (!alive || messages.length === 0) return; // nothing new — don't touch state
          lastSeq.current = messages[messages.length - 1]!.seq;
          setMsgs((prev) => [...prev, ...messages.map(channelToMsg)]);
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

  // Follow new messages ONLY when the reader is pinned to the bottom — never
  // yank someone who scrolled up to read history. Two things make this robust
  // where the old version failed: (1) useLayoutEffect fires BEFORE paint, so the
  // jump is atomic and can't race the user's own scroll between paint and effect;
  // (2) INSTANT (scrollTop=), not smooth — a smooth animation during active
  // multi-agent chat emits its own scroll events and physically fights an
  // upward scroll, dragging the reader back down. Only fires when the message
  // COUNT grew (real new content), never on an unrelated re-render.
  const prevMsgCount = useRef(0);
  useLayoutEffect(() => {
    const el = stream.current;
    const grew = msgs.length > prevMsgCount.current;
    prevMsgCount.current = msgs.length;
    if (el && grew && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
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
  const isLive = (t: Team): boolean => t.live ?? t.state !== "closed";
  const liveTeams = teamList.filter(isLive);
  const closedTeams = teamList.filter((t) => !isLive(t));
  // Liveness of the OPEN team comes from the polled list, not the click-time
  // snapshot — a team that drains (or rehydrates) while open updates the badge,
  // the composer, and the send guard within one poll.
  const polledOpen = openTeam ? teamList.find((t) => t.id === openTeam.id) : undefined;
  const openLive = openTeam ? (polledOpen ? isLive(polledOpen) : openTeam.live) : false;

  function push(m: Omit<Msg, "id">): void {
    setMsgs((prev) => [...prev, { ...m, id: nextId.current++ }]);
  }

  function refreshTeams(): void {
    void getTeams().then(setTeamList).catch(() => {});
  }

  // Archive (delete) a finished team, then drop back to the front door.
  async function archiveTeam(id: string): Promise<void> {
    setError(null);
    try {
      await deleteTeam(id);
      refreshTeams();
      if (openTeam?.id === id) onNewChat();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  // Kill one agent's process (after the rail's inline confirm) and refresh the roster.
  async function killAgent(handle: string): Promise<void> {
    if (!openTeam || killing) return;
    setKilling(handle);
    setError(null);
    try {
      await stopTeamAgent(openTeam.id, handle);
      setKillConfirm(null);
      void getTeamAgents(openTeam.id).then(setAgents).catch(() => {});
    } catch (e) {
      setError(`Couldn't stop ${handle}: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setKilling(null);
    }
  }

  // Composer file pick: upload each file immediately; chips track progress.
  function pickFiles(files: FileList | null): void {
    if (!openTeam || !files || files.length === 0) return;
    const room = 16 - pendingAtts.length;
    if (room <= 0) {
      setError("A message carries at most 16 attachments.");
      return;
    }
    for (const f of [...files].slice(0, room)) {
      if (f.size > 25 * 1024 * 1024) {
        setError(`${f.name} is over the 25MB attachment limit.`);
        continue;
      }
      const key = attKey.current++;
      setPendingAtts((prev) => [...prev, { key, filename: f.name, uploading: true }]);
      void uploadAttachment(openTeam.id, f)
        .then((ref) => setPendingAtts((prev) => prev.map((p) => (p.key === key ? { ...p, uploading: false, ref } : p))))
        .catch((e) => {
          setPendingAtts((prev) => prev.filter((p) => p.key !== key));
          setError(`Upload failed for ${f.name}: ${String(e instanceof Error ? e.message : e)}`);
        });
    }
    if (fileInput.current) fileInput.current.value = ""; // re-picking the same file must re-fire onChange
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
    if (t) onOpenChat({ id: t.id, channelId: t.channelId, name: t.name, live: isLive(t) });
  }

  // Rich team creation: make the team, spawn the lead + each member (full Solo-
  // style config), then open the new team's chat.
  async function createFullTeam(name: string, lead: SpawnAgentInput, members: SpawnAgentInput[]): Promise<void> {
    setCreating(true);
    setError(null);
    try {
      const team = await createTeam({ name, workerModel: lead.model, cwd: lead.cwd });
      try {
        await spawnTeamAgent(team.id, lead);
        for (const m of members) await spawnTeamAgent(team.id, m);
      } catch (e) {
        // Don't leave a zombie team behind when a spawn fails mid-way.
        await drainTeam(team.id).catch(() => {});
        throw e;
      }
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
    const readyAtts = pendingAtts.filter((p) => p.ref !== undefined).map((p) => p.ref!);
    // A bare-attachment send (no text) still needs a text line — the bus body
    // requires one, and agents read the filenames from it.
    const text = draft.trim() || (openTeam && readyAtts.length > 0 ? `📎 ${readyAtts.map((a) => a.filename).join(", ")}` : "");
    if (!text) return;

    // Team mode: post to the team's channel. Agents wake on an @mention or a
    // message directed at them — so if the user didn't @mention anyone, DIRECT
    // the message to the lead (or the first agent) so a plain "hello" gets a
    // reply instead of silence. Explicit @mentions still route themselves.
    if (openTeam) {
      if (!openLive) {
        setError("This team is closed — its history is read-only. Open a live team (or create a new one) to send messages.");
        return;
      }
      if (sending || pendingAtts.some((p) => p.uploading)) return;
      setDraft("");
      setPendingAtts([]);
      setError(null);
      setSending(true);
      // Only a mention of a REAL team agent counts — "foo@gmail.com" or a typo'd
      // handle must still fall back to waking the lead, or nobody replies.
      const mentionsSomeone = agents.some((a) => mentionsAgent(text, a.handle));
      const wake = mentionsSomeone ? undefined : (agents.find((a) => a.role === "lead") ?? agents[0])?.handle;
      void sendTeamMessage(openTeam.id, text, wake, true, readyAtts)
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
    void startLoop({ goal: text, cwd: cwd.trim(), leadModel: lead, workerModel: worker, allowedTools: ["Read", "Write", "Edit"] })
      .then(({ runId }) => {
        unsub.current = streamRun(
          runId,
          (e) => {
            if (e.kind === "started" && e.channelId) {
              const teamId = e.channelId.replace(/^maya\/team\//, "");
              watchAgents(teamId);
            }
            push({ who: "agent", handle: LEAD, text: renderEvent(e), kind: e.kind, runId, event: e });
            if (e.kind === "report") {
              // Terminal: streamRun closed the SSE; stop polling the drained team.
              setBusy(false);
              if (agentPoll.current) {
                clearInterval(agentPoll.current);
                agentPoll.current = null;
              }
            }
          },
          () => {
            setBusy(false);
            setError("Lost the connection to the run — it may still be finishing; check the Runs panel.");
          },
        );
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

  const composerDisabled = openTeam ? !openLive : false;
  const uploadsBusy = pendingAtts.some((p) => p.uploading);
  const hasReadyAtts = pendingAtts.some((p) => p.ref !== undefined);
  const sendDisabled = openTeam
    ? !openLive || sending || uploadsBusy || (!draft.trim() && !hasReadyAtts)
    : busy || !cwd.trim() || !draft.trim();
  const placeholder = openTeam
    ? openLive
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
                    <option key={t.id} value={t.id} style={{ color: "var(--text-muted)" }}>
                      {t.name} (finished)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {openTeam ? (
              <>
                <strong>{openTeam.name}</strong>
                {openLive ? (
                  <span className="cchat-live">● LIVE</span>
                ) : (
                  <>
                    <span className="chip">read-only</span>
                    <button
                      className="act"
                      onClick={() => void archiveTeam(openTeam.id)}
                      title="Archive this finished team (deletes its record + tasks)"
                    >
                      🗑 Archive
                    </button>
                  </>
                )}
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
          {(!openTeam || openLive) && (
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
        {showSetup && openTeam && openLive && (
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

        <div
          className="cchat-stream"
          ref={stream}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {shown.length === 0 ? (
            <div className="cchat-empty">
              {openTeam ? (
                <>
                  <p>👀 Watching <strong>{openTeam.name}</strong> — loading its conversation…</p>
                  <p className="muted">{openLive ? "Send a message below to talk to the team." : "This team has finished — read-only."}</p>
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
                    {openTeam && (m.attachments?.length ?? 0) > 0 && (
                      <div className="cmsg-atts">
                        {m.attachments!.map((a) => (
                          <a key={a.id} className="cmsg-att" href={attachmentUrl(openTeam.id, a.id)} target="_blank" rel="noreferrer">
                            📎 {a.filename}
                          </a>
                        ))}
                      </div>
                    )}
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
                    {openTeam && (m.attachments?.length ?? 0) > 0 && (
                      <div className="cmsg-atts">
                        {m.attachments!.map((a) => (
                          <a key={a.id} className="cmsg-att" href={attachmentUrl(openTeam.id, a.id)} target="_blank" rel="noreferrer">
                            📎 {a.filename}
                          </a>
                        ))}
                      </div>
                    )}
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
          {pendingAtts.length > 0 && (
            <div className="catt-chips">
              {pendingAtts.map((p) => (
                <span key={p.key} className={`catt-chip ${p.uploading ? "uploading" : ""}`}>
                  📎 {p.filename}
                  {p.uploading ? (
                    <em className="catt-state">uploading…</em>
                  ) : (
                    <button
                      className="catt-remove"
                      aria-label={`Remove ${p.filename}`}
                      title="Remove this attachment"
                      onClick={() => setPendingAtts((prev) => prev.filter((x) => x.key !== p.key))}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
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
            <span className="cchat-foot-left">
              {openTeam && openLive && (
                <>
                  <input ref={fileInput} type="file" multiple style={{ display: "none" }} onChange={(e) => pickFiles(e.target.files)} />
                  <button
                    className="catt-pick"
                    title="Attach a file (uploads immediately, sends with your message)"
                    aria-label="Attach a file"
                    onClick={() => fileInput.current?.click()}
                  >
                    📎
                  </button>
                </>
              )}
              <span className="muted">💡 Tip: type @handle to wake a specific agent</span>
            </span>
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
          </div>

          {agents.length === 0 ? (
            <p className="empty">
              {openTeam
                ? "No agents on this team."
                : "No standing agents — front-door loop workers are transient; their progress streams into the chat."}
            </p>
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
                  <button
                    className="crail-kill"
                    onClick={() => setKillConfirm((cur) => (cur === a.handle ? null : a.handle))}
                    title="Stop this agent — kills its process"
                    aria-label={`Stop ${a.handle}`}
                  >
                    ✕
                  </button>
                </div>
                {killConfirm === a.handle && (
                  <div className="crail-confirm" role="alertdialog" aria-label={`Confirm stopping ${a.handle}`}>
                    <span>Kill {a.handle}'s process?</span>
                    <button className="act crail-confirm-yes" disabled={killing === a.handle} onClick={() => void killAgent(a.handle)}>
                      {killing === a.handle ? "Stopping…" : "Stop it"}
                    </button>
                    <button className="act" disabled={killing === a.handle} onClick={() => setKillConfirm(null)}>
                      Cancel
                    </button>
                  </div>
                )}
                <code className="crail-model">{a.model}</code>
              </div>
            ))
          )}
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

/** Did the text @mention this agent? Word-boundary on both sides so "@qa"
 * doesn't match inside "@qa-lead" or "foo@qatar" — mirrors the bus-bridge's
 * wake regex, so what the UI treats as a mention is what actually wakes. */
function mentionsAgent(text: string, handle: string): boolean {
  const tag = handle.replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)@${tag}(?![a-z0-9-])`, "i").test(text);
}

/**
 * A bus channel message → a stream bubble. Classified by SENDER, not content:
 *  • from the manager and not human-marked → 'system' (housekeeping, hidden).
 *  • `body.human` (the composer's mark, relayed end-to-end) or no fromTokenId
 *    (a raw human post) → "You".
 *  • anything else → an agent bubble under its own handle.
 */
function channelToMsg(cm: ChannelMessage): Msg {
  const text = cm.body?.text ?? "(structured frame)";
  const human = cm.body?.human === true || (!cm.fromTokenId && cm.from !== "manager");
  const system = !human && cm.from === "manager";
  return {
    id: cm.seq,
    who: system ? "system" : human ? "you" : "agent",
    handle: system ? "system" : human ? "You" : cm.from,
    text,
    ...(cm.body?.attachments && cm.body.attachments.length > 0 ? { attachments: cm.body.attachments } : {}),
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
