import { useState } from "react";
import { ChatView } from "./ChatView";
import { ConversationsView } from "./ConversationsView";
import { ModelsView } from "./ModelsView";
import { RunPanel } from "./RunPanel";
import { SettingsView } from "./SettingsView";
import { TeamsView } from "./TeamsView";

/**
 * Chat is the front door — talk to the Loop Agent in plain language. Run is the
 * form-driven version; Models / Teams / Settings are the doers; Conversations
 * is the raw channel viewer. Lane split: Chat / Run / Teams / Conversations =
 * 01; Models / Settings = 02.
 */
const TABS = ["Chat", "Run", "Models", "Teams", "Settings", "Conversations"] as const;
type Tab = (typeof TABS)[number];

export function App(): React.JSX.Element {
  const [active, setActive] = useState<Tab>("Chat");
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
        {active === "Chat" && <ChatView />}
        {active === "Run" && <RunPanel />}
        {active === "Models" && <ModelsView />}
        {active === "Teams" && <TeamsView />}
        {active === "Settings" && <SettingsView />}
        {active === "Conversations" && <ConversationsView />}
      </main>
    </div>
  );
}
