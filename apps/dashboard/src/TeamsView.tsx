import { useEffect, useState } from "react";
import { getModels, type CatalogEntry } from "./api";
import { createTeam, drainTeam, getTeams, startLoop, type OpenTeam, type Team } from "./orchestratorApi";

/**
 * Teams: create a standing fleet, run loops on it, all from the web. Each team —
 * live or finished — has a 💬 Chat button that opens it in the Chat page, loaded
 * with that team's conversation (live teams you can talk to; closed ones open
 * read-only so you can review what the agents did). Live teams up front; the
 * pile of closed teams tucks behind a disclosure so the view stays clean.
 */
export function TeamsView({ onOpenChat }: { onOpenChat: (t: OpenTeam) => void }): React.JSX.Element {
  const [models, setModels] = useState<CatalogEntry[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // create-team form
  const [name, setName] = useState("");
  const [worker, setWorker] = useState("");
  const [cwd, setCwd] = useState("~/maya-demo");

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

  const live = teams.filter((t) => t.state !== "closed");
  const closed = teams.filter((t) => t.state === "closed");

  // Hand a team to the Chat page: live → talk to it, closed → read-only history.
  const open = (t: Team): void => onOpenChat({ id: t.id, channelId: t.channelId, name: t.name, live: t.state !== "closed" });

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
          <p className="empty">No live teams right now — create one above (or open a finished team below to review its chat).</p>
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
                    <button className="act primary" onClick={() => open(t)} title="Open this team in the Chat page">
                      💬 Chat
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

      {closed.length > 0 && (
        <div className="panel">
          <button className="disclosure" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "▾" : "▸"} Finished teams ({closed.length})
          </button>
          {showHistory && (
            <table>
              <tbody>
                {closed.slice(0, 40).map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.tokensUsed.toLocaleString()} tok</td>
                    <td className="muted">closed</td>
                    <td className="row-actions">
                      <button className="act" onClick={() => open(t)} title="Review this team's conversation (read-only)">
                        💬 Chat
                      </button>
                    </td>
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
