import { useEffect, useState } from "react";
import { getModels, type CatalogEntry } from "./api";
import { createTeam, drainTeam, getTeams, startLoop, type Team } from "./orchestratorApi";

/**
 * Teams: create a standing fleet, run loops on it, all from the web. Live
 * teams up front; the pile of closed per-run teams is tucked behind a
 * disclosure so the view stays clean.
 */
export function TeamsView(): React.JSX.Element {
  const [models, setModels] = useState<CatalogEntry[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // create-team form
  const [name, setName] = useState("");
  const [worker, setWorker] = useState("");
  const [cwd, setCwd] = useState("~/maya-demo");
  // Watch a team's live conversation inline (the agents talking on its bus channel).
  const [watch, setWatch] = useState<{ name: string; channelId: string } | null>(null);
  const [convo, setConvo] = useState<Array<{ seq: number; from: string; fromRole?: string; body: { text?: string } }>>([]);

  useEffect(() => {
    void getModels().then((m) => {
      setModels(m);
      const w = m.find((x) => x.capabilities?.toolCalling) ?? m.find((x) => x.kind === "local-gguf");
      setWorker((prev) => prev || w?.id || "");
    });
    const tick = (): void => void getTeams().then(setTeams).catch(() => setError("Can't reach the orchestrator — is `maya serve` running?"));
    void tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  // Poll the watched team's channel history so you see the agents converse live.
  useEffect(() => {
    if (!watch) return;
    let alive = true;
    const tick = (): void => {
      void fetch(`/api/channels/${encodeURIComponent(watch.channelId)}/history?limit=200`)
        .then((r) => r.json())
        .then((h: { messages?: typeof convo }) => {
          if (alive) setConvo(h.messages ?? []);
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [watch]);

  const live = teams.filter((t) => t.state !== "closed");
  const closed = teams.filter((t) => t.state === "closed");

  async function create(): Promise<void> {
    if (!name.trim() || !worker || !cwd.trim()) return;
    setError(null);
    try {
      await createTeam({ name: name.trim(), workerModel: worker, cwd: cwd.trim(), allowedTools: ["Write", "Edit"] });
      setName("");
      void getTeams().then(setTeams);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function runOn(team: Team): Promise<void> {
    const goal = window.prompt(`Goal for "${team.name}":`, "Create a file named NOTE.md containing exactly: hello");
    if (!goal) return;
    const leadModel = models.find((m) => m.capabilities?.toolCalling)?.id ?? models[0]?.id ?? worker;
    try {
      await startLoop({ goal, cwd, leadModel, teamId: team.id });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <section className="run" aria-label="Teams">
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <div className="panel run-form">
        <h2>Create a standing team</h2>
        <div className="field-row">
          <label className="field grow">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="dev-fleet" />
          </label>
          <label className="field grow">
            <span>Worker model</span>
            <select value={worker} onChange={(e) => setWorker(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.capabilities?.toolCalling ? " ✓tools" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Directory</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/any/dir" />
          </label>
        </div>
        <button className="act primary" onClick={() => void create()} disabled={!name.trim() || !worker}>
          + Create team
        </button>
      </div>

      <div className="panel">
        <h2>Live teams {live.length > 0 && <span className="chip">{live.length}</span>}</h2>
        {live.length === 0 ? (
          <p className="empty">No live teams — create one above, then run many loops on it.</p>
        ) : (
          <table>
            <tbody>
              {live.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.name}</strong> <span className={`chip state-${t.state}`}>{t.state}</span>
                  </td>
                  <td>{t.tokensUsed.toLocaleString()} tok</td>
                  <td>{t.inFlight > 0 ? `${t.inFlight} in flight` : "idle"}</td>
                  <td className="row-actions">
                    <button className="act" onClick={() => setWatch({ name: t.name, channelId: t.channelId })}>
                      👁 Watch
                    </button>
                    <button className="act" onClick={() => void runOn(t)}>
                      ▶ Run
                    </button>
                    <button className="act" onClick={() => void drainTeam(t.id).then(() => getTeams().then(setTeams))}>
                      Drain
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {watch && (
        <div className="panel">
          <div className="cchat-head">
            <div>
              <strong>👁 {watch.name}</strong> <span className="muted">· live conversation ({convo.length})</span>
            </div>
            <button
              className="disclosure"
              onClick={() => {
                setWatch(null);
                setConvo([]);
              }}
            >
              close
            </button>
          </div>
          {convo.length === 0 ? (
            <p className="empty">No messages yet — the team is spinning up (Opus agents think for a bit before they speak).</p>
          ) : (
            <div className="convo">
              {convo.map((m) => (
                <div className="convo-msg" key={m.seq}>
                  <span className="convo-meta">
                    <code>#{m.seq}</code> <strong>{m.from}</strong>
                    {m.fromRole && <span className="chip">{m.fromRole}</span>}
                  </span>
                  <span className="convo-text">{m.body.text ?? "(structured frame)"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {closed.length > 0 && (
        <div className="panel">
          <button className="disclosure" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "▾" : "▸"} History ({closed.length} closed)
          </button>
          {showHistory && (
            <table>
              <tbody>
                {closed.slice(0, 30).map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.tokensUsed.toLocaleString()} tok</td>
                    <td className="muted">closed</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
