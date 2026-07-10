import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

/**
 * Live output view for a spawned agent — himansh's "see what the agent is
 * actually doing" ask. Streams the agent's captured stdout/stderr + lifecycle
 * events over SSE from `GET /api/teams/:id/agents/:handle/output` (01's
 * agent-runtime seam). The endpoint replays a backlog then tails live, and
 * closes when the agent exits.
 *
 * Each SSE `data:` line is one AgentEvent JSON:
 *   log   {stream: "stdout"|"stderr"|"system", line, at}  → the terminal body
 *   say   {text, at}                                        → the agent's message
 *   error {message, at}
 *   state {state, at}
 *   tokens{input, output, at}                              → header counter
 *   pty   {data}                                            → raw TUI bytes
 * Rendered into xterm.js with ANSI colour so stdout/stderr/say/error read apart.
 *
 * The grid is FIXED at 120x34 to mirror the server-side pty (the adapter spawns
 * node-pty at exactly that size, with no resize plumbing) — fitting xterm to the
 * modal would re-wrap every TUI row and garble the real Claude UI. The host div
 * scrolls when the modal is narrower than the grid.
 */

/** Must match the adapter's hardcoded pty size (claude-code.ts spawn). */
const PTY_COLS = 120;
const PTY_ROWS = 34;

type AgentEvent =
  | { kind: "log"; stream?: "stdout" | "stderr" | "system"; line?: string }
  | { kind: "say"; text?: string }
  | { kind: "error"; message?: string }
  | { kind: "state"; state?: string }
  | { kind: "tokens"; input?: number; output?: number }
  | { kind: "pty"; data?: string }
  | { kind?: string; [k: string]: unknown };

const C = {
  reset: "\x1b[0m",
  stderr: "\x1b[31m", // red
  system: "\x1b[2m", // dim
  say: "\x1b[36m", // cyan
  error: "\x1b[1;31m", // bold red
  state: "\x1b[33m", // yellow
};

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
  const [tokens, setTokens] = useState<{ input: number; output: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cols: PTY_COLS,
      rows: PTY_ROWS,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      theme: { background: "#0b0e14", foreground: "#c7d0e0" },
      scrollback: 8000,
      disableStdin: true, // output-only view
    });
    term.open(host);

    const writeLine = (s: string) => term.write(s.replace(/\r?\n$/, "") + "\r\n");
    const render = (ev: AgentEvent) => {
      switch (ev.kind) {
        case "pty":
          // Interactive-pty agent: raw terminal bytes (ANSI + text) straight
          // from node-pty — xterm renders the real Claude TUI directly.
          if (typeof ev.data === "string") term.write(ev.data);
          return;
        case "log": {
          const line = typeof ev.line === "string" ? ev.line : "";
          if (!line) return;
          if (ev.stream === "stderr") writeLine(C.stderr + line + C.reset);
          else if (ev.stream === "system") writeLine(C.system + line + C.reset);
          else writeLine(line); // stdout — the raw agent output (stream-json)
          return;
        }
        case "say":
          if (ev.text) writeLine(C.say + "💬 " + ev.text + C.reset);
          return;
        case "error":
          if (ev.message) writeLine(C.error + "⚠️  " + ev.message + C.reset);
          return;
        case "state":
          if (ev.state) writeLine(C.system + "● state: " + ev.state + C.reset);
          return;
        case "tokens":
          setTokens({ input: Number(ev.input ?? 0), output: Number(ev.output ?? 0) });
          return;
        default:
          return;
      }
    };

    const url = `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(handle)}/output`;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let retried = false;
    let opened = false;

    // EventSource fires `error` both when the endpoint closes (agent exited)
    // and on any transient drop (proxy blip, orchestrator restart). Don't
    // conflate them: probe the roster once — if the agent is still live,
    // reconnect once (the endpoint replays its backlog, so reset first);
    // only claim "the agent exited" when it genuinely isn't there anymore.
    const probe = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/agents`);
        const roster = (res.ok ? await res.json() : []) as Array<{ handle?: string; state?: string }>;
        const a = Array.isArray(roster) ? roster.find((x) => x.handle === handle) : undefined;
        const stillLive = a !== undefined && (a.state === "live" || a.state === "working" || a.state === "spawning");
        if (disposed) return;
        if (stillLive && !retried) {
          retried = true;
          setStatus("connecting");
          term.reset(); // the reconnect replays the backlog — don't double it
          retryTimer = setTimeout(connect, 1200);
          return;
        }
        setStatus(stillLive ? "error" : opened ? "closed" : "error");
      } catch {
        if (!disposed) setStatus(opened ? "closed" : "error");
      }
    };

    const connect = (): void => {
      if (disposed) return;
      es = new EventSource(url);
      es.onopen = () => {
        opened = true;
        setStatus("live");
      };
      es.onmessage = (e) => {
        try {
          render(JSON.parse(e.data) as AgentEvent);
        } catch {
          // Not JSON — show the raw payload so nothing is silently dropped.
          if (e.data) writeLine(String(e.data));
        }
      };
      es.onerror = () => {
        es?.close();
        if (!disposed) void probe();
      };
    };
    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      term.dispose();
    };
  }, [teamId, handle]);

  return (
    <div className="term-overlay" onClick={onClose}>
      <div className="term-modal" onClick={(e) => e.stopPropagation()}>
        <div className="term-head">
          <span className="term-title">
            🖥️ {handle} <span className="term-sub">live output</span>
          </span>
          {tokens && (
            <span className="term-tokens" title="tokens in / out">
              ↑{tokens.input} ↓{tokens.output}
            </span>
          )}
          <span className={`term-status term-status-${status}`}>{status}</span>
          <button className="term-close" onClick={onClose} aria-label="Close terminal">
            ✕
          </button>
        </div>
        <div className="term-host" ref={hostRef} style={{ overflow: "auto" }} />
        {status !== "live" && (
          <div className="term-note">
            {status === "connecting" && "Connecting to the agent's output stream…"}
            {status === "closed" && "Stream ended (the agent exited)."}
            {status === "error" && "Couldn't reach the agent's output — is it still live?"}
          </div>
        )}
      </div>
    </div>
  );
}
