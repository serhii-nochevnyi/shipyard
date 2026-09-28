# INV-010 — research line 2: alternatives and prior art (OPTIONS.md draft)

- **Line:** alternatives (`signals: {"type":"alternatives"}`, preserved as DATA)
- **Selection:** caller-resolved Claude `claude-opus-5-5` / `medium` (ADR-014 Claude `research` base rung)
- **Source revision:** `f3ea7482e7fd6a61eed292125dce54e8973fbd58` (checked: `git rev-parse HEAD` → `f3ea7482e7fd6a61eed292125dce54e8973fbd58`)
- **Policy hash:** `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968` (ADR-014 `adr-014.v6`, from the context packet)
- **Scope:** read-only. No recommendation is made; the choice belongs to the human (DECISIONS.md).

## 0. Evidence base (command-backed)

Facts every option below depends on. Each carries the command that checked it.

| # | Fact | Command and output |
|---|---|---|
| E1 | The guard offers `arch-review` for **every** green PR without a conform verdict on its head; there is no merge-candidate ordering among siblings. Only a still-open **parent** defers a child (`wait-parent`). Items are sorted shallowest-first then by ticket id. | `Read plugins/delivery-pipeline/scripts/sentinel.cjs:600-789` — `parentIsMoving(id)` → `wait-parent` (`:606-613`); `s.draft && !gateConform(...)` → `arch-review` (`:672-683`); non-draft `!gateConform` → `arch-review` (`:718-722`); sort by `depth` then ticket (`:789`). |
| E2 | Launch timing today: a review is offered only after CI stops failing **and** stops pending, after unresolved threads are serviced, and after a moved base has been merged in. It is **not** offered while a parent PR is open. It **is** offered while sibling PRs on the same epic are open and about to move the base. | Same read: order is `ci-fix` (`:614`) → `base-merge` (`:644-653`) → `review-fix` (`:654`) → `wait-ci` (`:658-671`) → `arch-review` (`:672`, `:718`). |
| E3 | The guard asks for arch-review on a **draft** PR (`:672-683`, "green draft … judge the diff") and undrafts only after conform (`:691-693`), but the Claude role host rejects a draft PR: `live.isDraft === true` → `reject('live PR identity differs from the ticket worktree')`. This is N46. | `sed -n 440,450p plugins/delivery-pipeline/scripts/claude-role-host.cjs` → lines 442-445 shown above. |
| E4 | What the Claude host judges: `git merge-base <live base> <head>` and a `--unified=50` diff of `base...head`, bounded by `DIFF_MAX_BYTES = 1 MiB`; the arch-review packet bound is `ARCH_REVIEW_PACKET_TOKENS = 60000`. So the reviewed input is the whole PR against its **current** base's merge-base, which for a sibling on the epic is the ticket's own change plus whatever the base-merge resolution introduced. | `Grep DIFF_MAX_BYTES|ARCH_REVIEW_PACKET_TOKENS claude-role-host.cjs` → `:23`, `:26`, `:421-422`, `:708`; `sed -n 440,450p` → `:448-450`. |
| E5 | The carry installed today is **tree-equal only**: `gate-trailer.cjs carry` refuses when the head tree moved (`fromTree !== toTree`), when ancestry is rewritten, when the verdict is not for `--from`, or when the live head moved. No `patch-id` path exists yet (T-43-13 not landed). | `Read gate-trailer.cjs:455-534` (`:494-498` tree refusal); `Grep "patch-id" scripts/{gate-trailer,base-merge,claude-role-host,front}.cjs` → no match; `git log --oneline -400 --grep=43-13` → no output. |
| E6 | No Codex arch-review host exists at this revision (consistent with ADR-021 "Codex reuse is a named gap until a Codex arch-review host exists"). | `grep -n -i "arch-review\|arch_review" plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` → no output. |
| E7 | No exact-input arch-review reuse / single-flight exists yet in the Claude role host (C1 not landed). | `Grep "patch-id|verdict carry|reuse"` over the four scripts → only an unrelated comment at `front.cjs:1315`. |
| E8 | The tracked journal at this revision contains **no** phase-43 or phase-44 arch-review, base-merge or merge events; phase-43/44 counts (9 reviews / 8 PRs; ~23 / 13) are available only as prose in N54 and the T-43-13 plan. | `grep '"event":"arch_review"' .planning/graph/delivery-log.jsonl | grep -c "T-43-"` → 0; same for `T-44-` → 0; same zero for `base_merge` and `merge`. Journal has 1480 lines; `arch_review` 46, `base_merge` 78, `merge` 79, `dispatch` 421 (`grep -o '"event":"[a-z_]*"' … | sort | uniq -c`). |
| E9 | Older phases in the tracked journal show arch-review dispatch counts vs merge events per phase: T-23 3/3, T-24 7/11, T-25 9/5, T-26 14/15, T-28 2/9, T-29 6/6, T-36 24/2. Event coverage is incomplete (dispatch records were not written on every path), so these are **not** a matched-cohort baseline. | `grep '"event":"dispatch"' … | grep '"role":"arch-review"' | grep -o '"ticket":"T-[0-9]*' | sort | uniq -c` and the same for `"event":"merge"`. |

**Unknown U1:** the phase-43 and phase-44 journals live on their delivery boards, not in this worktree. The contract allows `gh pr view <n> --json` (read-only), but I did not run it; per-ticket own-diff share (contract Q2) and the matched-cohort baseline are therefore **not measured here**. Next check: read the phase-44 board's `delivery-log.jsonl` (or `gh pr view <n> --json commits,files` for PRs of phase 44) and count `arch_review` per merged ticket, split into "after a real violation" and "after a base move".

**Blocked read (reported, not worked around):** two compound shell commands were refused by the permission layer (`permissions.blockReadsOutsideWorkingDirectories`, "path computed at run time"). They were a `git log --all | grep` over branch names and an `ls` of the investigation directory; I reran their purpose with `git -C … log --grep` and `Glob`. Remote branch state (is the phase-43 epic merged to `main`?) was therefore not checked.

## 1. Prior art inside this repository

- **Backlog `a-conform-verdict-does-not-survive-a-base-merge-that-changes-nothing.md`** (selected in the packet): a byte-identical head tree after a base-merge was still refused. That became the tree-equal carry (E5).
- **Backlog `the-carry-window-closes-on-exactly-the-merge-that-needs-it.md`** (T-29-07): the tree-equal carry misses exactly the base-merges that bring in sibling content. That is what T-43-13's patch-id carry addresses.
- **Backlog `a-childs-pr-base-is-its-merge-target-not-just-its-review-diff.md`**: a child's review diff is against its merge target. This constrains any option that reviews against something other than the live base.
- **Backlog `drift-gate-judges-one-base-for-a-whole-cascade.md`**: a single base for a whole cascade was a defect for drift. This warns against a naive once-per-stack review.
- **ADR-020 own-diff carry** (T-43-13, `43-13-PLAN.md`): patch-id identity + only owned paths differ + owned blobs identical → carry; otherwise re-owe. Accepted input, **not re-decided**.
- **ADR-021 exact-input reuse + single-flight** (C1): reuse only on an identical manifest; no reuse across a changed base; a carried verdict is never a reuse source. Accepted input, **not re-decided**.
- **Phase-45 R3** (`WORK-PACKAGES.md`): "review only the PR that merges next … until the ADR-020 own-diff carry is installed". A queued package, not an accepted decision. Option B below generalizes it.
- **Phase-45 R10** (environment-only adjudication, N57), **R13** (N44 integrator `base`, N46 draft), **R14** (human preconditions before launch), **R11** (integrator per subset). Owners that the options must not duplicate.

External prior art (not command-checkable, labelled as assumptions):
- Merge queues (GitHub merge queue, Bors, Zuul gating): test/review the next merge candidate against the projected base, serialize landing. Source: public product documentation; assumption about applicability.
- Content-addressed review reuse (Gerrit "copy score if no code change / trivial rebase" rules, `copyCondition: changekind:TRIVIAL_REBASE`): a vote survives a rebase whose patch is unchanged. Source: Gerrit label documentation; this is the same idea as the ADR-020 patch-id carry.

## 2. Orthogonal preconditions that every option shares

These do not compete with the options; every option needs them, and each has an owner already.

- **P-draft (N46, owner R13):** either the host reviews a draft PR (drop `isDraft === true` from the identity check at `claude-role-host.cjs:442`, keeping head/branch identity) or the conveyor undrafts before review. Contradiction today: E3. Cost of leaving it: every draft review is refused before a verdict. This is a correctness fix, not an efficiency choice; no option works while it stands.
- **P-env (N57, owner R10):** classify setup/permission failures before assertions as environment-only and route them to the R10 adjudication instead of a fresh model review. INV-010 only decides whether that adjudication counts as a review launch in the success metric (it should be counted separately, like repair rounds).
- **P-pre (R14):** run every host precondition (draft, identity, packet bound `ARCH_REVIEW_PACKET_TOKENS`, required refs) before a model turn is spent.

## 3. Options

### Option A — Do nothing beyond the accepted inputs

**Sketch.** Keep the current launch timing (E1/E2: review after green, per PR, all siblings in parallel). Land the accepted inputs as planned: T-43-13 patch-id carry in `gate-trailer.cjs`/`base-merge.cjs`, C1 exact-input reuse and single-flight in the Claude role host, and the P-draft/P-env fixes via R13/R10. Measure afterwards.

**What it does to the pain.** A sibling squash that touches only non-owned paths leaves the ticket's own patch identical, so the patch-id carry keeps the verdict (43-13-PLAN scope case 1). If the phase-43 prose is right that the seven discarded verdicts "only brought already-judged sibling squashes", most of those become carries. Base-merges with a conflict in an owned file still re-owe review, correctly. C1 removes identical re-requests (retries, a guard re-posted on an unchanged state), but by ADR-021 it never crosses a changed base, so it does not help the cascade itself.

**Cost/complexity.** Zero new design. The work is already owned (T-43-13, C1, R10, R13).

**Risks.**
- The saving depends on the share of base-merges that leave owned paths untouched. That share is unmeasured (U1).
- Reviews still run in parallel on siblings. Each sibling that needed a conflict resolution in an owned file is re-judged once per earlier sibling merge: O(N) per ticket in the worst case.
- Codex gets nothing until a Codex arch-review host exists (E6).

**Forecloses.** Nothing. Every other option layers on top of it.

### Option B — Merge-candidate gating ("review the next merge", generalized R3)

**Sketch.** `sentinel.cjs duty` and `front.cjs` keep offering CI-fix, base-merge and review-fix for every sibling. They offer `arch-review` only to the **next merge candidate(s)** per base: the green PRs whose merge cannot be invalidated by another sibling landing first. The ordering is deterministic (front depth, then unlock count, then ticket id, as in R3). The other green siblings get a new non-actionable state, e.g. `wait-turn`. After the candidate merges, the next one base-merges, reruns CI, and is reviewed once on its final base. With the T-43-13 carry installed, the gate can be relaxed: a sibling may be reviewed early if its owned paths are **disjoint** from every open sibling's `files_modified`, because any later base-merge will carry (disjoint owned paths ⇒ patch-id identical, unless the merge adapts an owned file).

**Variants.**
- B1 strict: one candidate per epic.
- B2 disjoint-aware: candidates are the PRs whose `files_modified` do not overlap any open sibling ranked ahead of them. Overlap comes from the graph (`path-owner.cjs owns`), not from judgement.

**Latency / correctness.**
- B1 serializes review per epic. With N siblings, the wall time adds N × (base-merge + CI + review) instead of overlapping review with CI. That is a real latency cost on a phase with many independent tickets.
- B2 keeps parallelism for disjoint tickets, which the carry protects, and serializes only overlapping ones, which would be re-judged anyway.
- Correctness is unchanged: every verdict is still bound to the head it judged, on the base it merges into. No gate is weakened.

**Cost/complexity.** Medium. Changes `sentinel.cjs` duty ordering, `front.cjs` projection, deliver.md prose, both runtimes' guard instructions, plus tests. No new identity primitive. It touches files that T-43-13, R3 and D1 also own: needs one serialized owner.

**Risks.**
- A candidate stuck in `human_checkpoint` or `wait-human` must not freeze its siblings. It needs the same exception `wait-parent` already has for a parent waiting on a person (`pr-sentinel.md` "Parents first").
- Ordering must be stable across ticks, or two guards could pick different candidates.
- B2 relies on `files_modified` being accurate. An executor touching an undeclared path is already refused by the finalizer, but base-merge conflict resolution in a non-owned file is not in `files_modified`. The carry's condition 2 (only owned paths differ) catches that at carry time, so the failure mode is an extra review, not a stale verdict.

**Forecloses.** Parallel review of overlapping siblings. It makes R3 part of the permanent design instead of a stopgap "until the carry is installed".

### Option C — Own-patch review input (review judges the ticket's own patch, the verdict keyed by own-patch identity)

**Sketch.** Change **what** is judged, not when. The Claude host (and a future Codex host) build the arch-review packet from the ticket's own patch: `diff <judged merge-base> <head>` restricted to, or at least labelled by, `files_modified`. Any base-merge resolution in a non-owned path is a separate, clearly marked section. The verdict records the own-patch identity (patch-id `--stable` plus owned blob set) next to `base_tree`. Launch timing stays "after green" (E2), so latency is unchanged, and T-43-13's carry becomes the normal case rather than the lucky one: a verdict keyed on own-patch identity carries whenever that identity survives, and re-owes whenever an owned path or a governing input (plan, ADR refs, policy) changes.

**How it combines with the accepted inputs.** T-43-13 already defines the identity (patch-id + owned blobs + non-owned = new base). Option C aligns the *review input* with that identity, so the question the judge answered is the question the carry later checks. C1's manifest still governs exact reuse, and C1 still forbids reuse across a changed base. C does not add reuse; it makes the carry cover what the judge actually read.

**Cost/complexity.** Medium–high.
- It changes the arch-review packet (`claude-role-host.cjs:420-452`) and `references/arch-review.md`. The judge would receive the own patch, the ADR corpus, **and** a bounded view of the current base for the touched modules, because architecture conformance can depend on base context.
- It adds the own-patch identity to the `merge-gate` status description (140-character limit, already a T-43-13 concern).
- It needs the R7 lesson: a host-contract change needs a real round trip.

**Risks.**
- **Interaction blindness.** A sibling that changes a non-owned module the ticket depends on (43-13-PLAN case "sibling deletes a function the ticket calls") is not seen by the review. ADR-020's scope fence accepts that already: CI and the epic PR are the interaction checks. But C makes that fence the rule for *every* first review, not only for carries. That is the main correctness trade-off and needs an explicit human decision.
- ADR scoping of a partial diff may miss constraints on cross-module wiring the full diff shows.
- The judged-input change must be versioned in C1's manifest (instruction digest, packet digest); otherwise reuse could mix old-input and new-input verdicts.

**Forecloses.** Using the ticket review as an interaction check. That pushes more weight onto the integrator (R11) and CI.

### Option D — Batched / stack-level review with per-ticket verdicts

**Sketch.** One authenticated arch-review launch judges a **set** of sibling PRs at their current heads: a wave, or all green siblings on one epic. It emits one verdict per ticket, each bound to that ticket's own head and base tree. A merge then triggers carry per ticket (T-43-13). Only tickets whose carry fails re-enter the next batch. The integrator (epic → main) consumes the per-ticket verdicts and judges only the cross-ticket interaction and the combined residue, which addresses the N44/N30 overlap.

**Variants.**
- D1 "once per stack": defer every ticket review until the stack is fully green and review it as one batch.
- D2 "parent-first then carry": review the parent, then children as a batch after the parent lands.
- D3 "rolling batch": every tick, batch whatever is newly green.

**Latency / correctness.**
- D1 has the lowest launch count but the worst latency: nothing merges until the whole stack is green. It is also fragile, because one red ticket holds every other verdict back.
- D2 matches the existing parent-first ordering (E1).
- D3 keeps latency close to today's while amortizing per-launch overhead (ADR corpus read once per batch rather than once per ticket).
- Correctness is preserved only if each verdict stays per-ticket and head-bound. A single "stack conform" would accept a verdict for heads it did not judge, which the problem statement puts out of scope.

**Cost/complexity.** High.
- It needs a new host request shape (multi-subject), a new result schema with a per-ticket finding index, receipt handling for one dispatch covering N subjects (compare the sentinel `round:<digest>` pattern in `pr-sentinel.md`), and the C1 manifest per subject.
- It changes the packet bound: `ARCH_REVIEW_PACKET_TOKENS = 60000` (E4) is per request, so batches must be split by size. The measured-window signal would then route batches to Opus/high or the Fable ceiling more often.

**Risks.**
- One launch failing loses N verdicts.
- A batch crossing the window threshold changes the rung (ADR-014 `window_threshold_tokens: 250000`). This interacts with the grids, which are out of scope to change.
- Per-ticket attribution of consumption for the success metric becomes an apportionment, not a count.
- A "launches per merged ticket" metric becomes ambiguous (1 launch / N tickets). The success criterion would need a definition in model-work units, not launches.

**Forecloses.** Simple one-PR-one-dispatch accounting and the existing arch-review result schema. It likely needs an ADR amendment to the role-artifact contract.

### Option E (study-only) — Model and effort by diff size

**Sketch.** Add a size signal, e.g. `ownPatchBytes` or measured `inputTokens` below a floor, that selects a lower rung for small own-diffs: Claude Opus/low or Sonnet; Codex Luna. Today the grids only promote on size (Claude `ceiling` on `inputTokens > window_threshold_tokens`, Codex `critical` on the same; context packet `runtime_signal_rules`). There is no demotion rung.

**Status.** Out of scope to adopt (PROBLEM.md). It needs an ADR-014 amendment and an ADR-021 effort experiment: 20 completions, 95% attribution, a seven-day floor and a recorded human decision. It is orthogonal to A–D and does not reduce launch **count**, only cost per launch. It also conflicts with ADR-014's "a missing signal never silently promotes"; a demotion would need the same fail-closed discipline.

**Risks.** Review quality on small but architecturally central diffs, since size is not risk. The effort cohort key problem noted in ADR-021 context ("effort cannot be a treatment because it is a cohort key") must be solved by the experiment protocol first.

## 4. Comparison (mandatory)

| | A — accepted inputs only | B — merge-candidate gating | C — own-patch review input | D — batched per-ticket verdicts | E — size-routed model (study) |
|---|---|---|---|---|---|
| When a review launches | after green, every sibling (E2) | after green, only next candidate(s) per base | after green, every sibling | after green, per batch / stack | unchanged |
| What it judges | whole PR vs live merge-base (E4) | same | ticket's own patch (+ marked residue) | each ticket's PR, one launch | unchanged |
| Carry / reuse | T-43-13 + C1 as accepted | same; fewer carries needed | carry aligned to judged input | carry per ticket after each merge | unchanged |
| Expected launches per merged ticket | depends on owned-path overlap share (U1) | ≈1 for B1; ≈1 + overlap for B2 | ≈1 + (owned-path conflict rate) | < 1 launch/ticket, but not comparable unit | unchanged count |
| Latency | today's | B1: +N×(merge+CI+review) serial; B2: serial only for overlap | today's | D1 worst; D3 ≈ today | unchanged |
| Correctness trade-off | none new | none new | review no longer sees base interactions (relies on ADR-020 fence: CI + epic PR) | none if verdicts stay per-head; single failure loses N | quality risk on small central diffs |
| Complexity | low (already owned) | medium | medium–high (packet + contract + manifest version) | high (new schema, receipt, packet split) | needs ADR-014 amendment + experiment |
| Runtime parity | Codex gap until host exists (E6) | duty is shared → both runtimes | both hosts must build same packet | both hosts need multi-subject | per-grid |
| Files touched (collision with owners) | T-43-13, C1, R10, R13 owners | `sentinel.cjs`, `front.cjs`, deliver.md — overlaps R3, D1 | `claude-role-host.cjs`, `arch-review.md`, `gate-trailer.cjs` — overlaps T-43-13, C1 | role host, role-artifact, integrator — overlaps C1, R11, R13 | `model-policy*.cjs` — out of scope |
| Forecloses | nothing | parallel review of overlapping siblings | review as an interaction check | simple per-PR accounting / schema | — |

Options are composable: A is the floor; B and C are independent and can stack; D excludes neither but supersedes B's ordering; E is orthogonal and separately gated.

## 5. Constraints every option must satisfy (from sources)

- Verdict bound to the head it judged; no verdict for an unjudged head (PROBLEM.md out-of-scope; `pr-sentinel.md` "The verdict is bound to the head it judged"; `gate-trailer.cjs:524-534`). Confidence: high.
- Fresh review whenever the ticket's own change or governing inputs change (PROBLEM.md success; ADR-021 manifest). High.
- No reuse across a changed base; a carried verdict is never a reuse source (ADR-021). High.
- No ADR-014 grid change (PROBLEM.md; ADR-021 out of scope). High.
- Human checkpoints are not auto-merged and do not freeze unrelated work (`sentinel.cjs:694-701`, `:723-737`; `pr-sentinel.md` "Parents first" exception). High.
- A shared file needs one serialized owner when tickets are created (WORK-PACKAGES "Boundary and sequencing"). High.
- Savings are shown by matched cohorts, never a promised percentage (PROBLEM.md; ADR-021; WORK-PACKAGES decision gate 5). High.

## 6. Unknowns → OPEN-QUESTIONS seeds

- [ ] What share of phase-43/44 base-merges touched only non-owned paths, i.e. would the T-43-13 carry have kept the verdict? This decides whether A alone reaches ~1 launch/ticket. — owner: operator (phase-44 board journal + `gh pr view --json files,commits`)
- [ ] How many phase-44 re-reviews followed a real `violation` versus a base move? The success metric counts them separately. — owner: operator (phase-44 `delivery-log.jsonl`)
- [ ] Is the ADR-020 scope fence ("CI and the epic PR are the interaction checks") acceptable as the rule for every *first* review (Option C), not only for carries? — owner: repository maintainer
- [ ] Under Option B, how long can a ranked candidate wait on a human before its siblings are released? Reuse the `wait-parent` person exception or add a timeout? — owner: repository maintainer
- [ ] If Option D is chosen, how is "launches per merged ticket" defined for one launch covering N tickets? — owner: repository maintainer
- [ ] Draft review (N46): should the host accept a draft, or the conveyor undraft first? The undraft-first choice changes when bots start reviewing (`sentinel.cjs:691-693` comment on undraft being unreachable before the verdict). — owner: R13 owner / maintainer
- [ ] Does an R10 environment-only adjudication count as an arch-review launch in the INV-010 metric? — owner: maintainer
- [ ] Is the phase-43 epic merged to `main` at this revision? C1 and the T-43-13 carry both wait for it. Not checked here: the remote branch query was blocked. — owner: operator (`gh pr view` on the phase-43 integration PR)
- [ ] When will a Codex arch-review host exist (E6)? Until then, "both runtimes follow the same rules" holds only for the duty ordering (B), not for host-side input or reuse (C, D). — owner: phase-45 C1 owner

## 7. Spikes recommended (not performed)

- `/gsd-spike "replay phase-44 base-merges through the T-43-13 patch-id carry conditions and count carries vs re-owes"`: decides A's sufficiency.
- `/gsd-spike "simulate merge-candidate gating B1/B2 on the phase-44 ticket graph files_modified overlap and report serial wall-time added"`.
- `/gsd-spike "build an own-patch-only arch-review packet for three phase-44 PRs and diff the findings against the recorded full-PR verdicts"`: tests Option C's interaction-blindness risk.
- `/gsd-spike "measure packet tokens for batching all green phase-44 siblings into one arch-review request against ARCH_REVIEW_PACKET_TOKENS=60000"`: tests Option D feasibility.

## 8. Sources read

- `.planning/investigations/INV-010-review-stage-efficiency/PROBLEM.md`, `RESEARCH-CONTRACT.md`, `OPTIONS.md` (template)
- `.planning/architecture/ADR-014-mandatory-runtime-model-ladder.md`, `ADR-020-target-project-delivery-at-scale.md`, `ADR-021-subscription-efficiency-per-runtime.md` (from the packet)
- `.planning/phases/43-target-project-delivery-at-scale/43-13-PLAN.md`, `.planning/phases/45-close-residual-pipeline-efficiency-gaps/WORK-PACKAGES.md` (from the packet)
- `.planning/investigations/INV-008-residual-pipeline-efficiency/intake/phase40-delivery-findings.md` (N8, N15, N30, N44, N46, N54, N57)
- `plugins/delivery-pipeline/references/arch-review.md`, `references/pr-sentinel.md` (from the packet)
- `plugins/delivery-pipeline/scripts/sentinel.cjs:590-789`, `gate-trailer.cjs:455-534`, `claude-role-host.cjs:23,26,420-452,708`, `codex-delivery-host.cjs` (grep), `commands/deliver.md` (grep)
- `.planning/graph/delivery-log.jsonl` (grep counts, E8/E9)
- Selected backlog items (packet): the four carry/cascade notes listed in §1
