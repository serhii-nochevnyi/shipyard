---
status: closed
closed: 2026-09-10
adr: .planning/architecture/ADR-013-gsd-workflow-synchronization.md
---

# Problem

## What we are solving

Shipyard delivery state and native GSD planning state must form one closed,
resumable workflow. The delivery graph already describes ticket execution, but
GSD cannot currently see the resulting state because the native projection is
missing or stale.

## For whom

For maintainers and agents operating this repository through either Claude Code
or Codex, especially after a session boundary, interrupted delivery run, or a
phase transition.

## Current pain

- `gsd-tools query validate.health --raw` reports a broken project because
  `.planning/STATE.md` is absent.
- `.planning/REQUIREMENTS.md` is absent even though requirements are present in
  `.planning/ROADMAP.md`.
- The delivery graph contains 79 plans/tickets and records them as merged, but
  there are no native GSD `*-SUMMARY.md`, `*-UAT.md`, or
  `*-VERIFICATION.md` artifacts for the delivery result.
- Shipyard documentation explicitly replaces GSD execute/ship with the delivery
  loop in `docs/gsd_multilevel_delivery_pipeline.md`, but it does not publish a
  native GSD state projection after that replacement.
- GSD and Shipyard therefore answer different questions after a restart:
  delivery reports historical execution while GSD reports zero plan progress.

## What success will be

1. One deterministic, local-only synchronizer derives native GSD artifacts from
   PLAN files, the validated ticket graph, delivery state, and integration
   evidence.
2. The synchronizer is idempotent, atomic, checkable without mutation, and
   safe to run from both runtimes.
3. The GSD lifecycle invokes the synchronizer at planning, delivery, verify,
   and ship boundaries; a failed or stale projection blocks the boundary when
   the conveyor is active.
4. Generated summaries and verification artifacts report facts without
   converting missing integration evidence or `needs-fix` findings into a
   false pass.
5. `STATE.md`, `REQUIREMENTS.md`, GSD progress queries, the delivery graph, and
   the Shipyard front all describe the same current position.

## What is definitely out of scope

- Replacing GitHub as the source of truth for live PR/check state.
- Rewriting the delivery DAG, ticket plans, or historical integration reports
  merely to make progress look complete.
- Automatically deleting stale worktrees or making external tracker mutations.
- Claiming a phase is verified without repository evidence or a recorded
  integration verdict.
- Hand-editing generated Codex bundles or installed capability copies.
