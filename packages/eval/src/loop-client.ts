/**
 * HttpLoopRunner — drives the REAL Loop over the orchestrator's HTTP surface
 * (POST /api/loop, poll /api/runs). This is exactly the path `maya loop` and
 * the dashboard use, so the eval measures the shipping loop, not a stub.
 *
 * The runner returns ONLY what the loop reported (outcome + tokens); the
 * ground-truth judgement is the scorer's job against the workspace on disk —
 * the two are kept strictly separate so the eval can catch the loop lying.
 */

import type { ReportedOutcome } from './scorer.js';

export interface LoopRunInput {
  goal: string;
  /** Workspace dir the run writes into and is verified against. */
  cwd: string;
  leadModel: string;
  workerModel?: string;
  workerAdapter?: string;
  cldzProfile?: string;
  allowedTools?: string[];
  maxTurns?: number;
  tokenBudget?: number;
}

export interface LoopRunResult {
  reported: ReportedOutcome;
  tokensUsed?: number;
  runId?: string;
  summary?: string;
  /** Set when the run could not be driven to a report (transport/timeout). */
  error?: string;
}

/** A pluggable "run this goal in this workspace" function. Tests inject a fake. */
export type LoopRunner = (input: LoopRunInput) => Promise<LoopRunResult>;

export interface HttpLoopRunnerOptions {
  /** Orchestrator base URL, e.g. http://127.0.0.1:4400 */
  orchestratorUrl: string;
  /** Admin bearer for POST /api/loop when the service requires one. */
  adminToken?: string;
  /** Poll cadence while a run is in flight. Default 2000ms. */
  pollMs?: number;
  /** Give up on a single run after this long. Default 10 min. */
  runTimeoutMs?: number;
}

interface RunRecordLite {
  runId: string;
  state: 'running' | 'done';
  report?: { outcome?: string; summary?: string; team?: { tokensUsed?: number } | null };
}

function normalizeOutcome(o: string | undefined): ReportedOutcome {
  return o === 'success' || o === 'partial' || o === 'failed' ? o : 'error';
}

/** Build an HTTP-backed LoopRunner bound to a running orchestrator service. */
export class HttpLoopRunner {
  constructor(private readonly opts: HttpLoopRunnerOptions) {}

  /** Fail fast with a clear message if the orchestrator isn't reachable. */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base()}/api/orchestrator/health`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  readonly run: LoopRunner = async (input) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.adminToken) headers.authorization = `Bearer ${this.opts.adminToken}`;
    const body = {
      goal: input.goal,
      cwd: input.cwd,
      leadModel: input.leadModel,
      ...(input.workerModel !== undefined ? { workerModel: input.workerModel } : {}),
      ...(input.workerAdapter !== undefined ? { workerAdapter: input.workerAdapter } : {}),
      ...(input.cldzProfile !== undefined ? { cldzProfile: input.cldzProfile } : {}),
      ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    };
    let runId: string;
    try {
      const res = await fetch(`${this.base()}/api/loop`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) return { reported: 'error', error: `POST /api/loop → HTTP ${res.status} ${(await res.text()).slice(0, 160)}` };
      const j = (await res.json()) as { runId?: string };
      if (!j.runId) return { reported: 'error', error: 'POST /api/loop returned no runId' };
      runId = j.runId;
    } catch (err) {
      return { reported: 'error', error: `POST /api/loop failed: ${String(err).slice(0, 160)}` };
    }
    return this.poll(runId);
  };

  private async poll(runId: string): Promise<LoopRunResult> {
    const pollMs = this.opts.pollMs ?? 2000;
    const deadline = Date.now() + (this.opts.runTimeoutMs ?? 600_000);
    for (;;) {
      if (Date.now() > deadline) return { reported: 'error', runId, error: 'run timed out (never reported)' };
      await new Promise((r) => setTimeout(r, pollMs));
      let runs: RunRecordLite[];
      try {
        const res = await fetch(`${this.base()}/api/runs`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue; // transient — keep polling until the deadline
        runs = (await res.json()) as RunRecordLite[];
      } catch {
        continue;
      }
      const rec = runs.find((r) => r.runId === runId);
      if (!rec || rec.state !== 'done') continue;
      const outcome = normalizeOutcome(rec.report?.outcome);
      return {
        reported: outcome,
        runId,
        ...(rec.report?.team?.tokensUsed !== undefined ? { tokensUsed: rec.report.team.tokensUsed } : {}),
        ...(rec.report?.summary !== undefined ? { summary: rec.report.summary } : {}),
      };
    }
  }

  private base(): string {
    return this.opts.orchestratorUrl.replace(/\/$/, '');
  }
}
