/**
 * Tiny dependency-free Markdown → safe HTML renderer for chat + file previews.
 * XSS-safe by construction: the source is HTML-escaped FIRST, then only our own
 * tags are added, so no user content can inject markup. Links are restricted to
 * http(s). No external lib (keeps the bundle small + CSP-clean).
 *
 * Supports: fenced + inline code, #/##/### headings, **bold**, *italic*,
 * [text](url), - / 1. lists, blockquotes, paragraphs + line breaks.
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const inline = (s: string): string =>
  s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noreferrer">${t}</a>`);

export function renderMarkdown(src: string): string {
  const lines = esc(src ?? "").split("\n");
  const out: string[] = [];
  let inCode = false;
  let listType: "ul" | "ol" | null = null;
  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  for (const raw of lines) {
    if (raw.trimStart().startsWith("```")) {
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        closeList();
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(raw + "\n");
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) {
      closeList();
      const level = Math.min(6, h[1]!.length + 2); // # → h3, ## → h4 …
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(raw);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(raw);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`);
      continue;
    }
    const bq = /^\s*>\s?(.*)$/.exec(raw);
    if (bq) {
      closeList();
      out.push(`<blockquote>${inline(bq[1]!)}</blockquote>`);
      continue;
    }
    if (raw.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(raw)}</p>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}
