import { useCallback, useEffect, useState } from "react";
import { renderMarkdown } from "./md";

interface FsEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
}
interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

const fmtSize = (n?: number): string => {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
};

export function FilesView(): React.JSX.Element {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string; truncated: boolean } | null>(null);

  const load = useCallback(async (p?: string) => {
    setError(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/fs${p ? `?path=${encodeURIComponent(p)}` : ""}`);
      const body = (await res.json()) as FsListing & { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      setListing(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openFile = async (p: string): Promise<void> => {
    try {
      const res = await fetch(`/api/fs/read?path=${encodeURIComponent(p)}`);
      const body = (await res.json()) as { path: string; text: string; truncated: boolean; error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? "cannot preview");
      setPreview(body);
    } catch (e) {
      setPreview({ path: p, text: `(${e instanceof Error ? e.message : e})`, truncated: false });
    }
  };

  return (
    <>
      <section className="panel">
        <h2>Files <span className="hint">— browse your machine; pick a directory for a loop</span></h2>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="fs-bar">
          <button className="act" disabled={!listing?.parent} onClick={() => listing?.parent && void load(listing.parent)}>
            ↑ up
          </button>
          <code className="fs-path">{listing?.path ?? "…"}</code>
          {listing && (
            <button className="act" title="use this directory (copy path)" onClick={() => void navigator.clipboard?.writeText(listing.path)}>
              copy path
            </button>
          )}
        </div>
        {listing && (
          <div className="fs-list">
            {listing.entries.length === 0 && <div className="empty">empty directory</div>}
            {listing.entries.map((e) => (
              <button
                key={e.path}
                className="fs-row"
                onClick={() => (e.type === "dir" ? void load(e.path) : void openFile(e.path))}
              >
                <span className="fs-icon">{e.type === "dir" ? "📁" : "📄"}</span>
                <span className="fs-name">{e.name}</span>
                <span className="fs-size">{fmtSize(e.size)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {preview && (
        <section className="panel">
          <h2>
            {preview.path.split("/").pop()} <span className="hint">{preview.truncated ? "— preview (truncated)" : ""}</span>
          </h2>
          {/\.(md|markdown)$/i.test(preview.path) ? (
            <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.text) }} />
          ) : (
            <pre className="fs-preview">{preview.text}</pre>
          )}
        </section>
      )}
    </>
  );
}
