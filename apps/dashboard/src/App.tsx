import { ModelsView } from "./ModelsView";

/**
 * Dashboard shell — tab-based so each lane's views slot in independently.
 * Models = lane 02 (live). Agents / Teams / Conversations = lane 01 (Phase 4+).
 */
export function App(): React.JSX.Element {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="wordmark">Maya</span>
        <nav className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected="true">
            Models
          </button>
          <button className="tab" role="tab" aria-selected="false" disabled title="lands with Phase 4">
            Agents<span className="soon">soon</span>
          </button>
          <button className="tab" role="tab" aria-selected="false" disabled title="lands with Phase 6">
            Teams<span className="soon">soon</span>
          </button>
          <button className="tab" role="tab" aria-selected="false" disabled title="lands with Phase 6">
            Conversations<span className="soon">soon</span>
          </button>
        </nav>
      </header>
      <main>
        <ModelsView />
      </main>
    </div>
  );
}
