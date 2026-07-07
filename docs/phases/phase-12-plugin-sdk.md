# Phase 12 — Plugin SDK (lane 01 lead; both lanes contribute plugin points)

**Goal:** everything becomes a plugin — third parties extend Maya without
forking. The built-ins (adapters, providers, topologies, dashboard tabs) are
re-hosted on the same plugin points to prove the SDK is real.

**Demo:** `npx create-maya-plugin my-adapter` → scaffold → `maya plugin install
./my-adapter` → the new agent type appears in `maya agent spawn` and the
dashboard spawn form, without Maya releasing anything.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| Plugin manifest | brief | `maya-plugin.json`: type(s), entry points, declared permissions, semver + engine ranges |
| Plugin types | brief | model provider · agent adapter · tool · topology strategy · dashboard panel · TUI command · memory backend (phase-14 hook) |
| Permission model | **NEW** | plugins declare fs/net/exec needs; install-time consent prompt; undeclared access = refused at runtime |
| Isolation | **NEW** | out-of-process host for plugin execution where feasible (adapters/tools); crash containment — a broken plugin can't take down the supervisor |
| Lifecycle | brief | `maya plugin install/list/enable/disable/remove` — npm-backed (any registry), lockfile-pinned |
| Dev kit | **NEW** | `create-maya-plugin` templates per type, typed against `@maya-ai/core` contracts, local hot-reload against a running Maya |
| Dogfood proof | **NEW** | ship at least one built-in re-hosted as a real plugin (e.g. OpenCode adapter) to keep the SDK honest |
| Marketplace groundwork | brief | plugin metadata format + signing story defined here; the hub itself is phase 14 |

## Deliverables

- `packages/plugin-host` (loader, permission enforcement, process host)
- `create-maya-plugin` scaffolder + SDK docs (`docs/plugins.md`)
- Conformance suites per plugin type (an adapter plugin must pass the phase-4 adapter suite)

## Acceptance criteria

1. A third-party adapter plugin installs, spawns an agent, and passes the adapter conformance suite — with zero changes to Maya core.
2. A plugin that violates its declared permissions is blocked and reported, not silently allowed.
3. A plugin that throws/crashes never brings down the supervisor (chaos test).
4. Disable/remove cleanly unregisters everything (no ghost entries in CLI or dashboard).
5. The dogfooded built-in plugin is byte-identical in behavior to its former built-in (same conformance results).

## Risks

| Risk | Mitigation |
|------|-----------|
| SDK freezes contracts too early | plugin API versioned separately (`pluginApi: 1`); deprecation policy documented from day one |
| Permission model theater (bypassable) | enforcement in the host process, not the plugin; red-team tests in acceptance |
| Ecosystem fragmentation (plugins per Maya version) | engine ranges + CI compat matrix against last 2 minor versions |
