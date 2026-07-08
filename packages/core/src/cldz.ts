/**
 * cldz profile bridge — lets Maya agents run on the user's REAL Claude auth
 * (subscription/OAuth or API key) instead of only local GGUFs. cldz
 * (`~/personal/claude-with-x`) stores named auth profiles in `~/.cldz/config.json`;
 * this reads them so a spawned coding agent can authenticate as the user.
 *
 * SECURITY: `listCldzProfiles()` is the SAFE view — names + types only, never
 * secrets — for display/selection in the UI. `resolveCldzProfileEnv()` returns
 * the auth env a spawn needs; its values ARE secret — pass straight into the
 * child's env, never log or serialize it onto the bus.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CldzProfileType = "apiKey" | "oauth" | "gateway" | "bedrock" | "vertex";

/** A profile as SAFE to expose (no secret material). */
export interface CldzProfileInfo {
  name: string;
  type: CldzProfileType;
  isDefault: boolean;
  /** How the agent runs on it — for the UI to hint "real Opus/Sonnet" vs local. */
  auth: "subscription" | "api-key" | "gateway" | "cloud-vendor";
}

interface RawProfile {
  type: CldzProfileType;
  oauthToken?: string;
  apiKey?: string;
  baseUrl?: string;
  [k: string]: unknown;
}
interface RawConfig {
  version?: number;
  defaultProfile?: string;
  profiles?: Record<string, RawProfile>;
}

const configPath = (): string => join(homedir(), ".cldz", "config.json");

function readConfig(): RawConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawConfig;
  } catch {
    return null;
  }
}

const AUTH_KIND: Record<CldzProfileType, CldzProfileInfo["auth"]> = {
  oauth: "subscription",
  apiKey: "api-key",
  gateway: "gateway",
  bedrock: "cloud-vendor",
  vertex: "cloud-vendor",
};

/** True when cldz is set up on this machine (there's a readable config). */
export function hasCldz(): boolean {
  return readConfig() !== null;
}

/** Profiles SAFE for display/selection — names + types only, NO secrets. */
export function listCldzProfiles(): CldzProfileInfo[] {
  const cfg = readConfig();
  if (!cfg?.profiles) return [];
  const def = cfg.defaultProfile;
  return Object.entries(cfg.profiles).map(([name, p]) => ({
    name,
    type: p.type,
    isDefault: name === def,
    auth: AUTH_KIND[p.type] ?? "cloud-vendor",
  }));
}

/**
 * Resolve a profile to the auth ENV a coding agent must spawn with. Merge the
 * returned vars into the child env AFTER stripping the parent's identity (see
 * `stripAgentIdentityEnv`). Returns null for an unknown profile or one missing
 * its secret. NEVER log the result — the values are credentials.
 */
export function resolveCldzProfileEnv(name: string): Record<string, string> | null {
  const p = readConfig()?.profiles?.[name];
  if (!p) return null;
  switch (p.type) {
    case "oauth":
      return p.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: p.oauthToken } : null;
    case "apiKey":
      return p.apiKey ? { ANTHROPIC_API_KEY: p.apiKey } : null;
    case "gateway":
      return p.baseUrl ? { ANTHROPIC_BASE_URL: p.baseUrl } : null;
    default:
      // bedrock/vertex use multiple provider vars — add when a profile needs it.
      return null;
  }
}

/**
 * Should this env key be stripped from the parent before injecting profile auth?
 * A coding agent must run in a DETERMINISTIC identity — inheriting the launcher's
 * CLAUDE_CODE_* / ANTHROPIC_* makes it behave as a nested session (declines work)
 * OR silently keeps the wrong auth. Strip these, then inject the resolved profile
 * env on top (which re-adds exactly the one token the profile needs).
 */
export function isAgentIdentityEnv(key: string): boolean {
  return (
    /^CLAUDE_CODE_/.test(key) ||
    key === "CLAUDECODE" ||
    key === "AI_AGENT" ||
    key === "CLAUDE_EFFORT" ||
    key === "ANTHROPIC_BASE_URL" ||
    key === "ANTHROPIC_API_KEY"
  );
}

/** Build a clean child env: parent minus identity vars, plus the profile's auth. */
export function agentEnvForProfile(parent: NodeJS.ProcessEnv, profileName: string): Record<string, string> | null {
  const auth = resolveCldzProfileEnv(profileName);
  if (!auth) return null;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined || isAgentIdentityEnv(k)) continue;
    env[k] = v;
  }
  return { ...env, ...auth };
}
