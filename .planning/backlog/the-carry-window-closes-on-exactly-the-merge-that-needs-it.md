# The carry window closes on exactly the merge that needs judgement

Found 2026-09-10 on T-29-07, phase 29 — the first base merge in this repository
that both required a human decision AND provably added nothing.

## The mechanism, as designed

ADR-006 D2 exists to stop a ~150k-token re-judgement of a head move that adds
no content. `gate-trailer.cjs carry` re-stamps an existing `arch-review=conform`
onto a new head when two object identities hold: the head trees are equal, and
the recorded base tree equals the tree of the new merge base.

Its only caller is `base-merge.cjs`, and that script says why in its own header
(line 52):

> One consequence worth naming: the carry runs BEFORE the push (this script does
> not push) …

`gate-trailer.cjs:480` enforces that ordering:

```
if (liveHead !== from) refuse(`PR #${pr} is at ${shortSha(liveHead)}, not at the
  judged head ${shortSha(from)} — something was pushed, so the verdict is owed
  against that instead`);
```

Sound on its own terms: once a push has landed, the tool cannot know the push
was only the merge.

## The gap

`base-merge.cjs` deliberately does NOT auto-resolve a conflict in a file the
ticket DECLARES. That rule is correct and load-bearing — a declared file is the
ticket's own work and the base must not silently win there. So the script stops,
leaves the merge in progress, and hands the decision to an agent.

The agent then resolves, commits, and pushes — by hand, outside the script,
because the script has already stepped back. **The carry never runs, and the
window it needs is gone the moment that push lands.**

So the split is:

| base merge | who finishes it | carry |
|---|---|---|
| clean, or conflicts only in undeclared files | `base-merge.cjs` | runs, can prove |
| conflict in a DECLARED file | an agent, by hand | never runs |

The second row is the one where a judgement was already required — and on
T-29-07 it is also the row where the carry would have been provable.

## The measurement that makes this concrete

T-29-07's retarget onto the epic conflicted in `deliver.md`, a declared file.
Resolved by keeping the branch's own edition; verified line by line that the
only two differences from the epic were lines this ticket had EDITED (the config
key list gaining `jira_transitions`, loop-back item 1 gaining the projection
call), not lines it had lost.

```
git rev-parse HEAD^{tree}     d9494c83b83b
git rev-parse HEAD^1^{tree}   d9494c83b83b     ← identical
```

**The merge changed no content at all.** Both conditions D2 asks for were
satisfiable, and the verdict was re-owed anyway because the push had already
happened. That is the exact cost D2 was written to remove, paid in the case D2
most wants to cover.

Two smaller things this surfaced, both worth keeping:

- **A guard reported the opposite** — that "the merge changed the head tree, so
  carry has no proof". The tree shas above disprove it. A report is not a
  measurement, and the next reader of that report would have re-judged believing
  there was no alternative.
- **The orchestrator then wrote a duplicate `base_merge` event** (09:09:13 by
  the guard, 09:10:05 by the orchestrator, same head, same base) because it
  believed it had performed a merge that was in fact already committed and
  pushed. The journal is append-only, so the duplicate stands. Unlike the
  doubled `dispatch` rows seen earlier this phase — where both were truthful —
  this one asserts a second base move that did not happen.

## Shapes a fix could take

- **Let `base-merge.cjs` own the whole act**, including the push, for the
  declared-conflict path too: the agent resolves in the worktree and hands
  control back to the script, which stages, carries, commits and pushes in the
  documented order. Keeps one implementation of the ordering.
- **A `carry --after-push` that re-derives proof from the commit itself**: given
  a merge commit, compare its tree to its first parent's and to the recorded
  base tree. Nothing about that needs the PR to be at the old head; the merge
  commit carries both identities permanently. This is the smaller change and it
  removes the ordering constraint rather than working around it.
- **Say it in `references/pr-sentinel.md`**: when you finish a declared-file
  merge by hand, run the carry BEFORE you push. Cheapest, and it is prose — the
  class of rule this repository has repeatedly measured as skipped.

The second is the one that matches D2's own argument: a tree sha is immortal,
which is why the trailer records one. If the proof is immortal, the window
should not be.

Related: [[the-backlog-is-thirty-six-files-no-tool-can-find]] — this note is one
more the tooling cannot surface.
