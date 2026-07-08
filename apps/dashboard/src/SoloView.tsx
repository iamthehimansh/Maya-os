import { useEffect, useRef, useState } from "react";
import { getModels, getCldzProfiles, type CatalogEntry, type CldzProfile } from "./api";
import {
  createTeam,
  spawnTeamAgent,
  stopTeamAgent,
  sendTeamMessage,
  getChannelHistory,
  type AgentStatus,
  type ChannelMessage,
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

/** Manager/system chatter (join/leave/ready) — shown as quiet context, not chat. */
const isSystemLine = (m: ChannelMessage): boolean => /^\s*[🧭➕➖🛑]/u.test(m.body.text ?? "");

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
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getModels().then((m) => {
      setModels(m);
      const w = m.find((x) => x.capabilities?.toolCalling) ?? m.find((x) => x.kind === "local-gguf");
      setModel((prev) => prev || w?.id || "");
    });
    void getCldzProfiles()
      .then((p) => setProfiles(p.available ? p.profiles : []))
      .catch(() => {});
  }, []);

  const cloud = runAs !== "";

  // Poll the agent's channel while a session is live.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const tick = (): void => {
      void getChannelHistory(session.channelId)
        .then((h) => alive && setMessages(h.messages ?? []))
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session]);

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
    try {
      const h = handle.trim().startsWith("@") ? handle.trim() : `@${handle.trim()}`;
      const team = await createTeam({ name: `solo-${h.replace(/^@/, "")}`, workerModel: engineModel, cwd: cwd.trim() });
      const agent = await spawnTeamAgent(team.id, {
        handle: h,
        type,
        model: engineModel,
        cwd: cwd.trim(),
        ...(cloud ? { profile: runAs } : {}),
        // Essential tools by default (small request, ~fast). "All tools" is the
        // opt-in freedom toggle — heavier request, wants a bigger context.
        allowedTools: allTools ? ["*"] : ["Read", "Write", "Edit", "Bash"],
        systemPrompt:
          "You are a helpful worker agent on a shared channel. When asked to do something, DO it with your tools, then reply with a short, clear report. Render answers in Markdown.",
      });
      setSession({ teamId: team.id, channelId: team.channelId, agent });
      setMessages([]);
    } catch (e) {
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
      // Direct it at the agent's handle so the monitor wakes it.
      await sendTeamMessage(session.teamId, text, session.agent.handle);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function stop(): Promise<void> {
    if (!session) return;
    const s = session;
    setSession(null);
    setMessages([]);
    await stopTeamAgent(s.teamId, s.agent.handle).catch(() => {});
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
                      {p.name} · {p.auth}
                      {p.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field grow">
              <span>Model</span>
              {cloud ? (
                <select value={cloudModel} onChange={(e) => setCloudModel(e.target.value)}>
                  <option value="opus">opus — capable, for hard work</option>
                  <option value="sonnet">sonnet — faster/cheaper</option>
                </select>
              ) : (
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {m.capabilities?.toolCalling ? " ✓tools" : ""}
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
          <button className="act primary" onClick={() => void spawn()} disabled={busy || !handle.trim() || !model}>
            {busy ? "Spawning…" : "Spawn & chat"}
          </button>
        </div>
      </section>
    );
  }

  const chat = messages.filter((m) => !isSystemLine(m));
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
        <button className="act" onClick={() => void stop()}>
          Stop agent
        </button>
      </header>

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
          placeholder={`Message ${session.agent.handle}…  (Enter to send, Shift+Enter for newline)`}
          rows={2}
        />
        <button className="act primary" onClick={() => void send()} disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </section>
  );
}
