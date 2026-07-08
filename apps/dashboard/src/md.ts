import MarkdownIt from "markdown-it";

/**
 * Markdown → HTML for chat + file previews, backed by markdown-it.
 * `html: false` means raw HTML in the source is escaped, not rendered — so it's
 * XSS-safe by default (no user content can inject markup). `linkify` turns bare
 * URLs into links; `breaks` renders single newlines as <br> (chat-friendly).
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderMarkdown(src: string): string {
  return md.render(src ?? "");
}
