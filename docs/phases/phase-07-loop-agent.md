# Phase 7 — Loop Agent (lane 01) ⭐ the differentiator

**Goal:** a persistent interim team lead. The human talks to ONE agent; it
plans, delegates to N workers, verifies, merges, and only escalates questions
that genuinely need an owner decision. The human stays the real lead — the
Loop Agent handles most of the work between check-ins.

**Demo (the M3 wow-moment):** `maya loop "add auth to this repo" --team dev`
→ lead decomposes, spawns 2 workers, streams milestone progress, asks the
human exactly ONE question (with clickable options), delivers a verified,
merged result.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| Lead loop | brief | plan → decompose → assign → monitor → verify → merge → report; deterministic TS state machine — the LLM is consulted only for judgment steps (planning, review), never for control flow |
| Decomposition | brief | goal → scoped tasks (file/dir scopes so parallel workers can't collide) + dep graph; sized to worker context |
| Delegation | brief | loop protocol v1 over the bus (`task_assign`/`task_accept`/…); timeout → reassign; `task_failed(retryable)` → bounded retry |
| Verification | **NEW** | acceptance criteria checked before a `task_done` is accepted: build/tests run + spot-review by a verifier agent; failed verification → rework task with feedback |
| Escalation discipline | brief | lead answers what it can; batches + dedupes questions; ONLY owner-decision questions escalate — as clickable-option questions (bus → dashboard/TUI) |
| Proactive comms | brief | milestone progress posts, early warning on blockers and budget burn; silence otherwise (no play-by-play spam) |
| Failure recovery | brief | worker crash → respawn/reassign with partial-artifact salvage; lead crash → resume from persisted state; a final report is ALWAYS produced, even on abort |
| Merge strategy | **NEW** | workers commit to task branches (phase-4 worktrees); lead merges in dep order, runs the build between merges, bisects a breaking merge to its task |
| Session persistence | **NEW** | loop state (plan, assignments, verdicts) in SQLite; `maya loop resume <id>` after any restart |
| Self-tuning (v2 hook) | **NEW** | run journal captures decomposition quality metrics — feeds phase-14 self-improvement |

## Deliverables

- `packages/orchestrator/loop`: lead state machine, decomposer, verifier, merger
- `maya loop "<goal>" [--team]`, `maya loop status/resume/abort` (live Ink view)
- Loop-run journal format doc (`docs/loop-journal.md`)

## Acceptance criteria

1. Scripted M3 demo passes headless: lead + 2 workers deliver a multi-file feature with ≤1 human question, artifacts verified (tests green) before "done".
2. `kill -9` the lead mid-run → `maya loop resume` completes the run; no task redone from scratch that had verified results.
3. Lead never accepts unverified work: a planted always-failing test forces rework, not completion.
4. Question dedupe: two workers hitting the same unknown produce ONE human question.
5. Budget breach mid-run → orderly wind-down + partial-result report, not a hang.

## Risks

| Risk | Mitigation |
|------|-----------|
| Lead quality depends on the model behind it | lead runs on any ModelId — recommend strongest available; judgment prompts versioned + eval-tested against the run journal |
| Verification cost (tokens/time) balloons | verify incrementally (build + targeted tests per task), full suite only at merge points |
| "Only important questions" is subjective | explicit escalation rubric in the lead prompt + owner-tunable threshold; measured by questions-per-run in acceptance |
