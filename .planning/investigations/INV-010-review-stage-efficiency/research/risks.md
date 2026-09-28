# INV-010 research line 4 — risks and unknowns

- **Line:** risks (→ RISKS.md + OPEN-QUESTIONS.md drafts)
- **Subject:** `INV-010-review-stage-efficiency:risks`
- **Source revision:** `f3ea7482e7fd6a61eed292125dce54e8973fbd58` (checked: `git rev-parse HEAD`)
- **Policy hash (DATA, preserved):** `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968`, policy version `adr-014.v6`
- **Resolved selection (DATA):** Claude `claude-opus-5-5` / `medium`; policy signals `{}`
- **Date:** 2026-09-28
- Read-only line. No product code, no planning scaffolding and no other investigation file was changed.

## 0. Environment limits on this line (stated, not absorbed)

| Limit | Command | Result | Consequence |
|---|---|---|---|
| GitHub is unreadable from this sandbox | `gh pr list --repo serhii-nochevnyi/shipyard --state all --search "T-44 in:title" --limit 20 --json number,title,state` | `failed to create root command: failed to read configuration: open /Users/serhii/.config/gh/config.yml: operation not permitted` | No phase-43/44 PR diff, commit-status or review history was read. Every claim about per-PR reviewed-diff composition is an **unknown** (see OQ-1, OQ-2). |
| `ls` over computed paths was denied | `ls plugins/... .planning/investigations/...` (compound) | denied by permission policy (`blockReadsOutsideWorkingDirectories`) | Replaced by the Glob/Grep tools; no evidence was lost. |

## 1. Command-backed facts this risk register rests on

F1. **Today's carry requires BOTH the head tree and the base tree to be unchanged.**
`plugins/delivery-pipeline/scripts/gate-trailer.cjs:494-498` refuses "the head tree MOVED"; `:563-568` refuses "the BASE tree MOVED".
Checked with: `Read gate-trailer.cjs offset 440 limit 180`. A base-merge that brings in a sibling squash changes both trees, so today the carry never fires in the cascade case the problem describes. The only caller is `base-merge.cjs carryVerdict` (`base-merge.cjs:205-226`, checked: `Grep "carry|patch-id" base-merge.cjs`). No patch-id path exists yet (the same grep has no `patch-id` hit in code).

F2. **T-43-13 (own-diff carry) is not started.**
`node -e '…delivery-state.json…'` → `T-43-13 {"branch":"ticket/T-43-13-carry-a-conform-verdict-across-a-base-me","pr":null,"status":"pending", … "base_reason":"T-43-06 has no branch on the remote yet …"}`. Phase-43 board: `T-43:merged 3, pr-open 6, pending 10`; phase 44: `merged 8`.

F3. **C1 exact-input reuse and single-flight are not implemented.**
`Grep "reused|reuse_manifest|single-flight|inflight"` over `claude-role-host.cjs`, `base-merge.cjs`, `gate-trailer.cjs` → the only hits are `claude-role-host.cjs:1242-1315`, which are the generic `dispatch-record.recordInflight` dispatch lease, not a verdict-reuse reservation.

F4. **What arch-review judges today is the three-dot diff from the current merge-base to the head.**
`claude-role-host.cjs:448-450` computes `merge-base <base> <head>` and then `diffText(…, mergeBase, head)`; `:421` is `git diff --unified=50 <base>...<head>`, capped at `DIFF_MAX_BYTES = 1 MiB` (`:23`, `:422`). The packet bound is `ARCH_REVIEW_PACKET_TOKENS = 60000` (`:26`, `:708`). Checked: `Grep "isDraft|ARCH_REVIEW_PACKET_TOKENS|DIFF_MAX_BYTES" claude-role-host.cjs` and `Read claude-role-host.cjs 405-455`.

F5. **The N46 draft contradiction is real in code.**
`sentinel.cjs:672-683` assigns `arch-review` to a *green draft* without a conform gate ("Certify BEFORE readying"), and `undraft` only follows conform (`:691-693`). `claude-role-host.cjs:442-444` rejects `live.isDraft === true` with "live PR identity differs from the ticket worktree". So the duty that the sentinel emits for a draft cannot be served by the Claude host. Checked: `Grep "'arch-review'|wait-parent|undraft" sentinel.cjs`, `Read sentinel.cjs 595-790`.

F6. **The duty list offers arch-review to every green sibling at once (N15).**
`sentinel.cjs:600-789`: each item is decided independently; ordering is only `depth`, then ticket id (`:789`). There is no "next merge candidate" selection, so three green siblings on one epic each get `arch-review` in the same tick.

F7. **Codex has no arch-review host.**
`Grep "arch-review|archReview|arch_review" codex-delivery-host.cjs` → 0 matches. `Grep "arch-review" codex-*.cjs` → only evidence-file maps in `codex-runtime-host.cjs:933-934` and `codex-dispatch-adapter.cjs:105-106`. ADR-021 names Codex reuse "a named gap until a Codex arch-review host exists".

F8. **The tracked journal has no arch-review, base-merge or dispatch records for phases 40–44.**
`grep '"event":"arch_review"' .planning/graph/delivery-log.jsonl | grep -c '"ticket":"T-43-'` → 0; same for T-44 → 0; `base_merge` for T-43/T-44 → 0. Per-phase event breakdown (`grep "\"ticket\":\"T-$p-" … | grep -o '"event":"[a-z_]*"' | sort | uniq -c`): T-40 = 55 status_change + 5 escalation; T-43 = 30 status_change + 1 escalation; T-44 = 16 status_change. The last `arch_review` row is T-36-04 at `2026-09-15T09:24:51Z`; the last `base_merge` is T-36-09 at `2026-09-15T13:07:49Z`; the last `dispatch` is T-36-11 at `2026-09-15T14:29:57Z`. The file was last committed `4f6dafc8 2026-09-28 15:16:20 +0300` (`git log -1 --format='%h %ci' -- .planning/graph/delivery-log.jsonl`), so the file is current but those events are no longer written to it.

F9. **The "phase 43: ~23 launches for 13 tickets, seven discards" baseline is from the target-project run, not Shipyard phase 43.**
`Grep "23 arch|seven times|7 times" .planning/investigations/INV-007-target-project-scale` → `INV-007 RESEARCH.md:20` (F6): "No verdict carried — the head tree MOVED" at seven timestamps; "≈23 arch-review launches for 13 tickets". `ADR-020` Context names that run: pdffiller MYD-17835, 13 tickets across six repositories. Shipyard's phase 43 has 19 tickets (F2) with only 3 merged. `INV-007 research/risks.md:78` states the number "is not re-derived here".

F10. **An old journal row shows contradictory model telemetry.**
The T-36-04 `arch_review` rows record `"model":"sonnet"` next to `"observed_model":"gpt-5.6-sol"` (`grep '"event":"arch_review"' … | tail -2 | cut -c1-300`). This is historical and pre-ADR-014 v6, but it shows the journal alone cannot be trusted to classify cohorts by model.

## 2. Risk register (draft for RISKS.md)

Severity is this line's judgement; each risk names what it depends on.

### R-1 — A looser carry certifies an interaction nobody judged
severity: high
The T-43-13 rule carries a verdict when the own patch is identical and every other path equals the new base (`43-13-PLAN.md` Scope 1-3), and it explicitly carries the case "a sibling deletes a function the ticket calls in a non-owned file" (CI and the epic PR are the interaction checks). Any additional carry rule INV-010 adds (for example carrying across a base move where a non-owned path changed, or carrying from a parent to its children) widens that gap: an architectural conflict that lives in the combination (a sibling that changes an interface, layering or ADR-governed contract the ticket depends on) is judged by nobody until the integrator, and the integrator is itself unreliable at scale (N30, N44).
mitigation: Any new carry must be provable from object identities (ADR-020 "provable from object identities and journal records, not from judgement"). Keep the governing-inputs clause of the success criteria as a hard rule: a changed ADR, plan or policy re-owes review regardless of patch identity. Name the integrator as the interaction check in the ADR and make its identity defect (N44) a prerequisite, not a follow-up.

### R-2 — Carry and reuse combine into a verdict for inputs neither judged
severity: high
ADR-021 forbids "reuse across a changed base" and says "a carried verdict is never a reuse source". T-43-13 posts a carried `merge-gate` status with `carried=patch-id` (plan Scope), today's code marks `carried_from=` (`gate-trailer.cjs:595-604`). If the reuse lookup keys on a manifest that the carried status can satisfy (same head tree after a no-op base merge, for instance), a carried verdict becomes a reuse source by the back door. Neither mechanism exists yet (F1-F3), so the combination has no test.
mitigation: Require a mutation/negative test that a carried status can never be returned as `reused`, and that `carried_from` survives a chain (already a code rule at `gate-trailer.cjs:595-604`). State the precedence in the ADR: reuse (exact input) → carry (identity proof) → fresh launch, with carry never feeding reuse.

### R-3 — Deferral trades review cost for wall-time and serializes the stack
severity: medium
Deferring review until the base stops moving, or reviewing only the next merge candidate (WORK-PACKAGES R3), turns a parallel review phase into a serial one: each merge waits for one review (minutes to tens of minutes on Opus/medium or Sol/high). With N siblings the tail ticket waits for N reviews. The sentinel also hands back on `wait-ci` rather than waiting (`pr-sentinel.md` loop step 4), so each serialized step can cost an extra guard re-post, which is itself a model turn (Sonnet/high or Luna/medium). Savings on arch-review can be eaten by extra sentinel rounds.
mitigation: Measure sentinel rounds and wall time per merged ticket alongside arch-review launches; a treatment that lowers reviews but raises total child-run consumption fails. Consider D1 (host-side duty scheduling) as a dependency so waits do not cost model turns.

### R-4 — "Base stopped moving" is not observable in a live cascade
severity: medium
The epic moves on every sibling squash and on every refresh from `main` (N8). A human checkpoint or a parked sibling can hold the base "still" indefinitely, and a later sibling can move it after a review was launched on the assumption it was stable. There is no signal in `sentinel.cjs duty` today for "no further merge is expected before this one" (F6 shows ordering by depth and id only).
mitigation: Define stability as a property the conveyor controls (this PR is the next merge candidate on its base, per a deterministic priority), not as a prediction. Keep the head-bound gate (`merge-gate` bound to the reviewed head) as the backstop so a mis-predicted stability costs one extra review, never a wrong merge.

### R-5 — Once-per-stack review exceeds the packet bound and loses per-ticket accountability
severity: medium
One review for the whole stack judges a larger diff. The Claude arch-review packet is capped at 60 000 tokens (`claude-role-host.cjs:26`) and 1 MiB of diff (`:23`); N29 already overflowed at 81 785 tokens for one ticket, and N30 shows the integrator failing at 2.46 MB. A stack verdict also does not bind to each ticket's head, which the merge gate requires (`sentinel.cjs:718-722`, head-bound conform).
mitigation: Treat once-per-stack as needing a per-ticket verdict projection with per-ticket head binding and finding attribution; otherwise it collides with the "no gate weakened" criterion. Measure packet sizes on phase-43/44 PRs before choosing it (OQ-2).

### R-6 — The draft/undraft order fix can open a merge window
severity: medium
N46: the duty sends `arch-review` to a draft (`sentinel.cjs:672-683`) and the Claude host refuses drafts (`claude-role-host.cjs:442`). Fixing it by undrafting before review hands the PR to bots and humans (and to `undraft → merge` logic) before a verdict exists; the draft state is the only "not yet certified" signal the board reads (`sentinel.cjs:684-693`). Fixing it by letting the host review drafts changes the identity check that also guards against a stale head.
mitigation: Prefer letting the host accept `isDraft` as an explicit, recorded input while keeping `headRefOid`/branch identity strict; add it to the C1 manifest so a draft→ready flip is a named input rather than silently ignored. Test that undraft remains unreachable without conform.

### R-7 — Environment-only adjudication becomes a verdict override
severity: high
N57 (R10): an `EPERM` before any assertion produced an immutable `violation`. An adjudication path that turns such a violation into conform is exactly the kind of mechanism that can be widened to "accept a verdict for a head it did not judge" (out of scope in PROBLEM.md). Classifying "environment-only" is itself a judgement; a reviewer that could not run tests may have missed a real failure.
mitigation: Keep R10's constraints: unchanged exact head, base and instruction set; trusted same-command CI or host evidence; original violation preserved; explicit human authority or an accepted deterministic policy. Prefer preventing the case (host-owned verification before a review turn, a pre-launch environment check) over adjudicating after it. Count adjudications separately from reviews in the success metric.

### R-8 — The success metric cannot be computed from the journal
severity: high
The problem requires the saving to be "shown by the phase-44 observation data on matched cohorts". The tracked journal has zero arch-review, base-merge or dispatch rows for phases 40-44 (F8), so "9 reviews for 8 PRs" (N54) and the 1.1-1.8 ratio are operator-reported, not journal-derivable. ADR-021 keeps per-account samples in private host state (`~/.local/state/shipyard/<runtime>/subscription/`), outside this worktree and outside this line's read scope. Without a baseline that can be re-derived, the INV cannot show "≤ ~1 launch per merged ticket" or a matched-cohort saving, and every report will be `inconclusive`.
mitigation: Make "every arch-review launch, reuse, carry and re-owe is journalled with ticket, head, base tree and outcome" a prerequisite deliverable; re-derive the phase-44 baseline from role-host receipt stores or GitHub commit statuses before any treatment ships; accept `inconclusive` rather than a static estimate.

### R-9 — The "phase 43" baseline is misattributed
severity: medium
F9: the 23/13 figure and the seven discards come from the pdffiller MYD-17835 target-project run (six repositories), not Shipyard phase 43. Matching cohorts across a multi-repo target project and single-repo Shipyard phases would compare different cascade shapes (repository count, CI length, sibling count per epic).
mitigation: Correct the label in PROBLEM/RESEARCH, keep target-project and Shipyard cohorts separate, and use the target-project number only as motivation.

### R-10 — Cross-runtime parity is asymmetric
severity: medium
Codex has no arch-review host (F7); ADR-021 names Codex reuse a gap. "Both runtimes follow the same rules" therefore requires building a Codex arch-review host (or routing Codex arch-review through a common host), which is out of this INV's size and overlaps C1. Rules written for the Claude host's identity checks (`claude-role-host.cjs:442-450`) may have no Codex equivalent to enforce them.
mitigation: State in the ADR which rules are enforced by a shared deterministic layer (sentinel duty ordering, `gate-trailer.cjs` carry, reuse manifest) and which are host-specific; list Codex as a named gap with an owner rather than claiming parity.

### R-11 — Ownership collisions with pending tickets and work packages
severity: high
The files INV-010 would change are owned or queued elsewhere: `gate-trailer.cjs` and `base-merge.cjs` by T-43-13 (pending, F2) and then T-43-17; `claude-role-host.cjs` by C1, R12, R13 and the N29 packet bound; `sentinel.cjs duty` ordering by R3 and D1; environment adjudication by R10; integrator by R11/R13. ADR-020 already records that about half of phase 43 rewrites phase-40 files. Gate 2 rejects unordered shared paths (ADR-021 context). An INV-010 ADR that re-specifies any of these duplicates an owner (the research contract forbids duplication).
mitigation: The INV-010 decision should be a combination/ordering rule plus a small number of named deltas, each assigned to an existing owner (T-43-13, C1, R3, R10, R13) or explicitly new; sequence after the phase-43 epic reaches main, as C1 already must.

### R-12 — Phase-43 epic latency blocks every lever
severity: medium
T-43-13 waits on T-43-06, which has no remote branch (F2 `base_reason`); C1 waits on the phase-43 epic merge (ADR-021 amendment). Phase 43 has 10 pending and 6 open tickets (F2). Everything INV-010 decides that depends on carry or reuse cannot be measured until then; a decision made now is validated only after the fact.
mitigation: Separate levers that do not depend on T-43-13/C1 (next-candidate review ordering R3, draft precondition N46, pre-launch environment checks) so they can be piloted first, one treatment at a time (WORK-PACKAGES rollout step 5).

### R-13 — Size-based model/effort cannot be treated without a protocol and invalidates cohorts
severity: medium
Out of scope for adoption (PROBLEM.md, ADR-014 scope fences, ADR-021 effort experiment). If studied, it changes a cohort key: ADR-021 says "effort cannot be a treatment because it is a cohort key". Combining a size-based model change with a timing change in the same phase makes neither measurable. The existing signal `inputTokens > window_threshold_tokens` (250 000, policy DATA) already promotes arch-review upward; a size-based *downgrade* for small diffs has no ADR-014 rung and would require a grid amendment.
mitigation: Keep it an option only; if pursued, run it as a separate ADR-021 effort experiment after the timing change has its own measurement.

### R-14 — Reuse manifest misses an input
severity: high (inherited from ADR-021, amplified here)
ADR-021: "a missed input is a stale verdict". Any INV-010 rule that adds a new governing input to a review (draft state, next-candidate position, carried-from lineage, adjudication record) must also enter the C1 manifest, or reuse will return a verdict from a different context.
mitigation: Every new input INV-010 introduces gets a per-field mutation test in C1's suite; list them in the ADR.

### R-15 — Integrator overlap removed too eagerly
severity: medium
The problem includes the integrator "only where its input overlaps a ticket review". Skipping integrator judgement of already-reviewed hunks removes the only place where cross-ticket interactions are judged architecturally (R-1). Three of four phase-44 integrator results were refused on an identity field (N44), so the phase merged with no receipted integrator verdict; reducing integrator scope on top of that leaves no receipted interaction check.
mitigation: Fix N44/R13 first; any overlap reduction must keep the integrator judging the combination (interfaces between tickets), not just the sum of per-ticket hunks.

### R-16 — Orchestrator re-read cost is not addressed by review count
severity: low
PROBLEM.md notes "the orchestrator re-read every result". Reducing launches does not by itself reduce parent-session reads if the orchestrator still loads full artifacts; conversely, the bounded handback already exists (`arch-review.md` complete judgment artifact + bounded synopsis).
mitigation: Measure parent-session consumption separately (ADR-021 statusline observation) and keep it out of the arch-review launch metric.

## 3. Unknowns (draft for OPEN-QUESTIONS.md)

- [ ] OQ-1 — How many arch-review launches, carries, re-owes and base-merges did each phase-43 and phase-44 ticket actually have, and on which heads? The tracked journal has none after T-36 (F8); is the data in role-host receipt stores, board-worktree journals or GitHub `merge-gate` statuses? — owner: repository operator (next check: read `gh api repos/serhii-nochevnyi/shipyard/commits/<head>/statuses` for phase-44 PR heads from an environment where `gh` is authorized; locate the board worktree's `delivery-log.jsonl`)
- [ ] OQ-2 — What fraction of each reviewed phase-43/44 diff was the ticket's own change versus conflict resolution or base content, and what were the packet sizes? Needs `gh pr diff` per PR, blocked in this sandbox (§0). — owner: repository operator / system-state research line
- [ ] OQ-3 — Why did arch-review, base-merge and dispatch events stop being written to `.planning/graph/delivery-log.jsonl` after 2026-09-15 (F8)? Is it the board-worktree journal (N43), a writer removed by the role-host path, or intentional? — owner: delivery-pipeline maintainer
- [ ] OQ-4 — Does the phase-44 subscription observation (ADR-021, private host state) contain per-dispatch arch-review consumption that can be attributed to tickets, and is there an account label for the phase-44 run? Without it the "≈11 % of child consumption" (N54) cannot be reproduced. — owner: repository operator
- [ ] OQ-5 — Should the "phase 43: ~23 launches for 13 tickets" pain point be relabelled as the MYD-17835 target-project run (F9), and is there a Shipyard phase-43 number to replace it? — owner: investigation author
- [ ] OQ-6 — Will T-43-13's A3 hold (`git diff <judgedBaseTree> <judgedHeadTree> | git patch-id --stable` reproduces the judged patch from trees)? The plan leaves it to RED. If not, what fallback identity does INV-010 build on? — owner: T-43-13 executor; spike candidate SP-1
- [ ] OQ-7 — For the draft precondition (N46), does the operator prefer the host to review drafts or the conveyor to undraft before review? The choice changes when bots start reviewing and what the board reads as "certified". — owner: repository operator
- [ ] OQ-8 — Is a Codex arch-review host in scope for the phase that implements INV-010, or is Codex parity a named gap (F7)? — owner: repository operator
- [ ] OQ-9 — What is an acceptable wall-time increase per merged ticket in exchange for fewer reviews under next-candidate or deferred review (R-3)? No latency budget is recorded in the inputs. — owner: repository operator
- [ ] OQ-10 — Who authorizes environment-only adjudication (R10): a human per case, or an accepted deterministic policy, and which evidence counts as "trusted same-command CI"? — owner: repository operator / R10 owner
- [ ] OQ-11 — What defines a "matched cohort" for this INV (tickets per epic, stack depth, repository count, runtime, model/effort, diff size)? ADR-021 requires matched cohorts but does not fix the key for review-timing treatments. — owner: investigation author with the ADR-021 effort-experiment owner
- [ ] OQ-12 — Does the integrator have to re-judge already-reviewed ticket hunks for its interaction check, or only the cross-ticket interfaces, and can N44's `base` ambiguity be fixed without changing its receipt shape? — owner: R11/R13 owner
- [ ] OQ-13 — Which of the four selected backlog notes (`a-childs-pr-base-is-its-merge-target…`, `a-conform-verdict-does-not-survive-a-base-merge-that-changes-nothing`, `drift-gate-judges-one-base-for-a-whole-cascade`, `the-carry-window-closes-on-exactly-the-merge-that-needs-it`) are superseded by T-43-13/C1, and which remain open inputs? This line saw only their packet excerpts. — owner: investigation author (triage)
- [ ] OQ-14 — Does drift-check (D4) share the same stale-on-base-move problem, and should its timing follow the same rule as arch-review, given `drift-gate` takes one base for the whole cascade (backlog note)? — owner: D4 owner

## 4. Spike candidates (not executed; per contract)

- SP-1 — `/gsd-spike "reproduce the judged patch-id from judged base tree and judged head tree on a hermetic cascade (T-43-13 assumption A3), including a merge that duplicates a block in an owned file"`
- SP-2 — `/gsd-spike "replay phase-44 PR heads and merge order to count reviews under next-merge-candidate ordering versus current duty ordering"` (needs OQ-1 data)
- SP-3 — `/gsd-spike "let claude-role-host accept a draft PR as a recorded input and verify undraft stays unreachable without conform"`

## 5. Sources read

- Packet-embedded (authenticated): `PROBLEM.md`, `RESEARCH-CONTRACT.md`, `ADR-014`, `ADR-020`, `ADR-021`, `43-13-PLAN.md`, phase-45 `WORK-PACKAGES.md`, INV-008 `intake/phase40-delivery-findings.md`, `references/arch-review.md`, `references/pr-sentinel.md`, backlog excerpts (4 selected ids).
- Read in the worktree: `plugins/delivery-pipeline/scripts/gate-trailer.cjs:440-615`; `claude-role-host.cjs:23,26,405-455,708,1242-1315`; `sentinel.cjs:595-812`; `base-merge.cjs` (grep hits `:24-299`); `codex-delivery-host.cjs`, `codex-runtime-host.cjs:933-934`, `codex-dispatch-adapter.cjs:105-106` (grep); `.planning/graph/delivery-log.jsonl` (grep counts); `.planning/graph/delivery-state.json` (node summary); `.planning/investigations/INV-007-target-project-scale/{RESEARCH,DECISIONS,PROBLEM}.md`, `research/{alternatives,risks}.md` (grep); `.planning/investigations/INV-010-review-stage-efficiency/RISKS.md` (empty template).
- Not read: GitHub PRs (sandbox, §0); private host subscription state (outside worktree, contract fence); `front.cjs`, `state-sync.cjs`, `drift-needed.cjs`, `degenerate-green.cjs`, `model-policy*.cjs`, `workflows/`, `tests/unit/` (not needed for the risk claims above; the system-state line owns them).
