/**
 * Platform persistence — core owns THE schema (contracts/config.ts): one
 * SQLite at ~/.maya/maya.db; other packages go through this repo layer,
 * never raw SQL. (The bus keeps its own hot bus.db by design — Phase 9
 * archival ingests FROM it.)
 *
 * v1 tables: projects, teams, agents, tasks (+ schema_version).
 * Single-writer semantics via synchronous node:sqlite statements; every
 * multi-step transition runs in one IMMEDIATE transaction.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dbPath } from './paths.js';

export type TeamTopology = 'manager-tree' | 'round-robin' | 'parallel' | 'sequential' | 'voting' | 'debate';

export interface TeamRow {
  id: string;
  name: string;
  topology: TeamTopology;
  channelId: string;
  /** Token budget (input+output) across all members; null = uncapped. */
  tokenBudget: number | null;
  tokensUsed: number;
  state: 'active' | 'draining' | 'closed';
  createdAt: string;
}

export interface TeamAgentRow {
  id: string;          // AgentHandle.id
  teamId: string;
  adapter: string;
  model: string;
  busHandle: string | null;
  state: string;       // AgentState mirror, updated by the orchestrator
  createdAt: string;
}

export type TaskState = 'queued' | 'assigned' | 'accepted' | 'working' | 'blocked' | 'done' | 'failed';

export interface TaskRow {
  id: string;
  teamId: string;
  parentId: string | null;
  spec: string;
  scope: string[];      // file/dir scopes for safe parallelism
  deps: string[];       // task ids that must be done first
  state: TaskState;
  assignee: string | null; // TeamAgentRow.id
  attempts: number;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

const SCHEMA_VERSION = 1;

export class MayaDb {
  private readonly db: DatabaseSync;

  constructor(filePath?: string) {
    const p = filePath ?? dbPath();
    if (p !== ':memory:') fs.mkdirSync(path.dirname(p), { recursive: true });
    this.db = new DatabaseSync(p);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        topology TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_agents (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id),
        adapter TEXT NOT NULL,
        model TEXT NOT NULL,
        bus_handle TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id),
        parent_id TEXT,
        spec TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '[]',
        deps TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'queued',
        assignee TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_team_state ON tasks (team_id, state);
    `);
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }

  /** Run fn inside one IMMEDIATE transaction (single-writer transition safety). */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const out = fn();
      this.db.exec('COMMIT;');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // ── teams ─────────────────────────────────────────────────────────────

  createTeam(input: { name: string; topology: TeamTopology; tokenBudget?: number }): TeamRow {
    const id = 'team_' + randomUUID().replaceAll('-', '').slice(0, 10);
    const row: TeamRow = {
      id,
      name: input.name,
      topology: input.topology,
      channelId: `maya/team/${id}`,
      tokenBudget: input.tokenBudget ?? null,
      tokensUsed: 0,
      state: 'active',
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO teams (id, name, topology, channel_id, token_budget, tokens_used, state, created_at) VALUES (?,?,?,?,?,0,?,?)')
      .run(row.id, row.name, row.topology, row.channelId, row.tokenBudget, row.state, row.createdAt);
    return row;
  }

  team(id: string): TeamRow | null {
    const r = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toTeam(r) : null;
  }

  teams(): TeamRow[] {
    return (this.db.prepare('SELECT * FROM teams ORDER BY created_at').all() as Record<string, unknown>[]).map(toTeam);
  }

  setTeamState(id: string, state: TeamRow['state']): void {
    this.db.prepare('UPDATE teams SET state = ? WHERE id = ?').run(state, id);
  }

  /**
   * Add token usage; returns the new total and whether the budget is now
   * exhausted (callers hard-stop the team when it is).
   */
  addTeamTokens(id: string, tokens: number): { total: number; exhausted: boolean } {
    return this.transaction(() => {
      this.db.prepare('UPDATE teams SET tokens_used = tokens_used + ? WHERE id = ?').run(tokens, id);
      const t = this.team(id);
      if (!t) throw new Error(`unknown team ${id}`);
      return { total: t.tokensUsed, exhausted: t.tokenBudget !== null && t.tokensUsed >= t.tokenBudget };
    });
  }

  // ── team members ──────────────────────────────────────────────────────

  addAgent(row: Omit<TeamAgentRow, 'createdAt'>): TeamAgentRow {
    const full: TeamAgentRow = { ...row, createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO team_agents (id, team_id, adapter, model, bus_handle, state, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(full.id, full.teamId, full.adapter, full.model, full.busHandle, full.state, full.createdAt);
    return full;
  }

  setAgentState(id: string, state: string, busHandle?: string): void {
    if (busHandle !== undefined) {
      this.db.prepare('UPDATE team_agents SET state = ?, bus_handle = ? WHERE id = ?').run(state, busHandle, id);
    } else {
      this.db.prepare('UPDATE team_agents SET state = ? WHERE id = ?').run(state, id);
    }
  }

  agents(teamId: string): TeamAgentRow[] {
    return (this.db.prepare('SELECT * FROM team_agents WHERE team_id = ? ORDER BY created_at').all(teamId) as Record<string, unknown>[]).map(toAgent);
  }

  /** Every agent across teams, newest first (dashboard Agents tab). */
  agentsAll(limit = 200): TeamAgentRow[] {
    return (this.db.prepare('SELECT * FROM team_agents ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toAgent);
  }

  // ── tasks ─────────────────────────────────────────────────────────────

  createTask(input: { teamId: string; spec: string; parentId?: string; scope?: string[]; deps?: string[] }): TaskRow {
    const now = new Date().toISOString();
    const row: TaskRow = {
      id: 'task_' + randomUUID().replaceAll('-', '').slice(0, 10),
      teamId: input.teamId,
      parentId: input.parentId ?? null,
      spec: input.spec,
      scope: input.scope ?? [],
      deps: input.deps ?? [],
      state: 'queued',
      assignee: null,
      attempts: 0,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare('INSERT INTO tasks (id, team_id, parent_id, spec, scope, deps, state, assignee, attempts, result, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,NULL,?,?)')
      .run(row.id, row.teamId, row.parentId, row.spec, JSON.stringify(row.scope), JSON.stringify(row.deps), row.state, row.assignee, row.createdAt, row.updatedAt)
    return row;
  }

  task(id: string): TaskRow | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toTask(r) : null;
  }

  tasks(teamId: string, state?: TaskState): TaskRow[] {
    const rows = (
      state !== undefined
        ? this.db.prepare('SELECT * FROM tasks WHERE team_id = ? AND state = ? ORDER BY created_at').all(teamId, state)
        : this.db.prepare('SELECT * FROM tasks WHERE team_id = ? ORDER BY created_at').all(teamId)
    ) as Record<string, unknown>[];
    return rows.map(toTask);
  }

  /**
   * Guarded state transition — the single write path for task state. Throws
   * on an illegal edge so bugs surface instead of corrupting the board.
   */
  transitionTask(
    id: string,
    to: TaskState,
    opts?: { assignee?: string | null; result?: string; bumpAttempts?: boolean },
  ): TaskRow {
    const LEGAL: Record<TaskState, TaskState[]> = {
      queued: ['assigned'],
      assigned: ['accepted', 'queued', 'failed'],
      // accepted → done directly: a fast one-shot worker can finish before
      // its first workstatus round-trip lands.
      accepted: ['working', 'done', 'queued', 'failed'],
      working: ['blocked', 'done', 'failed', 'queued'],
      blocked: ['working', 'queued', 'failed'],
      done: [],
      failed: ['queued'], // retry re-queues
    };
    return this.transaction(() => {
      const cur = this.task(id);
      if (!cur) throw new Error(`unknown task ${id}`);
      if (!LEGAL[cur.state].includes(to)) throw new Error(`illegal transition ${cur.state} → ${to} (task ${id})`);
      this.db
        .prepare('UPDATE tasks SET state = ?, assignee = ?, result = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?')
        .run(
          to,
          opts?.assignee !== undefined ? opts.assignee : to === 'queued' ? null : cur.assignee,
          opts?.result ?? cur.result,
          opts?.bumpAttempts ? 1 : 0,
          new Date().toISOString(),
          id,
        );
      const next = this.task(id);
      if (!next) throw new Error('task vanished mid-transaction');
      return next;
    });
  }

  /** Tasks whose deps are all done and are ready to assign. */
  readyTasks(teamId: string): TaskRow[] {
    const all = this.tasks(teamId);
    const doneIds = new Set(all.filter((t) => t.state === 'done').map((t) => t.id));
    return all.filter((t) => t.state === 'queued' && t.deps.every((d) => doneIds.has(d)));
  }

  close(): void {
    this.db.close();
  }
}

function toTeam(r: Record<string, unknown>): TeamRow {
  return {
    id: String(r['id']),
    name: String(r['name']),
    topology: String(r['topology']) as TeamTopology,
    channelId: String(r['channel_id']),
    tokenBudget: r['token_budget'] === null ? null : Number(r['token_budget']),
    tokensUsed: Number(r['tokens_used']),
    state: String(r['state']) as TeamRow['state'],
    createdAt: String(r['created_at']),
  };
}

function toAgent(r: Record<string, unknown>): TeamAgentRow {
  return {
    id: String(r['id']),
    teamId: String(r['team_id']),
    adapter: String(r['adapter']),
    model: String(r['model']),
    busHandle: r['bus_handle'] === null ? null : String(r['bus_handle']),
    state: String(r['state']),
    createdAt: String(r['created_at']),
  };
}

function toTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r['id']),
    teamId: String(r['team_id']),
    parentId: r['parent_id'] === null ? null : String(r['parent_id']),
    spec: String(r['spec']),
    scope: JSON.parse(String(r['scope'])) as string[],
    deps: JSON.parse(String(r['deps'])) as string[],
    state: String(r['state']) as TaskState,
    assignee: r['assignee'] === null ? null : String(r['assignee']),
    attempts: Number(r['attempts']),
    result: r['result'] === null ? null : String(r['result']),
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at']),
  };
}
