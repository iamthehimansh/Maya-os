/**
 * skillsSearch.ts — turn the `/skills search` listing into installable hits.
 *
 * The skills manager (src/skills, owned elsewhere) hands the TUI a formatted,
 * human-readable listing — one block per hit:
 *
 *     Skills matching "git":
 *       • owner/repo/commit-helper  ↓482
 *           Write conventional commits from a diff
 *           /skills add owner/repo
 *
 * We keep printing that listing verbatim (the `/skills add …` lines are how a
 * user discovers the command) and ALSO parse it back into structured hits so the
 * results can be shown as a Picker where Enter installs the highlighted skill.
 * Parsing the rendered text — rather than reaching into the skills manager for a
 * second, structured API — keeps this feature entirely inside the TUI.
 *
 * The `/skills add <ref>` line is the anchor: a block without one is not
 * installable and is dropped, so an error string ("No skills found…", a network
 * message) parses to zero hits and the App simply falls back to plain output.
 */

export interface SkillHit {
  /** Fully-qualified registry id, e.g. "owner/repo/commit-helper". */
  id: string;
  /** The `owner/repo` spec to hand to `/skills add`. */
  ref: string;
  /** One-line description, when the listing carried one. */
  description: string;
  /** Install count, when the listing carried one. */
  installs?: number;
}

const BULLET = /^\s*[•*-]\s+(\S.*?)\s*$/;
const ADD = /^\s*\/skills\s+add\s+(\S+)\s*$/;
const INSTALLS = /\s*↓\s*([\d,]+)\s*$/;

/**
 * Parse the `/skills search` listing into hits, in the order the registry ranked
 * them. Tolerant by design: unknown lines are ignored, and a block only counts
 * once we've seen its `/skills add <ref>` line.
 */
export function parseSkillHits(listing: string): SkillHit[] {
  const hits: SkillHit[] = [];
  let id = '';
  let installs: number | undefined;
  let description = '';

  for (const raw of listing.split('\n')) {
    const add = ADD.exec(raw);
    if (add) {
      const ref = add[1]!;
      hits.push({
        id: id || ref,
        ref,
        description,
        ...(installs !== undefined ? { installs } : {}),
      });
      id = '';
      installs = undefined;
      description = '';
      continue;
    }

    const bullet = BULLET.exec(raw);
    if (bullet) {
      // A new block starts — anything buffered from a block with no add line is
      // dropped on the floor, which is exactly what we want.
      let head = bullet[1]!;
      const inst = INSTALLS.exec(head);
      if (inst) {
        head = head.slice(0, inst.index).trim();
        installs = Number(inst[1]!.replace(/,/g, ''));
      } else {
        installs = undefined;
      }
      id = head;
      description = '';
      continue;
    }

    // An indented, non-command line between a bullet and its add line is the
    // description. Only the first one is kept.
    const text = raw.trim();
    if (id && text && !description && !text.startsWith('/')) description = text;
  }

  return hits;
}

/** `{ label, hint }` for the Picker — id up front, installs + description after. */
export function hitLabel(hit: SkillHit): { label: string; hint: string } {
  const parts: string[] = [];
  if (hit.installs !== undefined) parts.push(`↓${hit.installs}`);
  if (hit.description) parts.push(hit.description);
  return { label: hit.id, hint: parts.join(' · ') };
}
