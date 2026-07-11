import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenTeam, Team } from "./orchestratorApi";
import "./TeamSelector.css";

/**
 * TeamSelector — the chat header's channel picker.
 *
 * A native <select> collapses under the real shape of this data: a handful of
 * LIVE teams you actually work in, buried under an ever-growing tail of finished
 * ones (30 today, 100 next week). So: a custom panel that keeps the few things
 * you want in reach and pages the rest.
 *
 *  • "＋ New chat" is pinned first, always.
 *  • Live teams are never paginated — they all show, up top.
 *  • Finished teams page 8 at a time (Prev/Next), so a 100-team list renders 8
 *    rows, not 100. A search pages through its MATCHES, same bound.
 *  • ↑/↓ walk the rows that are actually on screen, Enter picks, Esc closes,
 *    and the search box holds focus the whole time — so typing just types.
 */

/** Liveness of a team row: the server's `live` flag wins; `state` is the fallback. */
export function isLive(t: Team): boolean {
  return t.live ?? t.state !== "closed";
}

/** Finished teams shown per page. Live teams are exempt — there are few. */
export const PAGE_SIZE = 8;

interface TeamSelectorProps {
  teams: Team[];
  openTeam: OpenTeam | null;
  /** The open team was just closed+archived — it's gone from `teams`, label it. */
  archived?: boolean;
  /** "" → front door (new chat); otherwise a team id. */
  onSelect: (id: string) => void;
  /** Prune a finished team (DELETE /api/teams/:id). Omit to hide the affordance. */
  onArchive?: (id: string) => void;
  pageSize?: number;
}

/** One keyboard-navigable row of the open panel. */
type Row = { kind: "new" } | { kind: "team"; team: Team; live: boolean };

export function TeamSelector({
  teams,
  openTeam,
  archived = false,
  onSelect,
  onArchive,
  pageSize = PAGE_SIZE,
}: TeamSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const activeRow = useRef<HTMLLIElement>(null);

  const q = query.trim().toLowerCase();
  const matches = (t: Team): boolean => !q || t.name.toLowerCase().includes(q);

  const live = useMemo(() => teams.filter((t) => isLive(t) && matches(t)), [teams, q]);
  const finished = useMemo(() => teams.filter((t) => !isLive(t) && matches(t)), [teams, q]);

  const pages = Math.max(1, Math.ceil(finished.length / pageSize));
  // A shrinking result set (someone typed another letter) must never strand us on
  // a page that no longer exists — clamp instead of rendering an empty page.
  const safePage = Math.min(page, pages - 1);
  const pageStart = safePage * pageSize;
  const pageOfFinished = finished.slice(pageStart, pageStart + pageSize);

  // The flat row list = exactly what's on screen. ↑/↓ walk THIS, so the highlight
  // can never land on a finished team that's on some other page.
  const rows: Row[] = useMemo(
    () => [
      { kind: "new" } as Row,
      ...live.map((t): Row => ({ kind: "team", team: t, live: true })),
      ...pageOfFinished.map((t): Row => ({ kind: "team", team: t, live: false })),
    ],
    [live, pageOfFinished],
  );

  // Keep the highlight inside the row list as search/pagination reshape it.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Opening = a fresh pick: blank search, first page, focus the box so you can
  // just start typing.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPage(0);
    setActive(0);
    search.current?.focus();
  }, [open]);

  // Click away → close (mousedown, so it beats the row's own click).
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // Follow the highlight when it walks off the visible slice of the panel.
  useEffect(() => {
    activeRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function choose(row: Row): void {
    onSelect(row.kind === "new" ? "" : row.team.id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) choose(row);
      return;
    }
    // Typing ALWAYS types into the search box — even when focus is parked on a
    // pager button or a row. Without this, the first letters after a Next click
    // vanish into a button that has no use for them.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && document.activeElement !== search.current) {
      e.preventDefault();
      setQuery((s) => s + e.key);
      setPage(0);
      setActive(0);
      search.current?.focus();
    }
  }

  /** Paging keeps the search box focused, so ↑/↓/Enter/typing keep working. */
  function goToPage(next: number): void {
    setPage(Math.max(0, Math.min(pages - 1, next)));
    setActive(0);
    search.current?.focus();
  }

  const label = openTeam ? openTeam.name : "＋ New chat";
  const suffix = openTeam ? (archived ? "archived" : openTeam.live ? "" : "finished") : "front door";

  return (
    <div className="tsel" ref={box}>
      <button
        type="button"
        className="tsel-trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Switch between the front door and any team"
        title="Switch between the front door and any team"
        onClick={() => setOpen((v) => !v)}
      >
        {openTeam && openTeam.live && !archived && <span className="tsel-dot" aria-hidden="true">●</span>}
        <span className="tsel-label">{label}</span>
        {suffix && <span className="tsel-suffix">{suffix}</span>}
        <span className="tsel-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="tsel-panel" onKeyDown={onKeyDown}>
          <input
            ref={search}
            className="tsel-search"
            type="text"
            value={query}
            placeholder="Search teams…"
            aria-label="Search teams"
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0); // a new query is a new result set — page 3 of the old one is meaningless
              setActive(0);
            }}
          />

          <ul className="tsel-list" role="listbox" aria-label="Teams">
            {rows.map((row, i) => {
              const isNew = row.kind === "new";
              const id = isNew ? "" : row.team.id;
              const current = isNew ? openTeam === null : openTeam?.id === id;
              const hot = i === active;
              return (
                <li
                  key={isNew ? "__new__" : id}
                  role="option"
                  aria-selected={hot}
                  ref={hot ? activeRow : null}
                  className={[
                    "tsel-row",
                    hot ? "active" : "",
                    isNew ? "new" : row.live ? "live" : "done",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => setActive(i)}
                >
                  {/* The whole row is the click target; the archive ✕ sits beside it
                      so a stray click can't delete the team you meant to open. */}
                  <button type="button" className="tsel-pick" onClick={() => choose(row)}>
                    <span className="tsel-mark">{current ? "✓" : ""}</span>
                    {isNew ? (
                      <>
                        <span className="tsel-name">＋ New chat</span>
                        <span className="tsel-tag">front door</span>
                      </>
                    ) : (
                      <>
                        {row.live && <span className="tsel-dot" aria-hidden="true">●</span>}
                        <span className="tsel-name">{row.team.name}</span>
                        {!row.live && <span className="tsel-tag">finished</span>}
                      </>
                    )}
                  </button>
                  {!isNew && !row.live && onArchive && (
                    <button
                      type="button"
                      className="tsel-archive"
                      title={`Archive ${row.team.name}`}
                      aria-label={`Archive ${row.team.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onArchive(row.team.id);
                      }}
                    >
                      🗑
                    </button>
                  )}
                </li>
              );
            })}
            {rows.length === 1 && q && (
              <li className="tsel-none">No team matches “{query}”.</li>
            )}
          </ul>

          {finished.length > pageSize && (
            <div className="tsel-pager">
              <button
                type="button"
                className="tsel-page"
                disabled={safePage === 0}
                onClick={() => goToPage(safePage - 1)}
              >
                ‹ Prev
              </button>
              <span className="tsel-count" aria-live="polite">
                Finished {pageStart + 1}–{pageStart + pageOfFinished.length} of {finished.length}
              </span>
              <button
                type="button"
                className="tsel-page"
                disabled={safePage >= pages - 1}
                onClick={() => goToPage(safePage + 1)}
              >
                Next ›
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
