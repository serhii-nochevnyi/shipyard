# Phase 40 plan check

**Phase:** 40, build delivery seams and clean target-project PRs
**Plans checked:** 26 (40-01..40-26), plus 40-CONTEXT.md
**Sources:** ADR-017, 40-CONTEXT.md, 40-RESEARCH.md, INV-004 DECISIONS (including "Phase 40 planning refinements"), REQUIREMENTS.md REQ-136..REQ-150, CLAUDE.md, phase-39 plans 39-01..39-12
**Cycles:** 3 (cycle 1 found the issues and fixed them; cycles 2 and 3 re-checked and fixed four more)

## Verdict

**PASSED after revision.** The initial plan set had 7 blockers and 3 warnings. I fixed all of them in the PLAN and CONTEXT files. No blockers or warnings remain. Three advisories are listed below.

`.planning/graph/tickets.json` predates these edits, because the graph changed. **Gate 2 (`validate-graph.cjs`) must be re-run** before delivery. A sanity run on a temporary copy of the phase-39 and phase-40 plans gave `OK — 38 ticket(s), 15 wave(s)`: no wave mismatch, no multi-parent warning and no contested path. That run is not the verdict.

## Findings and changes

### Blockers (fixed)

1. **[dependency_correctness] A ticket's worktree must contain the code of every ticket it imports, edits or needs for verification.**
   Evidence: `ticket-worktree.sh create <T> <branch> <base>` cuts one base, and `state-sync.cjs` resolves that base to the primary parent's branch or the epic. The validator says so: "the cascade bases on <primary> only; the others land through the epic". Nine tickets had a needed parent that was not on their primary chain:
   - T-40-13 (base T-40-01) edits `planning-result-sealer.cjs`, which T-40-10 creates.
   - T-40-11 and T-40-12 import T-40-10's sealer.
   - T-40-14 edits T-40-13's host files.
   - T-40-15 imports `sentinel-preflight.cjs` and `pr-hygiene.cjs`.
   - T-40-22 imports `host-provenance.cjs` and edits T-40-16's and T-40-19's files.
   - T-40-24 and T-40-25 have contract tests that resolve scripts from other tickets.
   - T-40-23 names T-40-11 and T-40-09, but only for its live run.

   Change: I rebuilt the graph so that every ticket has at most one same-phase parent and everything it needs is on its primary chain (CONTEXT D-36):
   - Spine: T-40-07 → 02 → 03 → 19 → 17 → 01 → 16 → 10 → 13 → 12 → 14.
   - Branches: 17 → 18 and 17 → 20; 12 → 25; 14 → 15 → 23 → 26; 15 → 24; 14 → 05 → 04 → 11 → 09; 05 → 21 → 22; 07 → 08. T-40-06 stays a root.
   - Real needs dropped as `depends_on`: 23←11 and 23←09 (live-run preconditions, now stated in its checkpoint), 25←11, 26←06 and 26←21 (verified with `make -n` only), 24←19 (prose only).
   - Redundant parents removed: 14←01, 24←16/17/03, 26←07/17.
   - Four edges have no code need and exist only to linearize: 02←07, 01←17, 10←16, 05←14. Each plan's "Graph position" bullet names the child that needs the edge.
   - Three edges now have a stated reason: 17←19 (hygiene rejects `gate_status:` until T-40-19), 04←05 (the remedy names a Codex-safe `gsd-tune`), and 16←01 (the `claude-role-host` test needs T-40-01's harness on a signing host).
2. **[verification_derivation] `wave` equals the computed depth.** All 26 frontmatter waves are now set from the revised graph, including the cross-phase T-39 parents.
3. **[requirement_coverage, REQ-137] The contract test must refuse inline shapes for a registered boundary.**
   Evidence: T-40-07's only Codex pattern was a JSON string (`"type":"thread.started"`). All three Codex consumer tests fabricate records as object literals (`codex-runtime-host.test.cjs:42-58`, `codex-decompose-host.test.cjs:301-304`, `codex-delivery-host.test.cjs:225-227`), so the check would have passed without testing anything.
   Change:
   - T-40-07: the patterns cover both forms; the scan covers all unit tests; the three files start in a `migrating` list that must shrink; capture also records the `codex exec --json` stdout.
   - T-40-09: migrates all three consumers (files added: both host tests and `codex-agent-stream-exec.jsonl`; depends on T-40-11, T-39-01) and ends with `migrating` empty.
   - T-40-11, T-40-12 and T-40-14 add no new inline records.
   - T-40-08: the Claude patterns are specific to stream-json, so the session-transcript tests are not flagged (D-37).
4. **[task_completeness, REQ-137] T-40-07's own test must be able to pass.**
   Evidence: measured, `tests/fixtures/codex-agent-child-0.155.1.jsonl` contains `/home/fixture-user/…`. Check (2) required the 0.155.1 files to pass the path rule, and the plan said "stop and escalate" if they failed.
   Change: those files are listed under `legacy` and must pass the token rules only. T-40-09 empties `legacy`.
5. **[context_compliance, D-19] Commit subjects in target projects carry no ticket id.**
   Evidence: `workflows/executors.mjs:188` defaults `deliveryRulesHint` to "commit atomically with a (T-id): prefix". Only `prBodyGuide` was being overridden.
   Change: T-40-17 exports `NEUTRAL_DELIVERY_RULES_HINT`. T-40-15 sets it for target projects and tests that it does (D-38).
6. **[context_compliance, D-16 × D-07] The confirmed untrack migration passes the publish-time hygiene gate.**
   Evidence: the rule "no path starts with `.planning/`" over `git diff --name-only` rejected the migration's own deletions, and T-40-20 runs the gate on epic PRs.
   Change: T-40-17 rejects added, modified, copied or renamed `.planning/` and `.shipyard/` paths, and allows deletions (`--name-status`). A test shows the migration branch passes and an added `.planning/` file fails (D-39).
7. **[scope fence, D-06/D-21] The live round uses each role's base rung.**
   Evidence: T-40-23 stated this intent but had no way to enforce or check it. A decomposed ticket with `risk: high` or `checkpoint` would have promoted the executor, and stages recorded no model.
   Change:
   - The round passes no promotion signal and refuses tickets that would promote.
   - Each stage records the requested and applied model/effort from its ADR-014 application receipt. It fails unless both equal the base rung the existing resolver returns.
   - `live-receipt check` fails a receipt when applied differs from requested or a stage is missing.
   - The live PR is published through hygiene check → `gh pr create` → `pr-ledger.cjs record`.
   - The human-action run requires T-40-01..22 merged into the epic and the epic merged into the branch.

   (D-40.)

### Warnings (fixed)

1. **[requirement_coverage, REQ-146 on Codex]** T-40-25 documents a single-line re-dispatch command for both runtimes, but only the Claude path implemented one. Change: T-40-12 accepts `lines: [<id>]` with `verifySealedLine` sibling checks and tests for it. This is a real code need, so T-40-12 now depends on T-40-13 (D-41).
2. **[verification_derivation] T-40-06 edits `.github/workflows/test.yml`, whose content `tests/smoke/docs-smoke.sh` asserts.** Change: `bash tests/smoke/docs-smoke.sh` added to its verification and acceptance.
3. **[research_resolution]** The heading `40-RESEARCH.md ## Open Questions` is not marked RESOLVED. Change: CONTEXT now maps Q1..Q8 to D-16..D-24, D-38 and D-40. RESEARCH.md was left unedited, because this review may only edit PLAN and CONTEXT files.

### Advisories (info, no revision required)

1. **[dependency_correctness]** Once T-39-06 lands, its "shares no files_modified" warning will fire on the four linearization edges and on the import-only dependencies (for example 15←14, 22←21, 12←13). This is expected and recorded in D-36.
2. **[scope_sanity]** The graph is now 15 waves deep instead of 7. This is the price of correct bases. Only T-40-07, 02, 03, 19, 17, 18, 08 and 06 can run before phase 39 is on `main`.
3. **[key_links]** On Claude, the sentinel preflight runs twice: in T-40-15 (for `pr-sentinel`) and in T-40-16 (`prepareSentinel`). It is idempotent, so this is harmless.

## Dimension summary

| Dimension | Result |
|---|---|
| Requirement coverage, REQ-136..REQ-150 | Every requirement is claimed in frontmatter and has scoped tasks (CONTEXT source audit updated) |
| ADR-017 scope fences | Unchanged: the ADR-014 grid, resolver input (T-40-15 never forwards `type`), receipt shape and fail-closed verification. Provenance is a sidecar keyed by `dispatch_id` (T-40-22). The entry point calls the existing hosts. The live round uses base rungs (enforced now). The Shipyard repository is exempt through `applies({root, ref})`. Legacy `ticket/` PRs still match (T-40-03). |
| files_modified completeness and disjointness | Complete after the additions to T-40-09. There are no dependency-unordered overlaps. |
| Cross-phase dependencies | Every phase-39 file overlap carries its exact T-39 dependency, and no T-39 dependency lacks an overlap |
| Order-only dependencies | None, apart from the four documented linearization edges |
| Human-action checkpoints | Live captures (T-40-08, T-40-09) and the live round (T-40-23) are human-action. T-40-11 is human-action. T-40-14, 19, 21 and 22 are human-verify. Every risk-high ticket has `human_checkpoint: true`. |
| Verification commands | Scoped per file and runnable offline. Network checks are marked CI or operator only. |
| Hermetic tests | Tests use `os.tmpdir()` and their own `GIT_CONFIG_GLOBAL`. T-40-01 hardens the harness. |
| TDD | Every plan writes its failing test first |
| Acceptance criteria | Observable: exit codes, named refusals, file content, digests |
| CLAUDE.md | Canonical plugin first, installers only in the two scripts, `set -euo pipefail`, focused tests per rule, README updated with the command surface (T-40-26) |

## Files changed

- `40-01`..`40-26-PLAN.md`: `wave` and `depends_on` in every plan. "Graph position" notes in 01, 02, 04, 05, 09, 10, 15, 16, 17, 22, 24, 25 and 26. Scope, acceptance and verification edits in 06, 07, 08, 09, 11, 12, 13, 14, 15, 17 and 23.
- `40-CONTEXT.md`: D-35 revised; D-36..D-41 added; open-question resolution map; cross-phase gating paragraph; ticket map regenerated from the plans; source audit rows for REQ-137, REQ-146 and D-36..D-41.
