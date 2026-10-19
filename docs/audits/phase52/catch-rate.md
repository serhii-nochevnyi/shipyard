# R-32: same-family catch rate against the defects Copilot found in phases 27-29

status: pending-operator
date: 2026-10-19
host: executor sandbox, macOS Darwin 27.0.0, node v24.21.0, git 2.54.0 (Apple Git-157), worktree T-52-02 at HEAD e8299ce01e729f5e0c19e99477a33bb066ef4806 (main 1c34583b, Shipyard 0.73.0)

Question: how often does a same-family reviewer (a Claude or Codex model reviewing code that Claude or Codex models wrote) catch the defects that an independent reviewer (Copilot) caught in phases 27 to 29, and how often did an early ticket's defect cascade into later tickets (INV-018 R-32 and R-35).

Section status:

| Section | Status | Why |
|---|---|---|
| 1. Defect corpus | partial: 6 of 13 defects identified, plus 1 false-positive control | the backlog notes name six defects individually; the other seven exist only as counts and need the GitHub review threads, which the executor cannot reach |
| 2. Replay protocol | recorded | a procedure, not a result |
| 3. Per-defect results and catch rate per runtime | pending-operator | needs live model runs |
| 4. Cascaded fraction (R-35) | pending-operator | needs the complete corpus and the ticket graph per defect; one documented cascade instance is recorded |
| 5. Conclusion sentence | recorded | required by the plan; it does not depend on the figures |

A result is `inconclusive` rather than guessed if the operator cannot complete the corpus (say so and name the PRs that could not be read). No figure in this file was invented by the executor.

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
| D-01 | 27 | unknown | `plugins/delivery-pipeline/scripts/epic-branch.sh`, line unknown (a second `cleanup()` and a second `trap cleanup EXIT INT TERM`) | duplicate definition left by a clean merge (bash -n does not catch it) | T-27-04 added the block; a later branch in the same cascade added a byte-identical one | yes, per the note: "it recurred on the very next base-merge in the same round" | `a-clean-merge-can-duplicate-a-block-two-branches-added-alike.md`, section "What happened". The guard found it first; Copilot "independently flagged the same defect on its next review pass" |
| D-02 | 28 | unknown (ticket T-28-07) | `plugins/delivery-pipeline/scripts/base-merge.cjs`, the dirtiness check, line unknown | fail-open on an error path: a failed `git status` read as clean after the check was relaxed to `--untracked-files=no` | T-28-07 | no evidence either way (caught inside the introducing PR) | `phase-27-followups.md`, section "Two guards failed on real work, one phase after they shipped": "Copilot found it; the check now fails closed" |
| D-03 | 29 | #87 | unknown | dropped diagnostic: `loadConfig()` warnings dropped | unknown (a phase-29 ticket) | unknown | `a-disabled-reviewer-has-no-way-to-say-so.md`, 2026-09-10 section |
| D-04 | 29 | #87 | unknown | duplicated helper: `projectRootFor` and `lockRootFor` | unknown | unknown | same |
| D-05 | 29 | #87 | unknown | incomplete message: a missing `error.relative` in an error string | unknown | unknown | same |
| D-06 | 29 | #89 | `plugins/delivery-pipeline/commands/deliver.md`, line unknown | doc and contract mismatch: a line describes the planner's emitted item without its `ts` field | unknown | unknown | same |

Not individually identified (7 real defects; the operator fetches them): 3 in phase 27 (to reach four with D-01) and 4 in phase 28's first wave (to reach five with D-02). Rows D-07 to D-13:

| ID | Phase | PR | File and line | Class | Introducing ticket | Built on by later tickets |
|---|---|---|---|---|---|---|
| D-07 to D-09 | 27 | PENDING-OPERATOR (PRs #63 to #72) | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR |
| D-10 to D-13 | 28 | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR |

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

Status: pending-operator.

| Defect | Claude Sonnet/xhigh | Codex Sol/high | Notes (finding text, path and line reported) |
|---|---|---|---|
| D-01 to D-13 | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR |
| C-01 (control) | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR |

Catch rate per runtime, over the real defects only (N is the number of corpus rows with a recorded result; it is 13 if the corpus is complete):

| Runtime | N | found | found-with-different-identity | missed | Strict rate (found / N) | Loose rate ((found + different identity) / N) | Unmatched findings | C-01 reported |
|---|---|---|---|---|---|---|---|---|
| Claude Sonnet/xhigh | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR |
| Codex Sol/high | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR |

Commit scrubbed replay outputs under `docs/audits/phase52/samples/` (public repository content only; no tokens, account ids or private transcripts), and name each file here.

## 4. Cascaded fraction (R-35)

Definition: of the corpus defects, the share that an early ticket introduced and later tickets built on before it was fixed. "Built on" means a later ticket's branch contained the defective code when it was cut or base-merged. A defect with no recorded descendant is counted as `unknown`, not as `no`, unless the ticket graph shows no ticket stacked on the introducing ticket's branch at the time.

Seed observations from the notes (these are not the fraction):

- D-01 is documented as recurring: "it recurred on the very next base-merge in the same round" (`a-clean-merge-can-duplicate-a-block-two-branches-added-alike.md`).
- A cascade of a CI failure, not a Copilot defect, is documented in `phase-27-followups.md`, section "The board offers a fix at a child whose failure is its parent's": T-27-03's red assertion was inherited by T-27-04 and again by T-27-05 ("Three PRs, three offers, one cause"). It shows the mechanism (a parent's divergence propagates to every descendant already cut) and is excluded from the Copilot corpus because it was a failing check.
- Of the 6 identified defects, 1 (D-01) is documented as cascaded, 1 (D-02) was caught inside its introducing PR, and for 4 the notes say nothing; those 4 are `unknown`.

| Quantity | Value |
|---|---|
| Corpus defects with a recorded introducing ticket | PENDING-OPERATOR |
| Of those, built on by at least one later ticket | PENDING-OPERATOR |
| Of those, `unknown` | PENDING-OPERATOR |
| Cascaded fraction (built on / recorded) | PENDING-OPERATOR |
| Mean number of later tickets that carried a cascaded defect | PENDING-OPERATOR |

## 5. Conclusion that does not depend on the figures

The role reduces rather than removes the dependence on independent reviewers: a same-family reviewer can share the blind spots of the models that wrote the code, so an independent reviewer remains the check on the reviewer. The replay in section 3 measures how much of that dependence is left; it does not remove it.

## Commands run by the executor

- `shasum -a 256 <each backlog note in the Inputs table>`
- the Grep tool over `.planning/backlog` for `Copilot` (24 matching lines across 6 notes) and over `phase-27-followups.md` for section headings and `Copilot`
- reading `a-disabled-reviewer-has-no-way-to-say-so.md` lines 64 to 95 with the Read tool
