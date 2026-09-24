# ADR-018 — worktree conditions and residual delivery seams

- **Status:** accepted
- **Date:** 2026-09-24
- **Decision owner:** repository operator
- **Scope:** Shipyard role, delivery and decompose hosts, worktree lifecycle and gate carry on Claude Code and Codex
- **Supersedes:** none
- **Related:** ADR-006, ADR-014, ADR-016, ADR-017, INV-005
- **UI design:** none

## Context

Phase 39 was the first end-to-end delivery through the shipped Claude hosts. It
exposed defects that ADR-017 does not cover and showed that the conditions for
running a role inside a ticket or integration worktree are neither specified nor
checked. INV-005 traced each to code at the epic 39 tip:

- `claude-role-host.cjs:363,826` refuse a draft PR for arch-review, while
  deliver undrafts only after `conform`;
- `claude-role-host.cjs:123-124` refuse any untracked file, including the
  conveyor's own scratch; five places treat the scratch set four ways; a role's
  out-of-scope mutation is left in place (`:796-813`);
- a sentinel round fails when a non-member opens a PR (`:841-848`, `:885-891`);
- `gate-trailer.cjs` carry requires unchanged head and base trees, so no verdict
  survives a sibling merge (`:450-454`, `:519-524`);
- executor artifacts bind to the live base tip and go `STALE_ARTIFACT` on any epic
  move (`role-artifact.cjs:568-603`);
- `gsd-sync --check` blocks planning PRs that add tickets (`gsd-sync.cjs:603-613`);
- the integrator refuses the epic diff: 1.94 MB against a 1 MiB diff and 1.5 MB
  prompt bound, 1.47 MB of it `.planning` (`claude-role-host.cjs:19-24,341-345`).

Detail: `.planning/investigations/INV-005-worktree-and-residual-seams/`.

## Decision

- All residual fixes and the worktree-conditions work land as new phase 40 tickets that depend on the phase 40 tickets modifying the same files.
- A conform verdict carries across a sibling merge only when git tree objects prove the ticket's own change is identical and the base move touched no path the ticket declares or changes; otherwise arch-review is re-owed, and the carry is built on T-40-19's commit-status carrier.
- One worktree-conditions module defines scratch and host-owned files and the launch preconditions (clean tracked tree, role evidence path absent, plan and graph inside the worktree, fresh base ref, usable signing where a host commits), and every role, delivery and decompose host checks it before launch with a copyable remedy.
- `ticket-worktree.sh` prepares worktrees by construction: it writes `.git/info/exclude` entries for the registry's scratch files and offers a `verify` subcommand backed by the same module.
- A role's out-of-scope worktree mutation is restored by the host and reported, never left for the next launch.
- Executor artifacts are validated in a historical mode against their recorded base commit and tree at publication, and the PR opens against the live base for the normal base-merge.
- The integrator judges the full code diff excluding `.planning/` and `.shipyard-role-artifacts/` plus a name-status and blob-digest summary of `.planning`, and refuses with a named remedy when a bound is still exceeded.
- Arch-review accepts a draft PR, while the sentinel and the merge gate keep refusing drafts.
- A sentinel round excludes PRs opened after its snapshot and never acts on or reports them; changed members still expire.
- The planning flow writes a deterministic pending delivery observation for new tickets so `gsd-sync --check` stays offline and fail-closed.

## Consequences

- Phase 40 grows by a set of tickets ordered after T-40-16, T-40-18, T-40-19,
  T-40-22 and T-40-24 where files overlap.
- Parallel arch-reviews stay valid across disjoint sibling merges; overlapping
  merges still serialize.
- Worktrees need no manual cleanup between roles; refusals name the command.
- The integrator can run on phases whose planning volume exceeds the diff bound.
- Installer and host changes reach operators only after reinstall.

## Out of scope

- Decisions already taken in ADR-017 (dispatch entry point, sentinel preflight, pre-push gate, header-free YAML, PR hygiene, dogfood install root, sealer).
- The ADR-014 model/effort grid and the fail-closed receipt contract.
- Carrying verdicts on diff-text or patch-id comparison.
- Jira export of this work.
