import { useState } from "react";
import { ChatView } from "./ChatView";
import { ModelsView } from "./ModelsView";
import { RunPanel } from "./RunPanel";
import { FilesView } from "./FilesView";
import { SettingsView } from "./SettingsView";
import { SoloView } from "./SoloView";
import { TeamsView } from "./TeamsView";
import type { OpenTeam } from "./orchestratorApi";

/**
 * Chat is the front door — talk to the Loop Agent in plain language, or click a
 * team on the Teams page and land here connected to its conversation. Run is the
 * form-driven version; Models / Teams / Settings are the doers. (The old raw
 * Conversations tab folded into Chat — one place to watch AND talk to a team.)
 * Lane split: Chat / Run / Teams = 01; Models / Settings = 02.
 */
const TABS = ["Chat", "Run", "Models", "Teams", "Solo", "Files", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App(): React.JSX.Element {
  const [active, setActive] = useState<Tab>("Chat");
  // The team the user clicked "💬 Chat" on in Teams — Chat opens it and connects.
  const [openTeam, setOpenTeam] = useState<OpenTeam | null>(null);

  function openChat(team: OpenTeam): void {
    setOpenTeam(team);
    setActive("Chat");
  }

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
        {active === "Chat" && <ChatView openTeam={openTeam} onOpenChat={openChat} onNewChat={() => setOpenTeam(null)} />}
        {active === "Run" && <RunPanel />}
        {active === "Models" && <ModelsView />}
        {active === "Teams" && <TeamsView onOpenChat={openChat} />}
        {active === "Solo" && <SoloView />}
        {active === "Files" && <FilesView />}
        {active === "Settings" && <SettingsView />}
      </main>
    </div>
  );
}
