import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

/**
 * Live terminal view for a spawned agent — himansh's "see the real Claude UI"
 * ask. Opens from the agent list; streams the agent's PTY over a WebSocket that
 * the agent-runtime exposes at `GET /api/teams/:id/agents/:handle/pty` (01's
 * lane). Renders raw terminal bytes with xterm.js so ANSI/colour/TUI look real.
 *
 * Frame shape is decoded defensively so it works whichever encoding 01 wires:
 *   - a binary frame (ArrayBuffer/Blob) → written as-is
 *   - a plain text frame → written as-is
 *   - a JSON frame {"b64":"…"} or {"data":"…"} → base64-decoded then written
 * (stdin-in is a later slice; this is output-only for now.)
 */
export function TerminalPanel({
  teamId,
  handle,
  onClose,
}: {
  teamId: string;
  handle: string;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "closed" | "error">("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      theme: { background: "#0b0e14", foreground: "#c7d0e0" },
      scrollback: 5000,
      disableStdin: true, // output-only for now
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not laid out yet — first resize handles it */
    }

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);

    // Relative to the dashboard origin (proxied to the orchestrator), matching
    // the rest of the app's `/api/*` calls. ws/wss follows the page protocol.
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(handle)}/pty`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    const writeBase64 = (b64: string) => {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        term.write(bytes);
      } catch {
        term.write(b64); // not valid base64 — show raw
      }
    };

    ws.onopen = () => setStatus("live");
    ws.onmessage = (ev) => {
      const data = ev.data as unknown;
      if (data instanceof ArrayBuffer) {
        term.write(new Uint8Array(data));
        return;
      }
      if (typeof data === "string") {
        // Could be a JSON frame ({b64|data}) or already-raw terminal text.
        if (data.startsWith("{")) {
          try {
            const f = JSON.parse(data) as { b64?: string; data?: string; text?: string };
            if (typeof f.b64 === "string") return writeBase64(f.b64);
            if (typeof f.data === "string") return term.write(f.data);
            if (typeof f.text === "string") return term.write(f.text);
          } catch {
            /* not JSON — fall through and write raw */
          }
        }
        term.write(data);
      }
    };
    ws.onerror = () => setStatus("error");
    ws.onclose = () => setStatus((s) => (s === "error" ? s : "closed"));

    return () => {
      window.removeEventListener("resize", onResize);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, [teamId, handle]);

  return (
    <div className="term-overlay" onClick={onClose}>
      <div className="term-modal" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">
            🖥️ {handle} <span className="term-sub">live terminal</span>
          </span>
          <span className={`term-status term-status-${status}`}>{status}</span>
          <button className="term-close" onClick={onClose} aria-label="Close terminal">
            ✕
          </button>
        </div>
        <div className="term-host" ref={hostRef} />
        {status !== "live" && (
          <div className="term-note">
            {status === "connecting" && "Connecting to the agent's terminal…"}
            {status === "closed" && "Terminal stream closed (agent idle or ended)."}
            {status === "error" && "Couldn't reach the agent's terminal — is it running?"}
          </div>
        )}
      </div>
    </div>
  );
}
