---
status: accepted
---
# ADR-020 — target-project-delivery-at-scale

- **Status:** accepted
- **Date:** 2026-09-26
- **Decision owner:** repository maintainer; decisions taken in the INV-007 dialogue
- **Scope:** phase 43, delivered in parallel with phases 40 and 42 as tickets become ready (amended 2026-09-26; phase 42 is T-42-01, trusted finalization resume, split from T-41-04); implementation details belong to its plans
- **Supersedes:** none
- **Related:** ADR-004, ADR-008, ADR-014, ADR-017 (phase-40 amendment D-43..D-45), ADR-019
- **UI design:** none

## Context

The first delivery of a real target-project epic at scale (pdffiller MYD-17835: 13 tickets across six
repositories, Shipyard 0.63.0, session b11246f1 on 2026-09-25) finished only because the orchestrator
did the conveyor's work by hand: it verified and committed eight tickets itself, copied the graph into
worktrees, edited `.git/info/exclude` in six repositories, patched the installed plugin cache, wrapped
the pre-push hook, re-ran cancelled CI and moved Jira statuses. The defects are absent from Shipyard's
own repository (one repository, `main`, tracked `.planning/`, small tree), so `make test-fast` never
saw them. Three of them went into phase 40 as D-43..D-45 (plan delivery to sandboxed agents, per-repository
sentinel, per-repository PR title format). Investigation `.planning/investigations/INV-007-target-project-scale/`
covers the rest; evidence with file:line and timestamps is in its `RESEARCH.md` and `research/`.

## Decision

- Executor work is verified host-side: the trusted host, outside the agent sandbox, runs only the verification commands declared in the approved plan that match a project allow-list, as argument arrays with timeouts and bounded output, records the result as finalization evidence (or a sealed artifact referenced by digest), finalizes only on pass, and returns failures to a bounded executor or fixer round; the agent sandbox is not widened and the receipt shape does not change; Codex reuses the same host path.
- The merge gate refuses a head that the conveyor does not cover, for PRs opened after this phase is released: every commit since the ticket's base must be a verified executor or fixer receipt with trusted finalization, a journalled base-merge, or a declared remedy-workflow commit; any other commit refuses with the command that brings it under the conveyor; PRs opened earlier keep today's rule and are marked legacy in the journal; both runtimes' merge paths.
- A conform verdict carries across a base-merge when the ticket's own patch is identical (`git patch-id --stable`, or identical blobs for every `files_modified` path) and every other path equals the new base; any other difference re-owes arch-review; the carry posts the `merge-gate` commit status introduced by T-40-19.
- `human_checkpoint` takes `review` (a human approves the PR, then the guard merges into the epic) or `merge` (the human merges, also used for external-dependency holds); `true` keeps meaning `merge`, `preauthorized: true` keeps working, Gate 2 states the consequence of each value, and `pipeline-stats` keeps attributing guard merges separately.
- Target repositories may declare extra allowed comment markers as exact tokens in the project's `.planning/config.json`, keyed by `owner/repo` and read through `loadConfig`; a changed line whose pre-image was already a comment is not an addition; net-new free comments still block; the built-in markers and Shipyard defaults are unchanged.
- Pre-existing Jira issues are bound by key: decompose proposes the ticket-to-issue mapping, the human approves it with the ticket set at Gate 2, a recorded key is authoritative (lookup by key, never create, refuse an unknown key), and issues without the shipyard label are only transitioned and commented.
- Only operator-declared repository remedy workflows (per repository: failure signature, workflow, inputs) run before a human escalation, bounded by the attempt budget and journalled; a commit such a workflow pushes is a declared link of the merge gate's chain and still goes through arch-review and CI; nothing undeclared is discovered or run.
- One exported definition of the conveyor's scratch files is used by the role host, the finalizer, the Codex delivery host, base-merge and gc; any other untracked file still blocks the role host, whose status read no longer fails on large output; no `.gitignore` or `info/exclude` writes.
- A stale approval from a declared bot does not block a merge when the target branch requires no review or a human approval exists on the current head; a stale human approval still blocks; otherwise the guard re-requests the review once and escalates with the command; bot identities become configurable.
- A CANCELLED check superseded by a newer run is ignored and a lone cancelled latest run gets one journalled `gh run rerun` that is never green and does not count against `max_attempts`; on Claude one `ci-wait.cjs` call returns within 540 s unless `--timeout` is explicit, with the window budget accumulated across calls.
- `pipeline.gsd_sync` is honoured as a deprecated alias with the warning on the state-sync summary line, decompose writes its phase into ROADMAP in the shape gsd-sync reads, and plans of a phase absent from ROADMAP produce one summarised warning instead of a per-plan block.
- `publish-gate.cjs` resolves the base from the ticket's recorded base and then the repository's `origin/HEAD` before the `origin/main`/`main` fallback, the pre-push hook passes the ticket for ticket branches, and an unresolved base still refuses.
- Reachability checks ask bounded questions: `run-reachability.cjs` uses O(1)-output git forms with a large `maxBuffer`, and `sentinel.cjs` compares only declared paths through local git when the repository is checked out, with a path-scoped API fallback that still refuses a truncated listing.
- `deliver-dispatch.cjs` builds research, decomposition, arch-review, ci-fix and review-fix requests from the graph and the investigation directory, each round-tripping through the host's exported validator, with Codex parity or a named reason.
- `state-sync.cjs` lists PRs by ticket head and open state instead of `--state all --limit <pr_fetch_limit>`, and does not re-derive tickets whose merge into a landed epic is recorded immutably; `--full` re-derives everything.
- An arch-review finding of unknown type is kept as an informational note with its original type and never changes the verdict; a violation or an incomplete blocking finding still fails the artifact.
- Phase 43 is delivered in parallel with phases 40 and 42: each ticket starts as soon as its graph dependencies have landed, and a ticket that shares a file with a pending phase-40 or phase-42 ticket waits for that ticket through a cross-phase dependency (amended by user decision 2026-09-26; previously one wave after the release of phases 40, 41 and 42); every fix carries unit or fixture tests that fail on base, and the before/after measurements come from a later proving-ground rerun by the operator, outside the phase.

## Consequences

- Target-project runs stop depending on orchestrator hand work: verification, commits, pushes, base resolution, cancelled checks and scratch files are the conveyor's responsibility, and a hand commit can no longer reach an epic unnoticed.
- The merge gate becomes stricter and the verdict carry looser; both are provable from object identities and journal records, not from judgement.
- New project-config keys (comment markers, remedies, bot identities) follow D-45: registered in `pipeline-config.cjs`, keyed by `owner/repo`, `delivery_pipeline.*` wins, bad shapes warn and fall back.
- Phase 43 no longer waits for phase 40's release as a whole, but about half its tickets rewrite files phase 40 still owns (`sentinel.cjs`, `claude-role-host.cjs`, `state-sync.cjs`, the delivery hosts, `pipeline-config.cjs`, `role-artifact.cjs`, `gate-trailer.cjs`).
- Host-side verification adds wall time to the host per ticket and makes plan-declared commands an operator-authority path, bounded by the allow-list.
- The success numbers are not produced by the phase itself; they need the operator's proving-ground rerun.

## Out of scope

- Everything in phase 40 (including D-43..D-45) and phase 41.
- The ADR-014 model/effort grid, the resolver input schema and the receipt shape.
- Widening any agent sandbox (network, docker, reads outside the worktree).
- Target-project code changes and the proving-ground rerun itself.
