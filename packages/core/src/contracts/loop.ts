/**
 * Maya contract: the Loop protocol (Layer 5–6).
 *
 * The Loop Agent (interim team lead) coordinates worker agents over the bus.
 * These are the ONLY message kinds loop participants exchange; they travel
 * as walkie-talkie message bodies (body.maya.kind = one of these).
 *
 * Kinds are exactly the five agreed in the contract freeze:
 * task_assign / progress / done / question / answer.
 */

export type LoopRole = 'lead' | 'worker' | 'human';

export interface LoopEnvelope<K extends LoopMessage['kind'] = LoopMessage['kind']> {
  /** Protocol marker + version. Non-maya bus traffic simply lacks this. */
  maya: { v: 1; kind: K };
}

export type LoopMessage =
  | TaskAssign
  | Progress
  | Done
  | Question
  | Answer;

/** lead → worker. One unit of delegated work. */
export interface TaskAssign {
  kind: 'task_assign';
  taskId: string;
  /** What to do, self-contained (worker may have no other context). */
  spec: string;
  /** Files/dirs this task may touch — leads use this to parallelize safely. */
  scope?: string[];
  /** Definition of done the lead will verify against. */
  acceptance?: string;
  deadline?: string; // ISO 8601, advisory
}

/** worker → lead. Sent at meaningful checkpoints, not on a timer. */
export interface Progress {
  kind: 'progress';
  taskId: string;
  note: string;
  /** 0–100 best-effort estimate; omit if meaningless. */
  percent?: number;
}

/** worker → lead. Terminal for the task — success OR failure (see ok). */
export interface Done {
  kind: 'done';
  taskId: string;
  ok: boolean;
  summary: string;
  /** Paths of produced/modified artifacts, if any. */
  artifacts?: string[];
  /** Set when ok=false: what failed + whether retry is sensible. */
  failure?: { reason: string; retryable: boolean };
}

/**
 * worker → lead, or lead → human. Escalation is the EXCEPTION: the lead
 * answers what it can and only forwards to the human what genuinely needs
 * an owner decision (that is the product's core promise).
 */
export interface Question {
  kind: 'question';
  taskId?: string;      // omitted when the lead asks the human a project-level q
  questionId: string;
  text: string;
  /** Optional discrete options (dashboard renders as buttons). */
  options?: Array<{ id: string; label: string }>;
}

/** Answer to a Question, matched by questionId. */
export interface Answer {
  kind: 'answer';
  questionId: string;
  /** Either a chosen option id or free text. */
  optionId?: string;
  text?: string;
}
