import { useEffect, useState } from "react";
import { getTeams, getTeamTasks, type Task, type Team } from "./orchestratorApi";

/** Teams tab (lane 01): team list with live task boards. Poll-based (2s). */
export function TeamsView(): React.JSX.Element {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [tasksByTeam, setTasksByTeam] = useState<Record<string, Task[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const t = await getTeams();
        if (!alive) return;
        setTeams(t);
        const boards = await Promise.all(t.slice(0, 10).map(async (team) => [team.id, await getTeamTasks(team.id)] as const));
        if (!alive) return;
        setTasksByTeam(Object.fromEntries(boards));
        setError(null);
      } catch {
        if (alive) setError("Can't reach the orchestrator — is `maya serve` running with the agent plane?");
      }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const STATES: Task["state"][] = ["queued", "assigned", "accepted", "working", "blocked", "done", "failed"];

  return (
    <section className="models" aria-label="Teams">
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {teams === null ? (
        <p className="empty">loading…</p>
      ) : teams.length === 0 ? (
        <div className="panel">
          <p className="empty">No teams yet — a loop run creates one, or use the orchestrator API.</p>
        </div>
      ) : (
        teams.map((team) => {
          const tasks = tasksByTeam[team.id] ?? [];
          return (
            <div className="panel" key={team.id}>
              <h2>
                {team.name} <span className={`chip state-${team.state}`}>{team.state}</span>
              </h2>
              <p className="empty">
                topology {team.topology} · {team.inFlight} in flight · tokens {team.tokensUsed.toLocaleString()}
                {team.tokenBudget !== null ? ` / ${team.tokenBudget.toLocaleString()}` : ""} · channel <code>{team.channelId}</code>
              </p>
              <div className="board">
                {STATES.map((state) => {
                  const col = tasks.filter((t) => t.state === state);
                  if (col.length === 0) return null;
                  return (
                    <div className="board-col" key={state}>
                      <h3>
                        {state} ({col.length})
                      </h3>
                      {col.map((t) => (
                        <div className="board-card" key={t.id} title={t.result ?? undefined}>
                          <code>{t.id.slice(-6)}</code> {t.spec.slice(0, 70)}
                          {t.attempts > 0 && <span className="chip">retry ×{t.attempts}</span>}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
