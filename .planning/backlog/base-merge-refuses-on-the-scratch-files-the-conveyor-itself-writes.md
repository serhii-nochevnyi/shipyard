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

## Same root, second victim — and this one is the E2BIG blocker

Measured 2026-09-08, later the same run. `ticket-worktree.sh gc` classifies a
worktree `dirty` on the same evidence, and `dirty` is a class gc **never**
prunes, by deliberate design (it may hold work that exists nowhere else).

```
$ ticket-worktree.sh gc
  dirty   T-27-02   … uncommitted changes — never removed by gc
  dirty   T-27-04   … uncommitted changes — never removed by gc
  dirty   T-27-05   … uncommitted changes — never removed by gc
  dirty   T-27-06   … uncommitted changes — never removed by gc
  dirty   T-27-07   … uncommitted changes — never removed by gc
  ── 5 worktree(s); 0 removable (0 landed, 0 gone)

$ git -C …/T-27-02 status --short     # merged ticket, PR #64 landed in the epic
?? .shipyard-evidence.md
?? .shipyard-pr-body.md
```

Nothing but the two scratch files, in every one — including two tickets whose
PRs are MERGED. So **gc can never reclaim a single executed ticket's worktree.**

That is the missing half of a story this repo already treats as serious.
`CLAUDE.md` and `deliver.md` both call the worktree count a DELIVERY BLOCKER
rather than housekeeping: past a few dozen the sandbox profile exceeds the argv
limit (E2BIG) and every sandboxed command in the session starts failing. gc is
the mechanism built to stop that, it warns at
`SHIPYARD_WORKTREE_WARN_AT` (20), and it cannot act on its own on anything the
conveyor produced. Confirmed at this run's cold start: 32 worktrees, gc's own
verdict `0 removable`, and the E2BIG warning printed — the count only came down
because the reaper works from `delivery-state`'s `reapable` instead.

So the two mechanisms disagree about the same worktrees, and each is internally
consistent: the reaper asks "has this ticket's work LANDED" (a fact about the
world) and gc asks "could this directory hold work that exists nowhere else" (a
fact about the directory). The scratch files make the second question answer yes
forever.

The fix is the same one line of intent as above — the dirtiness test must ask
about TRACKED content — and the same caution applies: do not special-case the two
filenames. For gc there is one extra subtlety worth a test: a `landed`+untracked
worktree should prune, but gc must still refuse a worktree holding untracked
files that are NOT the conveyor's scratch, because those really can be work
existing nowhere else. Distinguishing "untracked and ignorable" from "untracked
and precious" without a filename list means the scratch files should be
`.gitignore`d — which T-26-14 explicitly decided against, on the reasoning that
`scope-gate` reads `git diff` and never sees them. That reasoning was right about
`scope-gate` and wrong about every other reader of `git status`, and this is the
second reader it has cost.
