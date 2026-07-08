import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

/**
 * Live output view for a spawned agent — himansh's "see what the agent is
 * actually doing" ask. Streams the agent's captured stdout/stderr + lifecycle
 * events over SSE from `GET /api/teams/:id/agents/:handle/output` (01's
 * agent-runtime seam — NOT a raw TTY, which would fight the headless
 * stream-json mode the bridge needs). The endpoint replays a backlog then tails
 * live, and closes when the agent exits.
 *
 * Each SSE `data:` line is one AgentEvent JSON:
 *   log   {stream: "stdout"|"stderr"|"system", line, at}  → the terminal body
 *   say   {text, at}                                        → the agent's message
 *   error {message, at}
 *   state {state, at}
 *   tokens{input, output, at}                              → header counter
 * Rendered into xterm.js with ANSI colour so stdout/stderr/say/error read apart.
 */

type AgentEvent =
  | { kind: "log"; stream?: "stdout" | "stderr" | "system"; line?: string }
  | { kind: "say"; text?: string }
  | { kind: "error"; message?: string }
  | { kind: "state"; state?: string }
  | { kind: "tokens"; input?: number; output?: number }
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
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      theme: { background: "#0b0e14", foreground: "#c7d0e0" },
      scrollback: 8000,
      disableStdin: true, // output-only view
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
    };
    refit();
    window.addEventListener("resize", refit);

    const writeLine = (s: string) => term.write(s.replace(/\r?\n$/, "") + "\r\n");
    const render = (ev: AgentEvent) => {
      switch (ev.kind) {
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
    const es = new EventSource(url);
    let opened = false;
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
      // EventSource fires error on stream end too. Once we've had data, treat a
      // subsequent error as the agent having exited (the endpoint closes then),
      // and stop the browser's auto-reconnect (it would 404 on a gone agent).
      es.close();
      setStatus(opened ? "closed" : "error");
    };

    return () => {
      window.removeEventListener("resize", refit);
      es.close();
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
        <div className="term-host" ref={hostRef} />
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
