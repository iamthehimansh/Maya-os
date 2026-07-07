/**
 * Maya contract: the Loop protocol (Layer 5–6). Owner: agent plane (01).
 *
 * The Loop Agent (interim team lead) coordinates worker agents over the bus.
 * These are the ONLY structured bodies loop participants exchange; they travel
 * inside walkie-talkie message frames as `body.maya` (see bus.ts). Plain-text
 * chatter without `body.maya` is allowed but carries no protocol meaning.
 *
 * v1 kinds (final, reconciled 01+02 drafts):
 *   task_assign / task_accept / task_progress / task_done / task_failed /
 *   question / answer / artifact
 */

export type LoopRole = 'lead' | 'worker' | 'human';

export interface ArtifactRef {
  id: string;
  kind: 'file' | 'diff' | 'url' | 'report';
  path?: string;
  url?: string;
  title: string;
}

export type LoopBody =
  | TaskAssign
  | TaskAccept
  | TaskProgress
  | TaskDone
  | TaskFailed
  | Question
  | Answer
  | ArtifactMsg;

/** lead → worker. One unit of delegated work. */
export interface TaskAssign {
  kind: 'task_assign';
  taskId: string;
  /** What to do, self-contained (worker may have no other context). */
  spec: string;
  /** Task ids that must be done first — the lead schedules around these. */
  deps?: string[];
  /** Files/dirs this task may touch — leads use this to parallelize safely. */
  scope?: string[];
  /** Definition of done the lead will verify against. */
  acceptance?: string;
  deadlineTs?: number; // epoch ms, advisory
}

/**
 * worker → lead. Explicit claim: until the lead sees this, the task is
 * unowned and may be reassigned (crash-safe delegation).
 */
export interface TaskAccept {
  kind: 'task_accept';
  taskId: string;
}

/** worker → lead. Sent at meaningful checkpoints, not on a timer. */
export interface TaskProgress {
  kind: 'task_progress';
  taskId: string;
  note: string;
  /** 0–100 best-effort estimate; omit if meaningless. */
  pct?: number;
}

/** worker → lead. Terminal: success. */
export interface TaskDone {
  kind: 'task_done';
  taskId: string;
  summary: string;
  artifacts?: ArtifactRef[];
}

/** worker → lead. Terminal: failure. Lead decides retry/reassign/escalate. */
export interface TaskFailed {
  kind: 'task_failed';
  taskId: string;
  error: string;
  retryable: boolean;
}

/**
 * worker → lead, or lead → human. Escalation is the EXCEPTION: the lead
 * answers what it can and only forwards to the human what genuinely needs
 * an owner decision (that is the product's core promise).
 */
export interface Question {
  kind: 'question';
  qid: string;
  taskId?: string;      // omitted when the lead asks a project-level question
  prompt: string;
  /** Optional discrete options (dashboard renders as buttons). */
  options?: Array<{ id: string; label: string }>;
}

/** Answer to a Question, matched by qid. */
export interface Answer {
  kind: 'answer';
  qid: string;
  /** Either a chosen option id or free text. */
  optionId?: string;
  text?: string;
}

/** Standalone artifact announcement outside a task lifecycle (rare). */
export interface ArtifactMsg {
  kind: 'artifact';
  ref: ArtifactRef;
}
