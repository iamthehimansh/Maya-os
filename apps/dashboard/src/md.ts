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
