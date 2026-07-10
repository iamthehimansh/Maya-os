import { useRef, useState } from "react";
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
  // Members keyed by a monotonic id (never reused): naming by array length
  // would mint duplicate @handles after remove-then-add, and index keys would
  // reparent each form's state on removal.
  const [members, setMembers] = useState<Array<{ id: number; draft: AgentDraft }>>([]);
  const nextId = useRef(1);

  function addMember(): void {
    const id = nextId.current++;
    setMembers((ms) => [...ms, { id, draft: newAgentDraft(`@member${id}`, lead.model, lead.cwd) }]);
  }
  const setMember = (id: number, d: AgentDraft): void => setMembers((ms) => ms.map((m) => (m.id === id ? { ...m, draft: d } : m)));
  const removeMember = (id: number): void => setMembers((ms) => ms.filter((m) => m.id !== id));

  // A duplicate handle would abort the create mid-spawn (the manager reserves
  // handles), leaving a half-created team — block it up front.
  const handles = [lead, ...members.map((m) => m.draft)].map((d) => d.handle.trim().replace(/^@/, "").toLowerCase());
  const hasDupHandle = new Set(handles).size !== handles.length;
  const canCreate = name.trim().length > 0 && draftReady(lead) && !hasDupHandle && !busy;

  function submit(): void {
    if (!canCreate) return;
    const leadSpec = toSpawnInput(lead, "lead");
    const memberSpecs = members.map((m) => m.draft).filter(draftReady).map((m) => toSpawnInput(m, "worker"));
    void onSubmit(name.trim(), leadSpec, memberSpecs);
  }

  return (
    <div className="team-builder">
      <label className="field grow">
        <span>Team name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="dev-fleet" />
      </label>

      <AgentSetupForm title="Team lead (@lead)" value={lead} onChange={setLead} models={models} profiles={profiles} handleLocked />
      {members.map((m) => (
        <AgentSetupForm
          key={m.id}
          title={`Member (${m.draft.handle || `@member${m.id}`})`}
          value={m.draft}
          onChange={(d) => setMember(m.id, d)}
          onRemove={() => removeMember(m.id)}
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
        {hasDupHandle && <span className="muted">two agents share a handle — make them unique</span>}
      </div>
    </div>
  );
}
