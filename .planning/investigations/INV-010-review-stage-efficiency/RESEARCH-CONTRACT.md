# Research contract — INV-010 (review-stage efficiency in cascaded PRs)

Read-only research. Do not edit code or any file except your own artifact.

## Inputs
- `PROBLEM.md` (this directory).
- Accepted designs that bound the scope:
  - `.planning/architecture/ADR-014-*.md` (model grids);
  - `ADR-017-*.md`, `ADR-019-*.md`;
  - `ADR-020-*.md` (host-side verification, own-diff verdict carry);
  - `ADR-021-*.md` (exact-input arch-review reuse and single-flight).
- Owners that must not be duplicated:
  - `.planning/phases/43-*/43-13-PLAN.md` (verdict carry across base merges, not started);
  - `.planning/phases/45-*/WORK-PACKAGES.md`, workstream C: C1 (exact-input reuse), plus R10 (environment-only adjudication), R12, R13 (N44/N46) and D4 (drift reuse);
  - the INV-008 intake findings N44, N46, N54 and N57 in `.planning/investigations/INV-008-residual-pipeline-efficiency/intake/phase40-delivery-findings.md`.
- Source:
  - `plugins/delivery-pipeline/commands/deliver.md` (Step 4 and the sentinel), `references/arch-review.md`, `references/pr-sentinel.md`;
  - `plugins/delivery-pipeline/scripts/` — in particular `claude-role-host.cjs`, `codex-delivery-host.cjs`, `sentinel.cjs`, `front.cjs`, `state-sync.cjs`, `base-merge.cjs`, `gate-trailer.cjs`, `degenerate-green.cjs`, `drift-needed.cjs`, `model-policy*.cjs`;
  - `plugins/delivery-pipeline/workflows/`, and `tests/unit/`.
- Journal evidence: `.planning/graph/delivery-log.jsonl` and `.planning/graph/delivery-state.json`. The phase-43 and phase-44 ticket PRs can be read on GitHub with `gh pr view <n> --json`, read-only.
- Everything else you need is inside this worktree. Do not read paths outside it and do not call any provider account API.

## Questions to answer
1. **Launch timing.** Which events today make an existing review verdict stale in a cascade, and at which point in the ticket lifecycle is a review launched? Is it launched before CI completes, before the base stops moving, or while a parent PR is still open?
2. **Review input.** What exactly does a review judge today: the whole PR against its base, or the ticket's own patch? How much of a typical reviewed diff in phases 43 and 44 was the ticket's own change?
3. **Carry and reuse.** How do the T-43-13 own-diff carry and the C1 exact-input reuse combine? Which stale cases remain after both, and what additional carry rule is still safe?
4. **Deferral options.** Defer review until the stack stabilizes, review once per stack, or review parent-first and then carry to children. What are their latency and correctness trade-offs?
5. **Environment findings and preconditions.** How should environment-only findings (N57) and host preconditions (draft PR, N46) be handled before a model turn is spent?
6. **Model and effort by diff size.** What would that look like under ADR-014? Treat it as an option only.

Every claim about the codebase carries a file path; every number carries its source.
