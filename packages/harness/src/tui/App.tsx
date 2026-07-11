/**
 * App — the full-screen Ink TUI for maya-harness. OWNER: @tui.
 *
 * Layout (fixed regions, top → bottom):
 *   ScrollView  a managed scroll viewport over the whole transcript (real
 *               scrollback: PageUp/PageDown, auto-stick to bottom, "▼ N new")
 *   Header      provider · model · auth · live token/cost meter · ⚙ N bg
 *   modal       permission / picker / tasks overlay (each owns its keys)
 *   input       autocomplete menu + queued chips + the prompt line + hints
 *
 * All keys funnel through ONE handler (below) so scrolling, tool-focus,
 * autocomplete, history recall, send-while-working and Esc-interrupt never
 * fight each other. The transcript is a single `Entry[]`; streaming mutates the
 * last assistant entry and the viewport re-windows — it never appends to stdout.
 *
 * Everything the App touches beyond the session is injected (models fetch, task
 * runner, session store, command history, credential resolver) so the whole
 * component is driveable under ink-testing-library with mocked I/O.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type {
  AuthMode,
  Credential,
  LoopEvent,
  ProviderId,
  RunInput,
  Session,
  SessionState,
} from '../types.js';
import { listProviders } from '../providers/index.js';
import { resolveAuth } from '../auth/index.js';
import { fetchModels as defaultFetchModels, clearModelCache } from '../models/index.js';
import type { TaskRunner, BgTask } from '../tasks/index.js';
import type { SessionStore, CommandHistory } from '../session/index.js';
import { Header } from './Header.js';
import { ScrollView } from './ScrollView.js';
import { AutocompleteMenu } from './AutocompleteMenu.js';
import { Picker, type PickerOption } from './Picker.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { TasksView } from './TasksView.js';
import { TuiPermissionGate, type PendingPermission } from './permission.js';
import { type Entry, type NoticeTone } from './entries.js';
import { isSlash, parseSlash, SLASH_COMMANDS } from './slash.js';
import { entriesToLines, toolIdsOf, type Line } from './lines.js';
import { computeCompletions, applyCompletion, type CompletionResult, type DirLister } from './autocomplete.js';
import { editLine, cursorSlices } from './edit.js';
import {
  initialScroll,
  reconcile,
  scrollLines,
  scrollPage,
  scrollToBottom,
  hasMoreBelow,
  parseWheel,
  type ScrollState,
} from './viewport.js';
import { messagesToEntries } from './transcript.js';
import { theme, SPINNER_FRAMES } from './theme.js';
import { createClipboard, type ClipboardWriter } from './clipboard.js';
import {
  copyRange,
  enterCopy,
  lastAssistantText,
  linesToText,
  moveCopy,
  revealRow,
  selectAll,
  toggleAnchor,
  toolBlockText,
  transcriptText,
  type CopyState,
} from './copy.js';
import { hitLabel, parseSkillHits } from './skillsSearch.js';
import {
  type Attachment,
  type FileAttachment,
  type FsLike,
  buildRunInput,
  chipLabel,
  isLargePaste,
  makePasteAttachment,
  parseDroppedPaths,
  readAttachment,
} from './attach.js';
import type { ContextManager } from '../context/index.js';
import { appendMemory, formatMemoryView } from '../memory/index.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePathJoin } from 'node:path';
import { homedir } from 'node:os';

export interface AppProps {
  session: Session;
  gate: TuiPermissionGate;
  tasks: TaskRunner;
  store: SessionStore;
  history: CommandHistory;
  /** Persisted session id we save into. */
  sessionId: string;
  /** Working directory (for `@`-path autocomplete, `/bg`, and session save). */
  cwd: string;
  initialPrompt?: string;
  /** Preloaded transcript (from `--continue` / `--resume`). */
  initialEntries?: Entry[];
  /** Open the `/resume` picker on launch (`--resume` with no id). */
  autoResume?: boolean;
  contextLimit?: number;
  /** Memory + compaction manager (from cli.ts) — powers `/memory` and the
   *  context meter. Optional so headless/tests work without it. */
  context?: ContextManager;
  /** Run a prompt as a foreground sub-agent (`/agent`). Wired by cli.ts. */
  runAgent?: (
    prompt: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<{ text: string; isError: boolean; errorMessage?: string }>;
  /** Run a workflow script that orchestrates sub-agents (`/workflow`). */
  runWorkflow?: (file: string) => Promise<unknown>;
  /** Render the MCP server/tool status for `/mcp` (from cli.ts + the hub). */
  mcpStatus?: () => string;
  /** Edit a loaded memory entry via find→replace (`/memory edit <old> => <new>`).
   *  Returns a human-readable result (e.g. the file path); throws on failure. */
  editMemory?: (find: string, replace: string) => Promise<string>;
  /** Add + connect an MCP server live and persist it (`/mcp add <spec>`).
   *  `spec` is the raw arg: inline JSON, or `name <command> [args…]` / `name <url>`. */
  mcpAdd?: (spec: string) => Promise<string>;
  /** Remove + disconnect an MCP server and drop it from config (`/mcp remove <name>`). */
  mcpRemove?: (name: string) => Promise<string>;
  /** Render the installed-skills list for `/skills` (from cli.ts + the skills registry). */
  skillsStatus?: () => string;
  /** Install a skill from GitHub/skills.sh into `.skills/` (`/skills add <owner/repo>`). */
  skillsAdd?: (ownerRepo: string) => Promise<string>;
  /** Search the skills.sh registry and list installable results (`/skills search <query>`). */
  skillsSearch?: (query: string) => Promise<string>;
  /** Remove an installed skill from `.skills/` (`/skills remove <name>`). */
  skillsRemove?: (name: string) => Promise<string>;
  // ── injectable I/O (tests) ──
  /** Clipboard sink for copy mode / `/copy` (OSC 52 + pbcopy by default). */
  copyToClipboard?: ClipboardWriter;
  fetchModels?: typeof defaultFetchModels;
  resolveCred?: (provider: ProviderId, mode: AuthMode) => Promise<Credential>;
  listDir?: DirLister;
  /** Filesystem used to read dropped attachments (injectable for tests). */
  attachFs?: FsLike;
  /** Terminal size overrides (tests). */
  cols?: number;
  rows?: number;
  /** Enter the alternate screen buffer (real TTY only). */
  fullscreen?: boolean;
  /** Where alt-screen / mouse-mode escapes go. Injectable so tests can assert
   *  exactly which modes we turn on (Ink's own stdout never sees these). */
  term?: TermWriter;
  /** Start with mouse capture on (wheel scroll) instead of off (drag-select). */
  mouseCapture?: boolean;
}

/** The bit of stdout the App drives directly for terminal modes. */
export interface TermWriter {
  write(s: string): unknown;
  isTTY?: boolean;
}

/** A message queued while a turn is running (may carry attachments). */
interface QueuedMsg {
  content: RunInput;
  /** Plain text for the queued-chip + transcript echo. */
  display: string;
  /** Attachment chip labels to echo alongside the text. */
  chips: string[];
}

/** Resolve a dropped path against cwd, expanding a leading `~`. */
function resolveDroppedPath(p: string, cwd: string): string {
  let x = p;
  if (x === '~' || x.startsWith('~/')) x = homedir() + x.slice(1);
  return isAbsolute(x) ? x : resolvePathJoin(cwd, x);
}

type PickerKind = 'model' | 'provider' | 'auth' | 'resume' | 'skill';
interface PickerState {
  kind: PickerKind;
  loading: boolean;
  options: PickerOption[];
  initialIndex: number;
}

/** Default clipboard sink — created once so every copy shares the same stdout. */
const defaultClipboard = createClipboard();

// ── mouse capture ──
// 1000 = report button press/release (this is what gives us the wheel), 1006 =
// SGR extended coordinates. There is no mouse mode that reports the wheel while
// leaving click-drag to the terminal: once ANY reporting mode is on, the
// terminal routes drags to us and native selection stops. 1002/1003 add motion
// tracking and are strictly worse (1003 defeats even the modifier bypass), so we
// never ask for them.
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

/** The selection hint — its own row, on screen in both states. Which mode owns
 *  the mouse decides whether a drag selects or scrolls, and "why can't I select?"
 *  has to be answerable from the screen alone. Sized to fit an 80-col row. */
export function mouseHint(on: boolean): string {
  return on
    ? 'mouse on — wheel scrolls · hold ⌥ and drag to select · Ctrl+G turns off'
    : 'mouse off — drag to select, ⌘C copies · PgUp/PgDn scroll · Ctrl+G wheel';
}

/** Keep a picker hint on one row. */
function shortHint(s: string, max = 52): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

const HELP_TEXT = SLASH_COMMANDS.map(
  (c) => `  /${c.name}${c.usage ? ' ' + c.usage : ''}  — ${c.description}`,
).join('\n');

/** Tools the model itself can call (mirrors slash capabilities). Shown in /help so
 *  users know the agent can also manage memory, tasks, context, and MCP on its own. */
const AGENT_TOOLS_HELP =
  'agent tools (the model can call these itself):\n' +
  '  memory      — view / add / edit persistent memory\n' +
  '  tasks       — list / kill background tasks\n' +
  '  compact     — summarize old turns to free context\n' +
  '  mcp_connect — configure + connect an MCP server live\n' +
  '  skill         — load a discovered skill (SKILL.md) into context on demand\n' +
  '  install_skill — add/search a skills.sh skill the agent needs';

/** Keys — kept to a handful of rows so /help still fits a short terminal. */
const KEYS_HELP =
  'keys:  PgUp/PgDn scroll · Esc interrupt/jump · Tab completion\n' +
  '       Ctrl+P/N focus a tool — →/Enter expand · ← collapse · y copies it\n' +
  'copy:  Ctrl+Space = COPY MODE — ↑/↓ or j/k move · v select · a all · y copy\n' +
  '       /copy [last|all|tool|mode] — OSC 52: works fullscreen AND over SSH\n' +
  'mouse: OFF by default — just drag to select, ⌘C/Ctrl+Shift+C to copy.\n' +
  '       Ctrl+G (or /mouse) turns capture ON for wheel-scroll; while ON the\n' +
  '       terminal owns no drags, so hold ⌥ (Option) and drag to select —\n' +
  '       works in Terminal.app and iTerm2. Shift-drag does the same on\n' +
  '       xterm/kitty. Ctrl+G again to get plain drag-select back.';

const defaultListDir: DirLister = (dir) => {
  return readdirSync(dir).map((name) => {
    try {
      return statSync(`${dir.replace(/\/$/, '')}/${name}`).isDirectory() ? name + '/' : name;
    } catch {
      return name;
    }
  });
};

export function App(props: AppProps): React.ReactElement {
  const {
    session,
    gate,
    tasks,
    store,
    history: cmdHistory,
    cwd,
    initialPrompt,
    initialEntries,
    contextLimit,
    context,
    runAgent,
    runWorkflow,
    mcpStatus,
    editMemory,
    mcpAdd,
    mcpRemove,
    skillsStatus,
    skillsAdd,
    skillsSearch,
    skillsRemove,
    copyToClipboard = defaultClipboard,
    fetchModels = defaultFetchModels,
    resolveCred = (p, m) => resolveAuth(p, m),
    listDir = defaultListDir,
    attachFs = { statSync, readFileSync },
    fullscreen = true,
    term: termOut = process.stdout,
    mouseCapture = false,
  } = props;
  const { exit } = useApp();
  const { stdin } = useStdin();

  // Enter the alternate screen synchronously on the FIRST render (a lazy state
  // initializer runs during render, before Ink paints). Doing this in a mount
  // effect instead — which runs after the first paint — left frame #1 on the
  // normal buffer, so the alt screen stayed blank until a keypress forced a
  // repaint. Exit is paired in the cleanup effect below.
  const altScreen = fullscreen && !!termOut.isTTY;
  useState(() => {
    if (altScreen) termOut.write('\x1b[?1049h\x1b[H');
    return null;
  });

  // Terminal size is state, not a one-shot read: SIGWINCH fires `resize` on
  // stdout and we re-lay-out the whole transcript at the new width (markdown
  // re-wraps, tables re-fit) instead of leaving rows sized for the old one.
  const [term, setTerm] = useState(() => ({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }));
  const sizePinned = props.cols !== undefined && props.rows !== undefined; // tests
  useEffect(() => {
    if (sizePinned) return;
    const onResize = () => {
      setTerm((t) => {
        const next = { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
        return next.cols === t.cols && next.rows === t.rows ? t : next;
      });
    };
    process.stdout.on('resize', onResize);
    onResize(); // catch a resize that landed before we subscribed
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, [sizePinned]);

  const cols = props.cols ?? term.cols;
  const rows = props.rows ?? term.rows;
  const width = Math.max(20, cols - 2);
  // Reserve rows for the header (3), input line, both hint rows (the second is
  // the mouse/selection state), and breathing room.
  const viewportHeight = Math.max(3, rows - 10);

  // ── core transcript + session state ──
  const [entries, setEntries] = useState<Entry[]>(
    initialEntries && initialEntries.length
      ? initialEntries
      : [{ kind: 'notice', tone: 'info', text: 'maya code — type a message, or /help. Drag to select text, ⌘C to copy · PgUp/PgDn scroll (Ctrl+G swaps to mouse-wheel) · Ctrl+P/N focus a tool call.' }],
  );
  const [snap, setSnap] = useState<SessionState>({ ...session.state });
  const [busy, setBusy] = useState(false);
  const [spin, setSpin] = useState(0);
  const [sessionId, setSessionId] = useState(props.sessionId);

  // ── input + autocomplete + history ──
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [acIndex, setAcIndex] = useState(0);
  const [acDismissed, setAcDismissed] = useState(false);
  const [histIdx, setHistIdx] = useState(-1);
  const [queued, setQueued] = useState<QueuedMsg[]>([]);
  const queuedRef = useRef<QueuedMsg[]>([]);

  // ── attachments (drag & paste) staged for the next submit ──
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // ── scroll + tool focus ──
  const [scroll, setScroll] = useState<ScrollState>(initialScroll);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const autoIdRef = useRef<string | null>(null);
  const manualRef = useRef<Set<string>>(new Set());
  // The last block the user focused, remembered AFTER focus exits: typing `/copy
  // tool` drops tool focus on the first keystroke, so without this the command
  // could never see the block it is named for.
  const lastToolRef = useRef<string | null>(null);

  // ── copy mode + mouse capture ──
  // Copy mode is NOT a modal: it runs inside the main key handler (below) so it
  // can move the same viewport the transcript already scrolls.
  const [copy, setCopy] = useState<CopyState | null>(null);
  // Off unless the caller asks otherwise — see the mouse-mode effect below. The
  // choice lives here for the whole session: nothing resets it but the user.
  const [mouseOn, setMouseOn] = useState(mouseCapture);

  // ── modals ──
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [yolo, setYolo] = useState(gate.autoAllow);
  const [confirmExit, setConfirmExit] = useState(false);

  // ── bg tasks ──
  const [bgTasks, setBgTasks] = useState<BgTask[]>(() => tasks.list());

  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

  const refreshSnap = useCallback(() => setSnap({ ...session.state }), [session]);
  const append = useCallback((e: Entry) => setEntries((c) => [...c, e]), []);
  const notice = useCallback(
    (tone: NoticeTone, text: string) => append({ kind: 'notice', tone, text }),
    [append],
  );

  // permission gate + bg-task subscriptions
  useEffect(() => gate.subscribe(setPending), [gate]);
  useEffect(() => tasks.onUpdate(() => setBgTasks(tasks.list())), [tasks]);

  // spinner
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(t);
  }, [busy]);

  // alternate screen — enter happens pre-paint (see the lazy initializer above);
  // this effect only restores the normal buffer on unmount.
  useEffect(() => {
    if (!altScreen) return;
    return () => {
      termOut.write('\x1b[?1049l');
    };
  }, [altScreen, termOut]);

  // Mouse reporting (real TTY only). Default is OFF: capture buys wheel-scroll
  // but costs plain drag-select, and being unable to select is the worse deal —
  // PgUp/PgDn still scroll, whereas nothing brings drag-select back except this.
  // Ctrl+G / `/mouse` opts into the wheel.
  //
  // When off we still write the disable escapes rather than doing nothing: a
  // previous run killed without cleanup leaves the terminal reporting mouse
  // events, and that stale mode eats drag-select in OUR window. Writing them
  // unconditionally makes the guarantee hold even after someone else's crash.
  useEffect(() => {
    if (!altScreen) return;
    if (!mouseOn) {
      termOut.write(MOUSE_OFF);
      return;
    }
    termOut.write(MOUSE_ON);
    return () => {
      termOut.write(MOUSE_OFF);
    };
  }, [altScreen, mouseOn, termOut]);

  // ── rendered line buffer + reconcile scroll on change ──
  const expandedForRender = useMemo(() => {
    const s = new Set(expanded);
    if (autoIdRef.current) s.add(autoIdRef.current);
    return s;
  }, [expanded]);

  const lines: Line[] = useMemo(
    () => entriesToLines(entries, { width, expandedToolIds: expandedForRender, selectedToolId: selectedTool ?? undefined }),
    [entries, width, expandedForRender, selectedTool],
  );

  useEffect(() => {
    setScroll((s) => reconcile(s, lines.length, viewportHeight));
  }, [lines.length, viewportHeight]);

  // mouse-wheel scroll: parse SGR wheel reports off raw stdin and move the
  // viewport a few lines per notch. Kept out of useInput (which never sees mouse
  // sequences) and read via refs so the listener subscribes once. Harmless when
  // mouse mode is off — no wheel bytes ever arrive.
  const scrollMetricsRef = useRef({ total: 0, height: 0 });
  scrollMetricsRef.current = { total: lines.length, height: viewportHeight };
  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      const delta = parseWheel(data.toString('utf8'));
      if (delta === 0) return;
      const { total, height } = scrollMetricsRef.current;
      setScroll((s) => scrollLines(s, delta, total, height));
    };
    stdin.on('data', onData);
    return () => { stdin.off('data', onData); };
  }, [stdin]);

  // ── autocomplete result ──
  const acResult: CompletionResult | null = useMemo(() => {
    if (acDismissed || !input) return null;
    return computeCompletions(input, cursor, { history: cmdHistory.all(), cwd, listDir });
  }, [input, cursor, acDismissed, cmdHistory, listDir, cwd]);
  const acOpen = !!acResult && acResult.items.length > 0;
  useEffect(() => setAcIndex(0), [input]);

  // ── apply one LoopEvent ──
  const applyEvent = useCallback((ev: LoopEvent) => {
    switch (ev.type) {
      case 'text_delta':
        setEntries((l) => {
          const last = l[l.length - 1];
          if (last && last.kind === 'assistant' && last.streaming) {
            return [...l.slice(0, -1), { ...last, text: last.text + ev.text }];
          }
          return [...l, { kind: 'assistant', text: ev.text, streaming: true }];
        });
        break;
      case 'tool_call':
        setEntries((l) => [...l, { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, done: false }]);
        // Auto-expand the newest; collapse the previous auto one (unless pinned).
        setExpanded((prev) => {
          const n = new Set(prev);
          const prevAuto = autoIdRef.current;
          if (prevAuto && !manualRef.current.has(prevAuto)) n.delete(prevAuto);
          autoIdRef.current = ev.id;
          return n;
        });
        break;
      case 'tool_result':
        setEntries((l) =>
          l.map((e) => (e.kind === 'tool' && e.id === ev.id ? { ...e, output: ev.output, isError: ev.isError ?? false, done: true } : e)),
        );
        break;
      case 'usage':
        refreshSnap();
        break;
      case 'compacted':
        append({ kind: 'notice', tone: 'warn', text: `compacted context: ${ev.before} → ${ev.after} tokens` });
        break;
      case 'error':
        append({ kind: 'notice', tone: 'error', text: ev.message });
        break;
      case 'turn_end':
        setEntries((l) => l.map((e) => (e.kind === 'assistant' ? { ...e, streaming: false } : e)));
        refreshSnap();
        break;
    }
  }, [append, refreshSnap]);

  // ── run one user turn (with queue drain + interrupt) ──
  const send = useCallback(
    async (content: RunInput) => {
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        for await (const ev of session.run(content, { signal: ac.signal })) applyEvent(ev);
      } catch (err) {
        append({ kind: 'notice', tone: 'error', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setEntries((l) => l.map((e) => (e.kind === 'assistant' ? { ...e, streaming: false } : e)));
        abortRef.current = null;
        setBusy(false);
        refreshSnap();
        void store.save({ id: sessionId, provider: session.state.provider, model: session.state.model, cwd, messages: [...session.messages] }).catch(() => {});
        // Drain the next queued message, if any.
        const next = queuedRef.current.shift();
        setQueued([...queuedRef.current]);
        if (next !== undefined) {
          append({ kind: 'user', text: next.display, ...(next.chips.length ? { attachments: next.chips } : {}) });
          void send(next.content);
        }
      }
    },
    [session, applyEvent, append, refreshSnap, store, sessionId, cwd],
  );

  // ── slash commands ──
  const applyModel = useCallback((model: string) => { session.setModel(model); refreshSnap(); notice('ok', `model → ${model}`); }, [session, refreshSnap, notice]);
  const applyProvider = useCallback((provider: string) => { void (async () => { try { await session.setProvider(provider); clearModelCache(); refreshSnap(); notice('ok', `provider → ${provider} (${session.state.model})`); } catch (err) { notice('error', `provider switch failed: ${err instanceof Error ? err.message : String(err)}`); } })(); }, [session, refreshSnap, notice]);
  const applyAuth = useCallback((mode: string) => { void (async () => { try { await session.setAuth(mode as AuthMode); clearModelCache(); refreshSnap(); notice('ok', `auth → ${mode} (${session.state.authSource})`); } catch (err) { notice('error', `auth switch failed: ${err instanceof Error ? err.message : String(err)}`); } })(); }, [session, refreshSnap, notice]);

  const openModelPicker = useCallback(() => {
    setPicker({ kind: 'model', loading: true, options: [], initialIndex: 0 });
    void (async () => {
      let opts: PickerOption[];
      let idx = 0;
      try {
        const cred = await resolveCred(session.state.provider, session.state.authMode);
        const { models, source } = await fetchModels(session.state.provider, cred, { force: true });
        opts = models.map((m) => ({ label: m.label ?? m.id, value: m.id, ...(m.id === session.state.model ? { hint: '(current)' } : {}) }));
        idx = Math.max(0, models.findIndex((m) => m.id === session.state.model));
        if (source === 'fallback') notice('warn', 'showing built-in model list (live fetch unavailable)');
      } catch (err) {
        opts = [{ label: session.state.model, value: session.state.model, hint: '(fetch failed)' }];
        notice('error', `model fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      setPicker((p) => (p && p.kind === 'model' ? { ...p, loading: false, options: opts, initialIndex: idx } : p));
    })();
  }, [session, resolveCred, fetchModels, notice]);

  const openResumePicker = useCallback(() => {
    setPicker({ kind: 'resume', loading: true, options: [], initialIndex: 0 });
    void (async () => {
      const summaries = await store.list();
      const opts: PickerOption[] = summaries.map((s) => ({ label: s.preview || '(empty)', value: s.id, hint: `${s.provider}/${s.model} · ${s.messageCount} msgs` }));
      setPicker((p) => (p && p.kind === 'resume' ? { ...p, loading: false, options: opts } : p));
    })();
  }, [store]);

  const doResume = useCallback((id: string) => {
    void (async () => {
      const rec = await store.load(id);
      if (!rec) { notice('error', `session ${id} not found`); return; }
      session.loadMessages(rec.messages);
      if (rec.provider !== session.state.provider) { try { await session.setProvider(rec.provider); } catch { /* keep current */ } }
      session.setModel(rec.model);
      setEntries([{ kind: 'notice', tone: 'ok', text: `resumed session ${id} (${rec.messages.length} messages)` }, ...messagesToEntries(rec.messages)]);
      setSessionId(id);
      manualRef.current = new Set();
      autoIdRef.current = null;
      lastToolRef.current = null;
      setSelectedTool(null);
      setCopy(null);
      setExpanded(new Set());
      setScroll(scrollToBottom(initialScroll, 0, viewportHeight));
      refreshSnap();
    })();
  }, [store, session, notice, refreshSnap, viewportHeight]);

  // ── copy: one sink, four ways in (copy mode, focused tool, /copy, select-all) ──
  const doCopy = useCallback(
    (text: string, what: string) => {
      if (!text.trim()) { notice('warn', `nothing to copy (${what})`); return; }
      void (async () => {
        try {
          const res = await copyToClipboard(text);
          const n = text.split('\n').length;
          if (res.ok) notice('ok', `copied ${n} line${n === 1 ? '' : 's'} — ${what}`);
          else notice('error', `copy failed: ${res.error ?? 'no clipboard sink available'}`);
        } catch (err) {
          notice('error', `copy failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    [copyToClipboard, notice],
  );

  const openCopyMode = useCallback(() => {
    if (lines.length === 0) { notice('info', 'nothing to copy yet'); return; }
    setCopy(enterCopy(scroll, lines.length, viewportHeight));
  }, [lines.length, scroll, viewportHeight, notice]);

  /** Hand the mouse to the app (wheel) or back to the terminal (drag-select).
   *  Shared by Ctrl+G and `/mouse` so the two can never disagree. */
  const toggleMouse = useCallback(() => {
    // Read `mouseOn` from the closure rather than a functional updater: `notice`
    // appends to the transcript, and a state updater must stay side-effect free
    // (React may run it more than once, which would double the notice).
    const next = !mouseOn;
    setMouseOn(next);
    notice(
      'ok',
      next
        ? 'mouse capture ON — wheel scrolls. To select text now, hold ⌥ (Option) and drag (Terminal.app/iTerm2; Shift-drag on xterm/kitty). Ctrl+G or /mouse to turn it back off.'
        : 'mouse capture OFF — drag to select and ⌘C to copy, like any terminal. PgUp/PgDn scroll. Ctrl+G or /mouse re-enables wheel-scroll.',
    );
  }, [mouseOn, notice]);

  /** Copy the tool block under Ctrl+P/N focus (falling back to the last one focused,
   *  then to the newest call) — from the ENTRY, so the copy carries the full output
   *  rather than the viewport's truncated preview. */
  const copyFocusedTool = useCallback(() => {
    const ids = toolIdsOf(entries);
    const id = selectedTool ?? lastToolRef.current ?? ids[ids.length - 1] ?? null;
    if (!id) { notice('info', 'no tool call to copy — Ctrl+P / Ctrl+N focuses one'); return; }
    doCopy(toolBlockText(entries, id), `tool ${id}`);
  }, [selectedTool, entries, doCopy, notice]);

  const installSkill = useCallback(
    (ref: string) => {
      if (!skillsAdd) { notice('error', 'installing skills is not wired in this session'); return; }
      notice('info', `installing skill ${ref}…`);
      void (async () => {
        try {
          const msg = await skillsAdd(ref);
          notice('ok', msg || `installed ${ref}`);
        } catch (err) {
          notice('error', `skills add failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    [skillsAdd, notice],
  );

  const handleSlash = useCallback((line: string) => {
    const parsed = parseSlash(line);
    if (!parsed) return;
    if ('unknown' in parsed) { notice('error', `unknown command /${parsed.unknown} — try /help`); return; }
    switch (parsed.name) {
      case 'help': notice('info', `commands:\n${HELP_TEXT}\n\n${AGENT_TOOLS_HELP}\n\n${KEYS_HELP}`); break;
      case 'quit': tasks.killAll(); void cmdHistory.flush(); exit(); break;
      case 'clear': session.clear(); setEntries([{ kind: 'notice', tone: 'ok', text: 'conversation cleared.' }]); manualRef.current = new Set(); autoIdRef.current = null; lastToolRef.current = null; setSelectedTool(null); setExpanded(new Set()); refreshSnap(); break;
      case 'yolo': { const next = !gate.autoAllow; gate.setAutoAllow(next); setYolo(next); notice('warn', next ? 'YOLO on — writes/bash auto-approved.' : 'YOLO off — writes/bash will prompt.'); break; }
      case 'model': if (parsed.arg) applyModel(parsed.arg); else openModelPicker(); break;
      case 'provider': if (parsed.arg) applyProvider(parsed.arg); else setPicker({ kind: 'provider', loading: false, options: providerOptions(), initialIndex: 0 }); break;
      case 'auth': if (parsed.arg) applyAuth(parsed.arg); else setPicker({ kind: 'auth', loading: false, options: [{ label: 'API key', value: 'api' }, { label: 'Subscription (OAuth)', value: 'subscription' }], initialIndex: 0 }); break;
      case 'resume': if (parsed.arg) doResume(parsed.arg); else openResumePicker(); break;
      case 'bg': {
        if (!parsed.arg) { notice('error', 'usage: /bg <command>'); break; }
        const t = tasks.start(parsed.arg, { cwd });
        notice('ok', `started ${t.id}: ${parsed.arg}`);
        break;
      }
      case 'tasks': setShowTasks(true); break;
      case 'compact':
        void (async () => {
          try {
            const r = await session.compact();
            notice(r ? 'ok' : 'info', r ? `compacted ${r.before} → ${r.after} tokens` : 'nothing to compact yet');
          } catch (err) {
            notice('error', `compaction failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          refreshSnap();
        })();
        break;
      case 'memory': {
        if (!context) { notice('info', 'memory is not loaded in this session'); break; }
        const arg = parsed.arg;
        if (arg.toLowerCase().startsWith('add ')) {
          const note = arg.slice(4).trim();
          if (!note) { notice('error', 'usage: /memory add <note>'); break; }
          void (async () => {
            try {
              await appendMemory('project', note, { cwd });
              await context.reload();
              notice('ok', 'saved to project memory (MAYAC.md)');
            } catch (err) {
              notice('error', `memory write failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        } else if (arg.toLowerCase().startsWith('edit')) {
          if (!editMemory) { notice('error', 'memory editing is not wired in this session'); break; }
          const rest = arg.slice(4).trim();
          const sep = rest.indexOf('=>');
          if (sep === -1) { notice('error', 'usage: /memory edit <old text> => <new text>'); break; }
          const find = rest.slice(0, sep).trim();
          const replace = rest.slice(sep + 2).trim();
          if (!find) { notice('error', 'usage: /memory edit <old text> => <new text>'); break; }
          void (async () => {
            try {
              const msg = await editMemory(find, replace);
              await context.reload();
              notice('ok', msg || 'memory updated');
            } catch (err) {
              notice('error', `memory edit failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        } else {
          notice('info', formatMemoryView(context.memory));
        }
        break;
      }
      case 'agent': {
        if (!parsed.arg) { notice('error', 'usage: /agent <prompt>'); break; }
        if (!runAgent) { notice('error', 'sub-agents are not wired in this session'); break; }
        notice('info', `↳ sub-agent: ${parsed.arg}`);
        void (async () => {
          try {
            const r = await runAgent(parsed.arg);
            notice(r.isError ? 'error' : 'ok', r.isError ? `sub-agent failed: ${r.errorMessage ?? ''}` : r.text);
          } catch (err) {
            notice('error', `sub-agent failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        break;
      }
      case 'workflow': {
        if (!parsed.arg) { notice('error', 'usage: /workflow <script.js>'); break; }
        if (!runWorkflow) { notice('error', 'workflow runner is not wired in this session'); break; }
        notice('info', `running workflow ${parsed.arg}…`);
        void (async () => {
          try {
            const res = await runWorkflow(parsed.arg);
            notice('ok', typeof res === 'string' ? res : JSON.stringify(res, null, 2));
          } catch (err) {
            notice('error', `workflow failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        break;
      }
      case 'mcp': {
        const arg = parsed.arg;
        if (arg.toLowerCase().startsWith('add')) {
          const spec = arg.slice(3).trim();
          if (!spec) { notice('error', 'usage: /mcp add <name> <command|url> [args…]  (or inline JSON)'); break; }
          if (!mcpAdd) { notice('error', 'adding MCP servers is not wired in this session'); break; }
          notice('info', `connecting MCP server…`);
          void (async () => {
            try {
              const msg = await mcpAdd(spec);
              notice('ok', msg || 'MCP server added');
            } catch (err) {
              notice('error', `mcp add failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        } else if (arg.toLowerCase().startsWith('remove') || arg.toLowerCase().startsWith('rm')) {
          const name = arg.replace(/^(remove|rm)\s*/i, '').trim();
          if (!name) { notice('error', 'usage: /mcp remove <name>'); break; }
          if (!mcpRemove) { notice('error', 'removing MCP servers is not wired in this session'); break; }
          void (async () => {
            try {
              const msg = await mcpRemove(name);
              notice('ok', msg || `removed MCP server "${name}"`);
            } catch (err) {
              notice('error', `mcp remove failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        } else {
          if (!mcpStatus) { notice('info', 'no MCP servers configured in this session'); break; }
          notice('info', mcpStatus());
        }
        break;
      }
      case 'skills': {
        const arg = parsed.arg;
        const lower = arg.toLowerCase();
        if (lower.startsWith('add')) {
          const spec = arg.slice(3).trim();
          if (!spec) { notice('error', 'usage: /skills add <owner/repo>'); break; }
          installSkill(spec);
        } else if (lower.startsWith('search')) {
          const query = arg.slice(6).trim();
          if (!query) { notice('error', 'usage: /skills search <query>'); break; }
          if (!skillsSearch) { notice('error', 'searching skills is not wired in this session'); break; }
          notice('info', `searching skills.sh for "${query}"…`);
          void (async () => {
            try {
              const msg = await skillsSearch(query);
              // The plain listing stays — it's how `/skills add <owner/repo>` is
              // discovered. On top of it, every hit we can parse an install ref
              // out of becomes a Picker row where Enter installs it directly.
              notice('info', msg || `no results for "${query}"`);
              const hits = parseSkillHits(msg ?? '');
              if (hits.length === 0) return;
              setPicker({
                kind: 'skill',
                loading: false,
                options: hits.map((h) => {
                  const { label, hint } = hitLabel(h);
                  return { label, value: h.ref, ...(hint ? { hint: shortHint(hint) } : {}) };
                }),
                initialIndex: 0,
              });
            } catch (err) {
              notice('error', `skills search failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        } else if (lower.startsWith('remove') || lower.startsWith('rm')) {
          const name = arg.replace(/^(remove|rm)\s*/i, '').trim();
          if (!name) { notice('error', 'usage: /skills remove <name>'); break; }
          if (!skillsRemove) { notice('error', 'removing skills is not wired in this session'); break; }
          void (async () => {
            try {
              const msg = await skillsRemove(name);
              notice('ok', msg || `removed skill "${name}"`);
            } catch (err) {
              notice('error', `skills remove failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        } else {
          if (!skillsStatus) { notice('info', 'no skills discovered in this session'); break; }
          notice('info', skillsStatus());
        }
        break;
      }
      case 'copy': {
        const what = parsed.arg.trim().toLowerCase();
        if (what === 'mode') { openCopyMode(); break; }
        if (what === 'tool') { copyFocusedTool(); break; }
        if (what === 'all' || what === 'transcript') { doCopy(transcriptText(entries), 'the transcript'); break; }
        if (what && what !== 'last') { notice('error', 'usage: /copy [last|all|tool|mode]'); break; }
        doCopy(lastAssistantText(entries), 'the last reply');
        break;
      }
      case 'mouse':
        toggleMouse();
        break;
    }
  }, [notice, exit, session, refreshSnap, gate, applyModel, applyProvider, applyAuth, openModelPicker, openResumePicker, doResume, tasks, cmdHistory, cwd, context, runAgent, runWorkflow, mcpStatus, editMemory, mcpAdd, mcpRemove, skillsStatus, installSkill, skillsSearch, skillsRemove, entries, doCopy, openCopyMode, copyFocusedTool, toggleMouse]);

  // ── submit / queue ──
  // `override` lets a caller submit a value other than the live input (e.g. the
  // key handler submits a just-accepted autocomplete completion, since the
  // `input` state hasn't updated yet within the same event).
  const submit = useCallback((override?: string) => {
    const text = (override ?? input).trim();
    const atts = attachments;
    setInput(''); setCursor(0); setHistIdx(-1); setAcDismissed(false);
    if (isSlash(text)) { setAttachments([]); handleSlash(text); return; }
    if (!text && atts.length === 0) return;
    const content = buildRunInput(text, atts);
    const chips = atts.map(chipLabel);
    setAttachments([]);
    if (text) cmdHistory.add(text);
    if (busy) {
      queuedRef.current.push({ content, display: text, chips });
      setQueued([...queuedRef.current]);
      return;
    }
    append({ kind: 'user', text, ...(chips.length ? { attachments: chips } : {}) });
    void send(content);
  }, [input, attachments, busy, handleSlash, cmdHistory, append, send]);

  // ── tool focus helpers ──
  const revealTool = useCallback((id: string) => {
    setScroll((s) => {
      const li = lines.findIndex((l) => l.toolHeader && l.toolId === id);
      if (li < 0) return s;
      if (li >= s.top && li < s.top + viewportHeight) return { ...s, stuck: false };
      const top = Math.max(0, Math.min(li - Math.floor(viewportHeight / 2), Math.max(0, lines.length - viewportHeight)));
      return { top, stuck: false };
    });
  }, [lines, viewportHeight]);

  const focusTool = useCallback((dir: -1 | 1) => {
    const ids = toolIdsOf(entries);
    if (ids.length === 0) { notice('info', 'no tool calls yet'); return; }
    const cur = selectedTool ? ids.indexOf(selectedTool) : -1;
    let next: number;
    if (cur === -1) next = dir === -1 ? ids.length - 1 : 0;
    else next = Math.max(0, Math.min(ids.length - 1, cur + dir));
    const id = ids[next]!;
    setSelectedTool(id);
    lastToolRef.current = id;
    revealTool(id);
  }, [entries, selectedTool, notice, revealTool]);

  const toggleExpandSelected = useCallback((want: boolean) => {
    if (!selectedTool) return;
    manualRef.current.add(selectedTool);
    setExpanded((prev) => {
      const n = new Set(prev);
      const isOpen = n.has(selectedTool) || autoIdRef.current === selectedTool;
      if (want && !isOpen) n.add(selectedTool);
      else if (!want) { n.delete(selectedTool); if (autoIdRef.current === selectedTool) autoIdRef.current = null; }
      else n.add(selectedTool);
      return n;
    });
  }, [selectedTool]);

  const acceptCompletion = useCallback(() => {
    if (!acResult) return;
    const item = acResult.items[acIndex];
    if (!item) return;
    const applied = applyCompletion(input, acResult, item);
    setInput(applied.value);
    setCursor(applied.cursor);
  }, [acResult, acIndex, input]);

  // ── auto-send initial prompt ──
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void cmdHistory.load();
    if (props.autoResume) openResumePicker();
    else if (initialPrompt && initialPrompt.trim()) {
      const text = initialPrompt.trim();
      cmdHistory.add(text);
      append({ kind: 'user', text });
      void send(text);
    }
  }, [initialPrompt, append, send, cmdHistory, props.autoResume, openResumePicker]);

  const modalActive = !!pending || !!picker || showTasks;

  // ── the single key handler ──
  useInput((ch, key) => {
    // Drop mouse-report bytes — the wheel listener handles scrolling; without
    // this guard Ink would insert the raw `[<64;…M` sequence into the prompt.
    if (ch && /\[<\d+;\d+;\d+[Mm]/.test(ch)) return;

    // ctrl+c → double-press exit
    if (key.ctrl && ch === 'c') {
      if (confirmExit) { tasks.killAll(); void cmdHistory.flush(); exit(); }
      else setConfirmExit(true);
      return;
    }
    if (confirmExit) setConfirmExit(false);

    // ── COPY MODE (tmux-style) ──
    // Owns every key while active, so nothing below can steal j/k/v/y. Movement
    // drags the cursor; the anchor (set with `v`) is what turns it into a range.
    if (copy) {
      const total = lines.length;
      const page = Math.max(1, viewportHeight - 1);
      const go = (delta: number) => {
        const next = moveCopy(copy, delta, total);
        setCopy(next);
        setScroll((s) => revealRow(s, next.cursor, total, viewportHeight));
      };
      if (key.escape) { setCopy(null); notice('info', 'copy mode: cancelled'); return; }
      if (key.return || ch === 'y') {
        const { from, to } = copyRange(copy);
        const text = linesToText(lines, from, to);
        const n = to - from + 1;
        setCopy(null);
        doCopy(text, `${n} line${n === 1 ? '' : 's'} of transcript`);
        return;
      }
      if (ch === 'v' || ch === ' ') { setCopy(toggleAnchor(copy)); return; }
      if (ch === 'a') { const all = selectAll(total); setCopy(all); setScroll((s) => revealRow(s, all.cursor, total, viewportHeight)); return; }
      if (key.upArrow || ch === 'k') { go(-1); return; }
      if (key.downArrow || ch === 'j') { go(1); return; }
      if (key.pageUp || (key.ctrl && ch === 'b')) { go(-page); return; }
      if (key.pageDown || (key.ctrl && ch === 'f')) { go(page); return; }
      if (ch === 'g') { go(-total); return; }
      if (ch === 'G') { go(total); return; }
      return; // swallow everything else — no stray typing into the prompt
    }

    // ctrl+space enters copy mode (Ink surfaces the NUL byte as ctrl + '`').
    if (key.ctrl && (ch === '`' || ch === ' ' || ch === '\0')) { openCopyMode(); return; }

    // ctrl+g hands the mouse back and forth. Deliberately a bare keybinding and
    // not just a slash command: when capture is eating your drags, the fix has to
    // be reachable without typing a line into a prompt you can't select out of.
    if (key.ctrl && ch === 'g') { toggleMouse(); return; }

    // ── paste / drag (Ink delivers a paste or dropped path as one multi-char
    // chunk). A dropped file path → attachment; a big multi-line paste → a
    // collapsed chip; a small paste → inserted verbatim (newlines preserved). ──
    if (ch && ch.length > 1 && !key.ctrl && !key.meta && !ch.includes('\x1b')) {
      // Anything landing in the prompt leaves tool focus — same as typing. Without
      // this, focus survived the paste and the next Enter expanded the focused
      // block instead of submitting what was just pasted.
      if (selectedTool) setSelectedTool(null);
      const paths = parseDroppedPaths(ch);
      const files = paths
        .map((p) => readAttachment(resolveDroppedPath(p, cwd), attachFs))
        .filter((a): a is FileAttachment => a !== null);
      if (files.length > 0) {
        setAttachments((a) => [...a, ...files]);
        notice('ok', `attached ${files.map((f) => f.name).join(', ')}`);
        return;
      }
      if (isLargePaste(ch)) {
        setAttachments((a) => [...a, makePasteAttachment(ch)]);
        return;
      }
      // small paste — insert at cursor, preserving any newlines
      setInput(input.slice(0, cursor) + ch + input.slice(cursor));
      setCursor(cursor + ch.length);
      setHistIdx(-1); setAcDismissed(false);
      return;
    }

    // scrolling (always available)
    if (key.pageUp) { setScroll((s) => scrollPage(s, -1, lines.length, viewportHeight)); return; }
    if (key.pageDown) { setScroll((s) => scrollPage(s, 1, lines.length, viewportHeight)); return; }

    // autocomplete menu navigation
    if (acOpen) {
      if (key.tab) { acceptCompletion(); return; }
      if (key.return) {
        // Enter on an open menu ACCEPTS the highlighted completion first — it
        // must never submit a half-typed token. A completed slash command is a
        // full command word, so it runs on this same Enter; file/history
        // completions just fill the token and keep the input open to compose.
        const item = acResult!.items[acIndex];
        if (item && acResult!.kind === 'slash') {
          submit(applyCompletion(input, acResult!, item).value);
        } else {
          acceptCompletion();
        }
        return;
      }
      if (key.upArrow) { setAcIndex((i) => (i - 1 + acResult!.items.length) % acResult!.items.length); return; }
      if (key.downArrow) { setAcIndex((i) => (i + 1) % acResult!.items.length); return; }
      if (key.escape) { setAcDismissed(true); return; }
    }

    // tool focus mode
    if (selectedTool) {
      if (ch === 'y' && !key.ctrl && !key.meta) { copyFocusedTool(); return; }
      // A prompt with text in it wins Enter — focus only owns Enter (= expand)
      // while the prompt is empty, so a half-typed message is never swallowed.
      if (key.return && input) { setSelectedTool(null); submit(); return; }
      if (key.upArrow) { focusTool(-1); return; }
      if (key.downArrow) { focusTool(1); return; }
      if (key.rightArrow || key.return) { toggleExpandSelected(true); return; }
      if (key.leftArrow) { toggleExpandSelected(false); return; }
      if (key.escape) { setSelectedTool(null); return; }
      // any printable key exits focus and falls through to editing
      if (!ch || key.ctrl || key.meta) return;
      setSelectedTool(null);
    }

    // enter tool focus
    if (key.ctrl && ch === 'p') { focusTool(-1); return; }
    if (key.ctrl && ch === 'n') { focusTool(1); return; }

    // escape: interrupt a running turn, else jump to bottom
    if (key.escape) {
      if (busy && abortRef.current) { abortRef.current.abort(); notice('warn', 'interrupted.'); }
      else setScroll((s) => scrollToBottom(s, lines.length, viewportHeight));
      return;
    }

    // newline vs submit: Shift/Alt+Enter, or a line ending in a backslash,
    // inserts a newline (multiline prompt); a plain Enter submits.
    if (key.return) {
      if (key.shift || key.meta) {
        setInput(input.slice(0, cursor) + '\n' + input.slice(cursor));
        setCursor(cursor + 1); setHistIdx(-1); setAcDismissed(false);
        return;
      }
      if (input.slice(0, cursor).endsWith('\\')) {
        // trailing backslash → newline continuation (works in every terminal)
        setInput(input.slice(0, cursor - 1) + '\n' + input.slice(cursor));
        setHistIdx(-1); setAcDismissed(false);
        return;
      }
      submit();
      return;
    }

    // history recall (menu closed, not focused)
    if (key.upArrow) {
      const all = cmdHistory.all();
      if (all.length === 0) return;
      const next = histIdx < 0 ? all.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next); const v = all[next] ?? ''; setInput(v); setCursor(v.length); setAcDismissed(true);
      return;
    }
    if (key.downArrow) {
      if (histIdx < 0) return;
      const all = cmdHistory.all();
      const next = histIdx + 1;
      if (next >= all.length) { setHistIdx(-1); setInput(''); setCursor(0); }
      else { setHistIdx(next); const v = all[next] ?? ''; setInput(v); setCursor(v.length); }
      return;
    }

    // backspace on an empty prompt removes the last staged attachment
    if ((key.backspace || key.delete) && !input && attachments.length > 0) {
      setAttachments((a) => a.slice(0, -1));
      return;
    }

    // line editing
    const edited = editLine({ value: input, cursor }, ch, key);
    if (edited) { setInput(edited.value); setCursor(edited.cursor); setHistIdx(-1); setAcDismissed(false); }
  }, { isActive: !modalActive });

  // ── render ──
  const below = hasMoreBelow(scroll, lines.length, viewportHeight);
  const { before, at, after } = cursorSlices(input, cursor);
  const bgCount = bgTasks.filter((t) => t.status === 'running').length;

  const selection = copy ? copyRange(copy) : undefined;

  return (
    <Box flexDirection="column" width={cols}>
      <ScrollView
        lines={lines}
        height={viewportHeight}
        scroll={scroll}
        selection={selection}
        cursorRow={copy ? copy.cursor : undefined}
      />

      <Box marginTop={1}>
        <Header state={snap} {...(contextLimit ? { contextLimit } : {})} yolo={yolo} bgCount={bgCount} />
      </Box>

      {pending ? (
        <PermissionPrompt pending={pending} onAlwaysAllow={() => { gate.setAutoAllow(true); setYolo(true); }} active />
      ) : showTasks ? (
        <TasksView tasks={bgTasks} onKill={(id) => tasks.kill(id)} onClose={() => setShowTasks(false)} active />
      ) : picker ? (
        picker.loading ? (
          <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
            <Text color={theme.accent}>{SPINNER_FRAMES[spin]} </Text>
            <Text color={theme.muted}>{picker.kind === 'model' ? 'fetching models…' : 'loading…'}</Text>
          </Box>
        ) : (
          <Picker
            title={pickerTitle(picker.kind)}
            options={picker.options}
            initialIndex={picker.initialIndex}
            {...(picker.kind === 'skill' ? { footer: '↑/↓ move · enter INSTALLS the highlighted skill · esc dismiss' } : {})}
            onSelect={(v) => { const kind = picker.kind; setPicker(null); if (kind === 'model') applyModel(v); else if (kind === 'provider') applyProvider(v); else if (kind === 'auth') applyAuth(v); else if (kind === 'resume') doResume(v); else if (kind === 'skill') installSkill(v); }}
            onCancel={() => setPicker(null)}
          />
        )
      ) : copy ? (
        <Box flexDirection="column">
          <Text color={theme.warn} bold>
            <Text inverse> COPY MODE </Text>
            <Text color={theme.muted}>
              {' '}
              {copy.anchor === null
                ? `row ${copy.cursor + 1}/${lines.length} — press v to start a selection`
                : `${selection!.to - selection!.from + 1} rows selected`}
            </Text>
          </Text>
          <Text color={theme.muted}>↑/↓ or j/k move · PgUp/PgDn page · g/G top/bottom · v select · a all · y/enter copy · esc cancel</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {acOpen ? <AutocompleteMenu result={acResult!} index={acIndex} /> : null}
          {attachments.length ? (
            <Box flexDirection="column">
              {attachments.map((a, i) => (
                <Text key={i} color={theme.accent}>{chipLabel(a)}<Text color={theme.muted} dimColor>  ⌫ to remove</Text></Text>
              ))}
            </Box>
          ) : null}
          {queued.length ? (
            <Box>
              <Text color={theme.muted}>queued: </Text>
              {queued.map((q, i) => {
                const label = q.display || (q.chips.length ? q.chips.join(', ') : '(attachment)');
                return <Text key={i} color={theme.warn}>[{label.length > 24 ? label.slice(0, 23) + '…' : label}] </Text>;
              })}
            </Box>
          ) : null}
          {selectedTool ? (
            <Text color={theme.accent}>◆ tool focus: {selectedTool} — →/Enter expand · ← collapse · ↑/↓ move · y copy · Esc exit</Text>
          ) : null}
          <Box>
            <Text color={theme.accent}>{busy ? `${SPINNER_FRAMES[spin]} ` : '› '}</Text>
            <Text>
              {before}
              <Text inverse>{at}</Text>
              {after}
              {input.length === 0 ? <Text color={theme.muted}>{busy ? 'working… (type to queue · Esc to interrupt)' : 'ask, or /help'}</Text> : null}
            </Text>
          </Box>
          <Text color={theme.muted}>
            {confirmExit ? 'press ctrl+c again to exit' : below ? '▼ new output below — PgDn/Esc to jump' : busy ? 'streaming — Esc interrupts · type to queue' : '/help · PgUp/PgDn scroll · Ctrl+P focus tool · Ctrl+Space copy mode · /copy last reply · ctrl+c exit'}
          </Text>
          {/* Its own row: the selection story has to be readable at a glance in
              every state, not only when the hint above happens to be idle. */}
          <Text color={theme.muted}>{mouseHint(mouseOn)}</Text>
        </Box>
      )}
    </Box>
  );
}

function pickerTitle(kind: PickerKind): string {
  return kind === 'model'
    ? 'Select model'
    : kind === 'provider'
      ? 'Select provider'
      : kind === 'auth'
        ? 'Select auth mode'
        : kind === 'skill'
          ? 'Install a skill'
          : 'Resume session';
}

function providerOptions(): PickerOption[] {
  return listProviders().map((p) => ({ label: p.id, value: p.id, hint: `(${p.models.length} models)` }));
}
