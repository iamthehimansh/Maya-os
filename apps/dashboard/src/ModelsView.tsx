import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CatalogEntry,
  type Health,
  type RuntimeEvent,
  getHealth,
  getModels,
  loadModel,
  onRuntimeEvents,
  pullModel,
  unloadModel,
} from "./api";

const GIB = 1024 ** 3;
const gb = (n: number): string => `${(n / GIB).toFixed(1)} GB`;

/** Instance state → status role + label. Label always shown — color never carries meaning alone. */
const STATE_STATUS: Record<string, { color: string; label: string }> = {
  ready: { color: "var(--status-good)", label: "running" },
  starting: { color: "var(--status-warning)", label: "starting" },
  degraded: { color: "var(--status-serious)", label: "degraded" },
  unhealthy: { color: "var(--status-serious)", label: "unhealthy" },
  stopping: { color: "var(--status-warning)", label: "stopping" },
  stopped: { color: "var(--text-muted)", label: "stopped" },
};

export function ModelsView(): React.JSX.Element {
  const [models, setModels] = useState<CatalogEntry[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  const [pullSrc, setPullSrc] = useState("");
  const [pullPct, setPullPct] = useState<{ model: string; pct: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([getModels(), getHealth()]);
      setModels(m);
      setHealth(h);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  // Debounced refresh so SSE bursts don't stampede the API.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refresh(), 250);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 10_000); // fallback when SSE drops
    const off = onRuntimeEvents((ev: RuntimeEvent) => {
      if (ev.type === "pull_failed") {
        setPullPct(null);
        setEvents((prev) => [`${new Date().toLocaleTimeString()}  ✗ pull failed: ${ev.model} — ${ev.error}`, ...prev].slice(0, 50));
        return;
      }
      if (ev.type === "pull_progress") {
        setPullPct(ev.pct >= 100 || ev.pct < 0 ? null : { model: ev.model, pct: ev.pct });
        if (ev.pct >= 100) scheduleRefresh();
        return;
      }
      setEvents((prev) => [`${new Date().toLocaleTimeString()}  ${describe(ev)}`, ...prev].slice(0, 50));
      scheduleRefresh();
    });
    return () => {
      clearInterval(poll);
      off();
    };
  }, [refresh, scheduleRefresh]);

  const ramPct = health ? Math.max(0, Math.min(100, (1 - health.ramFreeBytes / health.ramTotalBytes) * 100)) : 0;
  const floorPct = health ? (1 - (2 * GIB) / health.ramTotalBytes) * 100 : 100; // guardrail floor default 2 GiB
  const live = useMemo(() => new Map((health?.instances ?? []).map((i) => [i.model, i])), [health]);

  const act = async (name: string, fn: (n: string) => Promise<Response>): Promise<void> => {
    setBusy(name);
    try {
      const res = await fn(name);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setEvents((prev) => [`${new Date().toLocaleTimeString()}  ✗ ${body?.error?.message ?? `HTTP ${res.status}`}`, ...prev].slice(0, 50));
      }
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <>
      {offline && (
        <div className="error-banner" role="alert">
          Can't reach the gateway — is <code>maya serve</code> running?
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <div className="label">System RAM</div>
          <div className="value">{health ? gb(health.ramFreeBytes) : "–"}</div>
          <div className="sub">available of {health ? gb(health.ramTotalBytes) : "–"} · guardrail floor 2.0 GB</div>
          <div className="meter" role="img" aria-label={health ? `${gb(health.ramFreeBytes)} available; floor at 2 GB` : "loading"}>
            <div className="fill" style={{ width: `${ramPct}%` }} />
            <div className="floor" style={{ left: `${floorPct}%` }} title="guardrail floor (2 GB)" />
          </div>
        </div>
        <div className="tile">
          <div className="label">Live instances</div>
          <div className="value">{health ? health.instances.length : "–"}</div>
          <div className="sub">supervised llama-server processes</div>
        </div>
        <div className="tile">
          <div className="label">Installed models</div>
          <div className="value">{models ? models.length : "–"}</div>
          <div className="sub">~/.maya/models</div>
        </div>
      </div>

      <section className="panel">
        <h2>Pull a model</h2>
        <form
          className="pull"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pullSrc.trim()) return;
            void pullModel(pullSrc.trim());
            setPullSrc("");
          }}
        >
          <input
            value={pullSrc}
            onChange={(e) => setPullSrc(e.target.value)}
            placeholder="hf:owner/repo[/file.gguf]   or a direct URL"
            aria-label="model source"
          />
          <button className="act" type="submit">
            Pull
          </button>
        </form>
        {pullPct && (
          <>
            <div className="progress" role="progressbar" aria-valuenow={pullPct.pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="bar" style={{ width: `${pullPct.pct}%` }} />
            </div>
            <div className="sub" style={{ marginTop: 4 }}>
              {pullPct.model} — {pullPct.pct}%
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Models</h2>
        {!models?.length ? (
          <div className="empty">No local models yet — pull one above (e.g. hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF).</div>
        ) : (
          <table className="models">
            <thead>
              <tr>
                <th>Model</th>
                <th>State</th>
                <th>Quant</th>
                <th>Context</th>
                <th>Memory</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const inst = live.get(m.id) ?? m.instance;
                const st = inst ? (STATE_STATUS[inst.state] ?? STATE_STATUS.stopped!) : STATE_STATUS.stopped!;
                const name = m.id.replace(/^local\//, "");
                const isLive = Boolean(inst && inst.state !== "stopped");
                return (
                  <tr key={m.id}>
                    <td className="id">{m.id}</td>
                    <td>
                      <span className="chip">
                        <span className="dot" style={{ background: st.color }} />
                        {st.label}
                      </span>
                    </td>
                    <td>{inst?.quant ?? "–"}</td>
                    <td>{(inst?.contextLength ?? m.contextLength ?? 0).toLocaleString()}</td>
                    <td>{inst?.memoryBytes ? gb(inst.memoryBytes) : "–"}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="act"
                        disabled={busy === name}
                        onClick={() => void act(name, isLive ? unloadModel : loadModel)}
                      >
                        {busy === name ? "…" : isLive ? "Unload" : "Load"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Runtime events</h2>
        {events.length ? (
          <div className="events">
            {events.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        ) : (
          <div className="empty">Quiet — events (degrades, restarts, RAM pressure) stream here live.</div>
        )}
      </section>
    </>
  );
}

function describe(ev: RuntimeEvent): string {
  switch (ev.type) {
    case "instance_state":
      return `${ev.model} → ${ev.state}${ev.reason ? ` (${ev.reason})` : ""}`;
    case "model_degraded":
      return `⚠ ${ev.model} degraded ${ev.from} → ${ev.to} (${ev.reason})`;
    case "instance_restarted":
      return `↻ ${ev.model} auto-restarted (attempt ${ev.attempt})`;
    case "ram_pressure":
      return `⚠ RAM pressure — ${(ev.freeBytes / GIB).toFixed(1)} GB free, action: ${ev.action}`;
    case "pull_failed":
      return `✗ pull failed: ${ev.model} — ${ev.error}`;
    default:
      return JSON.stringify(ev);
  }
}
