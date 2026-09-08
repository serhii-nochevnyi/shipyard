# base-merge refuses on the two scratch files the conveyor itself writes

Measured 2026-09-08 on T-27-03, phase 27 wave 1, and it will recur on every
cascade child whose base moves.

## What happens

`base-merge.cjs:122` decides "is this worktree dirty" with

```js
if (git(['status', '--porcelain'], { tolerate: true }).out) {
  fail('the worktree has uncommitted changes — commit or stash before merging the base in');
}
```

`git status --porcelain` prints untracked files as `?? path`, so ANY untracked
file is read as uncommitted work. Every executor worktree has exactly two, by
deliberate design — T-26-14 has the agent write `.shipyard-pr-body.md` and
`.shipyard-evidence.md` into the worktree as UNTRACKED scratch, on the reasoning
that `ticket-worktree.sh remove` cleans them up and `scope-gate` reads `git diff`,
which never sees an untracked file, so no `.gitignore` entry is needed.

So the exact state the conveyor produces for every executed ticket is the state
`base-merge` refuses to work in. Reproduced verbatim:

```
$ node .../base-merge.cjs T-27-03 --worktree /Volumes/KINGSTON/.wt-claude-shipyard/T-27-03 \
      --base ticket/T-27-01-…
base-merge: the worktree has uncommitted changes — commit or stash before merging the base in
$ echo $?
2
$ git -C /Volumes/KINGSTON/.wt-claude-shipyard/T-27-03 status --short
?? .shipyard-evidence.md
?? .shipyard-pr-body.md
```

Moving the two files aside made the same command succeed (`merged cleanly with
origin/ticket/T-27-01-…`) with no other change.

## Why it is not cosmetic

`base-merge.cjs` is named as THE remedy for a moved base in four places —
`deliver.md`, `references/ci-fix.md`, `references/review-fix.md` and
`references/pr-sentinel.md` — and three of those are read by DISPATCHED AGENTS
that are told to `cd` into the worktree first. A fixer that follows its own
reference file hits a refusal it has no instruction for, and the plausible
recoveries are all wrong: committing the scratch files puts the PR body into the
diff (and the scope gate then refuses the push, since neither path is in any
ticket's `files_modified`), and deleting them destroys the PR body and the
verification evidence the main loop has not consumed yet.

The refusal itself is correct in intent — merging over uncommitted work loses it.
It is the QUESTION that is wrong: it asks "is anything unsaved here" and answers
with "is anything untracked here", which the conveyor guarantees is true.

## The fix, and the one thing to be careful about

`git status --porcelain --untracked-files=no` asks the intended question. Do NOT
narrow it to the two known filenames instead: a list of known scratch names is
the same failure shape as the pin's list of known homes (T-27-07), and the next
scratch file added would silently re-open this.

But untracked files are not universally harmless to a merge: an untracked file
that the incoming base ADDS at the same path makes `git merge` abort with
`untracked working tree files would be overwritten by merge`. Today that error
surfaces as a `fail()` from the merge itself, which is honest. With the check
relaxed it still does — the merge, not the pre-check, is what refuses — so the
behaviour is no worse, and the message is the one git wrote. Worth a test case
either way: an untracked path that the base adds must still refuse, and refuse
with a message naming that path.

Related: [[the-dispatch-records-periphery]], [[a-wiring-line-no-test-asserts]].
