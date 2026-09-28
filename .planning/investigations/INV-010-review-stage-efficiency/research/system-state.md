# INV-010 research — line 1: current system state

- **Line:** system-state (→ RESEARCH.md "Current system state")
- **Source revision:** `f3ea7482e7fd6a61eed292125dce54e8973fbd58` (`git rev-parse HEAD` in `/Volumes/KINGSTON/.wt-claude-shipyard/inv010`)
- **Policy hash (packet data):** `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968`, policy version `adr-014.v6`; policy signals passed to this dispatch: `{}`
- **Selection:** Claude `claude-opus-5-5` / medium (research base rung)
- **Codebase maps:** `.planning/codebase/` does not exist (`ls .planning/codebase` → `No such file or directory`), so this line maps from source directly.

## 0. Deployment state first (is the code under discussion actually there?)

The problem statement names two accepted mechanisms as "inputs": the ADR-020 own-diff carry (T-43-13) and the ADR-021 exact-input reuse (phase-45 C1). Before any analysis: **neither exists on `main`, on the phase-43 epic, or in this worktree.**

| Claim | Command | Result |
|---|---|---|
| Latest release | `git tag --sort=-creatordate \| head -3` | `v0.68.0`, `v0.67.0`, `v0.66.0` |
| `origin/main` tip | `git log -1 --format='%h %cI' origin/main` | `7a00a95f 2026-09-28T16:50:12+03:00` |
| Patch-id carry absent on HEAD and on the epic | `git show <r>:plugins/delivery-pipeline/scripts/gate-trailer.cjs \| grep -c patch-id` for `HEAD` and `origin/epic/43-target-project-delivery-at-scale` | `0` on both |
| T-43-13 test absent | `git cat-file -e <r>:tests/unit/verdict-carry.test.cjs` | `no` on both |
| C1 `reused` outcome absent | `git show <r>:plugins/delivery-pipeline/scripts/claude-role-host.cjs \| grep -ci reused` | `0` on both |
| T-43-13 never started | `node -e` over `.planning/graph/delivery-state.json` | `T-43-13 pending null` (no PR); T-43-12, -14…-19 also `pending` |
| No commit mentions T-43-13 | `git log --all --oneline --grep='T-43-13'` | empty |
| Phase-43 epic not on main | `git merge-base --is-ancestor origin/epic/43-target-project-delivery-at-scale main` | `epic43-NOT-in-main` (note: local `main` is stale at `22ef429b`; recheck against `origin/main` — assumption that the result is the same, since ADR-021 amendment states phase 43 has not merged) |

Consequence: every phase-43/44 observation in PROBLEM.md was produced by the **tree-equal carry only** (ADR-006 D2, §2.4 below) and **no reuse at all**. T-43-13 and C1 are paper contracts; their interaction with launch timing is unimplemented in both runtimes. C1 additionally "waits for the phase-43 epic" (ADR-021 amendment; WORK-PACKAGES.md workstream C).

Also on disk: `merge-gate` commit status (T-40-19) **is** present — `gate-trailer.cjs:171` `const STATUS_CONTEXT = 'merge-gate'`, `readGate` at `:183-197` (newest `merge-gate` status wins, body trailer is the fallback).

## 1. Entry points and lifecycle of a ticket PR today

### 1.1 Opening
- `commands/deliver.md:2063` and `:2073` — the PR is created with `gh pr create --base <state[T].base> … --draft`. Every ticket PR starts as a draft.

### 1.2 The duty ladder (`scripts/sentinel.cjs dutyItems`, `:579-789`)
Per `pr-open` ticket, exactly one action, first match wins (read from `sed -n 560,760p plugins/delivery-pipeline/scripts/sentinel.cjs`):

1. `parked` (escalation/attempts).
2. `wait-parent` — `parentIsMoving(id)` (`:604-611`): the ticket is stacked on a primary parent whose PR is still open. **A stacked child is not reviewed while its parent is open.**
3. `ci-fix` — any failing check (`:612-614`).
4. `base-merge` — `baseCheck` says `BEHIND`/`DIRTY` or `behind_by > 0` (`:639-648`, `baseCheck` at `:514-525`, `front.cjs baseMoved` at `:255-264`). Placed ahead of threads and pending CI.
5. `review-fix` — unresolved threads (`:649-652`).
6. `wait-ci` — check state unreadable or `pending > 0` (`:653-668`). **arch-review is never offered while CI is running.**
7. `arch-review` on a draft without a head-bound conform (`:669-683`).
8. `human-merge` (no CI ran) / `undraft` (`:684-693`).
9. `human` for an unanswered checkpoint (`:694-702`).
10. `wait-human` / `review-fix` on `CHANGES_REQUESTED` (`:703-716`).
11. `arch-review` on a non-draft without a conform for this head (`:717-722`).
12. `wait-parent` for a checkpoint parent, `human-merge` for no-CI/limb, else `merge` (`:723-760`).

Ordering: `items.sort` by stack depth, then ticket id (`sentinel.cjs:789`). There is **no merge-candidate election**: every depth-0 sibling on the same epic that is green, based-merged and thread-free is offered `arch-review` in the same tick (`grep -n "sort(\|priority\|unlock" sentinel.cjs` → only `:789`). This is N15 (INV-008 intake) and phase-45 R3, both open.

**Answer to research question 1 (launch timing):** a review launches after exact-head CI is green (steps 3, 6), after the base-merge for the *current* base tip (step 4), with threads at zero, and — for a stacked child — only once the parent is no longer open (step 2). It does **not** wait for the base to *stop* moving: siblings on the same epic are reviewed concurrently, and the first sibling squash-merge moves the epic under all the others.

### 1.3 Events that make a verdict stale today
The verdict is bound to the head it judged (`gate-trailer.cjs` header `:17-24`; `gateConform(s.gate, s.head_sha)` in `sentinel.cjs:669,717`). Any head change makes it absent unless `carry` succeeds:

| Event | Head moves? | Carry possible today? | Source |
|---|---|---|---|
| Sibling squash-merge into the epic → `base-merge` | yes (merge commit) | **No** in practice — head tree includes the sibling, so condition 1 fails | `gate-trailer.cjs:495` "the head tree MOVED" |
| Epic refresh from `main` → `base-merge` | yes | No, same reason | same |
| Parent squash + child retarget | yes | No (base tree and head tree both move) | `:495`, `:564` |
| review-fix / ci-fix push after the verdict | yes | No, by design ("a push after the verdict re-owes arch-review") | `deliver.md:2436-2438`, `pr-sentinel.md` "The verdict is bound…" |
| Base-merge with a declared-file conflict resolved by hand | yes, pushed outside the script | No — carry window already closed | `gate-trailer.cjs:533`; backlog `the-carry-window-closes-on-exactly-the-merge-that-needs-it.md` |
| Base branch moves during the review run | — | Result rejected `STALE_CONTEXT` (launch lost) | `claude-role-host.cjs:1051-1059` |

### 1.4 The only carry that exists (ADR-006 D2)
`gate-trailer.cjs carry` (`:426-613`), called only from `base-merge.cjs carryVerdict` (`:205-226`) **before** the push (base-merge does not push: header `:52-56`, N3). All must hold:
- `from` and `to` resolve to trees, and the **head trees are equal** (`:486-497`);
- `to` descends from `from` (`:501`);
- live PR is at `from` (`:533`);
- the trailer/status records a full 40-hex `base_tree` (`:536-545`);
- the **new merge-base tree equals the judged base tree** (`:547-566`);
- the live PR did not change during the proof (`:569-583`).
On success it posts a `merge-gate` status on `to` with `carried_from=` and drops `checks=` (`:585-611`).

Structural observation: for a sibling base-merge the merge commit's tree = judged head ∪ sibling change ≠ judged head tree, so this proof cannot fire in the N54/D-03 case. It covers only a base move that brings no content. This is exactly the gap T-43-13 (patch-id + owned-blob identity) was planned to close.

## 2. What a review judges today (research question 2)

### 2.1 Claude role host (`scripts/claude-role-host.cjs`)
`prepareArch` (`:438-470`):
- Refuses unless the live PR is `OPEN`, **`isDraft !== true`**, head branch/oid match the worktree (`:442-445`, "live PR identity differs from the ticket worktree").
- `mergeBase = git merge-base <live base> <head>`; `mergeBaseTree` (`:448-449`).
- Judged diff: `git diff --no-ext-diff --unified=50 <mergeBase>...<head>` (`diffText`, `:420-424`), bounded at `DIFF_MAX_BYTES = 1 MiB` (`:23`); packet bound `ARCH_REVIEW_PACKET_TOKENS = 60000` (`:26`, `:708`).
- Role context: PR identity, `exact_diff {base, base_tree, head, content}`, `integration_base {ref, commit, tree}`, ADR refs incl. excluded/unresolved, reference digest (`:452-462`).
- Signals are **derived by the host** (`observedSignals`, `:371-387`): `risk` from the row, `critical`, `checkpoint = human_checkpoint === true`, `contested = reviewDecision === 'CHANGES_REQUESTED'`, `inputTokens` from the packet estimate. A caller signal that differs is rejected `SIGNAL_MISMATCH` (`:382-385`).
- During the run: `revalidateLiveInputs` rejects if head, base ref or **base oid** changed (`:1051-1059`).

So the judged input is the PR's net change against the merge base with its **current** base. After a completed base-merge the merge base is the new epic tip, so the three-dot diff is the ticket's own net change (plus any conflict adaptation in owned files). The "whole PR vs own diff" distinction mostly collapses in the text the model reads: the re-review after a sibling merge reads essentially the **same own patch** again, plus the full ADR corpus. The cost is the re-judgement, not a larger diff. (Assumption, labelled: unverified against a live packet because `gh` is unavailable in this sandbox — see §6. Next check: `git diff <pre-merge merge-base>...<judged head> | git patch-id --stable` vs the same for the post-merge pair on a phase-44 PR.)

### 2.2 Codex path
- `codex-delivery-host.cjs:27` — `TICKET_DELIVERY_ROLES = new Set(['drift-check', 'ci-fix', 'review-fix'])`; `grep -n arch-review codex-delivery-host.cjs` → no match. **There is no Codex arch-review host.**
- Codex arch-review runs as a generated static agent (`shipyard-arch-review.toml` / `-critical.toml`) through `codex-runtime-host.cjs` / `codex-dispatch-adapter.cjs`; its evidence file is the only writable path under a **`read-only` sandbox** (`codex-runtime-host.cjs:929-945`, `staticEvidenceWritePath`: `sandbox !== 'read-only'` → null). The agent assembles its own input per `references/arch-review.md` (`gh pr diff`, compare API for `base_tree`).
- This is the mechanism behind N57: test commands run by the reviewer hit `EPERM` creating temp files because the sandbox is read-only, and the reference instructs "Treat an unverified checkable claim as a `violation`" (`references/arch-review.md` Procedure step 4). Nothing in the Codex path distinguishes environment-only failures (phase-45 R10, open).
- Generated TOMLs are install-time output; none is tracked (Glob for `shipyard-arch-review` finds only `.cjs`/`.md` references). ADR-021 already names "Codex reuse is a named gap until a Codex arch-review host exists".

### 2.3 Own-change share in phases 43/44 — measured part
Squash commits on `origin/main` for phase 44 (`git show --shortstat` on each):

| Ticket | PR | Squash | Merged (commit time) | Own change |
|---|---|---|---|---|
| T-44-07 | #332 | `115000ee` | 12:08:19 | 2 files, +862 |
| T-44-01 | #331 | `caf2ea20` | 12:16:10 | 4 files, +687 −4 |
| T-44-02 | #335 | `0b427c24` | 12:23:28 | 3 files, +211 −7 |
| T-44-06 | #336 | `7a8c7fbc` | 12:30:33 | 5 files, +448 −25 |
| T-44-03 | #337 | `e99ad34e` | 12:40:43 | 2 files, +728 |
| T-44-04 | #340 | `660b123c` | 12:59:22 | 5 files, +288 |
| T-44-05 | #341 | `7941b7ef` | 13:14:39 | 4 files, +268 −1 |
| T-44-08 | #344 | `c1b1d087` | 13:56:00 | 1 file, +1 |

Eight epic moves in ~1 h 48 min, each one making every still-open sibling `base-merge` → CI → `arch-review`. Own diffs are small (1–862 lines). Per §2.1 the judged text after a completed base-merge is the own net change; the share of "foreign" content in the reviewed diff is therefore ≈0 for non-conflicting sibling merges, and the waste is repetition, not size. **Unmeasured:** per-review packet size and the ADR corpus fraction of `inputTokens` (needs the host receipts or `dispatches.json` from the delivery board worktree).

Phase 43: the epic's first-parent history (`git log --first-parent origin/epic/43-…`) shows three `Merge origin/main into epic/43…` refreshes (`82f25a53`, `0e6299a3`, `649ab2bd`) and squashes #264, #323, #326 plus a true merge of #338 (`305cae89`, 16:47). Each is an epic move for every open sibling.

## 3. Journal and board evidence available in this worktree

- `.planning/graph/delivery-log.jsonl`: 46 `arch_review` events total (Grep count). The **latest is 2026-09-15, T-36-04** (`grep '"event":"arch_review"' … | tail -5`). Phase 43/44 tickets have only `status_change` (46) and `escalation` (1) events here (`grep -E '"ticket":"T-4[34]-' … | grep -o '"event":"[a-z_]*"' | sort | uniq -c`).
- Therefore the "9 reviews for 8 PRs" (N54) and "~23 launches for 13 tickets" (D-03, 43-13-PLAN) figures **cannot be re-derived from the tracked journal**; they live in the delivery-board worktrees' journals/dispatch stores, not committed here. They are cited from INV-008 intake and the T-43-13 plan, unverified by this line.
- The tracked `delivery-state.json` is stale for phase 43: it lists T-43-03 as `pr-open 338`, while `origin/epic/43` contains `305cae89 Merge pull request #338` (16:47). It lists T-43-05/-07/-10/-11 `pr-open` and T-43-04 stacked on T-43-07's branch.
- The tracked journal records a `base_tree` on arch_review events (e.g. T-36-04 lines) and a `model`/`effort_applied`/`observed_*` set, so a C1-style manifest can be cross-checked from the journal once board journals are consolidated.

## 4. Draft precondition (N46) — reproduced statically
- PRs are opened `--draft` (`deliver.md:2063`).
- `sentinel.cjs:669-683` offers `arch-review` on a **green draft** ("Certify BEFORE readying"); `undraft` only after conform (`:690-693`); `deliver.md:2439` "→ gh pr ready <pr>" after the trailer write.
- `claude-role-host.cjs:442` and `:1054` refuse `live.isDraft === true`.
- So on Claude the duty the guard is given is one its own host must refuse. The refusal happens in `prepareArch`, i.e. before the model launch (no model turn lost, but an operator/guard round is). The Codex static path has no such host check (§2.2).

## 5. Integrator overlap (N44)
- `claude-role-host.cjs:532-534`: combined diff = `git diff <merge-base(default, epic head)>...<epic head> -- . ':(exclude).planning'`, i.e. the union of all ticket diffs already individually reviewed, plus phase contracts and the ADR corpus (`:539-552`). No per-ticket verdict or its manifest is consulted as input; there is no carry from ticket verdicts (composition carry was rejected in INV-007, per 43-13-PLAN "Out of scope").
- `:910-916`: the result must match `prepared.base` exactly (the ref), else `ARTIFACT_IDENTITY_MISMATCH` — the exact refusal N44 reports when the model writes a commit sha. Refused results are lost launches; there is no bounded repair (phase-45 R6/R13 open).
- Bound `DIFF_MAX_BYTES` 1 MiB (`:23`) also applies here (N30).

## 6. Known warts found in the current code

1. **Tree-equal carry cannot fire on a sibling base-merge** (§1.4, `gate-trailer.cjs:495`). The only carry in production does not cover the dominant stale case.
2. **Carry runs only inside `base-merge.cjs`, before the push** (`base-merge.cjs:52-56`, `gate-trailer.cjs:533`). A hand-resolved conflict closes the window (backlog item).
3. **No merge-candidate election** (`sentinel.cjs:789`): all green siblings are reviewed concurrently; each merge invalidates the rest (N15, R3).
4. **Draft/host order contradiction** (§4, N46).
5. **`contested` has two definitions.** `pr-sentinel.md` step 1 derives it from the journal (`arch_review` with `verdict:violation` for this ticket); `claude-role-host.cjs:378` derives it from `reviewDecision === 'CHANGES_REQUESTED'` and rejects a mismatching caller value (`:382-385`). A caller following the reference after a prior violation would be refused. This matters for any rule that re-routes a re-review's rung.
6. **Codex arch-review is read-only and self-assembling** (§2.2): environment failures become verdicts (N57); no host-side input identity exists for a manifest or single-flight.
7. **Base movement mid-run discards the launch** (`claude-role-host.cjs:1051-1059`, `STALE_CONTEXT`) — correct, but in a fast cascade (8 merges in 108 min, §2.3) a long review is likely to be invalidated before it returns.
8. **Tracked journal lacks phase-43/44 review events** (§3): matched-cohort evidence demanded by PROBLEM.md success criteria is not in the repository.

## 7. Existing tests covering this surface
- `tests/unit/trailer.test.cjs` — `carry` refusal suite (`suite('gate-trailer carry: the refusals…')` at `:1069`, real-git fixture `carryRepo` at `:925`, abbreviated `base_tree` refusal `:1089`).
- `tests/unit/sentinel.test.cjs` — duty ordering (`arch-review` without trailer `:86-92`; never undraft without a verdict `:208`).
- `tests/unit/front.test.cjs`, `tests/unit/claude-role-host.test.cjs` (sentinel duty enum incl. `arch-review` `:695`, `:705`), `tests/unit/degenerate-green.test.cjs`, `tests/unit/drift-needed.test.cjs`.
- `base-merge.cjs` is exercised by `tests/smoke/worktree-gates-smoke.sh`, `tests/smoke/sentinel-smoke.sh`, `tests/unit/claude-delivery-host.test.cjs`, `repair-artifacts.test.cjs`, `source-contract.test.cjs`, `files-contract.test.cjs` (`grep -rln base-merge.cjs tests/`).
- **Missing:** `tests/unit/verdict-carry.test.cjs` (T-43-13), any reuse/manifest mutation test (C1), any test that a draft PR is reviewable or undrafted by the conveyor, any Codex arch-review host test. Test suites were not executed by this line (read-only research); existence only.

## 8. How the accepted inputs would combine (research question 3, state view only)
- T-43-13 (planned): carries a conform across a base-merge when `patch-id --stable(judgedBase..judgedHead) == patch-id(newBase..newHead)`, the new diff touches only owned `files_modified` paths, and each owned blob equals the judged one; else re-owed (43-13-PLAN Scope). It posts `merge-gate` with `carried=patch-id`.
- C1 (planned): reuse only on an exact manifest including base, merge-base and their trees; "no reuse across a changed base and a carried verdict is never a reuse source" (ADR-021).
- Therefore, in the current design, after a sibling merge **only T-43-13 can save the review**; C1 cannot (base changed). C1 saves only repeated launches on an identical input (e.g. a retry after a lost/refused result, or concurrent duplicates via single-flight).
- Stale cases neither covers (derived from the plans, not from code, because neither is implemented): (a) push after verdict (review-fix/ci-fix) — by design; (b) base-merge whose conflict touched an owned file; (c) parent squash + retarget where the child's own patch is recomputed against a new base with parent content now in the base — patch-id may match, owned-path condition depends on whether the child's owned files overlap the parent's; (d) review invalidated mid-run (`STALE_CONTEXT`) — a launch spent with no verdict to carry; (e) environment-only violation (N57) — neither carry nor reuse lifts a violation; (f) draft refusal (N46) — no verdict at all.
- Carry also depends on `base_tree` being recorded; the Claude host supplies `exact_diff.base_tree` and the writer refuses abbreviations (`gate-trailer.cjs:365-374`), so absence is visible, not silent.

## 9. Uncertainties and next checks

| Unknown | Why it matters | Next check |
|---|---|---|
| Real per-PR arch-review launch counts for phases 43/44 | Success criterion baseline (1.1–1.8/ticket) | Read the board worktree `delivery-log.jsonl` and `dispatches.json`/receipt store (not in this worktree); or `gh api repos/serhii-nochevnyi/shipyard/commits/<sha>/statuses` per head for `merge-gate` history — `gh` failed here: `open /Users/serhii/.config/gh/config.yml: operation not permitted` (sandbox) |
| Packet size split (diff vs ADR corpus) per review | Whether diff-size-based effort could matter at all | Host receipts' `inputTokens` from the board store |
| Whether patch-id is reproducible from trees (43-13 assumption A3) | T-43-13 viability | `/gsd-spike "patch-id from trees across a sibling base-merge"` (not run: read-only line) |
| Whether T-43-03/#338 state is truly merged | Stale tracked board | `node plugins/delivery-pipeline/scripts/state-sync.cjs` on the board worktree (not run: writes state) |
| Codex arch-review input and sandbox in the installed 0.68.0 bundle | Parity rule for both runtimes | Inspect generated `shipyard-arch-review.toml` in the installed Codex home (outside this worktree; not read) |
| Local `main` vs `origin/main` for the epic-ancestry check | §0 row | `git merge-base --is-ancestor origin/epic/43-… origin/main` |

## 10. Sources read
`PROBLEM.md`, `RESEARCH-CONTRACT.md` (this INV); ADR-014, ADR-020, ADR-021 (packet content); `.planning/phases/43-target-project-delivery-at-scale/43-13-PLAN.md`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/WORK-PACKAGES.md`; `.planning/investigations/INV-008-residual-pipeline-efficiency/intake/phase40-delivery-findings.md` (N15, N44, N46, N54, N57); `plugins/delivery-pipeline/references/arch-review.md`, `references/pr-sentinel.md`; `commands/deliver.md` (`:478-490`, `:2055-2075`, `:2300-2445`, `:2620-2640`); scripts `sentinel.cjs`, `front.cjs`, `gate-trailer.cjs`, `base-merge.cjs`, `claude-role-host.cjs`, `codex-delivery-host.cjs`, `codex-runtime-host.cjs`; `.planning/graph/delivery-log.jsonl`, `delivery-state.json`; backlog `the-carry-window-closes-on-exactly-the-merge-that-needs-it.md`. Not read: `state-sync.cjs`, `degenerate-green.cjs`, `drift-needed.cjs`, `model-policy*.cjs`, `workflows/*.mjs` beyond listing — the review launch path above does not pass through them except `state-sync` projecting `gate`/`head_sha` into state.

## 11. Blocked actions (reported, not worked around)
- `gh pr view` / `gh api` — sandbox denies reading `~/.config/gh/config.yml`; no GitHub PR data was read.
- A `cd …/.planning/graph && …` compound command and an `ls ~/.claude/plugins/cache` read required approval and were auto-denied; the same data was read via absolute-path commands where possible, and the installed-cache inspection was skipped.
