# Phase 10 — Packaging & Distribution

**Lane:** 02 · **Depends on:** Phase 5 · **Milestone:** M5

## Goal

`npx maya-os` works on a Mac that has nothing but Node — cold start to a
serving model in under 2 minutes (post-download), upgrades that never eat
user data, releases a solo maintainer can cut safely.

## Features

| Feature | Source | Detail |
|---------|--------|--------|
| `npx maya-os` cold-start path | brief | tsup-bundled CLI (fast npx), lazy-install heavier bits on first run, wizard handles the rest |
| llama.cpp acquisition strategy | **NEW** | Priority: existing binary → `brew install llama.cpp` (consented) → download signed prebuilt from our releases; pinned tested version range, `maya doctor` owns detection |
| Signed release pipeline | **NEW** | Tag → CI builds/tests → npm publish (provenance) + GitHub release; single source version stamping across packages |
| Homebrew tap | **NEW** | `brew install maya-os` alternative channel for non-Node users (formula wraps node + package) |
| Self-update | **NEW** | `maya upgrade` (npm-based) + gentle "new version" notice in TUI/dashboard (checked ≤1×/day, offline-quiet, opt-out) |
| Data migrations on upgrade | **NEW** | Phase 9 migration runner wired to version bumps; downgrade-protection warning (older CLI on newer DB refuses politely) |
| Uninstall path | **NEW** | `maya uninstall --purge` documents/removes `~/.maya`, brew formula cleans up — leave machines the way we found them |
| Crash reporting (local) | **NEW** | Crashes write a redacted local report bundle; `maya doctor --report` lets the USER choose to share — no silent telemetry, ever |
| Opt-in anonymous usage ping | **NEW** | Single boolean, off by default, shown once in the wizard; counts boots/versions only — local-first means telemetry-quiet |
| Supply-chain hygiene | **NEW** | Lockfile-only installs, `pnpm audit` gate in CI, minimal dep policy (node-pty is the only native module, owned by Phase 4) |

## Deliverables

CI workflows (build/test/release), tsup bundling for `apps/cli`, brew formula
repo, version/migration wiring, docs: INSTALL.md + UNINSTALL.md.

## Acceptance

- Clean macOS VM (Node only): `npx maya-os` → wizard → model pulled → served; **<2 min** excluding download bandwidth.
- Upgrade from previous release with live data → boots, migrates, everything intact (fixture-tested every release).
- `npm pack` contents audited: no source maps with local paths, no dev files, no secrets.
- Release cut by one command from a tagged commit; artifacts signed/provenance-stamped.

## Risks

- Shipping/loading prebuilt llama.cpp binaries (Gatekeeper, notarization) → prefer brew path first; prebuilts only if brew friction proves real.
- npx cold-start latency from dependency weight → bundle aggressively, defer dashboard assets to first `maya` boot.
