import { useState } from "react";
import { AgentsView } from "./AgentsView";
import { ConversationsView } from "./ConversationsView";
import { ModelsView } from "./ModelsView";
import { TeamsView } from "./TeamsView";

/**
 * Dashboard shell — tab-based so each lane's views slot in independently.
 * Models = lane 02. Agents / Teams / Conversations = lane 01 (all live).
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
          {TABS.map((tab) => (
            <button key={tab} className="tab" role="tab" aria-selected={active === tab} onClick={() => setActive(tab)}>
              {tab}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {active === "Models" && <ModelsView />}
        {active === "Agents" && <AgentsView />}
        {active === "Teams" && <TeamsView />}
        {active === "Conversations" && <ConversationsView />}
      </main>
    </div>
  );
}
