# Risks

<!-- Record format: ## <risk> / severity / mitigation. Source: research/risks.md §4 (R-01…R-24), scenario matrix and acceptance needs N-1…N-11. -->
<!-- Mitigations are guards or directions, not chosen designs. -->

## Upgraded project with pre-existing provenance refuses every launch (R-01)
severity: high
mitigation: treat legacy sidecars as historical/unverified in a host-owned, receipted migration; never pin them as authenticated; keep refusal for new or altered members.

## Missing env or capabilities refuses with a misleading remedy and failures appear one at a time (R-02, R-06, R-16, R-17, R-18)
severity: high
mitigation: one discovery rule and one preflight that reports every incompatibility before `recordInflight`, with named, accurate remedies on both runtimes; probe CLI exit code must reflect unavailability (compatibility of callers unknown).

## Legacy records promoted to trusted evidence (R-03, R-23)
severity: high
mitigation: explicit legacy marker in the protected authority state; audit every reader of catalogue pins; negative tests for forged, altered and symlinked members.

## History deleted or moved as recovery (R-04)
severity: high
mitigation: no remedy text suggests deletion; upgrade tests assert history stays byte-identical.

## Rollback after migration is unproven (R-11, R-21)
severity: high
mitigation: idempotent, re-runnable migration that never rewrites legacy files; upgrade → downgrade → upgrade acceptance.

## ADR-digest / decomposition subject grammar divergence (R-13)
severity: high
mitigation: one build/parse module for both hosts, sealer and run-contract; one repository identity; round-trip acceptance on both runtimes.

## Mixed catalogue shapes, multiple Codex homes, dogfood vs global installs (R-05, R-08, R-09, R-14)
severity: medium
mitigation: explicit schema/marker (version number alone is not a usable marker), one home resolver, host N and N+1 acceptance, each install resolves its own home.

## Concurrent sessions and lock behaviour (R-10)
severity: medium
mitigation: named remedy and bounded wait; verify stale-lock handling under pid reuse.

## E2E harness leaks into real user state, generated package and digest pins drift (R-20, R-22)
severity: medium
mitigation: harness isolates HOME, XDG, graph dir and writer-lease roots and asserts the real roots are unchanged; regenerate the package and digest pin with the change.

## Capability auto-discovery changes a pinned explicit-evidence contract; stale capabilities accepted at launch (R-07, R-24)
severity: medium
mitigation: decide which sources count as explicit evidence and whether launch re-validates the ADR-014 grid and manifest digest; update pinned tests deliberately; no ADR-014 change.

## The fix itself becomes a launch bypass ("launched via the launcher" read as an admission signal) (R-23)
severity: high
mitigation: launcher and preflight mint no trust; hosts re-validate every value; test that direct host calls are still strictly admitted.

## Orphan pinned sidecars from failed launches (R-15)
severity: low
mitigation: spike S-1 showed they are pinned and do not block later launches; they only accumulate. Prefer probe before record so a refused launch leaves no sidecar and no new authority directory.

## Linked-worktree executor writes an unpinned sidecar that blocks the next project-root host (S-1)
severity: high
mitigation: MS1 admission must cover the unauthenticated write path, or that path must pin its sidecar; acceptance test with an executor followed by an integrator/arch-review on a project with legacy history.

## Repository identity contains whitespace and the subject grammars disagree on it (S2)
severity: medium
mitigation: one `repositoryIdentity()` and one character class and parse for every subject family; contract test with a space, a non-ASCII and a rejected character.

## Research baseline is stale (local main 9 commits behind origin/main)
severity: medium
mitigation: re-bind the design baseline to `v0.72.2` before decomposition; confirm behaviour at that revision by spike S-1.

## Parallel Codex and Claude sessions share one project's bookkeeping and one authority namespace
severity: high
mitigation: treat mixed-runtime concurrency as a first-class scenario: the catalogue lock must give a named, bounded outcome to the second session; MS1 adoption must be safe when another runtime writes sidecars at the same time; acceptance runs a Codex launch and a Claude launch concurrently on one project, including during adoption. Observed 2026-10-15: a Codex research launch (INV-015, 14:50Z) and this session's Claude research launch (14:59Z) both wrote sidecars into the same `.planning/graph/provenance/`.
