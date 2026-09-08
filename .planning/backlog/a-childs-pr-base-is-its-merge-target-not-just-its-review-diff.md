# A child's PR base is its MERGE TARGET, not just its review diff

**Found:** 2026-09-08, by making the mistake. Supersedes the note this file
replaces (`a-parents-merge-decides-what-a-childs-first-review-sees.md`), whose
recommendation was acted on and was wrong.
**Scope:** none of the current tickets. It is a rule for the publish step of
delivery, and it needs a mechanical guard.

## What happened, in order

1. PR #50 (T-26-15) reached green + `conform` while its child T-26-03 was still
   with an executor. The guard offered `merge`.
2. Reasoning that merging the parent first would make the child's opening diff
   carry the parent's squashed work, the merge was held — then, under the stop
   gate's refusal, the premise was rechecked and found false in ONE respect:
   `deleteBranchOnMerge=false` means the parent branch survives the squash, so
   the child's PR CAN still be opened against it afterwards. Both parents were
   merged, and the children's PRs (#52, #53) were opened against their surviving
   parent branches.
3. That did deliver the intended property. #52's diff was exactly its own three
   files; #53's exactly its own seven. No parent work in either.
4. **And it broke the merge.** `sentinel.cjs merge T-26-03` squash-merged #52
   into `ticket/T-26-15-…` — its PR base — a branch already merged into the
   epic. `epic/26` therefore did NOT contain T-26-03's work, `grep -c ghTry`
   against the epic returned 0, and nothing on the board was ever going to bring
   it in: the ticket read `merged`, its PR read merged, and the front was empty.

**The base is one field with two jobs.** It decides what the review diff shows
AND where the squash lands. Optimising the first in isolation silently
mis-targets the second, and the failure is invisible from every board the
conveyor prints, because every one of them was telling the truth about its own
subject.

## The repair, for the record

`ticket/T-26-15-…` was merged into `epic/26` (a merge, never a rebase — the epic
carries an open PR into `main`), one conflict in `tests/smoke/sentinel-smoke.sh`
resolved in favour of the branch after proving it a strict superset (+176 lines,
0 lines only on the epic side — exactly T-26-03's additions). Verified on the
merged tree before pushing: `front.test.cjs` 103/0, `make test-sentinel` 93/0,
`node --check` clean, `ghTry` and `baseMoved` both present. The parent branch is
now 0 ahead of the epic.

## The rule

**A child's PR base may be the parent's ticket branch only while the parent's PR
is still OPEN.** That is the case the cascade was designed for, and the
post-merge RETARGET is the mechanism that then gives both properties: the review
runs against the parent branch (clean slice), and the retarget moves the base to
the epic before the child itself merges.

**Once the parent has merged, the child's base must be the EPIC.** To keep the
diff clean at the same time, do not choose between them — `base-merge` first:

    node scripts/base-merge.cjs <ticket> --worktree <wt> --graph <project>/.planning/graph
    # then open the PR against the epic

With the parent's work already in the epic, merging the epic into the child's
branch makes the child's diff against the epic exactly its own slice again. Both
properties, one order of operations, and the merge target is right.

## The guard this wants

Prose will not hold it — the whole point of this note is that a careful,
argued decision got it wrong in the direction the boards could not see. Two
mechanical checks, both cheap:

- **At publish:** refuse to open a child's PR against a ticket branch whose own
  ticket is already `merged`. `delivery-state[parent].status` is right there.
  Name the epic as the base instead, and say `base-merge` first.
- **At merge:** `sentinel.cjs mergeOne` already refuses a base outside the
  stack. Extend it: refuse a base that is a ticket branch whose ticket is
  `merged`, because the squash would land on a limb rather than in the epic.
  This is the same shape as the `BEHIND` rule — a state that looks mergeable and
  is not.

And one detection for the class, since the mistake produced a board that read
completely healthy: after any ticket merge, assert that the ticket's own files
are reachable from its EPIC. A merged ticket whose work is not in its epic is
the invariant that was violated here, and nothing in the conveyor asserts it.
