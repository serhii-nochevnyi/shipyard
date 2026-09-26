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

## Amendment after user review

**Date:** 2026-09-24. **Decision (user):** Chaining the phase linearly to fix bases made it 15 waves deep. Replace that chain with the real dependency graph, and fix the conveyor so a diamond child is delivered correctly (CONTEXT D-42). This supersedes the single-parent rule in blocker 1 and in D-36, and advisory 2.

### Graph changes

1. **Four linearization edges removed.** The plan-check itself said none of them carries a code need: T-40-02←07, T-40-01←17, T-40-10←16, T-40-05←14. The "Graph position" bullets in 01, 02, 05 and 10 have been rewritten.
2. **Children get their needed parents directly.** These are the parents they used to reach only through those four edges:
   - T-40-09 and T-40-26 ← T-40-07.
   - T-40-15, 23, 24 and 25 ← T-40-17.
   - T-40-15, 22 and 24 ← T-40-16.
   - T-40-22, 11 and 09 ← T-40-14.

   The bullets in 04, 09, 11, 15, 17, 22, 23, 24, 25 and 26 now name the primary parent and the parents that reach each child through the epic.
3. **Two orderings the removed chain used to give, kept as real file edges.** Without them, Gate 2 would see dependency-unordered overlaps:
   - T-40-10 ← T-40-01. T-40-10's verification runs `claude-delivery-host.test.cjs` and needs T-40-01's hermetic harness, a need the plan-check had already stated. This edge also orders T-40-01 before 13, 12, 14 and 09, which edit the same two host test files as T-40-01.
   - T-40-22 ← T-40-19. Both edit `sentinel.cjs`.
4. **Unchanged.** Every other plan-check change is kept: the edges with stated reasons (17←19, 04←05, 16←01, 12←13) and every cross-phase T-39 dependency.
5. **Waves.** Every frontmatter `wave` is recomputed as 1 + the maximum wave of the ticket's same-phase and cross-phase parents. Phase-39 tickets count at their own waves: all are 1 except T-39-09 at 2. The resulting waves:
   - 01:2, 02:1, 03:2, 04:3, 05:2, 06:2, 07:1, 08:2, 09:8
   - 10:3, 11:7, 12:5, 13:4, 14:6, 15:7, 16:3, 17:4, 18:5, 19:3
   - 20:5, 21:3, 22:7, 23:8, 24:8, 25:6, 26:9, 27:6

   The phase is now **9 waves deep instead of 15**.

   I measured this on a temporary copy of the phase-39 and phase-40 plans: `validate-graph: OK — 39 ticket(s), 9 wave(s)`, with no wave mismatch and no contested path. A script over every plan's `files_modified` also found no dependency-unordered overlap. `.planning/graph/tickets.json` must still be regenerated (Gate 2) before delivery.

### Diamond children (primary parent → parents that must land in the epic first)

| Child | Primary parent | Must land in the epic first |
|---|---|---|
| T-40-09 | T-40-11 | T-40-07, T-40-14 |
| T-40-11 | T-40-14 | T-40-04 |
| T-40-15 | T-40-14 | T-40-17, T-40-16 |
| T-40-22 | T-40-14 | T-40-21, T-40-16, T-40-19 |
| T-40-23 | T-40-15 | T-40-17 |
| T-40-24 | T-40-15 | T-40-17, T-40-16 |
| T-40-25 | T-40-12 (tie on depth with T-40-17, lowest id) | T-40-17 |
| T-40-26 | T-40-23 | T-40-07 |

### T-40-27 (new): conveyor fix for diamond children

**Why this ticket exists.** A ticket worktree is cut from its primary parent's branch only. Without a fix, a diamond child would be offered as ready while its other parents are only branched, and it would run in a tree that lacks their code. The backlog entry `diamond-child-base-is-materially-incomplete.md` measured this on T-20-06.

**What T-40-27 does.**

- `state-sync.cjs` keeps branched-is-enough for the primary parent. It blocks on every non-primary same-phase parent until that parent has landed in the epic, either merged into it or merged into a stacked branch that itself landed. The board line gives the reason.
- `ticket-worktree.sh create` merges `origin/<epic>` into a fresh diamond branch. On a conflict or a missing epic it refuses and leaves nothing behind.
- `scope-gate.cjs` and `delivery-commit-finalizer.cjs` measure a diamond child's own work against the merge of its base and the epic. Without that, both would reject the merged epic content as out of scope, because the hosts pass the primary branch tip as `expectedBase`.
- The shared computation lives in the new `diamond-parents.cjs`.
- The fixtures are a two-parent diamond. The child is not ready while the non-primary parent is only branched. After that parent merges, the child is ready, its tree holds both parents, and its own PR reads merged.
- The ticket closes the backlog entry. The waiting rule replaces that entry's "Deliberately NOT the fix" paragraph.

**Graph position.** T-40-27 depends on T-40-18, the last earlier writer of `delivery-commit-finalizer.cjs`. Its primary chain holds every earlier `state-sync.cjs` writer (T-40-02, 03, 19). None of its files is in a phase-39 plan, so it has no cross-phase dependency. It is at wave 6. It is risk high with a human-verify step over the scope cases, because it changes a readiness rule and two scope gates.

**No diamond child depends on T-40-27.** None of them imports, edits or verifies against its files, so the edge would add nothing to any child's tree. What the children need is the behaviour in the conveyor that delivers them, and a `depends_on` cannot provide that. This is recorded as an operating precondition in 40-27-PLAN.md instead: dispatch no phase-40 diamond child until T-40-27 is merged into the epic and the delivering conveyor runs a build that contains it (T-40-21's dogfood install root, or a release). Until then, apply the backlog entry's manual workaround.

### Advisories (amendment)

1. **[dependency_correctness]** Once T-39-06 lands, its "shares no files_modified" warning will fire on the import-only dependencies (for example 15←17, 15←16, 24←16, 26←07, 09←07). This is expected. The four linearization edges that advisory 1 above named no longer exist.
2. **[review diff]** While a diamond child's primary parent is still open, the child's PR targets the primary branch, so the GitHub diff also shows the merged epic content. It narrows once the primary parent lands and the sentinel retargets the child onto the epic (existing rule). The scope gates are exact throughout (T-40-27). Human reviewers of such a PR should be told this.
3. **[scope_sanity]** Advisory 2 above (15 waves) is superseded. Before phase 39 is on `main`, only T-40-07, 02, 03, 19, 17, 18 and 27 can run. Everything else is still gated by its T-39 dependencies.

### Files changed by this amendment

- `40-01`..`40-26-PLAN.md`: `wave` in the plans whose depth changed, `depends_on` in 01, 02, 05, 09, 10, 11, 15, 22, 23, 24, 25 and 26, and the "Graph position" bullets listed above.
- `40-27-PLAN.md`: new.
- `40-CONTEXT.md`: D-42, the ticket map regenerated from the plans, and the D-42 source-audit coverage.

## Amendment after the pdffiller proving-ground run

**Date:** 2026-09-25. **Decision (user):** fix in phase 40 only what phase 40 as planned would ship broken, found while delivering MYD-17835 in pdffiller (session b11246f1, Shipyard 0.63.0); the remaining findings go to a separate phase (CONTEXT D-43..D-45).

### Scope changes

1. **T-40-28 (new, D-43).** `plan-delivery.cjs`: `assertCanonicalGraph` (both hosts refuse an untracked graph copy in a non-main worktree) and `deliverPlan` (the canonical plan is mandatory; `.planning/` files named in Context reads are optional, bounded and reported as not delivered when they cannot be sent; `.planning/graph/` is never sent). The Claude host attaches a delivery per executor, drift-check and repair entry; the Codex host appends it to the executor, drift-check, ci-fix and review-fix prompts. The three workflows embed it. `prepareArgs` keeps a caller-supplied `deliveryRulesHint`. A plan inside the worktree (Shipyard) changes nothing.
2. **T-40-15 (D-43, D-44).** One graph rule: a ticket worktree that tracks `.planning/graph/tickets.json` at `HEAD` (Shipyard) uses its own graph as today; otherwise the canonical project graph, never an untracked copy; the request carries `planSha256`; the entry point builds the executor context packet with no out-of-worktree `requiredRefs` in a target project; `pr-sentinel` runs `preflightRound`. File list unchanged; it now depends on T-40-28.
3. **T-40-16 (D-44).** `preflightRound` groups a round's PRs by repository and measures each base in its owning checkout; in a foreign clone it only fetches and reads `origin/<base>`; `repository_root` must be non-null. No file list change.
4. **T-40-17 (D-45).** `titleFormat`/`formatTitle`, a `format` CLI, the merged `pr_title_format` key, project slug from `origin` when `--repo` is absent; placeholder-free optional segments are match-only; an unrenderable title refuses. `files_modified` adds `pipeline-config.cjs` and its test.
5. **T-40-20 and T-40-24 (D-45, D-43).** Titles are rendered through `pr-hygiene.cjs format` with the owning repository's slug (`--repo <row.repo>` for ticket PRs, the epic repository's `origin` for epic PRs); T-40-24 also drops the packet prose that assumes the plan is inside the worktree. No file list change.

### Graph changes

- **T-40-28 ← T-40-14** (primary; last previous editor of both delivery hosts and their tests). Wave 7.
- **T-40-15 ← T-40-28** (new primary parent, deeper than T-40-14). T-40-15 moves to wave 8, so T-40-23 and T-40-24 move to wave 9 and T-40-26 to wave 10. The phase is now 10 waves deep.
- **T-40-09 ← T-40-28.** T-40-28 edits `tests/unit/codex-delivery-host.test.cjs`; T-40-09 stays its last editor and migrates any record T-40-28 adds. T-40-09's primary parent stays T-40-11 and it stays in wave 8.
- T-40-16's frontmatter wave is corrected from 3 to 4 (its cross-phase parent T-39-17 has depth 3; this predates the amendment).
- `validate-graph: OK — 198 ticket(s), 20 wave(s)`, with no frontmatter-wave warning for any phase-40 ticket; `tickets.json`/`tickets.yaml` regenerated.

| Child | Primary parent | Must land in the epic first |
|---|---|---|
| T-40-09 | T-40-11 | T-40-07, T-40-14, T-40-28 |
| T-40-15 | T-40-28 | T-40-17, T-40-16 |

### Ownership with other phases

- `plan-delivery.cjs`, the three workflows, `workflows-args.test.cjs` and `pipeline-config.cjs` (+test) each have a single writer in phases 40/41.
- Delivery hosts: 39-08 → 40-10 → 40-13 → 40-14 → 40-28 (Claude) and 42-01 → 40-12 → 40-14 → 40-28 (Codex); the Codex host test then goes to T-40-09.
- `claude-role-host.cjs`: T-40-16 precedes T-40-22; its only phase-41 editor is T-41-01, a declared dependency of T-40-16.

### Plan-check rounds of this amendment

- Round 1 (`gsd-plan-checker`, claude-opus-5-5/medium, receipt verified, session cc1bdb31): ISSUES, 5 blockers / 5 warnings / 4 info — plan-reading roles beyond the executor, the Codex seam, graph copies, `{[!]}` rendering, title producers in T-40-20/24, merged config, `check` input, foreign clones, the context packet, commit subjects.
- Round 2 (same role and rung, receipt verified): ISSUES, 3 blockers / 4 warnings / 4 info — optional references must not refuse and Shipyard must stay unchanged; both hosts, not only the entry point, must refuse graph copies; titles must use the owning repository's format; T-40-15 over budget (split into T-40-28 with RED steps per test); Codex plan fields and insertion point; packet ownership; bare phase references; stale anchors; per-ticket delivery; non-null `repository_root`.
- Round 3 (same role and rung, receipt verified): ISSUES, 2 blockers / 4 warnings / 5 info — the Shipyard graph rule (worktree-tracked graph keeps today's path), Codex drift-check and repair prompts, a text slip in T-40-17's CLI lines, the collection rule for bare phase names and skipped references, a recorded baseline for byte-identity, graph directories outside any worktree; plus optional worktree argument, explicit Codex digest input, tracked-at-HEAD, project-repository main worktree, and T-40-16's wave.
- Round 4 (same role and rung, receipt verified): **PASS** — no blockers; one warning (Codex roles in the Shipyard repository must resolve the worktree-tracked graph when launched outside the entry point) and three info items (name the rejected `plan*` context keys, name the Shipyard baseline source, T-40-28 at the 10-file line). The warning and the first two info items were applied as one sentence each plus a test case; no file was added.
