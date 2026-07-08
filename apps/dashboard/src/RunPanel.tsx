import { useEffect, useMemo, useRef, useState } from "react";
import { getModels, type CatalogEntry } from "./api";
import { getRuns, startLoop, streamRun, type LoopEvent, type Run } from "./orchestratorApi";

/**
 * The action hub: describe a goal + a directory, pick models, hit Run — the
 * loop executes and streams live milestones here. No terminal, no curl. This
 * is what "create loop from the web, in any dir" means.
 */
export function RunPanel(): React.JSX.Element {
  const [models, setModels] = useState<CatalogEntry[]>([]);
  const [goal, setGoal] = useState("Create a file named STATUS.md containing exactly: Maya M3 demo complete");
  const [cwd, setCwd] = useState("~/maya-demo");
  const [lead, setLead] = useState("");
  const [worker, setWorker] = useState("");
  const [tools, setTools] = useState("Write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const unsub = useRef<() => void>(() => {});

  useEffect(() => {
    void getModels().then((m) => {
      setModels(m);
      const localFirst = m.filter((x) => x.kind === "local-gguf");
      const toolCaller = localFirst.find((x) => x.capabilities?.toolCalling) ?? localFirst[0];
      setLead((prev) => prev || toolCaller?.id || m[0]?.id || "");
      setWorker((prev) => prev || toolCaller?.id || "");
    });
    const tick = (): void => void getRuns().then(setRuns).catch(() => {});
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      clearInterval(t);
      unsub.current();
    };
  }, []);

  const workers = useMemo(
    () => models.filter((m) => m.capabilities?.toolCalling !== false), // exclude only MEASURED non-callers
    [models],
  );

  async function run(): Promise<void> {
    if (!goal.trim() || !cwd.trim()) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    unsub.current();
    try {
      const { runId } = await startLoop({
        goal: goal.trim(),
        cwd: cwd.trim(),
        leadModel: lead,
        workerModel: worker,
        allowedTools: tools.split(",").map((t) => t.trim()).filter(Boolean),
      });
      unsub.current = streamRun(runId, (e) => {
        setEvents((prev) => [...prev, e]);
        if (e.kind === "report") setBusy(false);
      });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }

  const report = events.find((e) => e.kind === "report");

  return (
    <section className="run" aria-label="Run a loop">
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <div className="panel run-form">
        <h2>Run a loop</h2>
        <label className="field">
          <span>Goal</span>
          <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should the team build?" />
        </label>
        <div className="field-row">
          <label className="field grow">
            <span>Directory</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/any/dir" list="recent-dirs" />
            <datalist id="recent-dirs">
              <option value="~/maya-demo" />
            </datalist>
          </label>
          <label className="field">
            <span>Tools</span>
            <input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="Write,Edit" />
          </label>
        </div>
        <div className="field-row">
          <label className="field grow">
            <span>Lead model</span>
            <select value={lead} onChange={(e) => setLead(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Worker model</span>
            <select value={worker} onChange={(e) => setWorker(e.target.value)}>
              {workers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.capabilities?.toolCalling ? " ✓tools" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="act primary" onClick={() => void run()} disabled={busy || !goal.trim() || !cwd.trim()}>
          {busy ? "Running…" : "▶ Run"}
        </button>
      </div>

      {events.length > 0 && (
        <div className="panel">
          <h2>
            Progress {report ? <span className={`chip outcome-${report.outcome}`}>{report.outcome}</span> : <span className="chip">● live</span>}
          </h2>
          <ol className="timeline">
            {events.map((e, i) => (
              <li key={i} className={`tl-${e.kind}`}>
                <span className="tl-kind">{label(e)}</span>
                <span className="tl-detail">{detail(e)}</span>
              </li>
            ))}
          </ol>
          {report && (
            <p className="empty">
              {report.summary} · {report.tokensUsed?.toLocaleString()} tokens
            </p>
          )}
        </div>
      )}

      <div className="panel">
        <h2>Recent runs</h2>
        {runs.length === 0 ? (
          <p className="empty">No runs yet — describe a goal above and hit Run.</p>
        ) : (
          <table>
            <tbody>
              {runs.slice(0, 12).map((r) => (
                <tr key={r.runId}>
                  <td>{r.goal.slice(0, 70)}</td>
                  <td>
                    {r.report ? (
                      <span className={`chip outcome-${r.report.outcome}`}>{r.report.outcome}</span>
                    ) : (
                      <span className="chip">● running</span>
                    )}
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

function label(e: LoopEvent): string {
  switch (e.kind) {
    case "started":
      return "🏁 started";
    case "planned":
      return `🧠 planned ${e.tasks ?? ""} task(s)`;
    case "question":
      return "❓ question";
    case "verified":
      return e.ok ? "✅ verified" : "✗ rejected";
    case "rework":
      return `🔧 rework r${e.round ?? ""}`;
    case "goal_check":
      return e.met ? "🎯 goal met" : "🎯 goal check";
    case "report":
      return `🏁 ${e.outcome}`;
  }
}

function detail(e: LoopEvent): string {
  if (e.kind === "question") return e.prompt ?? "";
  if (e.kind === "verified" || e.kind === "rework") return e.feedback ?? e.taskId ?? "";
  if (e.kind === "goal_check" && !e.met) return (e.missing ?? []).join(", ");
  if (e.kind === "report") return e.summary ?? "";
  return "";
}
