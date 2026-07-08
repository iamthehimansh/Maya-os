/**
 * LoopLead integration: deterministic planner/verifier + scripted workers
 * over a REAL bus. Proves the M3 mechanics: decompose → seed → dispatch →
 * verify → rework → report, clarification round-trip with a human answer,
 * and the never-hang question timeout.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { BusMessageFrame, LoopBody } from '@maya-ai/core';
import { MayaDb } from '@maya-ai/core';
import { AgentBusBridge, AgentRuntime } from '@maya-ai/agent-runtime';
import { BusClient } from '@maya-ai/bus-client';
import { mintToken, startBusServer, type RunningBusServer } from '@maya-ai/bus';
import { LoopLead, type Plan, type Planner, type Verifier } from '../src/loop-lead.js';
import { TeamManager } from '../src/team-manager.js';
import { ScriptedWorkers } from './scripted-workers.js';

let running: RunningBusServer | null = null;
const clients: BusClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  if (running) {
    await running.close();
    running = null;
  }
});

async function setup(
  planner: Planner,
  verifier: Verifier,
  extra?: {
    questionTimeoutMs?: number;
    maxGoalFix?: number;
    goalCheck?: (goal: string) => Promise<{ met: boolean; missing: string[]; fixInstruction?: string }>;
  },
) {
  running = await startBusServer({ dbPath: ':memory:', port: 0 });
  const admin = running.bootstrapAdminToken!;
  const wsBase = `ws://127.0.0.1:${running.port}`;
  const db = new MayaDb(':memory:');
  const runtime = new AgentRuntime({ gatewayBaseUrl: 'http://127.0.0.1:1' });
  runtime.register(new ScriptedWorkers());
  const bridge = new AgentBusBridge({ wsBase, adminToken: admin.token });
  const teams = new TeamManager({ db, runtime, bridge, bus: { wsBase, adminToken: admin.token } });
  const lead = new LoopLead({
    db,
    teams,
    team: { topology: 'manager-tree', members: [{ adapter: 'scripted', model: 'local/x', cwd: '/tmp' }] },
    planner,
    verifier,
    bus: { wsBase, adminToken: admin.token },
    ...(extra?.questionTimeoutMs !== undefined ? { questionTimeoutMs: extra.questionTimeoutMs } : {}),
    ...(extra?.maxGoalFix !== undefined ? { maxGoalFix: extra.maxGoalFix } : {}),
    ...(extra?.goalCheck !== undefined ? { goalCheck: extra.goalCheck } : {}),
  });
  return { db, lead, wsBase };
}

const okVerifier: Verifier = async () => ({ ok: true });

describe('LoopLead', () => {
  it('runs a two-task plan with a dependency to a verified success report', async () => {
    const planner: Planner = async () => ({
      tasks: [
        { spec: 'write the module', acceptance: 'module exists' },
        { spec: 'test the module', deps: [0] },
      ],
    });
    const { lead } = await setup(planner, okVerifier);
    const report = await lead.run('build a module with tests');

    expect(report.outcome).toBe('success');
    expect(report.tasks).toHaveLength(2);
    expect(report.tasks.every((t) => t.state === 'done' && t.verified)).toBe(true);
    expect(report.questionsAsked).toBe(0);
  }, 30_000);

  it('asks exactly one clarification, uses the human answer, and completes', async () => {
    const plans: string[] = [];
    const planner: Planner = async (_goal, context) => {
      plans.push(context.answer ?? '(none)');
      if (!context.answer) {
        return { tasks: [], clarification: { prompt: 'REST or GraphQL?', options: ['REST', 'GraphQL'] } };
      }
      return { tasks: [{ spec: `build the ${context.answer} API` }] };
    };
    const { db, lead, wsBase } = await setup(planner, okVerifier);

    // A "human" watching for the question and answering it.
    const runPromise = lead.run('build the API');
    await (async () => {
      // Wait for the team channel to exist (first team in the db).
      for (;;) {
        const teams = db.teams();
        if (teams.length > 0) {
          const { token } = mintToken(running!.db, { label: 'himansh', role: 'owner', scopes: [teams[0]!.channelId] });
          const human = new BusClient({ wsBase, channelId: teams[0]!.channelId, token });
          clients.push(human);
          const answerQuestion = (maya: LoopBody | undefined): void => {
            if (maya?.kind === 'question') {
              const answer: LoopBody = { kind: 'answer', qid: maya.qid, optionId: '1' }; // GraphQL
              human.sendMessage({ body: { text: 'GraphQL', maya: answer } });
            }
          };
          // Handlers attach BEFORE connect: 'joined' and 'history' can arrive
          // in one TCP segment, firing synchronously back-to-back — a handler
          // attached after `await joined` misses that batched history frame.
          // (Question may predate the join; real dashboards read history too.)
          human.on('message', (m) => answerQuestion(m.body.maya as LoopBody | undefined));
          human.on('history', (h) => {
            for (const m of h.messages) answerQuestion(m.body.maya as LoopBody | undefined);
          });
          human.connect();
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    })();

    const report = await runPromise;
    expect(report.outcome).toBe('success');
    expect(report.questionsAsked).toBe(1);
    expect(plans).toEqual(['(none)', 'GraphQL']);
    expect(report.tasks[0]?.spec).toContain('GraphQL');
  }, 30_000);

  it('reworks a rejected task once, then accepts', async () => {
    const planner: Planner = async () => ({ tasks: [{ spec: 'produce the report', acceptance: 'mentions Q3' }] });
    let verdicts = 0;
    const verifier: Verifier = async () => {
      verdicts += 1;
      return verdicts === 1 ? { ok: false, feedback: 'missing Q3 numbers' } : { ok: true };
    };
    const { db, lead } = await setup(planner, verifier);
    const report = await lead.run('quarterly report');

    expect(report.outcome).toBe('success');
    const all = db.tasks(report.team.id);
    expect(all).toHaveLength(2); // original + rework
    expect(all.some((t) => t.spec.includes('REWORK'))).toBe(true);
    expect(verdicts).toBe(2);
  }, 30_000);

  it('question timeout falls back to the first option instead of hanging', async () => {
    const planner: Planner = async (_goal, context) =>
      context.answer !== undefined
        ? { tasks: [{ spec: `go with ${context.answer}` }] }
        : { tasks: [], clarification: { prompt: 'pick one', options: ['alpha', 'beta'] } };
    const { lead } = await setup(planner, okVerifier, { questionTimeoutMs: 500 });
    const report = await lead.run('ambiguous goal');

    expect(report.outcome).toBe('success');
    expect(report.tasks[0]?.spec).toContain('alpha'); // first option
  }, 30_000);

  it('goal-acceptance catches a planner that drops a hard requirement (02 capstone v2)', async () => {
    // Planner paraphrases the goal away, so every task "passes" its own gate —
    // but the goalCheck sees the GOAL is unmet, queues an explicit fix, and if
    // still unmet downgrades to partial with the exact gap named.
    const planner: Planner = async () => ({ tasks: [{ spec: 'write a status file' }] });
    let round = 0;
    const goalCheck = async () => {
      round += 1;
      // Even after the explicit fix tasks, still unmet (scripted worker writes nothing real).
      return { met: false, missing: ['content "Maya M3 demo complete"'] };
    };
    const { lead } = await setup(planner, okVerifier, { goalCheck, maxGoalFix: 2 });
    const report = await lead.run('Create STATUS.md containing exactly: Maya M3 demo complete');

    expect(report.outcome).toBe('partial');
    expect(report.summary).toContain('Maya M3 demo complete');
    expect(round).toBe(4); // initial + 2 fix-round re-checks + 1 tail-race guard check
  }, 30_000);

  it('report re-reads the team so tokensUsed is fresh, not the creation snapshot (02 metering bug)', async () => {
    // TOKENS:600 makes the scripted worker meter 600; the report's team must
    // reflect the ledger, not the stale 0 captured at team creation.
    const planner: Planner = async () => ({ tasks: [{ spec: 'expensive TOKENS:600 job' }] });
    const { db, lead } = await setup(planner, okVerifier);
    const report = await lead.run('meter check');
    expect(report.team.tokensUsed).toBe(600);
    expect(db.team(report.team.id)?.tokensUsed).toBe(600); // ledger agrees
  }, 30_000);

  it('goal-acceptance passes cleanly when the fix task satisfies the goal', async () => {
    const planner: Planner = async () => ({ tasks: [{ spec: 'write a status file' }] });
    let round = 0;
    const goalCheck = async () => {
      round += 1;
      return round === 1 ? { met: false, missing: ['content "X"'] } : { met: true, missing: [] };
    };
    const { lead } = await setup(planner, okVerifier, { goalCheck });
    const report = await lead.run('goal with a requirement');
    expect(report.outcome).toBe('success');
    expect(round).toBe(2);
  }, 30_000);
});
