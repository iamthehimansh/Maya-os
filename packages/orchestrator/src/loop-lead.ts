/**
 * LoopLead — Phase 7, the differentiator.
 *
 * A deterministic run loop; the LLM is consulted ONLY at judgment points
 * (decompose, verify) and both are pluggable functions, so tests inject
 * deterministic ones and production wires them to Maya's own gateway
 * (llm.ts — dogfooding).
 *
 *   run(goal): decompose → seed board → dispatch/settle (TeamManager)
 *              → verify each done task → rework or accept
 *              → final report (ALWAYS produced, even on failure/abort)
 *
 * Escalation discipline: the lead only asks the human when a decomposition
 * genuinely needs an owner decision (`clarification` in the plan). Questions
 * post to the team channel as loop `question` frames with options; the run
 * blocks on the answer with a deadline. ≤1 question per run is the design
 * target measured in the demo.
 */

import type { LoopBody, MayaDb, TaskRow, TeamRow } from '@maya-ai/core';
import { BusClient } from '@maya-ai/bus-client';
import type { CreateTeamInput, TeamManager } from './team-manager.js';

export interface PlannedTask {
  spec: string;
  /** Indexes into the plan array (converted to task-id deps on seeding). */
  deps?: number[];
  scope?: string[];
  acceptance?: string;
}

export interface Plan {
  tasks: PlannedTask[];
  /** Set when the goal is too ambiguous to decompose without the owner. */
  clarification?: { prompt: string; options: string[] };
}

export type Planner = (goal: string, context: { answer?: string }) => Promise<Plan>;
export type Verifier = (task: TaskRow) => Promise<{ ok: boolean; feedback?: string }>;

export interface LoopLeadOptions {
  db: MayaDb;
  teams: TeamManager;
  team: Omit<CreateTeamInput, 'name'>;
  planner: Planner;
  verifier: Verifier;
  bus: { wsBase: string; adminToken: string; httpBase?: string };
  /** Max rework rounds per task after failed verification. Default 1. */
  maxRework?: number;
  /** How long to wait for a human answer before proceeding with a default. */
  questionTimeoutMs?: number;
  /**
   * Goal-level acceptance: a final check that the GOAL is actually met, run
   * after per-task verification. It exists because weak planners paraphrase
   * the goal into task specs that drop hard requirements (02's capstone: goal
   * demanded exact content `Maya M3 demo complete`, the plan lost it, per-task
   * gates had nothing to match, the run "succeeded" with wrong content).
   * Returns the unmet requirements; when non-empty the lead queues one
   * explicit fix task naming them verbatim, re-checks, and downgrades the
   * outcome to `partial` if still unmet. Injectable; the default checks a
   * workspace dir for the goal's required filenames + exact content.
   */
  goalCheck?: (goal: string) => Promise<{ met: boolean; missing: string[]; fixInstruction?: string }>;
  /** Max goal-fix rounds after per-task verification. Default 2. */
  maxGoalFix?: number;
}

export interface LoopReport {
  runId: string;
  goal: string;
  team: TeamRow;
  outcome: 'success' | 'partial' | 'failed';
  tasks: Array<{ id: string; spec: string; state: string; verified: boolean; result: string | null }>;
  questionsAsked: number;
  summary: string;
}

export class LoopLead {
  constructor(private readonly opts: LoopLeadOptions) {}

  async run(goal: string, opts?: { name?: string }): Promise<LoopReport> {
    const runId = 'run_' + Date.now().toString(36);
    const team = await this.opts.teams.createTeam({
      name: opts?.name ?? `loop-${runId}`,
      ...this.opts.team,
    });
    let questionsAsked = 0;

    // The lead speaks on the team channel with its own identity.
    const lead = await this.joinChannel(team);

    const finish = async (outcome: LoopReport['outcome'], summary: string, verified: Set<string>): Promise<LoopReport> => {
      const tasks = this.opts.db.tasks(team.id).map((t) => ({
        id: t.id,
        spec: t.spec,
        state: t.state,
        verified: verified.has(t.id),
        result: t.result,
      }));
      lead.sendMessage({ body: { text: `🏁 loop ${runId}: **${outcome}** — ${summary}` } });
      lead.close();
      return { runId, goal, team, outcome, tasks, questionsAsked, summary };
    };

    try {
      // 1. Decompose (judgment point #1) — one clarification round allowed.
      let plan = await this.opts.planner(goal, {});
      if (plan.clarification) {
        questionsAsked += 1;
        const answer = await this.ask(lead, plan.clarification);
        plan = await this.opts.planner(goal, { answer });
        if (plan.clarification) {
          // Never nag: proceed with the first option instead of asking again.
          plan = await this.opts.planner(goal, { answer: plan.clarification.options[0] ?? 'proceed sensibly' });
        }
      }
      if (plan.tasks.length === 0) return await finish('failed', 'planner produced no tasks', new Set());
      lead.sendMessage({ body: { text: `🧠 plan: ${plan.tasks.length} task(s) for "${goal.slice(0, 80)}"` } });

      // 2. Seed the board (plan-index deps → task-id deps).
      const ids: string[] = [];
      for (const p of plan.tasks) {
        // Lenient ingestion: small-model plans emit forward/self/out-of-range
        // dep indexes — drop the bad ones (a dropped dep at worst serializes
        // less) rather than failing the whole run.
        const deps = (p.deps ?? [])
          .filter((i) => Number.isInteger(i) && i >= 0 && i < ids.length)
          .map((i) => ids[i] as string);
        const task = this.opts.teams.addTask(team.id, p.spec, {
          deps,
          ...(p.scope !== undefined ? { scope: p.scope } : {}),
        });
        ids.push(task.id);
      }
      const acceptance = new Map(ids.map((id, i) => [id, plan.tasks[i]?.acceptance]));

      // 3–5. Dispatch, verify each done task, rework bounded times.
      const verified = new Set<string>();
      /** Originals replaced by a rework task — never re-verified. */
      const superseded = new Set<string>();
      const reworked = new Map<string, number>();
      const maxRework = this.opts.maxRework ?? 1;

      for (;;) {
        await this.opts.teams.settle(team.id);
        const done = this.opts.db.tasks(team.id, 'done').filter((t) => !verified.has(t.id) && !superseded.has(t.id));
        if (done.length === 0) break;

        let anyRework = false;
        for (const task of done) {
          const verdict = await this.opts.verifier(task); // judgment point #2
          if (verdict.ok) {
            verified.add(task.id);
            continue;
          }
          const rounds = reworked.get(task.id) ?? 0;
          if (rounds >= maxRework) {
            verified.add(task.id); // stop churning; report the doubt honestly below
            lead.sendMessage({ body: { text: `⚠️ ${task.id} kept after ${rounds} rework round(s); verifier still doubtful: ${verdict.feedback ?? ''}`.slice(0, 300) } });
            continue;
          }
          reworked.set(task.id, rounds + 1);
          superseded.add(task.id);
          anyRework = true;
          const spec = `${task.spec}\n\nREWORK (round ${rounds + 1}): the previous attempt was rejected — ${verdict.feedback ?? 'does not meet acceptance'}.${acceptance.get(task.id) ? `\nAcceptance: ${acceptance.get(task.id)}` : ''}`;
          const rework = this.opts.teams.addTask(team.id, spec, { scope: task.scope });
          reworked.set(rework.id, rounds + 1); // the replacement inherits the round count
          lead.sendMessage({ body: { text: `🔧 rework queued for ${task.id}: ${verdict.feedback?.slice(0, 160) ?? ''}` } });
        }
        if (!anyRework) break;
      }

      // 5b. Goal-level acceptance — the GOAL, not just the paraphrased tasks.
      // A weak planner drops hard requirements; workers write templates instead
      // of literals. Loop up to `maxGoalFix` rounds: each queues a CRYSTAL-clear
      // imperative fix task (goalCheck.fixInstruction) so even a small worker
      // can comply, then re-checks the goal against reality.
      let goalMissing: string[] = [];
      if (this.opts.goalCheck) {
        const maxGoalFix = this.opts.maxGoalFix ?? 2;
        let check = await this.opts.goalCheck(goal);
        for (let round = 0; !check.met && round < maxGoalFix; round++) {
          lead.sendMessage({ body: { text: `🎯 goal not yet met (round ${round + 1}/${maxGoalFix}) — missing: ${check.missing.join(', ')}`.slice(0, 300) } });
          const fixSpec =
            check.fixInstruction ??
            `The goal is NOT satisfied. Do EXACTLY this and nothing else:\n${goal}\nStill missing/wrong — fix precisely: ${check.missing.join('; ')}`;
          this.opts.teams.addTask(team.id, fixSpec);
          await this.opts.teams.settle(team.id);
          for (const t of this.opts.db.tasks(team.id, 'done').filter((x) => !verified.has(x.id) && !superseded.has(x.id))) {
            const v = await this.opts.verifier(t);
            if (v.ok) verified.add(t.id);
          }
          check = await this.opts.goalCheck(goal);
        }
        goalMissing = check.met ? [] : check.missing;
      }

      // 6. Report.
      const all = this.opts.db.tasks(team.id);
      const failed = all.filter((t) => t.state === 'failed');
      const tasksOk = failed.length === 0;
      const goalOk = goalMissing.length === 0;
      const outcome: LoopReport['outcome'] = tasksOk && goalOk ? 'success' : failed.length < all.length || goalMissing.length > 0 ? 'partial' : 'failed';
      const summary = goalOk
        ? tasksOk
          ? `${all.length} task(s) completed and verified (${questionsAsked} question(s) asked)`
          : `${all.length - failed.length}/${all.length} tasks completed; failed: ${failed.map((t) => t.id).join(', ')}`
        : `goal NOT fully met — still missing: ${goalMissing.join(', ')}`;
      return await finish(outcome, summary, verified);
    } catch (err) {
      return await finish('failed', `lead error: ${String(err).slice(0, 300)}`, new Set());
    } finally {
      // Team teardown: drain if anything is still live (idempotent).
      await this.opts.teams.drain(team.id, 'loop run complete').catch(() => {});
    }
  }

  // ── channel plumbing ───────────────────────────────────────────────────

  private async joinChannel(team: TeamRow): Promise<BusClient> {
    const httpBase = (this.opts.bus.httpBase ?? this.opts.bus.wsBase.replace(/^ws/, 'http')).replace(/\/$/, '');
    const res = await fetch(`${httpBase}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.bus.adminToken}` },
      body: JSON.stringify({ label: 'lead', role: 'admin', caps: ['receive', 'send'], scopes: [team.channelId] }),
    });
    if (!res.ok) throw new Error(`lead token mint failed: HTTP ${res.status}`);
    const minted = (await res.json()) as { token: string };
    const lead = new BusClient({ wsBase: this.opts.bus.wsBase, channelId: team.channelId, token: minted.token });
    const joined = new Promise<void>((r) => lead.on('joined', () => r()));
    lead.connect();
    await joined;
    return lead;
  }

  /**
   * Escalate ONE question to the human on the channel (clickable options via
   * the loop protocol); resolve on the first `answer` with our qid, or fall
   * back to the first option at the deadline — a stuck run helps nobody.
   */
  private async ask(lead: BusClient, q: { prompt: string; options: string[] }): Promise<string> {
    const qid = 'q_' + Date.now().toString(36);
    const body: LoopBody = {
      kind: 'question',
      qid,
      prompt: q.prompt,
      options: q.options.map((label, i) => ({ id: String(i), label })),
    };
    lead.sendMessage({ body: { text: `❓ **owner decision needed:** ${q.prompt}\n${q.options.map((o, i) => `${i}. ${o}`).join('\n')}`, maya: body } });

    const timeoutMs = this.opts.questionTimeoutMs ?? 300_000;
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        lead.sendMessage({ body: { text: `⏱️ no answer in ${Math.round(timeoutMs / 1000)}s — proceeding with: ${q.options[0] ?? 'default'}` } });
        resolve(q.options[0] ?? '');
      }, timeoutMs);
      const onMessage = (m: { body: { maya?: unknown; text?: string } }): void => {
        const maya = m.body.maya as LoopBody | undefined;
        if (maya?.kind === 'answer' && maya.qid === qid) {
          cleanup();
          const label = maya.optionId !== undefined ? q.options[Number(maya.optionId)] : undefined;
          resolve(maya.text ?? label ?? q.options[0] ?? '');
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        lead.off('message', onMessage);
      };
      lead.on('message', onMessage);
    });
  }
}
