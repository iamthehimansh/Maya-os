import { useCallback, useEffect, useState } from "react";

/** Redacted config shape from GET /api/config — provider keys are never sent. */
interface WebProvider {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
  enabled: boolean;
  keyPresent: boolean;
}
interface Guardrails {
  minFreeRamBytes: number;
  autoDowngradeQuant: boolean;
  autoShrinkContext: boolean;
  healthCheckIntervalMs: number;
  hungProcessTimeoutMs: number;
  maxRestarts: number;
  restartWindowMs: number;
}
interface WebConfig {
  user?: { handle: string };
  gateway: { port: number };
  dashboard: { port: number };
  bus: { port: number };
  orchestrator: { port: number };
  modelsDir: string;
  providers: WebProvider[];
  guardrails: Guardrails;
}

const GIB = 1024 ** 3;
const gb = (n: number): string => `${(n / GIB).toFixed(1)} GB`;

interface SystemInfo {
  node: string;
  llamaCpp: { installed: boolean; version: string | null; hint: string | null };
  switchyard: { running: boolean; port: number | null };
  ram: { availableBytes: number; totalBytes: number; guardrailFloorBytes: number };
  models: { installed: number; dir: string };
  liveInstances: number;
}

interface Tunnel { id: string; port: number; url: string | null; state: string; }
function TunnelsPanel(): React.JSX.Element {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [installed, setInstalled] = useState(true);
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = (): void => void fetch("/api/tunnels").then((r) => r.json()).then((d) => { setTunnels(d.tunnels ?? []); setInstalled(d.installed !== false); }).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);
  const open = async (): Promise<void> => {
    if (!port.trim()) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/tunnels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port: Number(port) }) });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error?.message ?? "failed");
      setPort(""); load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const stop = (id: string): void => void fetch(`/api/tunnels/${id}`, { method: "DELETE" }).then(load);
  return (
    <section className="panel">
      <h2>Port forwarding <span className="hint">— expose a local port publicly via Cloudflare (explicit + stoppable)</span></h2>
      {!installed && <div className="error-banner">cloudflared not installed — <code>brew install cloudflared</code></div>}
      <div className="pull">
        <input type="number" placeholder="local port (e.g. 3000)" value={port} onChange={(e) => setPort(e.target.value)} />
        <button className="act primary" disabled={busy || !installed} onClick={() => void open()}>{busy ? "opening…" : "Expose"}</button>
      </div>
      {err && <div className="save-note" style={{ borderColor: "var(--status-critical)" }}>{err}</div>}
      {tunnels.length > 0 && (
        <table className="models" style={{ marginTop: 10 }}>
          <tbody>
            {tunnels.map((t) => (
              <tr key={t.id}>
                <td>:{t.port}</td>
                <td>{t.url ? <a href={t.url} target="_blank" rel="noreferrer" className="mono">{t.url}</a> : <span className="chip"><span className="dot" style={{ background: "var(--status-warning)" }} />{t.state}</span>}</td>
                <td style={{ textAlign: "right" }}><button className="act" onClick={() => stop(t.id)}>Stop</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function HealthPanel(): React.JSX.Element {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  useEffect(() => {
    const load = (): void => void fetch("/api/system").then((r) => r.json()).then(setSys).catch(() => setSys(null));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (!sys) return <section className="panel"><h2>System</h2><div className="empty">Loading…</div></section>;
  const item = (ok: boolean, label: string, detail: string): React.JSX.Element => (
    <div className="health-item">
      <span className="dot" style={{ background: ok ? "var(--status-good)" : "var(--status-critical)" }} />
      <span className="health-label">{label}</span>
      <span className="health-detail">{detail}</span>
    </div>
  );
  return (
    <section className="panel">
      <h2>System health <span className="hint">— maya doctor, live</span></h2>
      <div className="health-grid">
        {item(true, "Node", sys.node)}
        {item(sys.llamaCpp.installed, "llama.cpp", sys.llamaCpp.installed ? (sys.llamaCpp.version ?? "installed") : "not installed")}
        {item(sys.switchyard.running, "Switchyard", sys.switchyard.running ? `:${sys.switchyard.port}` : "off")}
        {item(sys.ram.availableBytes > sys.ram.guardrailFloorBytes, "RAM", `${gb(sys.ram.availableBytes)} free of ${gb(sys.ram.totalBytes)}`)}
        {item(true, "Models", `${sys.models.installed} installed`)}
        {item(true, "Instances", `${sys.liveInstances} live`)}
      </div>
    </section>
  );
}

export function SettingsView(): React.JSX.Element {
  const [cfg, setCfg] = useState<WebConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = (await (await fetch("/api/config")).json()) as WebConfig;
      setCfg(c);
      setError(null);
    } catch {
      setError("Can't reach the gateway — is `maya serve` running?");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (fn: (c: WebConfig) => WebConfig): void => {
    setCfg((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
    setNote(null);
  };

  // A cleared port field becomes 0 and the PUT handler has no range check — a
  // saved 0 makes the next `maya serve` bind a random port and breaks the
  // stack. Validate here; Save stays disabled (with a reason) until fixed.
  const validPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;
  const invalidReason = ((): string | null => {
    if (!cfg) return null;
    if (!(["gateway", "dashboard", "bus", "orchestrator"] as const).every((k) => validPort(cfg[k].port))) return "ports must be 1–65535";
    if (cfg.modelsDir.trim().length === 0) return "models directory can't be empty";
    if (cfg.user !== undefined && cfg.user.handle.trim().length <= 1) return "@handle can't be empty";
    return null;
  })();

  const save = async (): Promise<void> => {
    if (!cfg || invalidReason !== null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const body = (await res.json()) as { ok?: boolean; needsRestart?: boolean; error?: { message?: string } };
      if (!res.ok || !body.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      setDirty(false);
      setNote(body.needsRestart ? "Saved. Ports/models-dir changes need a `maya serve` restart." : "Saved — applies on next use.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (error && !cfg) return <div className="error-banner" role="alert">{error}</div>;
  if (!cfg) return <div className="empty">Loading settings…</div>;

  return (
    <>
      <HealthPanel />
      <section className="panel">
        <h2>Your identity <span className="hint">— your @handle in team channels (agents can tag you)</span></h2>
        <label className="field" style={{ maxWidth: 320 }}>
          <span>@handle</span>
          <input
            className="mono"
            value={cfg.user?.handle ?? "@me"}
            onChange={(e) => {
              let h = e.target.value.trim();
              if (h && !h.startsWith("@")) h = "@" + h;
              patch((c) => ({ ...c, user: { handle: h } }));
            }}
          />
        </label>
      </section>
      <TunnelsPanel />
      {error && <div className="error-banner" role="alert">{error}</div>}
      {note && <div className="save-note">{note}</div>}

      <section className="panel">
        <h2>Ports <span className="hint">— restart required after change</span></h2>
        <div className="field-grid">
          {(["gateway", "dashboard", "bus", "orchestrator"] as const).map((k) => (
            <label key={k} className="field">
              <span>{k}</span>
              <input
                type="number"
                value={cfg[k].port}
                onChange={(e) => patch((c) => ({ ...c, [k]: { port: Number(e.target.value) } }))}
              />
            </label>
          ))}
          <label className="field wide">
            <span>models directory</span>
            <input value={cfg.modelsDir} onChange={(e) => patch((c) => ({ ...c, modelsDir: e.target.value }))} />
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Cloud providers <span className="hint">— keys come from environment variables, never stored here</span></h2>
        <table className="models">
          <thead>
            <tr><th>Provider</th><th>Enabled</th><th>API-key env var</th><th>Key</th><th>Base URL (optional)</th></tr>
          </thead>
          <tbody>
            {cfg.providers.map((p, i) => (
              <tr key={p.id}>
                <td className="id">{p.id}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => patch((c) => { c.providers[i]!.enabled = e.target.checked; return c; })}
                  />
                </td>
                <td>
                  <input
                    className="mono"
                    value={p.apiKeyEnv}
                    onChange={(e) => patch((c) => { c.providers[i]!.apiKeyEnv = e.target.value; return c; })}
                  />
                </td>
                <td>
                  <span className="chip">
                    <span className="dot" style={{ background: p.keyPresent ? "var(--status-good)" : "var(--text-muted)" }} />
                    {p.keyPresent ? "set" : "not set"}
                  </span>
                </td>
                <td>
                  <input
                    className="mono"
                    placeholder="default"
                    value={p.baseUrl}
                    onChange={(e) => patch((c) => { c.providers[i]!.baseUrl = e.target.value; return c; })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Guardrails <span className="hint">— the "never crash the Mac" policy; applies on next model load</span></h2>
        <div className="field-grid">
          <label className="field">
            <span>min free RAM (GB)</span>
            <input
              type="number" step="0.5"
              value={(cfg.guardrails.minFreeRamBytes / GIB).toFixed(1)}
              onChange={(e) => patch((c) => { c.guardrails.minFreeRamBytes = Math.round(Number(e.target.value) * GIB); return c; })}
            />
          </label>
          <label className="field">
            <span>max restarts</span>
            <input
              type="number"
              value={cfg.guardrails.maxRestarts}
              onChange={(e) => patch((c) => { c.guardrails.maxRestarts = Number(e.target.value); return c; })}
            />
          </label>
          <label className="field">
            <span>hung timeout (s)</span>
            <input
              type="number"
              value={Math.round(cfg.guardrails.hungProcessTimeoutMs / 1000)}
              onChange={(e) => patch((c) => { c.guardrails.hungProcessTimeoutMs = Number(e.target.value) * 1000; return c; })}
            />
          </label>
          <label className="field toggle">
            <input
              type="checkbox"
              checked={cfg.guardrails.autoDowngradeQuant}
              onChange={(e) => patch((c) => { c.guardrails.autoDowngradeQuant = e.target.checked; return c; })}
            />
            <span>auto-downgrade quant under RAM pressure</span>
          </label>
          <label className="field toggle">
            <input
              type="checkbox"
              checked={cfg.guardrails.autoShrinkContext}
              onChange={(e) => patch((c) => { c.guardrails.autoShrinkContext = e.target.checked; return c; })}
            />
            <span>auto-shrink context under RAM pressure</span>
          </label>
        </div>
      </section>

      <div className="save-bar">
        <button className="act primary" disabled={!dirty || saving || invalidReason !== null} onClick={() => void save()}>
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {dirty && <button className="act" onClick={() => void load()}>Discard</button>}
        {dirty && invalidReason && <span className="hint">{invalidReason}</span>}
      </div>
    </>
  );
}
