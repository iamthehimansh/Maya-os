import { useState } from "react";
import { ConversationsView } from "./ConversationsView";
import { ModelsView } from "./ModelsView";
import { RunPanel } from "./RunPanel";
import { TeamsView } from "./TeamsView";

/**
 * Action-first shell: Run is the home tab (describe a goal + dir → go). Models
 * and Teams are the other doers; Conversations is the live channel viewer.
 * (The old read-only Agents dump is gone — agents show per run/team instead.)
 */
const TABS = ["Run", "Models", "Teams", "Conversations"] as const;
type Tab = (typeof TABS)[number];

export function App(): React.JSX.Element {
  const [active, setActive] = useState<Tab>("Run");
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
        {active === "Run" && <RunPanel />}
        {active === "Models" && <ModelsView />}
        {active === "Teams" && <TeamsView />}
        {active === "Conversations" && <ConversationsView />}
      </main>
    </div>
  );
}
