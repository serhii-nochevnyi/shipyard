---
status: accepted
---
# ADR-023 — residual-pipeline-efficiency

- **Status:** accepted
- **Date:** 2026-09-28
- **Decision owner:** repository maintainer; decisions taken in the INV-008 dialogue
- **Scope:** phase 45 (S1, P1–P5, D1–D6, R1–R18). C1–C4 keep the ADR-021 contracts and review timing keeps ADR-022. Implementation details belong to the phase-45 plans.
- **Supersedes:** none
- **Related:** ADR-014, ADR-020, ADR-021, ADR-022
- **UI design:** none

## Context

[INV-008](../investigations/INV-008-residual-pipeline-efficiency/) examined the phase-45 packages against release 0.68.0. The packages come from the phase-40, phase-43 and phase-44 delivery findings N1–N59, the three phase-45 research notes and the audits.

What the research found:
- **S1 is still present.** The armed Stop gate takes the newest board across worktrees and has no `disarm` (`stop-gate.cjs:515-531`).
- **Phase 43 is not on `main`.** 14 of its tickets are unmerged, and most R and D packages touch files declared by those tickets.
- **Some packages are independent** of phase-43 files: S1's core, P1, P2, P4, R9, R16, R13's `usage-report` part and an advisory D5 ledger.
- **Some items are already fixed:** N47, and N43 in part.

Measured waste:
- phase 44: Sonnet executors about 56% of child consumption, the orchestrator about 29%, reviews about 11%;
- phase 43: outer Codex coordination about 84.6% of measured Codex input.

## Decision

- Phase 45 is delivered correctness-first: correctness fixes whose core files lie outside unmerged phase-43 `files_modified` ship first, packages on phase-43 files take a cross-phase `depends_on` on the owning T-43 ticket or wait for the phase-43 epic, and efficiency treatments are rolled out one at a time and measured on matched cohorts.
- The armed Stop-gate marker binds the realpath of the delivery board chosen at arm time, the hook reads only that board with no newest-wins fallback while a binding exists, an unbound legacy marker has a bounded behaviour, and `stop-gate-arm.cjs disarm` removes the session's own marker.
- Plans declare human preconditions as `preconditions:` with explicit artifact paths in the sandbox `TMPDIR` or the worktree; Gate 2 validates them and dispatch refuses before any model turn when a precondition is unmet.
- Dogfood installs target a dedicated runtime home by default, the doctor and release preconditions classify another session's dogfood cache as foreign instead of a release error, and the pre-push hook checks the worktree that is actually pushed.
- The executor host persists the bounded result, PR body and evidence in private host state keyed by dispatch id and bound by digest to the finalization candidate before a signed commit becomes publishable, and recovery replays those same bytes through seal, validate and read without another executor turn, refusing when they are absent.
- Reviewer and executor results record a typed `environment_failure` for setup or permission failures before assertions; an environment-only violation is resolved only by a separate human-signed, audited gate record on an unchanged head, base and instruction set with exact same-command evidence, and the original violation is preserved.
- A clean base move is handled first by a spike on a GitHub merge queue for `epic/*` branches, then by a host merge-result attestation if the queue is unavailable, with `base-merge.cjs` kept as the fallback and no changed-base review ever declared conform.
- A host-side duty diff wakes a model sentinel only when the actionable set changes, after S1 is installed.
- An aggregate admission ledger on `capacity-lease.cjs` runs in advisory mode first and enforces only after measurement, always reserving verification and checkpoint capacity.
- Outer Codex coordination sessions record their identity and inherited model now; a bounded handoff with a Luna/max candidate for routine stages follows only an approved phase-44 effort experiment and a recorded human decision, with native ADR-014 routing unchanged.
- Planning gets a planning-tree writer lease with a fencing token, recovery of a completed judgment role from its durable reservation and authenticated transcript without relaunch, deterministic pre-validation before the checker, a blocking `dispatch wait` for decomposition, and exact-revision INV reuse after C3.
- The input identity shared by C1, D4 and P5 is the context-packet identity core (source revision, policy hash, packet digest) with per-consumer extensions.

## Consequences

- S1 and the independent correctness fixes can be decomposed and delivered now, alongside phase 43. The rest waits on specific phase-43 tickets, which Gate 2 enforces through cross-phase dependencies.
- The hot files need one serialized owner each:
  - `sentinel.cjs` / `front.cjs`;
  - `claude-role-host.cjs`;
  - the finalizer and delivery hosts;
  - `deliver.md`, `decompose.md` and `dispatch-boundary.cjs`.
- Environment-only violations still need a person, but they no longer need another full review.
- Every efficiency treatment reports `inconclusive` until matched cohorts exist. No savings percentage is promised.

## Out of scope

- A global model downgrade, a change to the ADR-014 grids, cross-provider fallback or scheduling, automatic session transfer, and an always-on sentinel daemon.
- Deterministic adjudication of environment findings, until the human-signed record has proven itself.
- Reopening ADR-021 (C1–C4) or ADR-022.
