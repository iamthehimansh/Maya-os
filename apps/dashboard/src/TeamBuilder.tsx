import { useState } from "react";
import type { CatalogEntry, CldzProfile } from "./api";
import type { SpawnAgentInput } from "./orchestratorApi";
import { AgentSetupForm, newAgentDraft, toSpawnInput, draftReady, type AgentDraft } from "./AgentSetupForm";

/**
 * Rich team creation (himansh's ask): a full Solo-style setup for the LEAD plus
 * N members — each an AgentSetupForm. This is a CONTROLLED COLLECTOR: it gathers
 * the specs and hands them to `onSubmit`; the parent (ChatView / TeamsView) owns
 * createTeam + spawn + open-chat. models/profiles are provided by the parent so
 * they're fetched once for the whole page.
 */
interface Props {
  models: CatalogEntry[];
  profiles: CldzProfile[];
  busy?: boolean;
  /** Parent creates the team, spawns the lead + members, opens the chat. */
  onSubmit: (teamName: string, lead: SpawnAgentInput, members: SpawnAgentInput[]) => Promise<void> | void;
  /** Optional: seed the lead's model (e.g. the page's default). */
  defaultModel?: string;
}

export function TeamBuilder({ models, profiles, busy, onSubmit, defaultModel }: Props): React.JSX.Element {
  const [name, setName] = useState("");
  const [lead, setLead] = useState<AgentDraft>(() => newAgentDraft("@lead", defaultModel ?? ""));
  const [members, setMembers] = useState<AgentDraft[]>([]);

  function addMember(): void {
    setMembers((ms) => [...ms, newAgentDraft(`@member${ms.length + 1}`, lead.model, lead.cwd)]);
  }
  const setMember = (i: number, d: AgentDraft): void => setMembers((ms) => ms.map((m, j) => (j === i ? d : m)));
  const removeMember = (i: number): void => setMembers((ms) => ms.filter((_, j) => j !== i));

  const canCreate = name.trim().length > 0 && draftReady(lead) && !busy;

  function submit(): void {
    if (!canCreate) return;
    const leadSpec = toSpawnInput(lead, "lead");
    const memberSpecs = members.filter(draftReady).map((m) => toSpawnInput(m, "worker"));
    void onSubmit(name.trim(), leadSpec, memberSpecs);
  }

  return (
    <div className="team-builder">
      <label className="field grow">
        <span>Team name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="dev-fleet" />
      </label>

      <AgentSetupForm title="Team lead (@lead)" value={lead} onChange={setLead} models={models} profiles={profiles} handleLocked />
      {members.map((m, i) => (
        <AgentSetupForm
          key={i}
          title={`Member ${i + 1}`}
          value={m}
          onChange={(d) => setMember(i, d)}
          onRemove={() => removeMember(i)}
          models={models}
          profiles={profiles}
        />
      ))}

      <div className="team-builder-actions">
        <button type="button" className="act" onClick={addMember} disabled={busy}>
          + Add member
        </button>
        <button type="button" className="act primary" onClick={submit} disabled={!canCreate}>
          {busy ? "Creating…" : "Create team & open chat"}
        </button>
      </div>
    </div>
  );
}
