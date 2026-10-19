# R-32: same-family catch rate against the defects Copilot found in phases 27-29

status: inconclusive
date: 2026-10-19
host: executor sandbox, macOS Darwin 27.0.0, node v24.21.0, git 2.54.0 (Apple Git-157), worktree T-52-02 at HEAD e8299ce01e729f5e0c19e99477a33bb066ef4806 (main 1c34583b, Shipyard 0.73.0)

Question: how often does a same-family reviewer (a Claude or Codex model reviewing code that Claude or Codex models wrote) catch the defects that an independent reviewer (Copilot) caught in phases 27 to 29, and how often did an early ticket's defect cascade into later tickets (INV-018 R-32 and R-35).

Section status:

| Section | Status | Why |
|---|---|---|
| 1. Defect corpus | partial: 6 of 13 defects identified with PR, file and line, plus 1 false-positive control | the PR threads were read on 2026-10-19 with `gh`; the notes' remaining seven defects are counts, and the threads do not say which of them the notes counted as real (section 1) |
| 2. Replay protocol | recorded | a procedure, not a result |
| 3. Per-defect results and catch rate per runtime | not run | needs new blind live reviewer runs on pre-fix diffs; the fill used existing session data only, and no past session reviewed those diffs blind |
| 4. Cascaded fraction (R-35) | measured on the 6 identified defects only | 1 of 6; the 7 unidentified defects are not counted |
| 5. Conclusion sentence | recorded | required by the plan; it does not depend on the figures |

This file is `inconclusive`: the corpus has 6 of 13 defects identified and the replay was not run (reasons in sections 1 and 3). No figure in this file was invented; every number comes from the cited note, a `gh` read of a pull request, or a count over those reads.

## Inputs

Digests were taken with `shasum -a 256 <path>` in the worktree.

| Input | sha256 |
|---|---|
| `.planning/backlog/a-disabled-reviewer-has-no-way-to-say-so.md` | `597a56014c8e3bdee8436aa7576013ed99880152273c063592307f16d234e917` |
| `.planning/backlog/phase-27-followups.md` | `118ccd6e7d8ed8eba32c4b1c68029c32eefe86a54be5aba49509ff741e83b6a8` |
| `.planning/backlog/a-clean-merge-can-duplicate-a-block-two-branches-added-alike.md` | `2db730bfc87644c6d110e9de7c5082348680afc76a975d6fe5c7e1c86b0b1eea` |
| `.planning/backlog/phase-20-followups.md` | `80ca33d08d7eea06193e0fa2e8340fb276eb4459cf0c63fa92929b3528120c8b` |

Counts the corpus must reach, quoted from the notes: "Copilot found four real defects in phase 27 and five in phase 28's first wave" (`a-disabled-reviewer-has-no-way-to-say-so.md`, section "What it costs", item 3, and again in its 2026-09-10 section; `phase-20-followups.md` section 6 says Copilot "found four real defects" in phase 27) and, for phase 29, "#87 ... 3 findings, all real, all fixed" and "#89 ... 1 finding, real, fixed" (same file, 2026-09-10 section). That is 4 + 5 + 4 = 13 real defects.

## 1. Defect corpus

Evidence source for every row: the cited backlog note. Where the note gives no PR number, file or line, the cell says `unknown` and the operator fills it from the PR thread. "Introducing ticket" is the ticket whose change contained the defect; "built on by later tickets" is whether a later ticket's branch carried the defect before it was fixed.

Identified by the notes (6 real defects):

| ID | Phase | PR | File and line | Class | Introducing ticket | Built on by later tickets | Source |
|---|---|---|---|---|---|---|---|
| D-01 | 27 | #70 (T-27-06; the note names no PR, the Copilot thread on this PR matches its description: "the cleanup/trap + lock bookkeeping block is duplicated back-to-back") | `plugins/delivery-pipeline/scripts/epic-branch.sh:121` (a second `cleanup()` and a second `trap cleanup EXIT INT TERM`) | duplicate definition left by a clean merge (bash -n does not catch it) | T-27-04 added the block; a later branch in the same cascade added a byte-identical one | yes, per the note: "it recurred on the very next base-merge in the same round" | `a-clean-merge-can-duplicate-a-block-two-branches-added-alike.md`, section "What happened". The guard found it first; Copilot "independently flagged the same defect on its next review pass" |
| D-02 | 28 | #75 (T-28-07) | `plugins/delivery-pipeline/scripts/base-merge.cjs:166`, the dirtiness check | fail-open on an error path: a failed `git status` read as clean after the check was relaxed to `--untracked-files=no` | T-28-07 | no: caught inside the introducing PR, and no PR is stacked on its branch | `phase-27-followups.md`, section "Two guards failed on real work, one phase after they shipped": "Copilot found it; the check now fails closed" |
| D-03 | 29 | #87 (T-29-04) | `plugins/delivery-pipeline/scripts/jira-project.cjs:450` | dropped diagnostic: `loadConfig()` warnings dropped | T-29-04 (the PR that carried the thread) | no: caught in its own PR before merge, and no PR in GitHub has a base on that ticket branch (0 of the PRs of phases 27 to 29 are stacked on a ticket branch; read with `gh pr list --state all --base <branch>`) | `a-disabled-reviewer-has-no-way-to-say-so.md`, 2026-09-10 section |
| D-04 | 29 | #87 (T-29-04) | `plugins/delivery-pipeline/scripts/jira-project.cjs:272` | duplicated helper: `projectRootFor` and `lockRootFor` | T-29-04 | no (same reason as D-03) | same |
| D-05 | 29 | #87 (T-29-04) | `plugins/delivery-pipeline/scripts/jira-project.cjs:451` | incomplete message: a missing `error.relative` in an error string | T-29-04 | no (same reason as D-03) | same |
| D-06 | 29 | #89 (T-29-06) | `plugins/delivery-pipeline/commands/deliver.md:724` | doc and contract mismatch: a line describes the planner's emitted item without its `ts` field | T-29-06 | no: caught in its own PR before merge; no PR is stacked on its branch | same |

Not individually identified (7 real defects): 3 in phase 27 (to reach four with D-01) and 4 in phase 28's first wave (to reach five with D-02). The notes give only the counts. The PR threads were read on 2026-10-19 (`gh api repos/<owner>/<repo>/pulls/<n>/comments`, Copilot author only), and they do not say which threads the notes counted as real, so choosing seven of them here would be a guess. The candidates, by PR (Copilot line comments; threads on pre-fix heads are included, declined and proven-wrong ones are not separated):

| Phase | PR (ticket) | Copilot line comments | Examples of the threads (path:line, topic) |
|---|---|---|---|
| 27 | #63 (T-27-01) | 8 | `ci-wait.cjs:201` and `stop-gate.cjs:528` `capNum()` treats `null` as 0; `ci-wait.cjs:208` and `stop-gate.cjs:529` negative capacity accepted; `drift-gate.mjs:13` stale header comment |
| 27 | #64 (T-27-02) | 1 | `gate-trailer.cjs:457` `gh pr view` run without a working directory |
| 27 | #65 (T-27-07) | 5 | `source-contract.test.cjs:68,69,110,111` brittle assertions; `docs-smoke.sh:246` message inaccurate |
| 27 | #66 (T-27-03) | 4 | `sentinel.cjs:201,202` (the control C-01); `sentinel.cjs:676`, `front.cjs:451` redundant `limbBaseOf` scans |
| 27 | #68 (T-27-04) | 2 | `epic-branch.sh:51` `stat -f` on GNU stat; `ticket-worktree.sh:7` misleading usage text |
| 27 | #69 (T-27-05) | 5 | `deliver.md:125` agent-file naming; `pipeline-config.cjs:802` `runtimeToken()` can return `-`; `dispatch-record.cjs:367` route not cross-checked; two test-quality threads |
| 27 | #71 (T-27-08) | 2 | `pipeline-config.test.cjs:127` misleading comment; `front.cjs:1392` wording |
| 27 | #72 (T-27-09) | 0 | none |
| 28 | #73 (T-28-02) | 3 | not itemised here |
| 28 | #74 (T-28-04) | 3 | not itemised here |
| 28 | #76 (T-28-01) | 2 | not itemised here |
| 28 | #78 (T-28-05) | 4 | not itemised here |
| 28 | #80 (T-28-03) | 6 | not itemised here |
| 28 | #81 (T-28-06) | 4 | not itemised here |
| 28 | #77, #82 (T-28-08, T-28-09) | 0 | none |

Phase 29's #83 to #90: only #87 (3 threads) and #89 (1) have Copilot threads that the notes count (D-03 to D-06); #90 (T-29-07) has 2 more that the notes do not mention. Phase 28's first wave is not identified in the notes and the phase's own ticket PRs carry 23 Copilot threads (22 outside D-02's), so the four missing defects cannot be narrowed to a PR.

| ID | Phase | PR | File and line | Class | Introducing ticket | Built on by later tickets |
|---|---|---|---|---|---|---|
| D-07 to D-09 | 27 | one or more of the candidates above | not identified | not identified | not identified | not counted |
| D-10 to D-13 | 28 | one or more of the candidates above | not identified | not identified | not identified | not counted |

False-positive control (not counted as a defect):

| ID | Phase | PR | File | What Copilot said | What was true | Source |
|---|---|---|---|---|---|---|
| C-01 | 27 | T-27-03 (PR #66) | the `treeBlobs()` helper | flagged twice that a slash-containing ref is interpolated into `git/trees/<ref>` unencoded | encoded and unencoded requests return byte-identical responses live; applying `encodeURIComponent(ref)` produced a live 404 and 5 smoke failures, so the suggestion was a regression | `phase-27-followups.md`, section "Copilot proposed a regression, and the guard proved it was one" |

A reviewer that reports C-01 as a defect has a false positive; record it separately from the catch rate.

### How the operator completes the corpus (read-only)

```
gh repo view --json nameWithOwner
gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate
gh api repos/<owner>/<repo>/pulls/<n>/reviews --paginate
```

For each PR in the phase (phase 27: #63 to #72; phase 29: #83 to #90, of which the notes say only #87 and #89 had Copilot findings; phase 28: the PRs of its first wave, numbers to be read from `git log --first-parent` and `.planning/graph/delivery-state.json`), keep the threads whose author is the Copilot reviewer, and for each real one record `path`, `line` or `original_line`, `original_commit_id` (the head Copilot reviewed), the fix commit, and whether the thread was accepted, declined or proven wrong. To find the introducing commit and its descendants: `git log -S'<distinctive string>' --format='%H %s' -- <file>` for the introducing commit, then the ticket graph (`.planning/graph/tickets.json`, parents and `primary_parent`) for the tickets stacked on the introducing ticket's branch before the fix landed. Declined and proven-wrong threads go to the control table, not the corpus.

## 2. Replay protocol

1. **Reviewer prompt.** The reviewer prompt and finding format verified in `gsd-reviewer-contract.md` (R-31). If R-31 is `not-verified`, replay with the same prompt anyway and report identity-dependent figures with that caveat.
2. **Models.** Claude Sonnet at `xhigh` (the Claude base rung of `arch-review`) and Codex Sol at `high` (the Codex base rung); the rungs are read in `arch-review-cost.md`, section 3. One run per defect per runtime.
3. **Input.** The pre-fix diff of the PR: the base of the PR against `original_commit_id` of the Copilot thread (the head Copilot reviewed), in a worktree at that head. Run in that worktree so that backlog notes written after the defect are absent; the notes in this repository describe these defects and a model that reads them is not a blind reviewer. Do not give the reviewer Copilot's comment.
4. **Per-defect result**, judged by a person from the reviewer's findings list:
   - `found`: a finding describes the same defect and has the same `path` and `line` as the Copilot thread (so the same identity under `review-signature.cjs`);
   - `found-with-different-identity`: a finding describes the same defect but its `path` or `line` differs, so a later round would treat it as a different finding;
   - `missed`: no finding describes it.
5. **False positives.** Record whether the run reports C-01 as a defect, and count findings that match no corpus defect and no known-real issue as `unmatched` (reported, not scored).

## 3. Per-defect results and catch rate per runtime

Status: not run. The protocol in section 2 needs a blind reviewer run on the pre-fix diff of each defect, on Claude Sonnet/xhigh and on Codex Sol/high, with a person judging the findings. The fill used only data from existing sessions, and no past session reviewed these pre-fix diffs without Copilot's comment or the notes in view, so there is nothing to score. No result was estimated.

| Defect | Claude Sonnet/xhigh | Codex Sol/high | Notes |
|---|---|---|---|
| D-01 to D-06 | not run | not run | the PR, path and line of each are in section 1, so a replay can start from them |
| D-07 to D-13 | not run | not run | not yet identified (section 1) |
| C-01 (control) | not run | not run | |

Catch rate per runtime: N = 0 recorded results on both runtimes, so no rate is stated. The planned columns (found, found-with-different-identity, missed, strict and loose rate, unmatched findings, whether C-01 is reported) have no values.

What is needed to turn this file into `measured`: (1) the operator classifies the phase-27 (28 threads, one of them D-01's) and phase-28 (23 threads, one of them D-02's) candidate threads and names the seven missing defects; (2) one blind run per defect and runtime, 13 defects by 2 runtimes plus the control, on the `original_commit_id` heads; (3) the scrubbed outputs under `docs/audits/phase52/samples/`. That is up to 28 live reviewer launches. The operator has not authorised them, so the status stays `inconclusive`. Plan 52-05 and the tickets after it are blocked by an `inconclusive` R-27, not R-32; the downstream consequence of an `inconclusive` R-32 is the one the plan states for it (the catch-rate figure stays unknown and the ADR's statement that a same-family reviewer reduces rather than removes the dependence on independent reviewers stands without a figure).

## 4. Cascaded fraction (R-35)

Definition: of the corpus defects, the share that an early ticket introduced and later tickets built on before it was fixed. "Built on" means a later ticket's branch contained the defective code when it was cut or base-merged. A defect with no recorded descendant is counted as `unknown`, not as `no`, unless the ticket graph shows no ticket stacked on the introducing ticket's branch at the time.

Seed observations from the notes (these are not the fraction):

- D-01 is documented as recurring: "it recurred on the very next base-merge in the same round" (`a-clean-merge-can-duplicate-a-block-two-branches-added-alike.md`).
- A cascade of a CI failure, not a Copilot defect, is documented in `phase-27-followups.md`, section "The board offers a fix at a child whose failure is its parent's": T-27-03's red assertion was inherited by T-27-04 and again by T-27-05 ("Three PRs, three offers, one cause"). It shows the mechanism (a parent's divergence propagates to every descendant already cut) and is excluded from the Copilot corpus because it was a failing check.
- Of the 6 identified defects, 1 (D-01) is documented as cascaded and 5 (D-02 to D-06) were caught inside their introducing PR. For those 5 the ticket graph rule applies: no PR of phases 27 to 29 has a base on a ticket branch (`gh pr list --state all --base <ticket branch>` returned nothing for T-27-06, T-28-07, T-29-04 and T-29-06, and a count over the last 400 PRs found 0 with a `ticket/T-27`, `ticket/T-28` or `ticket/T-29` base), so no ticket was stacked on them, and a ticket cut from the epic after the merge received the fixed code. They are counted `no`, not `unknown`. D-01's cascade is by base-merge of the epic into a parallel branch, a different route.

| Quantity | Value |
|---|---|
| Corpus defects with a recorded introducing ticket | 6 of the 6 identified (D-01 T-27-04; D-02 T-28-07; D-03 to D-05 T-29-04; D-06 T-29-06); the other 7 are not identified |
| Of those, built on by at least one later ticket | 1 (D-01) |
| Of those, `unknown` | 0 |
| Cascaded fraction (built on / recorded) | 1 of 6 (about 17 percent), over the identified defects only |
| Mean number of later tickets that carried a cascaded defect | at least 1 for D-01 (the note records one recurrence on the next base-merge); the exact count is not recorded, so no mean is stated |

Reading the fraction: the 6 identified defects are the ones the backlog notes chose to describe, so they are not a random sample of the 13, and a fraction over 6 is a weak estimate (one defect moves it by 17 points). It does show the topology: in phases 27 to 29 tickets are cut from the epic and merged one at a time, so a Copilot-found defect rarely lives long enough to be built on; the cascading cases in the notes arise from parallel branches (D-01) or from a red check inherited by descendants (the T-27-03 case above), not from stacked tickets.

## 5. Conclusion that does not depend on the figures

The role reduces rather than removes the dependence on independent reviewers: a same-family reviewer can share the blind spots of the models that wrote the code, so an independent reviewer remains the check on the reviewer. The replay in section 3 measures how much of that dependence is left; it does not remove it.

## Commands run by the executor

- `shasum -a 256 <each backlog note in the Inputs table>`
- the Grep tool over `.planning/backlog` for `Copilot` (24 matching lines across 6 notes) and over `phase-27-followups.md` for section headings and `Copilot`
- reading `a-disabled-reviewer-has-no-way-to-say-so.md` lines 64 to 95 with the Read tool

Commands run on 2026-10-19 to fill sections 1, 3 and 4 (read-only):

- `gh repo view --json nameWithOwner`; `gh pr view <n> --json number,title,state,mergedAt,headRefName,baseRefName,reviews,comments` for #63 to #72, #87 and #89; the same with `createdAt`, `mergedAt` and `commits` for #70, #75, #87 and #89
- `gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate` filtered to the Copilot author for #63 to #66, #68 to #72, #75, #87 and #89, and a comment count for #73 to #90
- `gh pr list --state all --base <ticket branch>` for the four ticket branches above, and a count of PRs among the last 400 whose base starts with `ticket/T-27`, `ticket/T-28` or `ticket/T-29`
