---
status: open
closed:
adr:
---

# Problem

## What we are solving

Prepare phase 41 to reduce avoidable model context and repeated pipeline work,
after phase 39 and before phase 40. The user authorized starting phase 41 in
this session on 2026-09-25. Intake is derived from the preceding audit and
explicitly requested phase scope; no additional product preferences are needed.

## For whom

The repository maintainer running Shipyard development on subscription-backed
Claude and Codex runtimes.

## Current pain

Today's local Claude snapshot has 861 responses and 252,061,225 processed input
tokens, 97.46% cache reads. Parent sessions account for 54.74% of input. Six
false stop-hook replies process 5,097,592 input tokens; the second T-39-16
executor pass adds 4,822,956 input tokens during host/base recovery. Judgment
packets include the entire 203-section backlog. See the linked audits for
methods, source identities and limits: these are not subscription-credit totals.

## What success will be

Meet P41-A–F in ../../phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:
measure installed packet behavior, bound parent continuation, prevent foreign
or unchanged-wait wakeups, recover finalization without unnecessary execution,
localize projection fingerprints and report comparable outcome-linked usage.
Preserve independent review and all correctness gates.

## What is definitely out of scope

Duplicate T-39-17, lower model floors, bypass integration review, overwrite
another worktree, or implement phase-40 provenance/schema features twice.
No promise of a fixed subscription saving from token totals.

## Execution context

- Investigation runtime: Codex, from installed pipeline-config resolution.
- Research baseline: main at 4830411b; phase 39 changes remain separately owned.
- Phase 39 integration PR #215 was OPEN at kickoff; T-39-17 had no implementation
  PR at the check. Recheck before implementation; these are timestamped signals,
  not permanent blockers to research or planning.
- This INV number was reserved in prior Claude-session discussion; no matching
  INV/ADR file existed in registered worktrees at kickoff. Reconcile any later
  parallel artifact rather than overwrite it.
