# A clean merge can duplicate a block two branches added alike

Measured 2026-09-09 during phase 27's cascade, twice in one guard round, in
`plugins/delivery-pipeline/scripts/epic-branch.sh`.

## What happened

T-27-04 added a `cleanup()` function plus its `trap cleanup EXIT INT TERM` to
`epic-branch.sh`. A later branch in the same cascade added a byte-identical
block, independently. When the base was merged in, git kept **both copies** and
reported no conflict.

The file after the merge had two `cleanup()` definitions and two `trap` lines —
in shell, the second definition silently wins and the second `trap` replaces the
first, so the failure is quiet rather than loud. The guard found it, took the
base's single copy verbatim, and Copilot independently flagged the same defect on
its next review pass. Fixed in the epic (`cleanup()` = 1, `trap` = 1, verified),
and it recurred on the very next base-merge in the same round, which is why this
note exists rather than a one-line fix comment.

## Why git could not see it

**Squash merges do not share SHAs, even for identical content.** The conveyor
lands every ticket PR with `--squash`, so the epic's copy of a change is a
different commit object from the branch's, with no shared ancestor commit
carrying that hunk. A 3-way merge compares against the merge BASE; when the same
hunk was introduced on both sides after that base, git has no evidence they are
the same change and the only safe answer it can give is "keep both".

So this is not a git bug and not a base-merge bug. It is a structural consequence
of squash-merging a cascade, and it will reproduce on any base-merge across these
same commits.

## The sharp part, and why it belongs with ADR-006

`base-merge.cjs` resolves the mechanical half of a conflict by ownership: a
conflict in a file the ticket does NOT declare takes the base's edition, a
conflict in a file it DOES declare is left for judgement. That rule is correct
and it could not help here, **because there was no conflict.** `epic-branch.sh`
is in neither of the affected tickets' `files_modified`, and the merge exited 0.

A clean exit is the cheapest available signal, and it was used to answer a
question it does not answer: "did this merge produce a coherent file". That is
the sentence ADR-006's Context ends on, arriving from a direction the ADR did not
list.

## What would actually catch it

Not a conflict rule — a post-merge assertion. Cheap and specific, in rough order
of value:

1. **A duplicate-definition check on shell scripts the merge touched.** Two
   `^name()` definitions of the same function, or two `^trap ` lines, in one
   file is a defect in every case this repo has. `bash -n` does NOT catch it
   (both are syntactically valid), which is why the smoke suite stayed green.
2. **The same for the deterministic layer's `.cjs` files**: two `const NAME =`
   at top level is a `SyntaxError` and would be caught by `node --check`, so the
   shell scripts are the exposed half.
3. Worth noting what already exists and did not fire: `tests/unit/source-contract.test.cjs`
   (T-27-07) is now the home for assertions about the SHAPE of our own source,
   and a duplicate-definition sweep is exactly its kind of case.

Related: [[base-merge-refuses-on-the-scratch-files-the-conveyor-itself-writes]],
[[a-childs-pr-base-is-its-merge-target-not-just-its-review-diff]].
