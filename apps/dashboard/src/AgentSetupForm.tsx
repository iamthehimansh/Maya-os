import { useEffect, useRef, useState } from "react";
import { getAuthMethods, getCloudModels, type AuthMethods, type CatalogEntry, type CldzProfile, type CloudModel } from "./api";
import type { SpawnAgentInput } from "./orchestratorApi";
import "./AgentSetupForm.css";

/**
 * "Run as" sentinels stored in AgentDraft.runAs:
 *   ""              → local gateway model
 *   "__claude_sub__"→ the user's own logged-in Claude Code subscription
 *   "__codex_sub__" → the user's own logged-in Codex/ChatGPT subscription
 *   "__mayac_sub__" → maya code on the user's own subscription (it resolves the
 *                     SAME ~/.claude credentials Claude Code uses)
 *   anything else   → a cldz profile name (runs on real Claude/Codex via cldz)
 */
export const SUB_CLAUDE = "__claude_sub__";
export const SUB_CODEX = "__codex_sub__";
export const SUB_MAYAC = "__mayac_sub__";

/** Native model choices when running on your OWN subscription (no gateway, no
 * cldz profile to enumerate the provider's real list). */
const CLAUDE_SUB_MODELS = [
  { id: "opus", name: "opus — most capable" },
  { id: "sonnet", name: "sonnet — faster" },
];
const CODEX_SUB_MODELS = [
  { id: "gpt-5-codex", name: "gpt-5-codex" },
  { id: "gpt-5", name: "gpt-5" },
];
/** mayac passes --model STRAIGHT to the provider SDK, so these must be full
 * model ids — the "opus"/"sonnet" aliases the claude CLI accepts would 404.
 * (Mirrors PROVIDER_CATALOG in packages/harness/src/providers/index.ts.) */
const MAYAC_SUB_MODELS = [
  { id: "claude-opus-4-8", name: "claude-opus-4-8 — most capable" },
  { id: "claude-sonnet-5", name: "claude-sonnet-5 — faster" },
  { id: "claude-haiku-4-5-20251001", name: "claude-haiku-4-5 — cheapest" },
];

const isSubRunAs = (runAs: string): boolean => runAs === SUB_CLAUDE || runAs === SUB_CODEX || runAs === SUB_MAYAC;
const EMPTY_AUTH: AuthMethods = { claudeSubscription: { available: false }, codexSubscription: { available: false }, cldzProfiles: [] };

/** The subscription each type can run on, and which login gates it. mayac's
 * `--auth subscription` reads the same ~/.claude credentials as Claude Code, so
 * the Claude login is what makes it available. */
const SUB_FOR_TYPE: Partial<Record<AgentType, typeof SUB_CLAUDE | typeof SUB_CODEX | typeof SUB_MAYAC>> = {
  "claude-code": SUB_CLAUDE,
  codex: SUB_CODEX,
  mayac: SUB_MAYAC,
};

/**
 * The rich agent-setup form himansh wanted everywhere (Solo, team lead, team
 * members, add-agent) — one component so every place asks the SAME detailed
 * questions: Handle · Type · Run-as (cldz profile) · Model · Directory · Tools.
 * Controlled: parent owns the `AgentDraft`; a TeamBuilder holds an array of them.
 */

export const AGENT_TYPES = ["claude-code", "codex", "opencode", "mayac"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/** Display names for the Type picker — "mayac" is the CLI's name, but the
 * product is "maya code" (Maya's own harness). */
export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  "claude-code": "claude-code",
  codex: "codex",
  opencode: "opencode",
  mayac: "maya code (mayac)",
};

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

/** Resolve a draft into the spawn payload (cloud vs local model, tools, profile).
 * Everything this form creates is a STANDING agent (team lead/member, solo,
 * add-agent), so it runs a real PTY — explicit here so the default holds even
 * against an older orchestrator without the server-side pty default. */
export function toSpawnInput(d: AgentDraft, role?: "lead" | "worker"): SpawnAgentInput {
  const sub =
    d.runAs === SUB_CLAUDE
      ? "claude-subscription"
      : d.runAs === SUB_CODEX
        ? "codex-subscription"
        : d.runAs === SUB_MAYAC
          ? "mayac-subscription"
          : undefined;
  const cloud = d.runAs !== ""; // subscription OR cldz profile — both send cloudModel
  const isProfile = cloud && sub === undefined; // a real cldz profile name
  const handle = d.handle.trim().startsWith("@") ? d.handle.trim() : `@${d.handle.trim()}`;
  return {
    handle,
    type: d.type,
    model: cloud ? d.cloudModel : d.model,
    cwd: d.cwd.trim(),
    pty: true,
    ...(role ? { role } : {}),
    ...(isProfile ? { cldzProfile: d.runAs } : {}),
    ...(sub ? { auth: sub } : {}),
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
  const sub = isSubRunAs(value.runAs); // running on the user's OWN subscription
  const cloud = value.runAs !== ""; // subscription OR cldz profile (i.e. not local gateway)
  // Patch against the LATEST draft, not the render-time closure — async
  // callers (the cloud-model autopick below) must not revert fields the user
  // edited while their fetch was in flight.
  const valueRef = useRef(value);
  valueRef.current = value;
  const set = (patch: Partial<AgentDraft>): void => onChange({ ...valueRef.current, ...patch });

  // Which "Run as" options exist + whether the subscriptions are actually logged
  // in (labels them "(not logged in)" but still selectable). Fetched once; the
  // client never throws, so a missing endpoint just greys both subscriptions out.
  const [auth, setAuth] = useState<AuthMethods>(EMPTY_AUTH);
  useEffect(() => {
    let alive = true;
    void getAuthMethods().then((m) => alive && setAuth(m));
    return () => {
      alive = false;
    };
  }, []);

  // Type ↔ subscription must stay consistent: each subscription belongs to exactly
  // one type (see SUB_FOR_TYPE). Switching the type out from under a selected
  // subscription drops back to the local gateway.
  const onType = (type: AgentType): void => {
    const drop = isSubRunAs(value.runAs) && value.runAs !== SUB_FOR_TYPE[type];
    set({ type, ...(drop ? { runAs: "" } : {}) });
  };
  // Picking a subscription seeds a sensible native default model (the cldz-cloud
  // list doesn't apply — there's no profile to enumerate the provider from).
  const onRunAs = (runAs: string): void => {
    if (runAs === SUB_CLAUDE) set({ runAs, cloudModel: CLAUDE_SUB_MODELS[0]!.id });
    else if (runAs === SUB_CODEX) set({ runAs, cloudModel: CODEX_SUB_MODELS[0]!.id });
    else if (runAs === SUB_MAYAC) set({ runAs, cloudModel: MAYAC_SUB_MODELS[0]!.id });
    else set({ runAs });
  };

  // When running on a cldz profile, list the REAL models from the provider (via
  // the credential, server-side) instead of a hardcoded opus/sonnet. Subscriptions
  // have no profile to enumerate — they use the native lists below.
  const [cloudModels, setCloudModels] = useState<CloudModel[]>([]);
  useEffect(() => {
    if (!value.runAs || isSubRunAs(value.runAs)) {
      setCloudModels([]);
      return;
    }
    let alive = true;
    void getCloudModels(value.runAs)
      .then((ms) => {
        if (!alive) return;
        setCloudModels(ms);
        // Pick a real model id if the current value isn't one of them (prefer opus).
        if (ms.length > 0 && !ms.some((m) => m.id === valueRef.current.cloudModel)) {
          set({ cloudModel: (ms.find((m) => /opus/i.test(m.id)) ?? ms[0]!).id });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.runAs]);

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
          <select value={value.type} onChange={(e) => onType(e.target.value as AgentType)}>
            {AGENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {AGENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Run as</span>
          <select value={value.runAs} onChange={(e) => onRunAs(e.target.value)}>
            <option value="">Local model (gateway)</option>
            {value.type === "claude-code" && (
              <option value={SUB_CLAUDE}>
                Claude Code — my subscription{auth.claudeSubscription.available ? "" : " (not logged in)"}
              </option>
            )}
            {value.type === "codex" && (
              <option value={SUB_CODEX}>
                Codex — my subscription{auth.codexSubscription.available ? "" : " (not logged in)"}
              </option>
            )}
            {value.type === "mayac" && (
              /* mayac --auth subscription resolves the SAME ~/.claude credentials,
                 so the Claude login is what gates it. */
              <option value={SUB_MAYAC}>
                maya code — my Claude subscription{auth.claudeSubscription.available ? "" : " (not logged in)"}
              </option>
            )}
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {p.type === "oauth" ? "subscription" : p.type}
                {p.default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Model</span>
          {sub ? (
            <select value={value.cloudModel} onChange={(e) => set({ cloudModel: e.target.value })}>
              {(value.runAs === SUB_CODEX
                ? CODEX_SUB_MODELS
                : value.runAs === SUB_MAYAC
                  ? MAYAC_SUB_MODELS
                  : CLAUDE_SUB_MODELS
              ).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : cloud ? (
            <select value={value.cloudModel} onChange={(e) => set({ cloudModel: e.target.value })}>
              {cloudModels.length > 0 ? (
                cloudModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))
              ) : (
                <>
                  <option value="opus">opus — capable</option>
                  <option value="sonnet">sonnet — faster</option>
                </>
              )}
            </select>
          ) : (
            <select value={value.model} onChange={(e) => set({ model: e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.toolCalling ? " ✓tools" : ""}
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
      {sub ? (
        <p className="muted small">
          {value.runAs === SUB_CLAUDE
            ? "Runs the native Claude Code CLI on your own logged-in subscription — no gateway, no API key."
            : value.runAs === SUB_MAYAC
              ? "Runs maya code (mayac) — Maya's own harness — on your own logged-in Claude subscription; no gateway, no API key."
              : "Runs the native Codex CLI on your own logged-in ChatGPT/Codex subscription."}
          {(value.runAs === SUB_CODEX ? auth.codexSubscription : auth.claudeSubscription).available
            ? ""
            : " You're not logged in yet — run the CLI's login first, or it won't start."}
        </p>
      ) : cloud ? (
        <p className="muted small">
          Runs on your real Claude via the <strong>{value.runAs}</strong> profile — capable enough for real work.
        </p>
      ) : null}
    </div>
  );
}
