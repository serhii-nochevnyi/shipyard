# Research

Four sealed research lines at source revision `f3ea7482`: [system state](research/system-state.md), [alternatives](research/alternatives.md), [constraints](research/constraints.md), [risks](research/risks.md). All four used Claude Opus/medium, and their receipts are verified. The operator added the measurements in the last section from sources outside the sandbox.

## Current system state

- **Launch timing.** The guard offers `arch-review` to every green PR without a conform verdict on its head, and to every green sibling in the same tick. There is no merge-candidate ordering; items are sorted by depth, then ticket id (`plugins/delivery-pipeline/scripts/sentinel.cjs:600-789`, `:789`). Only a still-open parent defers a child (`wait-parent`, `:606-613`). The order is `ci-fix` → `base-merge` → `review-fix` → `wait-ci` → `arch-review`, so a review follows green CI and a merged-in base, but it can run while sibling PRs are about to move that base.
- **What is judged.** The Claude host judges `git diff --unified=50 <merge-base>...<head>` of the PR against its current base (`claude-role-host.cjs:421`, `:448-450`). For a sibling on the epic this is roughly the ticket's own patch plus any base-merge resolution. Limits: `DIFF_MAX_BYTES = 1 MiB` (`:23`) and `ARCH_REVIEW_PACKET_TOKENS = 60000` (`:26`, `:708`).
- **Carry.** Today's carry requires both the head tree and the base tree to be unchanged (`gate-trailer.cjs:494-498`, `:563-568`). Its only caller is `base-merge.cjs carryVerdict` (`:205-226`). A base merge that brings in a sibling squash changes both trees, so the carry never fires in a cascade. The T-43-13 patch-id carry is not started (phase-43 board: T-43-13 `pending`).
- **Reuse.** C1 exact-input reuse and single-flight are not implemented. The only reservation code is the generic dispatch lease (`claude-role-host.cjs:1242-1315`).
- **Draft contradiction (N46).** The guard assigns `arch-review` to a green draft (`sentinel.cjs:672-683`) and undrafts only after conform (`:691-693`). The Claude host rejects `live.isDraft === true` (`claude-role-host.cjs:442-444`).
- **Codex (correction to lines 1, 3 and 4).** The research lines reported "no Codex arch-review host" (F7, E6), because they grepped for the role name inside `codex-delivery-host.cjs`. Codex does run arch-review: the generic `codex-delivery-host.cjs` launches the generated `shipyard-arch-review.toml` role. The operator counted 11 Codex `arch-review` receipts for phase-43 tickets under `~/.local/state/shipyard/codex/*/receipts`. What Codex lacks is a phase-scoped, identity-checking arch-review host like `claude-role-host.cjs`, and ADR-021's Codex reuse gap still stands.
- **Journal gap.** The tracked `.planning/graph/delivery-log.jsonl` has no `arch_review`, `base_merge` or `dispatch` rows for phases 40–44 (F8). Role-host receipts and board-worktree journals hold them instead, so the success metric cannot be computed from the tracked journal today.

## Measurements (operator, outside the sandbox)

- **Phase 44 (Claude, 8 tickets, merged).**
  - 9 arch-review launches for 8 merged PRs.
  - The one extra launch was T-44-01, re-reviewed after T-44-07's squash moved the epic. T-44-07 touched only its own two files, so T-44-01's own patch was unchanged; the T-43-13 carry would have kept that verdict.
  - The operator finalized siblings one at a time (base-merge → CI → review → merge, per candidate). That ordering is Option B1 in practice, and it is why phase 44 stayed near one review per ticket.
  - Integrator: 4 launches, of which 3 results were refused on the `base` identity field (N44).
- **Phase 43 (Codex, in progress).** 11 arch-review receipts on 4 tickets: T-43-03 ×4, T-43-09 ×3, T-43-07 ×2, T-43-01 ×2. There are also 9 review-fix receipts on 3 tickets. The repeats follow real `violation` verdicts and repairs, and on T-43-03 a sandbox `EPERM` violation (N57). They are not base moves. So in phase 43 the cost comes from the violation-repair loop and the reviewer environment, not from stale verdicts.
- **Target-project baseline.** The "about 23 launches for 13 tickets, seven discards" figure is from the pdffiller MYD-17835 target-project run (INV-007 RESEARCH F6, ADR-020 Context), not from Shipyard phase 43 (F9). It is motivation and a separate cohort.

## Constraints

### Technical
- A verdict is bound to the head it judged, and a verdict for an unjudged head is never accepted (`gate-trailer.cjs:524-534`, `pr-sentinel.md`).
- Any new carry must be provable from object identities (ADR-020). A changed ADR, plan or policy re-owes review regardless of patch identity (ADR-021 manifest).
- No reuse across a changed base, and a carried verdict is never a reuse source (ADR-021).
- The arch-review packet bound (60k tokens) and the 1 MiB diff bound limit any batched or stack review (R-5).

### Product
- Target: in an epic-stacked cascade, about one arch-review launch or fewer per merged ticket, with repairs after a real violation counted separately (PROBLEM.md). No gate is weakened, and both runtimes are covered.
- The ADR-014 grids are unchanged here. Model and effort by diff size is an option only (ADR-014 amendment plus ADR-021 experiment).

### Delivery
- The files involved have owners:
  - `gate-trailer.cjs` and `base-merge.cjs`: T-43-13, then T-43-17;
  - `claude-role-host.cjs`: C1, R12, R13;
  - `sentinel.cjs` duty ordering: R3, D1;
  - environment adjudication: R10;
  - integrator: R11, R13.
  
  INV-010 therefore decides a combination and ordering rule, plus named deltas assigned to those owners (R-11).
- T-43-13 and C1 wait for the phase-43 epic (R-12). Levers that do not depend on them can be piloted first: candidate ordering, the draft precondition, pre-launch environment checks and journalling.

## Unknowns

- The own-diff share of phase-43/44 reviewed diffs and their packet sizes (OQ-2) need `gh pr diff` per PR. Phase-44 PRs are small single-ticket slices, so the own-patch share is close to 100% there.
- Whether T-43-13's tree-based patch-id reproduction (its A3) holds (OQ-6) is settled by that ticket's RED step.
