/**
 * YAML frontmatter parser for SKILL.md files. OWNER: @skills.
 *
 * This is the SAME open format Anthropic Agent Skills + skills.sh use: a file
 * that OPTIONALLY opens with a `---`-fenced YAML block, then the Markdown body.
 * We only need a tiny, dependency-free subset — the fields a skill declares:
 *
 *   ---
 *   name: my-skill
 *   description: What this skill does and when to use it.
 *   when-to-use: Optional extra trigger guidance.
 *   license: MIT
 *   metadata:
 *     internal: false
 *   ---
 *   <markdown body…>
 *
 * We parse top-level `key: value` pairs plus a ONE-LEVEL nested block (used for
 * `metadata:`). Values may be single/double quoted; quotes are stripped. This is
 * deliberately NOT a full YAML engine — a SKILL.md's frontmatter is flat by
 * convention, and we never execute any of it (a skill is knowledge, not code).
 */

export interface Frontmatter {
  /** Parsed key→value map. Nested blocks (e.g. metadata) become sub-objects. */
  data: Record<string, unknown>;
  /** The Markdown body AFTER the frontmatter block (or the whole file if none). */
  body: string;
}

/** Strip a single pair of matching surrounding quotes. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Coerce a scalar string into boolean/number where unambiguous, else the string. */
function coerce(raw: string): unknown {
  const v = unquote(raw);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~' || v === '') return v === '' ? '' : null;
  return v;
}

/**
 * Parse a SKILL.md (or any Markdown) string into `{ data, body }`. A file with
 * no leading `---` fence yields empty `data` and the whole text as `body`.
 */
export function parseFrontmatter(text: string): Frontmatter {
  // Normalize newlines so a CRLF file parses identically.
  const src = text.replace(/\r\n/g, '\n');
  // Must open with a `---` line (allow a leading BOM / blank lines before it? No —
  // the fence must be the very first line, matching Anthropic/skills.sh behavior).
  if (!src.startsWith('---\n') && src !== '---') {
    return { data: {}, body: text };
  }
  const rest = src.slice(4); // after "---\n"
  const end = rest.indexOf('\n---');
  if (end === -1) {
    // Unterminated fence — treat the whole thing as body (be forgiving).
    return { data: {}, body: text };
  }
  const yaml = rest.slice(0, end);
  // Body starts after the closing fence line. Skip "---" and its trailing newline.
  let after = rest.slice(end + 4); // after "\n---"
  if (after.startsWith('\n')) after = after.slice(1);

  const data: Record<string, unknown> = {};
  let nestKey: string | null = null;
  let nestObj: Record<string, unknown> | null = null;

  for (const line of yaml.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indented = /^\s/.test(line);
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (indented && nestObj) {
      // A child of the current nested block (e.g. `  internal: true`).
      nestObj[key] = coerce(value);
      continue;
    }
    // Top-level key.
    if (value === '') {
      // Opens a nested block: `metadata:` with indented children following.
      nestKey = key;
      nestObj = {};
      data[key] = nestObj;
    } else {
      data[key] = coerce(value);
      nestKey = null;
      nestObj = null;
    }
  }
  // Drop an empty nested block that never got children (keep it as {} is fine too).
  void nestKey;
  return { data, body: after };
}
