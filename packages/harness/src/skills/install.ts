/**
 * Skill install + registry search. OWNER: @skills.
 *
 * INSTALL (`/skills add <owner/repo>`): we fetch the repo's skill files DIRECTLY
 * from GitHub — public, deterministic, and lands them under our `.skills/` root
 * so they Just Work (no dependency on `npx skills`, and no agent-dir mismatch).
 *   1. GET the repo tree (`api.github.com/.../git/trees/HEAD?recursive=1`).
 *   2. Find every `SKILL.md`/`skill.md`; each defines one skill (its folder).
 *   3. Download that SKILL.md + its sibling files (raw.githubusercontent.com)
 *      into `<root>/<skill-folder>/`.
 * A bare repo-root SKILL.md installs under `<root>/<repo>/`.
 *
 * SEARCH (`/skills search <query>`): hits the same PUBLIC, no-auth endpoint the
 * official `skills` CLI uses — `GET https://skills.sh/api/search?q=…&limit=…`,
 * a bare fetch with no headers and no token. (The `/api/v1/*` paths are the
 * authenticated surface and answer 401 — do not use them here.) Override the
 * base with `SKILLS_API_URL`, as the CLI does. Failures degrade to a friendly
 * message — never a throw.
 *
 * `fetchImpl` is injectable so tests drive both without real network.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type FetchImpl = typeof fetch;

const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
/** Public registry base. `SKILLS_API_URL` overrides it (same knob as the CLI). */
export const SKILLS_REGISTRY = 'https://skills.sh';

const SKILL_FILE = /(^|\/)(skill\.md)$/i;

/**
 * Headers for GitHub. Anonymous works for public repos (the normal case) but is
 * capped at 60 req/hr per IP; `GITHUB_TOKEN`, if the user has one exported,
 * lifts that to 5000 — we never require it.
 */
function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    'User-Agent': 'mayac-skills',
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** A 403/429 with the rate-limit budget exhausted — not a permissions problem. */
function isRateLimited(res: { status: number; headers: Headers }): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  return res.headers.get('x-ratelimit-remaining') === '0';
}

/** "in 12 min" — how long until the anonymous GitHub budget resets. */
function rateLimitHint(res: { headers: Headers }): string {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(reset) || reset <= 0) return 'shortly';
  const mins = Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000));
  return `in ~${mins} min`;
}

/** Parse "owner/repo" (tolerating a leading github.com/ or trailing slash). */
export function parseOwnerRepo(spec: string): { owner: string; repo: string } | null {
  const cleaned = spec
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0]!, repo: parts[1]! };
}

interface TreeEntry {
  path: string;
  type: string;
}

export interface InstallResult {
  ok: boolean;
  message: string;
  /** Names (folder names) of skills installed. */
  installed: string[];
}

/**
 * Install every skill in `owner/repo` into `root` (a `.skills/` dir). Returns a
 * human message + the installed folder names. Never throws — failures come back
 * as `{ ok: false }`.
 */
export async function installSkill(
  spec: string,
  root: string,
  opts: { fetchImpl?: FetchImpl; ref?: string } = {},
): Promise<InstallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ref = opts.ref ?? 'HEAD';
  const parsed = parseOwnerRepo(spec);
  if (!parsed) {
    return { ok: false, message: `Invalid skill spec "${spec}" — expected <owner/repo>.`, installed: [] };
  }
  const { owner, repo } = parsed;

  let tree: TreeEntry[];
  try {
    const res = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, {
      headers: githubHeaders({ Accept: 'application/vnd.github+json' }),
    });
    if (!res.ok) {
      if (isRateLimited(res)) {
        return {
          ok: false,
          message:
            `GitHub rate-limited this machine (60 anonymous requests/hour). ` +
            `Retry ${rateLimitHint(res)}, or export GITHUB_TOKEN to lift the cap. Nothing installed.`,
          installed: [],
        };
      }
      return {
        ok: false,
        message:
          res.status === 404
            ? `Repo ${owner}/${repo} not found (or private). Nothing installed.`
            : `Could not read ${owner}/${repo} (HTTP ${res.status}).`,
        installed: [],
      };
    }
    const body = (await res.json()) as { tree?: TreeEntry[] };
    tree = Array.isArray(body.tree) ? body.tree : [];
  } catch (e) {
    return {
      ok: false,
      message: `Network error reaching GitHub for ${owner}/${repo}: ${e instanceof Error ? e.message : String(e)}`,
      installed: [],
    };
  }

  const skillFiles = tree.filter((t) => t.type === 'blob' && SKILL_FILE.test(t.path));
  if (skillFiles.length === 0) {
    return { ok: false, message: `No SKILL.md found in ${owner}/${repo}.`, installed: [] };
  }

  const installed: string[] = [];
  for (const sf of skillFiles) {
    const skillDir = dirname(sf.path); // '' when SKILL.md is at repo root
    // Folder to install into: the skill's own folder, or the repo name at root.
    const folder = skillDir === '.' || skillDir === '' ? repo : skillDir.split('/').pop()!;
    const destDir = join(root, folder);
    // Sibling files that belong to this skill (same directory subtree).
    const prefix = skillDir === '.' || skillDir === '' ? '' : `${skillDir}/`;
    const members = tree.filter(
      (t) => t.type === 'blob' && (prefix === '' ? !t.path.includes('/') || t.path === sf.path : t.path.startsWith(prefix)),
    );
    // Always include the SKILL.md even if the prefix filter is loose at root.
    if (!members.some((m) => m.path === sf.path)) members.push(sf);

    let wroteAny = false;
    for (const m of members) {
      const rel = prefix === '' ? m.path : m.path.slice(prefix.length);
      if (!rel || rel.includes('..')) continue;
      try {
        const raw = await fetchImpl(`${GITHUB_RAW}/${owner}/${repo}/${ref}/${m.path}`, {
          headers: githubHeaders(),
        });
        if (!raw.ok) continue;
        const text = await raw.text();
        const dest = join(destDir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, text, 'utf8');
        wroteAny = true;
      } catch {
        // Skip an individual file that fails; keep installing the rest.
      }
    }
    if (wroteAny) installed.push(folder);
  }

  if (installed.length === 0) {
    return { ok: false, message: `Failed to download any skill files from ${owner}/${repo}.`, installed: [] };
  }
  return {
    ok: true,
    message: `Installed ${installed.length} skill(s) from ${owner}/${repo}: ${installed.join(', ')} → ${root}`,
    installed,
  };
}

export interface SearchHit {
  /** Fully-qualified "owner/repo/skill" — what the registry calls the skill. */
  id: string;
  name: string;
  description: string;
  /** "owner/repo" — the spec to pass to `/skills add`. */
  source?: string;
  installs?: number;
}

/**
 * Search the skills.sh registry over its PUBLIC endpoint — no login, no token.
 * Returns hits (possibly empty), best-installed first. Network/HTTP failures
 * throw a friendly Error the caller renders — callers should catch.
 *
 * Deliberately sends NO headers: this mirrors the official CLI's bare `fetch`,
 * so we can never be rejected for a header the public endpoint doesn't expect.
 */
export async function searchRegistry(
  query: string,
  opts: { fetchImpl?: FetchImpl; limit?: number; owner?: string } = {},
): Promise<SearchHit[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = process.env.SKILLS_API_URL || SKILLS_REGISTRY;
  const params = new URLSearchParams({ q: query, limit: String(opts.limit ?? 10) });
  if (opts.owner) params.set('owner', opts.owner);
  const res = await fetchImpl(`${base}/api/search?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`skills.sh search failed (HTTP ${res.status}) — try again, or browse https://skills.sh.`);
  }
  const body = (await res.json()) as unknown;
  // Be liberal in what we accept: { skills: [...] } | { results: [...] } | [...].
  const arr: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { skills?: unknown[] }).skills)
      ? (body as { skills: unknown[] }).skills
      : Array.isArray((body as { results?: unknown[] }).results)
        ? (body as { results: unknown[] }).results
        : [];
  const hits = arr.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    // `source` is the owner/repo to install; `skillId` (a.k.a. slug) the folder.
    const source = typeof r.source === 'string' ? r.source : '';
    const slug =
      typeof r.skillId === 'string' && r.skillId ? r.skillId : typeof r.slug === 'string' ? r.slug : '';
    const id =
      typeof r.id === 'string' && r.id
        ? r.id
        : source && slug
          ? `${source}/${slug}`
          : slug || source || (typeof r.name === 'string' ? r.name : '');
    return {
      id,
      name: typeof r.name === 'string' && r.name ? r.name : slug || id,
      description: typeof r.description === 'string' ? r.description : '',
      ...(source ? { source } : {}),
      ...(typeof r.installs === 'number' ? { installs: r.installs } : {}),
    };
  });
  // Most-installed first — same ordering the official CLI presents.
  return hits.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
}
