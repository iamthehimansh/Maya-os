import MarkdownIt from "markdown-it";

/**
 * Markdown → HTML for chat + file previews, backed by markdown-it.
 * `html: false` means raw HTML in the source is escaped, not rendered — so it's
 * XSS-safe by default (no user content can inject markup). `linkify` turns bare
 * URLs into links; `breaks` renders single newlines as <br> (chat-friendly).
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Links open in a new tab — an in-place navigation would replace the SPA,
// dropping the open chat and any running front-door stream.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(src: string): string {
  return md.render(src ?? "");
}

/**
 * Highlight @mentions in already-rendered chat HTML — wraps each @handle token in
 * `<span class="mention">`. CHAT-ONLY: apply it after renderMarkdown in the chat
 * stream, never in file previews or Solo where a bare @word isn't a teammate.
 *
 * It walks the rendered HTML but rewrites ONLY text OUTSIDE tags (so it never
 * touches href="…@…" in a mailto/URL) and OUTSIDE <code>/<pre> (so code stays
 * verbatim). Preceded-by-word-char @'s are skipped, so `foo@bar.com` never lights
 * up — only free-standing @tokens do.
 *
 * @param html    output of renderMarkdown
 * @param handles known team handles (with or without the leading @). When
 *                non-empty ONLY these match (case-insensitive), so a stray email
 *                or random @word isn't styled; empty ⇒ a generic @[\w-]+ fallback.
 */
export function highlightMentions(html: string, handles: string[] = []): string {
  const bare = [...new Set(handles.map((h) => h.replace(/^@/, "").trim()).filter(Boolean))]
    // longest-first so "@qa-lead" wins over "@qa" at the same position
    .sort((a, b) => b.length - a.length)
    .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const token = bare.length > 0 ? `(?:${bare.join("|")})` : "[\\w-]+";
  const re = new RegExp(`(^|[^\\w@/])@(${token})(?![\\w-])`, "gi");
  let codeDepth = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((seg) => {
      if (seg.startsWith("<")) {
        if (/^<(code|pre)[\s/>]/i.test(seg)) codeDepth++;
        else if (/^<\/(code|pre)>/i.test(seg)) codeDepth = Math.max(0, codeDepth - 1);
        return seg;
      }
      if (codeDepth > 0 || !seg.includes("@")) return seg;
      return seg.replace(re, (_m, pre: string, h: string) => `${pre}<span class="mention">@${h}</span>`);
    })
    .join("");
}
