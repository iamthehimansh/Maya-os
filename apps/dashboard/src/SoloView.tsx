import { useEffect, useRef, useState } from "react";
import { getModels, getCldzProfiles, getCloudModels, type CatalogEntry, type CldzProfile, type CloudModel } from "./api";
import {
  attachmentUrl,
  createTeam,
  deleteTeam,
  drainTeam,
  spawnTeamAgent,
  getTeamAgents,
  sendTeamMessage,
  getChannelHistory,
  stopTeamAgent,
  type AgentStatus,
  type ChannelMessage,
  type SpawnAgentInput,
} from "./orchestratorApi";
import { renderMarkdown } from "./md";
import "./SoloView.css";

/**
 * Solo agent — himansh's "create a single worker-only agent on the bus with me
 * and talk to it." Spawn one addressable agent, then a 1:1 chat: what you type
 * is directed at it (which wakes it), and its replies stream back from the bus
 * channel. A solo session is just a one-member team under the hood, so it
 * composes with the same endpoints team-chat uses.
 */

const AGENT_TYPES = ["claude-code", "codex", "opencode"] as const;
type AgentType = (typeof AGENT_TYPES)[number];
interface Session {
  teamId: string;
  channelId: string;
  agent: AgentStatus;
}

/** Manager/system chatter (join/leave/ready/restore/task frames) — classified
 * by SENDER, not emoji: anything the manager posts that isn't human-marked is
 * housekeeping. The owner's own messages arrive from the manager token too,
 * but carry body.human — those are chat ("you"), not system. */
const isSystemLine = (m: ChannelMessage): boolean => m.from === "manager" && m.body.human !== true;

/** Tear a solo session's backing team down: drain it (kills the agent, closes
 * the team) and then archive the now-closed row so solo-* teams never pile up
 * in the Teams page. Best-effort — an older orchestrator without DELETE
 * /api/teams/:id just leaves the closed row behind. */
async function teardownSoloTeam(teamId: string): Promise<void> {
  await drainTeam(teamId).catch(() => {});
  await deleteTeam(teamId).catch(() => {});
}

export function SoloView(): React.JSX.Element {
  const [models, setModels] = useState<CatalogEntry[]>([]);
  const [profiles, setProfiles] = useState<CldzProfile[]>([]);
  const [handle, setHandle] = useState("@assistant");
  const [type, setType] = useState<AgentType>("claude-code");
  const [model, setModel] = useState("");
  const [runAs, setRunAs] = useState(""); // "" = local gateway model; else a cldz profile name
  const [cloudModel, setCloudModel] = useState("opus"); // when running on a cloud profile
  const [cwd, setCwd] = useState("~/maya-demo");
  const [allTools, setAllTools] = useState(false);

  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killConfirm, setKillConfirm] = useState(false); // inline confirm for the header's ✕
  const [killing, setKilling] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getModels().then((m) => {
      setModels(m);
      const w = m.find((x) => x.toolCalling) ?? m.find((x) => x.kind === "local-gguf");
      setModel((prev) => prev || w?.id || "");
    }).catch(() => {});
    void getCldzProfiles().then(setProfiles).catch(() => {});
  }, []);

  const cloud = runAs !== "";

  // When running on a cldz profile, list the REAL models from the provider
  // (server-side, via the credential) — opus/sonnet stay as the fallback.
  const [cloudModels, setCloudModels] = useState<CloudModel[]>([]);
  const cloudModelRef = useRef(cloudModel);
  cloudModelRef.current = cloudModel;
  useEffect(() => {
    if (!runAs) {
      setCloudModels([]);
      return;
    }
    let alive = true;
    void getCloudModels(runAs).then((ms) => {
      if (!alive) return;
      setCloudModels(ms);
      if (ms.length > 0 && !ms.some((m) => m.id === cloudModelRef.current)) {
        setCloudModel((ms.find((m) => /opus/i.test(m.id)) ?? ms[0]!).id);
      }
    });
    return () => {
      alive = false;
    };
  }, [runAs]);

  // Poll the agent's channel AND its live state while a session is open — the
  // header chip must reflect reality (a crashed/limited agent), not the
  // spawn-time snapshot, or the composer becomes a silent void.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const tick = (): void => {
      void getChannelHistory(session.channelId, 500)
        .then((h) => alive && setMessages(h.messages ?? []))
        .catch(() => {});
      void getTeamAgents(session.teamId)
        .then((agents) => {
          if (!alive) return;
          const a = agents.find((x) => x.handle === session.agent.handle);
          if (a && a.state !== session.agent.state) setSession((cur) => (cur ? { ...cur, agent: a } : cur));
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session]);

  // If the page navigates away mid-session, the session state is gone for good
  // (no reconnect UI yet) — tear the backing team down instead of leaking it.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    return () => {
      if (sessionRef.current) void teardownSoloTeam(sessionRef.current.teamId);
    };
  }, []);

  // Autoscroll to newest.
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages]);

  async function spawn(): Promise<void> {
    // Engine = a cloud model alias when running on a cldz profile, else the local
    // gateway model. Cloud (real Opus/Sonnet) is the capable path for hard work.
    const engineModel = cloud ? cloudModel : model;
    if (!handle.trim() || !engineModel || !cwd.trim() || busy) return;
    setBusy(true);
    setError(null);
    let teamId: string | null = null;
    try {
      const h = handle.trim().startsWith("@") ? handle.trim() : `@${handle.trim()}`;
      const team = await createTeam({ name: `solo-${h.replace(/^@/, "")}`, workerModel: engineModel, cwd: cwd.trim() });
      teamId = team.id;
      // Solo agents are standing/interactive — a real PTY (the actual Claude
      // TUI in the 🖥️ terminal), never headless --print. Explicit here so the
      // default holds even against an older orchestrator.
      const input: SpawnAgentInput = {
        handle: h,
        type,
        model: engineModel,
        cwd: cwd.trim(),
        pty: true,
        ...(cloud ? { cldzProfile: runAs } : {}),
        // Essential tools by default (small request, ~fast). "All tools" is the
        // opt-in freedom toggle — heavier request, wants a bigger context.
        allowedTools: allTools ? ["*"] : ["Read", "Write", "Edit", "Bash"],
        systemPrompt:
          "You are a helpful worker agent on a shared channel. When asked to do something, DO it with your tools, then reply with a short, clear report. Render answers in Markdown.",
      };
      const agent = await spawnTeamAgent(team.id, input);
      setSession({ teamId: team.id, channelId: team.channelId, agent });
      setMessages([]);
    } catch (e) {
      // Don't abandon a just-created team with no agent on it — tear it down.
      if (teamId) void teardownSoloTeam(teamId);
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    if (!session || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    try {
      // Direct it at the agent's handle so the monitor wakes it; human-mark it
      // so it renders as "you", not manager housekeeping.
      await sendTeamMessage(session.teamId, text, session.agent.handle, true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function stop(): Promise<void> {
    if (!session) return;
    const s = session;
    setSession(null);
    setMessages([]);
    // Drain kills the agent and closes the team; the archive keeps solo-*
    // rows out of the Teams pile.
    await teardownSoloTeam(s.teamId);
  }

  // Kill just the agent's PROCESS (the session + its history stay open — the
  // state chip flips to stopped via the roster poll). Distinct from stop(),
  // which tears the whole session down.
  async function killAgent(): Promise<void> {
    if (!session || killing) return;
    setKilling(true);
    setError(null);
    try {
      await stopTeamAgent(session.teamId, session.agent.handle);
      setKillConfirm(false);
    } catch (e) {
      setError(`Couldn't stop ${session.agent.handle}: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setKilling(false);
    }
  }

  if (!session) {
    return (
      <section className="run" aria-label="Solo agent">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="panel run-form">
          <h2>Talk to a single agent</h2>
          <p className="empty">Spawn one agent on the bus and chat with it 1:1 — pick its type, model, and working directory.</p>
          <div className="field-row">
            <label className="field">
              <span>Handle</span>
              <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@assistant" />
            </label>
            <label className="field">
              <span>Type</span>
              <select value={type} onChange={(e) => setType(e.target.value as AgentType)}>
                {AGENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {profiles.length > 0 && (
              <label className="field grow">
                <span>Run as</span>
                <select value={runAs} onChange={(e) => setRunAs(e.target.value)}>
                  <option value="">Local model (gateway)</option>
                  {profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} · {p.type === "oauth" ? "subscription" : p.type}
                      {p.default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field grow">
              <span>Model</span>
              {cloud ? (
                <select value={cloudModel} onChange={(e) => setCloudModel(e.target.value)}>
                  {cloudModels.length > 0 ? (
                    cloudModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="opus">opus — capable, for hard work</option>
                      <option value="sonnet">sonnet — faster/cheaper</option>
                    </>
                  )}
                </select>
              ) : (
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {m.toolCalling ? " ✓tools" : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
          {cloud && (
            <p className="muted small">
              Runs on your real Claude auth via the <strong>{runAs}</strong> cldz profile — capable enough for real work (Opus wrote a file
              end-to-end in ~7s in testing).
            </p>
          )}
          <div className="field-row">
            <label className="field grow">
              <span>Working directory</span>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/any/dir" />
            </label>
            <label className="field checkbox">
              <input type="checkbox" checked={allTools} onChange={(e) => setAllTools(e.target.checked)} />
              <span>All tools (full freedom — slower, wants a bigger context)</span>
            </label>
          </div>
          {!cloud && models.length === 0 && (
            <p className="muted small">
              No local models installed — pull one on the <strong>Models</strong> page, or pick a cldz profile under “Run as” to spawn on a
              cloud model instead.
            </p>
          )}
          <button
            className="act primary"
            onClick={() => void spawn()}
            disabled={busy || !handle.trim() || !(cloud ? cloudModel : model)}
          >
            {busy ? "Spawning…" : "Spawn & chat"}
          </button>
        </div>
      </section>
    );
  }

  const chat = messages.filter((m) => !isSystemLine(m));
  const agentDown = session.agent.state === "failed" || session.agent.state === "stopped";
  return (
    <section className="solo-chat" aria-label={`Chat with ${session.agent.handle}`}>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <header className="solo-head panel">
        <div>
          <strong>{session.agent.handle}</strong> <span className="chip">{session.agent.type}</span>{" "}
          <span className="chip">{session.agent.model}</span> <span className={`chip state-${session.agent.state}`}>{session.agent.state}</span>
          <div className="muted small">{session.agent.cwd}</div>
        </div>
        <div className="solo-head-actions">
          {killConfirm ? (
            <span className="solo-kill-confirm" role="alertdialog" aria-label={`Confirm killing ${session.agent.handle}`}>
              <span className="muted">Kill the process?</span>
              <button className="act" disabled={killing} onClick={() => void killAgent()}>
                {killing ? "Stopping…" : "Stop it"}
              </button>
              <button className="act" disabled={killing} onClick={() => setKillConfirm(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              className="act solo-kill"
              onClick={() => setKillConfirm(true)}
              title="Stop this agent — kills its process"
              aria-label={`Stop ${session.agent.handle}`}
            >
              ✕
            </button>
          )}
          <button className="act" onClick={() => void stop()}>
            Stop agent
          </button>
        </div>
      </header>

      {agentDown && (
        <div className="error-banner" role="alert">
          {session.agent.handle} has {session.agent.state === "failed" ? "exited unexpectedly" : "stopped"} — messages won't reach it. Stop the
          session and spawn again.
        </div>
      )}

      <div className="solo-stream" ref={streamRef}>
        {chat.length === 0 ? (
          <p className="empty">Say hello, or give {session.agent.handle} a task — e.g. “create NOTE.md with today’s plan”.</p>
        ) : (
          chat.map((m) => {
            const mine = m.from !== session.agent.handle;
            return (
              <div key={m.seq} className={`bubble ${mine ? "mine" : "agent"}`}>
                <div className="bubble-who">{mine ? "you" : session.agent.handle}</div>
                <div className="bubble-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.body.text ?? "") }} />
                {(m.body.attachments?.length ?? 0) > 0 && (
                  <div className="cmsg-atts">
                    {m.body.attachments!.map((a) => (
                      <a key={a.id} className="cmsg-att" href={attachmentUrl(session.teamId, a.id)} target="_blank" rel="noreferrer">
                        📎 {a.filename}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="solo-composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            agentDown
              ? `${session.agent.handle} is ${session.agent.state} — respawn to keep chatting`
              : `Message ${session.agent.handle}…  (Enter to send, Shift+Enter for newline)`
          }
          disabled={agentDown}
          rows={2}
        />
        <button className="act primary" onClick={() => void send()} disabled={!draft.trim() || agentDown}>
          Send
        </button>
      </div>
    </section>
  );
}
