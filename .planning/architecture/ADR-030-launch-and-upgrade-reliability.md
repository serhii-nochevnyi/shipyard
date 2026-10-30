---
status: accepted
---
# ADR-030 — Launch and upgrade reliability

- **Status:** accepted; authenticated INV-017 Gate 1, accepted by the repository operator on 2026-10-15
- **Date:** 2026-10-15
- **Decision owner:** repository operator; every decision below was selected in the INV-017 dialogue on 2026-10-15
- **Scope:** how an installed Shipyard host discovers its environment, preflights compatibility, treats pre-existing project history after an upgrade, shares the phase/repository/ADR subject contract, and proves this through the installed package
- **Supersedes:** none
- **Related:** ADR-014, ADR-015, ADR-021, ADR-025 (its phase-47-only deferral of automatic environment adjudication does not constrain this ADR)
- **UI design:** none

## Context

[INV-017](../investigations/INV-017-launch-and-upgrade-reliability/PROBLEM.md) was opened after a parallel Codex session in this repository was blocked on launch. Evidence is in `EVIDENCE.md`, the four sealed research lines under `research/`, and `spikes/SPIKES.md`.

- Launch is not one supported path. The invoking agent runs `pipeline-config.cjs`, `deliver-dispatch.cjs build` and a host script in whatever environment its session provides. Codex home, capability evidence and agents dir are resolved at 20+ sites by 8+ rules; `codex-runtime-host.cjs:160-171` finds the installed capabilities file only when `CODEX_HOME` is set, while sibling sites default to `~/.codex`.
- An upgraded project with pre-existing provenance sidecars and no authority catalogue refuses every launch (`role-artifact.cjs` refusal `ARCHIVE_AUTHORITY_INVALID`, introduced by `d8a70dec`, present in v0.72.0–v0.72.2). No migration or historical status exists. Spike S-1 reproduced it for the call shape of all three hosts and showed that a refused launch still creates the authority directory and that a linked-worktree write leaves an unpinned sidecar that blocks the next project-root host.
- The original ADR-digest incident (FlowPDF Phase 9, parallel Codex session) was the missing `adr=` binding, fixed by #486 for decomposition seals. Five subject grammars and four repository-identity constructions remain; they already disagree on whitespace in the repository value (spike S2).
- Preflight does not cover the environment or project-local state; `hint[CODE]` lines print from four hosts only and several remedies are checkout-relative or mismatched.
- No test covers launch without env variables, upgrade with old history, or the installed bundle from a clean shell.

## Decision

- **L-1 Shape:** implement a library-first change (research Option B, "B-lite"): one shared environment resolver in an existing module and a preflight inside every host entry before any state is created, with no new launcher CLI, persisted launch context or new script file.
- **L-2 Self-locating environment:** a host derives its bundle root, Codex home, capabilities path and policy hash from the executing bundle's manifest. An explicit flag or environment value that agrees with the bundle is accepted; one that disagrees is a named conflict and refuses, naming both values. Without a bundle (source checkout) the host reads the evidence an install left at `${CODEX_HOME:-~/.codex}/shipyard/codex-capabilities.json`; an explicit value takes priority, and a missing or malformed file refuses. The resolver passes only the validated Codex home, capabilities path and runtime to child processes; other variables keep their current owners.
- **L-3 Capability evidence:** the evidence is the installer-written bundle copy, located from the bundle and verified against the manifest `capabilities_digest` and the ADR-014 grid at every launch. Discovery never synthesizes evidence and the installer's explicit-evidence refusal is unchanged. No live `codex debug models` probe per launch; snapshot staleness against the installed Codex CLI is reported by preflight.
- **L-4 Legacy-history adoption (MS1):** on first admission of a worktree with pre-existing sidecars and no authenticated record, the host adopts them automatically, once per worktree, under the existing catalogue lock, recording the inventory in the protected authority state under a separate versioned legacy field with status `historical-unverified`. Files stay in place and unchanged. Legacy members never become authenticated pins, never satisfy the existence check for a new dispatch id, and are never verified evidence. The unauthenticated linked-worktree write path is covered by adoption or pins its own sidecar.
- **L-5 After adoption:** a changed legacy member blocks the launch; any later unknown file blocks with a named remedy to update the host that wrote it. History is never deleted, archived or moved by a supported procedure.
- **L-6 Preflight:** every host runs preflight before `controller.begin` and before any bookkeeping, reports every incompatibility in one pass with a remedy that runs from the installed bundle, and every entry point prints `hint[CODE]` lines. Each host accepts `--preflight` to show the result without launching and to exit non-zero on any incompatibility. `--capability-only` keeps its always-exit-0 contract. A refused launch creates no authority directory and no sidecar.
- **L-7 Claude and Codex share one route:** the Claude delivery, role, investigation and decomposition hosts use the same resolver, preflight and bookkeeping admission as the Codex hosts; Claude gets no preparation hook.
- **L-8 Concurrency:** adoption and migration use only the existing catalogue lock; a second session waits a bounded time or gets a named refusal with a remedy. No new cross-runtime coordination.
- **L-9 One subject contract:** the canonical repository identity is the realpath of `git --git-common-dir`, built by one `repositoryIdentity()` in an existing module with one character class and one parse for every subject family; a contract test round-trips each family on both runtimes with a path containing whitespace, a non-ASCII path and a rejected character. Sealed artifacts that used the old Codex `owner/repo` form must still verify.
- **L-10 Acceptance:** a hermetic CI core (Linux, Node 24, isolated HOME, state roots and graph directory) covering launch without env variables on both runtimes; upgrade with each legacy variant (partial history, linked worktree, changed legacy member, new unknown member, symlinked member); concurrent Codex and Claude launches including during adoption; assertion that real user state is unchanged; and a UI smoke through the existing GSD path (`gsd-ui-phase` then `gsd-ui-review`) or an explicit declared gap if it cannot run non-interactively. Live receipts on both runtimes at release, as already required.
- **L-11 Verification obligations carried into delivery:** the first tickets must close these before relying on them: audit every reader of authority pins to show legacy members are never promoted; confirm bounded behaviour of `catalogue.lock` under pid reuse; record the result of upgrade → downgrade → upgrade as a known limitation unless it shows a hazard; define the legacy schema marker and version (the catalogue label `shipyard.role-archive-catalogue.v1` was reused when pins were added); check ordering with the run-store and planning-writer lease during adoption; measure Claude launch with no `CLAUDE_*`/`SHIPYARD_*` variables and the reader of `CLAUDE_HOME`; find which component writes the `.git/info/exclude` entries for provenance and runs and what happens in a fresh clone; decide whether GSD core exposes a reusable preflight.

## Consequences

- After install or upgrade the ordinary command works in an existing project with no manual `export`, no history cleanup and no knowledge of internal host commands; this is the readiness criterion.
- Host entry points are heavier and every host must call the shared preflight; a test must enumerate host entries so none is missed.
- `role-artifact.cjs` and `dispatch-record.cjs` change (authority admission); the change needs the runtime-digest refresh and the generated package regenerated, and touches the largest authority module.
- A parallel older host that writes after adoption blocks newer sessions until updated; this is intended and must be explained in its refusal.
- Rollback is a revert of the change; the added legacy catalogue field is additive and older hosts ignore it. Downgrade after adoption is not an acceptance gate.
- Subject strings change for Codex decomposition from the remote `owner/repo` form to the git-common path form; verification of already sealed artifacts must keep working.

## Out of scope

- A launcher CLI, a persisted launch context and a Claude preparation hook.
- Deleting, archiving or rewriting legacy history, and any trust shortcut that treats legacy files as authenticated.
- Changes to ADR-014 model or effort policy, provider fallback, or host admission rules beyond the adoption and preflight above.
- UI-SPEC, UI-review or `ui-phase` design (INV-015 owns UI lifecycle integration; this ADR only smokes the existing path).
- A cross-runtime coordination protocol beyond the catalogue lock, and extending `make doctor`.
- Mutating real user state, installed bundles or the user's project history during investigation or acceptance.
