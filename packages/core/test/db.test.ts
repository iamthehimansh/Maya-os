/**
 * Core repo layer: schema, guarded task transitions, claim semantics,
 * dependency readiness, budget accounting. All against :memory: SQLite.
 */

import { describe, expect, it } from 'vitest';
import { MayaDb } from '../src/db.js';

const mk = () => new MayaDb(':memory:');

describe('MayaDb', () => {
  it('creates teams with derived channel ids and lists them', () => {
    const db = mk();
    const team = db.createTeam({ name: 'dev', topology: 'manager-tree' });
    expect(team.channelId).toBe(`maya/team/${team.id}`);
    expect(db.teams().map((t) => t.id)).toContain(team.id);
    db.close();
  });

  it('enforces legal task transitions and rejects illegal ones', () => {
    const db = mk();
    const team = db.createTeam({ name: 'dev', topology: 'round-robin' });
    const task = db.createTask({ teamId: team.id, spec: 'do X' });

    db.transitionTask(task.id, 'assigned', { assignee: 'ag_1' });
    db.transitionTask(task.id, 'accepted');
    db.transitionTask(task.id, 'working');
    const done = db.transitionTask(task.id, 'done', { result: 'ok' });
    expect(done.state).toBe('done');
    expect(done.result).toBe('ok');

    expect(() => db.transitionTask(task.id, 'working')).toThrow(/illegal transition/);
    db.close();
  });

  it('re-queue clears the assignee (crash-safe reassignment)', () => {
    const db = mk();
    const team = db.createTeam({ name: 'dev', topology: 'round-robin' });
    const task = db.createTask({ teamId: team.id, spec: 'do X' });
    db.transitionTask(task.id, 'assigned', { assignee: 'ag_dead' });
    // Worker died before accepting → back to queued, assignee cleared, attempt counted.
    const requeued = db.transitionTask(task.id, 'queued', { bumpAttempts: true });
    expect(requeued.assignee).toBeNull();
    expect(requeued.attempts).toBe(1);
    expect(requeued.state).toBe('queued');
    db.close();
  });

  it('readyTasks respects dependency completion', () => {
    const db = mk();
    const team = db.createTeam({ name: 'dev', topology: 'manager-tree' });
    const a = db.createTask({ teamId: team.id, spec: 'A' });
    const b = db.createTask({ teamId: team.id, spec: 'B (needs A)', deps: [a.id] });

    expect(db.readyTasks(team.id).map((t) => t.id)).toEqual([a.id]);

    db.transitionTask(a.id, 'assigned', { assignee: 'ag_1' });
    db.transitionTask(a.id, 'accepted');
    db.transitionTask(a.id, 'working');
    db.transitionTask(a.id, 'done');

    expect(db.readyTasks(team.id).map((t) => t.id)).toEqual([b.id]);
    db.close();
  });

  it('budget accounting flags exhaustion at the cap', () => {
    const db = mk();
    const team = db.createTeam({ name: 'dev', topology: 'parallel', tokenBudget: 1000 });
    expect(db.addTeamTokens(team.id, 400).exhausted).toBe(false);
    const second = db.addTeamTokens(team.id, 700);
    expect(second.total).toBe(1100);
    expect(second.exhausted).toBe(true);
    // Uncapped team never exhausts.
    const free = db.createTeam({ name: 'free', topology: 'parallel' });
    expect(db.addTeamTokens(free.id, 10_000_000).exhausted).toBe(false);
    db.close();
  });

  it('tracks team members and their bus handles', () => {
    const db = mk();
    const team = db.createTeam({ name: 'dev', topology: 'manager-tree' });
    db.addAgent({ id: 'ag_1', teamId: team.id, adapter: 'claude-code', model: 'local/q', busHandle: null, state: 'spawning' });
    db.setAgentState('ag_1', 'running', 'worker-1');
    const [agent] = db.agents(team.id);
    expect(agent?.state).toBe('running');
    expect(agent?.busHandle).toBe('worker-1');
    db.close();
  });
});
