---
status: closed
closed: 2026-09-26
adr: .planning/architecture/ADR-020-target-project-delivery-at-scale.md
source: intake/findings-report.md (pdffiller Claude session b11246f1, 2026-09-25)
target_phase: 43 (one wave after phases 40, 41 and 42 are released)
---

# Problem

## What we are solving

The first delivery of a real target-project epic at scale (pdffiller MYD-17835: 13 tickets across
pdffiller, jsfiller, front-signature-flow, front-user-management, front-mobile-web and docs-platform,
Shipyard 0.63.0) reached its end only because the orchestrator did the conveyor's work by hand. The
defects that forced this are absent from Shipyard's own repository (single repo, `main`, tracked
`.planning/`, small tree), so `make test-fast` never saw them. Phase 40 was amended on 2026-09-25 to
take three of them (D-43 plan delivery to the sandboxed executor, D-44 per-repository sentinel,
D-45 per-repository PR title format). This investigation covers the rest and ends in an ADR for a
new phase 43.

Evidence: `intake/findings-report.md` (items 2 and 5–18), `intake/target-project-workarounds.md`
(the target project's own notes), and the transcript
`~/.claude/projects/-Volumes-KINGSTON-PhpstormProjects-pdffiller/b11246f1-9854-4094-aa8f-997e2b873ca6.jsonl`.

## For whom

Operators who run `/shipyard:deliver` (Claude or Codex) on target projects: large monorepos,
default branches other than `main`, phases spanning several repositories, untracked `.planning/`,
repository-specific CI, review bots and conventions, and pre-existing Jira issues.

## Current pain

- Verification: the Claude executor sandbox has no docker, php, network or dependencies, so 8 of 13
  tickets returned `blocked` after doing the edit; the orchestrator re-ran the checks, committed
  (signed, twice with `--no-verify`) and published them, and `sentinel merge` merged those commits
  although no executor receipt or trusted finalization covered them.
- Push and merge gates break on scale and non-`main` repositories: `publish-gate.cjs` resolves only
  `origin/main|main`; `run-reachability.cjs` hits ENOBUFS on a 27k-file tree; `sentinel.cjs`
  reads full recursive trees through `gh api`; a stale bot approval blocks merge forever.
- The orchestrator hand-builds host requests for research, decompose, arch-review and fix-round.
- Cost and wall time: ~23 arch-review launches for 13 tickets (base-merges that bring sibling
  squashes discard the verdict); 25 state-syncs with a 128 s median; `ci-wait` windows longer than
  the Claude Bash cap; CANCELLED checks sent to ci-fix; a whole arch-review lost to one unknown
  finding type.
- Friction that needed user decisions or silent workarounds: comment-policy versus annotations the
  target repository requires; human checkpoints blocking merges into the epic; no binding to
  existing Jira issues (export disabled, statuses moved by hand); decompose's ROADMAP blocking
  gsd-sync and `pipeline.gsd_sync` silently dropped; the conveyor's own scratch files making the
  role host refuse; a human escalation where the repository had an automatable remedy.

## What success will be

- A later rerun of a comparable multi-repository phase in a target project completes with no
  orchestrator-authored commits, no graph copies, no `.git/info/exclude` edits, no plugin-cache
  patches and no wrapper around the push hook.
- Every merge into an epic is backed by a verified executor (or fixer) receipt and trusted
  finalization; a hand commit is refused, with the command that brings it under the conveyor.
- Each fix above has a focused unit or fixture test that fails on base. The before/after numbers
  (state-sync time, arch-review launches per ticket) come from a later proving-ground rerun by the
  operator, outside phase 43.

## What is definitely out of scope

- Everything already in phase 40 (including D-43..D-45) and phase 41; this phase does not repeat
  or reshape their tickets.
- The ADR-014 model/effort grid, the resolver input schema and the receipt shape.
- Target-project code changes; the proving ground is evidence, not a work item.
