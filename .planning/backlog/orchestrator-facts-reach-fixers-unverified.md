# A fixer is told a fact by the orchestrator, and no gate ever checks it

**Found:** 2026-08-30, phase 21 of the pdffiller proving ground (PRs #645–#648).
**Scope:** none of phase 21's tickets — it is a conveyor gap, not a project one.

## What happened

arch-review on #645 flagged a mismatch: the provider comment said the port
declared a singular language, and the reviewer read that as a contradiction of
the ticket's plural field. The orchestrator overruled the reviewer in the
dispatch prompt it then wrote for the fixer:

    the port really WAS widened in T-21-02 — the reviewer judged by the plan and
    did not know the ticket had already run

and told the fixer to rewrite the comment accordingly. It was wrong. **#646 is a
stacked CHILD of #645, not a merged ancestor** — on #645's own head the port
still declared the singular. A true sentence was replaced with a false one, in
code, by an agent doing exactly as instructed.

Nothing caught it for two and a half hours. The *second* arch-review did, at
21:39; the loop's own words were "це моя помилка, не виконавцева". Fixed 21:42.

## Why it is the expensive class

Every gate in the conveyor judges the DIFF. This defect enters through the
PROMPT. The fixer had no way to know the claim was false — verifying it means
diffing a sibling branch, which is not its job and not in its contract — and
arch-review re-reads the code, so it can only catch the result on a later pass,
after the false statement has been committed and pushed.

So the orchestrator is the one actor in the conveyor whose factual claims reach
an executor with no gate between them. Its claims are also the ones most likely
to be wrong about *stack topology*, because that is the part of the board it
holds in prose rather than reading from a file: which parent is merged, which is
merely open beneath you, what the base actually contains right now.

## Shape of the fix (unowned)

The narrow version is cheap and probably enough: a fixer prompt that asserts
something about ANOTHER ticket's branch must carry the evidence, not the claim —
the orchestrator already has `git diff <parent>..<this>` and
`gh pr view --json baseRefName,state`. "T-21-02 widened the port" is a sentence;
`origin/ticket/T-21-02 differs from your base at these lines` is a fact the
fixer can re-check in one command.

The wider version is the standing lesson: **the stack's shape is state, and it
belongs in a file.** `delivery-state.json` already knows every PR's base and
status. A claim about a parent that contradicts the board is exactly the kind of
thing a script can refuse, and prose cannot.

Worth pairing with a line in `review-fix.md`: a fact about a branch you were not
given a worktree for is a claim to verify, not an instruction to execute.
