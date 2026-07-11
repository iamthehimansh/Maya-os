import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogEntry, Instance } from "./api";
import {
  FIT_BADGE,
  SORTS,
  USE_CASES,
  type SortBy,
  type SuggestResponse,
  type Suggestion,
  type UseCase,
  filterSuggestions,
  fmtCtx,
  fmtGb,
  fmtParams,
  fmtTps,
  getSuggestions,
  isRunnable,
  sortSuggestions,
  systemLabel,
} from "./hwfit";

export interface RecommendedProps {
  /** Installed local models — the live truth for "already downloaded", fresher
   * than the `installed` flag the route computed when the list was built. */
  models: CatalogEntry[] | null;
  live: Map<string, Instance>;
  busy: string | null;
  onPull: (source: string, name: string) => void;
  onLoad: (name: string) => void;
  onUnload: (name: string) => void;
  /** Test seam: injected instead of hitting the gateway. */
  fetchSuggestions?: typeof getSuggestions;
}

export function Recommended({ models, live, busy, onPull, onLoad, onUnload, fetchSuggestions = getSuggestions }: RecommendedProps): React.JSX.Element {
  const [data, setData] = useState<SuggestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [useCase, setUseCase] = useState<UseCase>("coding");
  const [sortBy, setSortBy] = useState<SortBy>("score");
  const [search, setSearch] = useState("");
  const [fitOnly, setFitOnly] = useState(false);
  const fetchRef = useRef(fetchSuggestions);
  fetchRef.current = fetchSuggestions;

  // Re-rank server-side only when the use case changes; search/sort/fit are
  // client-side over the returned set, so typing never round-trips.
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fetchRef
      .current({ useCase, limit: 24 }, ac.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [useCase]);

  const installedIds = useMemo(() => new Set((models ?? []).map((m) => m.id)), [models]);

  const shown = useMemo(() => {
    const list = filterSuggestions(data?.results ?? [], { search, fitOnly });
    return sortSuggestions(list, sortBy);
  }, [data, search, fitOnly, sortBy]);

  const stateOf = useCallback(
    (s: Suggestion): { installed: boolean; serving: boolean } => {
      const installed = installedIds.has(`local/${s.name}`) || Boolean(s.installed);
      const inst = live.get(`local/${s.name}`);
      return { installed, serving: Boolean(inst && inst.state !== "stopped") };
    },
    [installedIds, live],
  );

  const heading = data ? `Recommended for your ${systemLabel(data.system)}` : "Recommended for your machine";

  return (
    <section className="panel">
      <div className="reco-head">
        <div>
          <h2>{heading}</h2>
          <div className="sub">
            {data ? (
              <>
                {data.system.backend} · {data.system.cores ? `${data.system.cores} cores · ` : ""}
                {fmtGb(data.system.ramAvailableGb)} free
                {data.system.bandwidthGbs ? ` · ${Math.round(data.system.bandwidthGbs)} GB/s` : ""}
                {data.catalog?.source === "seed" && <span className="reco-stale"> · offline catalog (curated seed only)</span>}
              </>
            ) : (
              "detecting hardware…"
            )}
          </div>
        </div>
        <div className="reco-usecase" role="group" aria-label="use case">
          {USE_CASES.map((u) => (
            <button key={u} className="tab" role="radio" aria-checked={useCase === u} aria-label={u} onClick={() => setUseCase(u)}>
              {u}
            </button>
          ))}
        </div>
      </div>

      <div className="reco-controls">
        <input
          className="reco-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search models — name, provider, arch…"
          aria-label="search recommendations"
        />
        <label className="reco-check">
          <input type="checkbox" checked={fitOnly} onChange={(e) => setFitOnly(e.target.checked)} />
          Only models that fit
        </label>
        <label className="reco-check">
          Sort
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} aria-label="sort by">
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          Couldn't rank models for this machine — {error}. Is <code>maya serve</code> running?
        </div>
      )}
      {loading && !data && <div className="empty">Detecting your hardware and ranking models…</div>}
      {data && !shown.length && (
        <div className="empty">
          {search || fitOnly ? "No recommendations match those filters." : "No models in the catalog yet."}
        </div>
      )}

      <div className="reco-grid">
        {shown.map((s) => {
          const badge = FIT_BADGE[s.fitLevel];
          const { installed, serving } = stateOf(s);
          const runnable = isRunnable(s);
          const name = s.name;
          const isBusy = busy === name;
          return (
            <article key={name} className="reco-card">
              <header className="reco-card-head">
                <div className="reco-name" title={s.displayName ?? name}>
                  {s.displayName ?? name}
                </div>
                <span className="chip reco-fit" title={badge.hint}>
                  <span className="dot" style={{ background: badge.color }} />
                  {badge.label}
                </span>
              </header>

              <div className="reco-provider">
                {s.provider}
                {s.isMoe && <span className="reco-tag" title="mixture of experts — fewer active params per token">MoE</span>}
                {s.arch && <span className="reco-tag">{s.arch}</span>}
              </div>

              <dl className="reco-meta">
                <div>
                  <dt>Params</dt>
                  <dd>{fmtParams(s.paramsB)}</dd>
                </div>
                <div>
                  <dt>Quant</dt>
                  <dd>{s.quant}</dd>
                </div>
                <div>
                  <dt>Context</dt>
                  <dd>{fmtCtx(s.context)}</dd>
                </div>
                <div>
                  <dt>Speed</dt>
                  <dd>{fmtTps(s.speedTps)}</dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>{fmtGb(s.requiredGb)}</dd>
                </div>
                <div>
                  <dt>Runs on</dt>
                  <dd>{s.runMode}</dd>
                </div>
              </dl>

              <div
                className="reco-score"
                title={`quality ${s.subscores.quality} · speed ${s.subscores.speed} · fit ${s.subscores.fit} · context ${s.subscores.context}`}
              >
                <div className="reco-score-bar" role="img" aria-label={`match score ${Math.round(s.score)} of 100`}>
                  <div className="fill" style={{ width: `${Math.max(0, Math.min(100, s.score))}%` }} />
                </div>
                <span className="reco-score-num">{Math.round(s.score)}</span>
              </div>

              {s.reasons?.length ? <div className="reco-why">{s.reasons.join(" · ")}</div> : null}

              <footer className="reco-actions">
                {!runnable ? (
                  <span className="reco-note" title={s.sources.mlx ? "the gateway serves GGUF via llama-server; there is no MLX serving path yet" : badge.hint}>
                    {s.fitLevel === "no_fit" ? `needs ${fmtGb(s.requiredGb)} — more than this machine has` : "no GGUF build — not runnable here"}
                  </span>
                ) : !installed ? (
                  <button className="act" disabled={isBusy} onClick={() => onPull(s.sources.gguf!, name)}>
                    {isBusy ? "…" : "Download & serve"}
                  </button>
                ) : (
                  <button className="act" disabled={isBusy} onClick={() => (serving ? onUnload(name) : onLoad(name))}>
                    {isBusy ? "…" : serving ? "Unload" : "Serve"}
                  </button>
                )}
                {installed && <span className="reco-note">installed</span>}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
