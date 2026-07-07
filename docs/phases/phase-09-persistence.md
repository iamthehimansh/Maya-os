# Phase 9 — Persistence & Projects

**Lane:** 02 (core) · **Depends on:** Phase 0 · **Milestone:** M4 (with Phase 8)

## Goal

Everything Maya does is durable, queryable, and portable: one SQLite database
(`~/.maya/maya.db`, built-in `node:sqlite`, zero native deps), owned by core,
accessed only through core's repository layer — never raw SQL from other
packages.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| Core schema v1 | brief | `projects` `teams` `agents` `tasks` + model-plane tables (`model_profiles`, `runtime_samples`) — as documented in `contracts/config.ts` |
| Repository layer | **NEW** | Typed accessors per table exported from `@maya-ai/core`; other packages depend on functions, not SQL — schema can evolve without cross-package breakage |
| Versioned migrations | **NEW** | `schema_version` pragma + ordered migration scripts run on boot; forward-only, tested against fixture DBs from every prior release |
| Projects | brief | Register repos/workspaces (`maya project add .`); teams and agent `cwd`s reference projects, dashboards group by them |
| Runs history | **NEW** | Every loop run: task tree, assignments, timings, outcomes — the "what did my AI team do yesterday" answer |
| Artifact store | brief | `ArtifactRef` targets under `~/.maya/artifacts/<run>/` with content-addressed names; diffs/reports/files the dashboard can open |
| Bus message archive | **NEW** | Team-channel history persisted (bus keeps hot window; archive keeps the rest) with per-team retention settings |
| Full-text search | **NEW** | SQLite FTS5 across conversations, task specs, artifacts — "which agent touched auth.ts and why" |
| Usage & cost ledger | **NEW** | Token usage rows from the gateway meter with cloud price snapshots — per project/team/day rollups |
| Retention & GDPR-ish hygiene | **NEW** | Per-project retention windows, `maya data purge` (project/date-ranged), export before purge |
| Export / import | **NEW** | `maya export <project>` → tarball (db slice + artifacts) for moving machines or filing bug reports |
| Backup safety | **NEW** | WAL mode, checkpoint on clean shutdown, startup integrity check with automatic `.bak` fallback |

## Deliverables

`@maya-ai/core` additions: `db.ts` (open/migrate/integrity), `repo/*.ts`
typed accessors, FTS virtual tables, retention job; migration test harness.

## Acceptance

- Fresh boot creates schema v1; a fixture v1 DB upgrades in place to head with data intact.
- Kill -9 the platform mid-write → next boot passes integrity check, no data loss beyond the in-flight write (WAL verified).
- FTS query over 10k archived messages returns in <50 ms on an M1.
- `maya export` + `import` on another machine reproduces project history + artifacts.
- No package outside core imports `node:sqlite` (lint rule enforced).

## Risks

- Two processes writing (CLI supervisor vs dashboard server) → single writer: all writes go through the supervisor process's core service; others use its API.
- FTS index bloat on chatty teams → retention defaults + `VACUUM` in the retention job.
