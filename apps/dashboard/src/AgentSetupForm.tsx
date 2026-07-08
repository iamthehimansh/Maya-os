import type { CatalogEntry, CldzProfile } from "./api";
import type { SpawnAgentInput } from "./orchestratorApi";
import "./AgentSetupForm.css";

/**
 * The rich agent-setup form himansh wanted everywhere (Solo, team lead, team
 * members, add-agent) — one component so every place asks the SAME detailed
 * questions: Handle · Type · Run-as (cldz profile) · Model · Directory · Tools.
 * Controlled: parent owns the `AgentDraft`; a TeamBuilder holds an array of them.
 */

export const AGENT_TYPES = ["claude-code", "codex", "opencode"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export interface AgentDraft {
  handle: string;
  type: AgentType;
  /** "" = local gateway model; else a cldz profile name (runs on real Claude). */
  runAs: string;
  /** Local model id (when runAs === ""). */
  model: string;
  /** Cloud model alias when runAs is a profile. */
  cloudModel: string;
  cwd: string;
  allTools: boolean;
}

export function newAgentDraft(handle: string, defaultModel = "", cwd = "~/maya-demo"): AgentDraft {
  return { handle, type: "claude-code", runAs: "", model: defaultModel, cloudModel: "opus", cwd, allTools: false };
}

/** Resolve a draft into the spawn payload (cloud vs local model, tools, profile). */
export function toSpawnInput(d: AgentDraft, role?: "lead" | "worker"): SpawnAgentInput {
  const cloud = d.runAs !== "";
  const handle = d.handle.trim().startsWith("@") ? d.handle.trim() : `@${d.handle.trim()}`;
  return {
    handle,
    type: d.type,
    model: cloud ? d.cloudModel : d.model,
    cwd: d.cwd.trim(),
    ...(role ? { role } : {}),
    ...(cloud ? { cldzProfile: d.runAs } : {}),
    ...(d.allTools ? { allowedTools: ["*"] } : { allowedTools: ["Read", "Write", "Edit", "Bash"] }),
  };
}

/** True when the draft has the minimum to spawn (handle + a model/engine + cwd). */
export function draftReady(d: AgentDraft): boolean {
  const engine = d.runAs !== "" ? d.cloudModel : d.model;
  return d.handle.trim().length > 1 && !!engine && d.cwd.trim().length > 0;
}

interface Props {
  value: AgentDraft;
  onChange: (d: AgentDraft) => void;
  models: CatalogEntry[];
  profiles: CldzProfile[];
  /** Shown as a heading with a remove control (for team members). */
  title?: string;
  onRemove?: () => void;
  /** Lock the handle (e.g. the lead is always @lead). */
  handleLocked?: boolean;
}

export function AgentSetupForm({ value, onChange, models, profiles, title, onRemove, handleLocked }: Props): React.JSX.Element {
  const cloud = value.runAs !== "";
  const set = (patch: Partial<AgentDraft>): void => onChange({ ...value, ...patch });

  return (
    <div className="agent-setup">
      {(title || onRemove) && (
        <div className="agent-setup-head">
          {title && <strong>{title}</strong>}
          {onRemove && (
            <button type="button" className="linklike" onClick={onRemove}>
              remove
            </button>
          )}
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span>Handle</span>
          <input value={value.handle} disabled={handleLocked} onChange={(e) => set({ handle: e.target.value })} placeholder="@assistant" />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={value.type} onChange={(e) => set({ type: e.target.value as AgentType })}>
            {AGENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {profiles.length > 0 && (
          <label className="field grow">
            <span>Run as</span>
            <select value={value.runAs} onChange={(e) => set({ runAs: e.target.value })}>
              <option value="">Local model (gateway)</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} · {p.type === "oauth" ? "subscription" : p.type}
                  {p.default ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field grow">
          <span>Model</span>
          {cloud ? (
            <select value={value.cloudModel} onChange={(e) => set({ cloudModel: e.target.value })}>
              <option value="opus">opus — capable</option>
              <option value="sonnet">sonnet — faster</option>
            </select>
          ) : (
            <select value={value.model} onChange={(e) => set({ model: e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.capabilities?.toolCalling ? " ✓tools" : ""}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>
      <div className="field-row">
        <label className="field grow">
          <span>Working directory</span>
          <input value={value.cwd} onChange={(e) => set({ cwd: e.target.value })} placeholder="~/any/dir" />
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={value.allTools} onChange={(e) => set({ allTools: e.target.checked })} />
          <span>All tools</span>
        </label>
      </div>
      {cloud && (
        <p className="muted small">
          Runs on your real Claude via the <strong>{value.runAs}</strong> profile — capable enough for real work.
        </p>
      )}
    </div>
  );
}
