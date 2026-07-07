import { useState } from "react";
import { AgentsView } from "./AgentsView";
import { ModelsView } from "./ModelsView";
import { TeamsView } from "./TeamsView";

/**
 * Dashboard shell — tab-based so each lane's views slot in independently.
 * Models = lane 02. Agents / Teams = lane 01 (live). Conversations = lane 01,
 * lands with the bus-viewer slice.
 */
const TABS = ["Models", "Agents", "Teams", "Conversations"] as const;
type Tab = (typeof TABS)[number];

export function App(): React.JSX.Element {
  const [active, setActive] = useState<Tab>("Models");
  return (
    <div className="shell">
      <header className="topbar">
        <span className="wordmark">Maya</span>
        <nav className="tabs" role="tablist">
          {TABS.map((tab) => {
            const soon = tab === "Conversations";
            return (
              <button
                key={tab}
                className="tab"
                role="tab"
                aria-selected={active === tab}
                disabled={soon}
                title={soon ? "lands with the bus-viewer slice" : undefined}
                onClick={() => setActive(tab)}
              >
                {tab}
                {soon && <span className="soon">soon</span>}
              </button>
            );
          })}
        </nav>
      </header>
      <main>
        {active === "Models" && <ModelsView />}
        {active === "Agents" && <AgentsView />}
        {active === "Teams" && <TeamsView />}
      </main>
    </div>
  );
}
