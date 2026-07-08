import { useEffect, useMemo, useRef, useState } from "react";
import { getModels, type CatalogEntry } from "./api";
import { answerRun, startLoop, streamRun, type LoopEvent } from "./orchestratorApi";

/**
 * Chat — Maya's front door. You talk to the Loop Agent in plain language; it
 * plans, spawns worker agents, streams its progress back as chat, and when it
 * hits a genuinely ambiguous fork it asks YOU a tap-able question and waits.
 * Each of your messages is a goal the lead runs to completion (or an honest
 * "partial"). Built on the same loop + SSE as the Run tab, presented as a
 * conversation. (Layout is intentionally simple pending the reference design.)
 */

type Bubble =
  | { who: "you"; text: string }
  | { who: "lead"; kind: LoopEvent["kind"]; text: string; runId: string; event: LoopEvent };

export function ChatView(): React.JSX.Element {
  const [models, setModels] = useState<CatalogEntry[]>([]);
  const [lead, setLead] = useState("");
  const [worker, setWorker] = useState("");
  const [cwd, setCwd] = useState("~/maya-demo");
  const [showConfig, setShowConfig] = useState(false);
  const [draft, setDraft] = useState("");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsub = useRef<() => void>(() => {});
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getModels().then((m) => {
      setModels(m);
      const local = m.filter((x) => x.kind === "local-gguf");
      const caller = local.find((x) => x.capabilities?.toolCalling) ?? local[0] ?? m[0];
      setLead((p) => p || caller?.id || "");
      setWorker((p) => p || caller?.id || "");
    });
    return () => unsub.current();
  }, []);

  // Keep the newest message in view.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [bubbles]);

  const workers = useMemo(() => models.filter((m) => m.capabilities?.toolCalling !== false), [models]);

  function send(): void {
    const text = draft.trim();
    if (!text || busy || !cwd.trim()) return;
    setDraft("");
    setError(null);
    setBusy(true);
    setBubbles((b) => [...b, { who: "you", text }]);
    unsub.current();
    void startLoop({ goal: text, cwd: cwd.trim(), leadModel: lead, workerModel: worker, allowedTools: ["Write", "Edit"] })
      .then(({ runId }) => {
        unsub.current = streamRun(runId, (e) => {
          setBubbles((b) => [...b, { who: "lead", kind: e.kind, text: renderEvent(e), runId, event: e }]);
          if (e.kind === "report") setBusy(false);
        });
      })
      .catch((e) => {
        setError(String(e instanceof Error ? e.message : e));
        setBusy(false);
      });
  }

  function answer(runId: string, qid: string | undefined, optionId: string, label: string): void {
    // Optimistically show the owner's choice, then route it to the waiting loop.
    setBubbles((b) => [...b, { who: "you", text: label }]);
    void answerRun(runId, { ...(qid ? { qid } : {}), optionId }).catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }

  return (
    <section className="chat" aria-label="Chat with the Loop Agent">
      <div className="chat-head">
        <div>
          <strong>Loop Agent</strong>
          <span className="muted"> · runs in {cwd || "(set a directory)"}</span>
        </div>
        <button className="disclosure" onClick={() => setShowConfig((v) => !v)}>
          {showConfig ? "hide setup" : "setup"}
        </button>
      </div>
      {showConfig && (
        <div className="chat-config">
          <label className="field grow">
            <span>Directory</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/any/dir" />
          </label>
          <label className="field">
            <span>Lead</span>
            <select value={lead} onChange={(e) => setLead(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Worker</span>
            <select value={worker} onChange={(e) => setWorker(e.target.value)}>
              {workers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.capabilities?.toolCalling ? " ✓tools" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <div className="chat-log" ref={scroller}>
        {bubbles.length === 0 ? (
          <div className="chat-empty">
            <p>👋 Tell the Loop Agent what to build. It plans, spawns worker agents, verifies against the real files, and reports back — asking you if it gets stuck.</p>
            <p className="muted">Try: "Create a file named NOTES.md containing exactly: hello from Maya"</p>
          </div>
        ) : (
          bubbles.map((b, i) =>
            b.who === "you" ? (
              <div className="msg you" key={i}>
                <div className="bubble">{b.text}</div>
              </div>
            ) : (
              <div className={`msg lead ${b.kind}`} key={i}>
                <div className="bubble">
                  <span className="bubble-icon">{ICON[b.kind]}</span>
                  <span>{b.text}</span>
                  {b.kind === "question" && (b.event.options?.length ?? 0) > 0 && (
                    <div className="q-options">
                      {b.event.options!.map((o) => (
                        <button key={o.id} className="act" onClick={() => answer(b.runId, b.event.qid, o.id, o.label)}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ),
          )
        )}
        {busy && (
          <div className="msg lead">
            <div className="bubble typing">Loop Agent is working…</div>
          </div>
        )}
      </div>

      <div className="chat-input">
        <textarea
          rows={1}
          value={draft}
          placeholder="Message the Loop Agent…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="act primary" onClick={send} disabled={busy || !draft.trim() || !cwd.trim()}>
          Send
        </button>
      </div>
    </section>
  );
}

const ICON: Record<LoopEvent["kind"], string> = {
  started: "🏁",
  planned: "🧠",
  question: "❓",
  verified: "✅",
  rework: "🔧",
  goal_check: "🎯",
  report: "🏁",
};

function renderEvent(e: LoopEvent): string {
  switch (e.kind) {
    case "started":
      return "On it — starting the loop.";
    case "planned":
      return `Planned ${e.tasks ?? ""} task${e.tasks === 1 ? "" : "s"}. Delegating to worker agents.`;
    case "question":
      return e.prompt ?? "I need a decision from you.";
    case "verified":
      return e.ok ? "Verified a task against the real files." : `A task didn't pass: ${e.feedback ?? "reworking"}.`;
    case "rework":
      return `Re-instructing the worker: ${e.feedback ?? e.taskId ?? "finish the task"}.`;
    case "goal_check":
      return e.met ? "Goal met — checked against the actual workspace." : `Not there yet — still missing: ${(e.missing ?? []).join(", ")}.`;
    case "report":
      return e.outcome === "success"
        ? `Done ✅ — ${e.summary ?? "goal met"}${e.tokensUsed ? ` (${e.tokensUsed.toLocaleString()} tokens)` : ""}.`
        : `${e.outcome === "partial" ? "Partial" : "Failed"} — ${e.summary ?? ""}. I won't claim success I can't verify.`;
  }
}
