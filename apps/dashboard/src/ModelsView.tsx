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
  setModelProfile,
  unloadModel,
} from "./api";
import { Recommended } from "./Recommended";

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
  const [pullErr, setPullErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [wontFit, setWontFit] = useState<Set<string>>(new Set());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Models a recommendation card asked to *serve*, not merely download — keyed
   * by the id the gateway reports on pull events (`local/<name>`). Drained when
   * the pull hits 100%, which is what makes the button's promise true. */
  const autoServe = useRef<Set<string>>(new Set());

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
        autoServe.current.delete(ev.model); // don't try to serve a download that died
        setPullPct(null);
        setPullErr(`${ev.model} — ${ev.error}`); // near the form, not just the events feed
        setEvents((prev) => [`${new Date().toLocaleTimeString()}  ✗ pull failed: ${ev.model} — ${ev.error}`, ...prev].slice(0, 50));
        return;
      }
      if (ev.type === "pull_progress") {
        setPullPct(ev.pct >= 100 || ev.pct < 0 ? null : { model: ev.model, pct: ev.pct });
        if (ev.pct >= 100) {
          // "Download & serve" — finish the second half of the promise. The
          // load route takes the bare name; the event carries `local/<name>`.
          if (autoServe.current.delete(ev.model)) {
            void loadModel(ev.model.replace(/^local\//, "")).finally(() => scheduleRefresh());
          }
          scheduleRefresh();
        }
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

  /** Kick a pull off with instant feedback: the bar shows at 0% immediately
   * (HF resolution takes seconds before the first progress frame), and a
   * rejected POST surfaces right here instead of only in the events feed.
   * `name` pins the installed id to local/<name> so the reco-chip "already
   * installed" check can actually match. */
  const startPull = (source: string, name?: string, serveWhenDone = false): void => {
    setPullErr(null);
    if (serveWhenDone && name) autoServe.current.add(`local/${name}`);
    setPullPct({ model: name ?? source, pct: 0 });
    void pullModel(source, name)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          setPullPct(null);
          setPullErr(body?.error?.message ?? `HTTP ${res.status}`);
        }
      })
      .catch((e) => {
        setPullPct(null);
        setPullErr(String(e instanceof Error ? e.message : e));
      });
  };

  const act = async (name: string, fn: (n: string, force?: boolean) => Promise<Response>, force = false): Promise<void> => {
    setBusy(name);
    try {
      const res = await fn(name, force);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        const msg = body?.error?.message ?? `HTTP ${res.status}`;
        if (/cannot fit/i.test(msg)) setWontFit((s2) => new Set(s2).add(name));
        setEvents((prev) => [`${new Date().toLocaleTimeString()}  ✗ ${msg}`, ...prev].slice(0, 50));
      } else {
        setWontFit((s2) => { const n = new Set(s2); n.delete(name); return n; });
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

      <Recommended
        models={models}
        live={live}
        busy={busy}
        onPull={(source, name) => startPull(source, name, true)}
        onLoad={(name) => void act(name, loadModel)}
        onUnload={(name) => void act(name, unloadModel)}
      />

      <section className="panel">
        <h2>Pull a model</h2>
        <form
          className="pull"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pullSrc.trim()) return;
            startPull(pullSrc.trim());
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
        {pullErr && (
          <div className="error-banner" role="alert">
            Pull failed: {pullErr}
          </div>
        )}
        {pullPct && (
          <>
            <div className="progress" role="progressbar" aria-valuenow={pullPct.pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="bar" style={{ width: `${pullPct.pct}%` }} />
            </div>
            <div className="sub" style={{ marginTop: 4 }}>
              {pullPct.model} — {pullPct.pct === 0 ? "starting…" : `${pullPct.pct}%`}
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
                <th>Quant · quality</th>
                <th>Context</th>
                <th>Default ctx / draft</th>
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
                    <td>{qualityCell(m, inst?.quant)}</td>
                    <td>{(inst?.contextLength ?? m.contextLength ?? 0).toLocaleString()}</td>
                    <td>
                      <input
                        className="mono ctx-edit"
                        type="number"
                        defaultValue={m.contextLength ?? 8192}
                        title="default context on next load"
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v >= 512) void setModelProfile(name, { contextLength: v }).then(() => refresh());
                        }}
                      />
                    </td>
                    <td>{inst?.memoryBytes ? gb(inst.memoryBytes) : "–"}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="act"
                        disabled={busy === name}
                        onClick={() => void act(name, isLive ? unloadModel : loadModel)}
                      >
                        {busy === name ? "…" : isLive ? "Unload" : "Load"}
                      </button>
                      {!isLive && wontFit.has(name) && (
                        <button
                          className="act"
                          title="load anyway — uses SSD as RAM (slower, won't crash)"
                          style={{ marginLeft: 6, borderColor: "var(--status-warning)" }}
                          disabled={busy === name}
                          onClick={() => void act(name, loadModel, true)}
                        >
                          ⚡ swap-load
                        </button>
                      )}
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

function qualityCell(m: CatalogEntry, liveQuant?: string): string {
  const q = m.quants?.find((x) => x.quant === (liveQuant ?? m.quants?.[0]?.quant));
  if (!q) return liveQuant ?? "–";
  return `${q.quant} · ${(q.quality * 100).toFixed(1).replace(/\.0$/, "")}%`;
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
