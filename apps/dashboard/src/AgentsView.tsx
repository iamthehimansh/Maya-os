import { useEffect, useState } from "react";
import { getAgents, getRuns, type Run, type TeamAgent } from "./orchestratorApi";

/**
 * Agents tab (lane 01): every spawned agent across teams, plus loop runs.
 * Poll-based (2s) — local service, cheap reads; live push lands with the
 * Conversations slice.
 */
export function AgentsView(): React.JSX.Element {
  const [agents, setAgents] = useState<TeamAgent[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const [a, r] = await Promise.all([getAgents(), getRuns()]);
        if (!alive) return;
        setAgents(a);
        setRuns(r);
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

  return (
    <section className="models" aria-label="Agents">
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <div className="panel">
        <h2>Loop runs</h2>
        {runs.length === 0 ? (
          <p className="empty">No loop runs yet — start one with `maya loop "…"` or POST /api/loop.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>run</th>
                <th>goal</th>
                <th>state</th>
                <th>outcome</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId}>
                  <td>
                    <code>{r.runId}</code>
                  </td>
                  <td>{r.goal.slice(0, 80)}</td>
                  <td>
                    <span className={`chip state-${r.state}`}>{r.state === "running" ? "● running" : "done"}</span>
                  </td>
                  <td>{r.report ? `${r.report.outcome} — ${r.report.summary.slice(0, 60)}` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Agents</h2>
        {agents === null ? (
          <p className="empty">loading…</p>
        ) : agents.length === 0 ? (
          <p className="empty">No agents spawned yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>agent</th>
                <th>adapter</th>
                <th>model</th>
                <th>bus handle</th>
                <th>state</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <code>{a.id}</code>
                  </td>
                  <td>{a.adapter}</td>
                  <td>
                    <code>{a.model}</code>
                  </td>
                  <td>{a.busHandle ?? "–"}</td>
                  <td>
                    <span className={`chip state-${a.state}`}>{a.state}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
