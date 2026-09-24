---
status: open          # open | closed — Gate 1 sets `closed`
closed:               # YYYY-MM-DD, filled in at Gate 1
adr:                  # path to .planning/architecture/ADR-NNN-*.md, filled in at Gate 1
---

# Problem

## What we are solving

Delivering phase 39 end to end through the shipped Claude hosts (2026-09-24) exposed
defects that ADR-017 / phase 40 (`.planning/phases/40-build-delivery-seams-and-clean-target-project-prs/`)
does not cover, and showed that the conditions for running a role inside a ticket
or integration worktree are nowhere specified or checked. Evidence:
`.planning/backlog/phase-39-delivery-findings.md` and the phase 39 PRs #204–#217.

Residual defects (numbering from the findings file):

- (4) `plugins/delivery-pipeline/scripts/claude-role-host.cjs` refuses a draft PR
  for arch-review, while `commands/deliver.md` undrafts only after `conform`.
- (5) The role host treats the executor's own scratch files
  (`.shipyard-pr-body.md`, `.shipyard-evidence.md`, `.shipyard-role-artifact.json`,
  `.shipyard-arch-review-evidence.md`) as local changes and refuses to dispatch.
- (6) A pr-sentinel round is discarded when any PR opens during it; the main loop
  opens PRs continuously, so the shared guard rarely completes.
- (7) A `conform` verdict never carries across a sibling merge (the base merge
  always brings content), so every epic merge re-owes arch-review for every open
  sibling and delivery becomes strictly serial.
- (8) An executor artifact becomes `STALE_ARTIFACT` when the epic moves between
  seal and publication; recovery is rebase + uncommit + re-dispatch.
- (12) `gsd-sync --check` fails a planning PR that changes plans without a fresh
  delivery-state observation for the new tickets.
- (new) The integrator cannot run: the epic diff (1.9 MB) exceeds the role host's
  `DIFF_MAX_BYTES` (1 MB); ~1.4 MB of it is `.planning`.

Worktree conditions audit: what a role needs to run inside a ticket/integration
worktree — restricted file tools versus plan/graph location, untracked scratch
files, tracked `.shipyard-role-artifacts/`, GPG signing, local versus origin refs,
reviewer mutation leftovers left uncommitted, reaper/gc — and which host checks
each condition before launch.

## For whom

The operator running `/shipyard:deliver` on Claude Code (primary) and Codex, and
the delivery loop that must reach a fixpoint without manual repairs.

## Current pain

Phase 39 needed ~10 manual interventions: moving scratch files, refreshing the local
epic ref, undrafting before review, discarding sentinel rounds, re-sealing an
executor after a base move, reverting a reviewer's leftover mutation, regenerating
projections for planning PRs, and 12 strictly serial review+merge cycles. The phase
still cannot finish because the integrator refuses the epic diff.

## What success will be

- Each residual defect has a deterministic fix with a focused unit or fixture test,
  delivered as tickets in phase 40 with correct `depends_on` on phase 40 tickets
  that touch the same files.
- The worktree conditions are specified in one place and checked by the hosts
  before launch, refusing with a named remedy (never a silent failure).
- Phase 40 (existing plus new tickets) is delivered and the integrator runs on the
  epic.

## What is definitely out of scope

- Anything ADR-017 already decides (dispatch entry point, sentinel preflight,
  pre-push gate, header-free YAML, PR hygiene, dogfood install root, sealer).
- The ADR-014 grid and the fail-closed boundary contract.
- Jira export of this work.
