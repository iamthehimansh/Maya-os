import { useEffect, useState } from "react";
import { getModels, getCldzProfiles, type CatalogEntry, type CldzProfile } from "./api";
import { createTeam, drainTeam, getTeams, spawnTeamAgent, startLoop, type OpenTeam, type SpawnAgentInput, type Team } from "./orchestratorApi";
import { TeamBuilder } from "./TeamBuilder";

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

  // defaults for the quick "▶ Run" loop; full team creation uses <TeamBuilder>.
  const [worker, setWorker] = useState("");
  const [cwd] = useState("~/maya-demo");
  const [profiles, setProfiles] = useState<CldzProfile[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void getModels().then((m) => {
      setModels(m);
      const w = m.find((x) => x.capabilities?.toolCalling) ?? m.find((x) => x.kind === "local-gguf");
      setWorker((prev) => prev || w?.id || "");
    });
    void getCldzProfiles().then(setProfiles).catch(() => {});
    const tick = (): void => void getTeams().then(setTeams).catch(() => setError("Can't reach the orchestrator — is `maya serve` running?"));
    void tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  const live = teams.filter((t) => t.state !== "closed");
  const closed = teams.filter((t) => t.state === "closed");

  // Hand a team to the Chat page: live → talk to it, closed → read-only history.
  const open = (t: Team): void => onOpenChat({ id: t.id, channelId: t.channelId, name: t.name, live: t.state !== "closed" });

  // Rich create: team + lead + N members (each fully configured), then open it.
  async function createFullTeam(name: string, lead: SpawnAgentInput, members: SpawnAgentInput[]): Promise<void> {
    setCreating(true);
    setError(null);
    try {
      const team = await createTeam({ name, workerModel: lead.model, cwd: lead.cwd });
      await spawnTeamAgent(team.id, lead);
      for (const m of members) await spawnTeamAgent(team.id, m);
      void getTeams().then(setTeams);
      onOpenChat({ id: team.id, channelId: team.channelId, name: team.name, live: true });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
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
        <p className="empty">A team lead plus any number of members — each fully configured (type, model, cldz profile, directory, tools). Creates the team and opens its chat.</p>
        <TeamBuilder models={models} profiles={profiles} busy={creating} onSubmit={createFullTeam} defaultModel={worker} />
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
