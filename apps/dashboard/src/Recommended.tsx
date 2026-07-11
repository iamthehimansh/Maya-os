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
  publisherOf,
  pullSourceFor,
  sortSuggestions,
  systemLabel,
  tightNow,
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
  // Starts closed and stays closed unless the user opts in, every render.
  const [showUnverified, setShowUnverified] = useState(false);
  const fetchRef = useRef(fetchSuggestions);
  fetchRef.current = fetchSuggestions;

  // Re-rank server-side when the use case changes, or when the user asks to see
  // unvetted uploaders (that one has to round-trip — the gateway does the
  // filtering, and we deliberately don't keep a copy of its allowlist).
  // search/sort/fit stay client-side, so typing never round-trips.
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fetchRef
      .current({ useCase, limit: 24, ...(showUnverified ? { trusted: false } : {}) }, ac.signal)
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
  }, [useCase, showUnverified]);

  const installedIds = useMemo(() => new Set((models ?? []).map((m) => m.id)), [models]);
  const hidden = data?.catalog?.untrustedHidden ?? 0;

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
                {data.system.backend} · {data.system.cpuCores ? `${data.system.cpuCores} cores · ` : ""}
                {fmtGb(data.system.availableRamGb)} free
                {data.system.memoryBandwidthGbs ? ` · ${Math.round(data.system.memoryBandwidthGbs)} GB/s` : ""}
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

      {/* A filter the user can't see is a filter they can't overrule. The gateway
          withholds picks from uploaders it doesn't vet; say how many, and let
          them be shown deliberately — never silently, and never by default. */}
      {!showUnverified && hidden > 0 && (
        <div className="reco-hidden">
          {hidden} {hidden === 1 ? "model" : "models"} hidden — published by uploaders Maya doesn't vet.{" "}
          <button className="linkish" onClick={() => setShowUnverified(true)}>
            Show them anyway
          </button>
        </div>
      )}
      {showUnverified && (
        <div className="reco-warn" role="alert">
          Showing unverified uploaders. <strong>Download &amp; serve</strong> fetches that account's binary and runs it — check the
          publisher on each card first.{" "}
          <button className="linkish" onClick={() => setShowUnverified(false)}>
            Hide them
          </button>
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
          const pullSource = pullSourceFor(s);
          const publisher = publisherOf(s);
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
                {/* Says what we don't know, never what the model is. Maya cannot
                    trace this artifact to an upstream release — which is a gap in
                    OUR knowledge, not a defect in the model. It may be excellent. */}
                {s.verified === false && (
                  <span
                    className="reco-unverified"
                    title="Maya can't trace this build back to an upstream release, so it isn't scored on reputation — only on what we can measure. It may still be very good; we just can't vouch for it."
                  >
                    unverified lineage
                  </span>
                )}
                {publisher && (
                  <span className="reco-pub" title={`Download & serve fetches this binary from huggingface.co/${publisher}`}>
                    by {publisher}
                  </span>
                )}
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

              {/* Fit is scored against the machine's memory, not whatever is free this
                  second (that would reshuffle the list every reload). So a "perfect"
                  pick can still exceed free RAM right now — and the runtime guardrail
                  will refuse to load it. Say so here rather than let Serve fail. */}
              {tightNow(s, data?.system) && (
                <div className="reco-tight" title="Ranking uses your machine's total memory; loading needs it free right now.">
                  needs {fmtGb(s.requiredGb)} — only {fmtGb(data!.system.availableRamGb)} free right now
                </div>
              )}

              <footer className="reco-actions">
                {!runnable ? (
                  <span className="reco-note" title={s.sources.mlx ? "the gateway serves GGUF via llama-server; there is no MLX serving path yet" : badge.hint}>
                    {s.fitLevel === "no_fit"
                      ? `needs ${fmtGb(s.requiredGb)} — more than this machine has`
                      : (s.notRunnableReason ?? "no GGUF build — not runnable here")}
                  </span>
                ) : !installed ? (
                  <button className="act" disabled={isBusy || !pullSource} onClick={() => pullSource && onPull(pullSource, name)}>
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
