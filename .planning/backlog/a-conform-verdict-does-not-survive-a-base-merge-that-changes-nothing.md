# A conform verdict does not survive a base-merge that changes nothing

**Found:** 2026-09-08, driving T-25-03 through its cascade step. Measured, not
reasoned: the base-merge produced a head whose tree is byte-identical to the
judged head, and the conform gate still refuses it.
**Scope:** none of the current tickets. It is the conveyor's largest per-ticket
cost in a stacked cascade, and it is a design question rather than a bug.

## The mechanism, as it stands

T-24-04 bound the architecture verdict to the head it judged — correctly, and
for a measured reason: a verdict rendered against one diff says nothing about
another. `gate-trailer.cjs` writes `head=<sha>` and `sentinel.cjs` gates on
`gateConform(s.gate, s.head_sha)` at three call sites (426, 472, 695), with no
exception of any kind.

A stacked cascade then moves every child's head for reasons that have nothing to
do with its author. Parent squash-merges into the epic, child goes BEHIND,
`base-merge` brings the epic in, the head moves — and the child's `conform`,
its CI green and its resolved threads are all discarded. Per ticket, per
cascade step.

## What was measured here

`base-merge.cjs T-25-03 --base epic/25` reported **0 paths taken** from the epic
and one real conflict in `tests/unit/pipeline-config.test.cjs` — a file both
T-25-02 and T-25-03 legitimately declare, being dependency-ordered. The
branch's version proved a strict superset (0 lines present only on the epic
side, 23 only on the branch's), so it was resolved to the branch's version, and
the resolved file is byte-identical to the judged head.

    git diff --stat b9fd669 HEAD   ->   0 lines

The merge changed **no content whatsoever**. It changed only the commit graph —
which is precisely what the BEHIND state was about, and why the merge was
necessary. And yet: new head, so `arch-review` is owed again, and a full CI run
with it.

For this ticket the re-judgement is a formality, and it is not free — this
reviewer's context had grown to ~170k tokens by its third round. Multiply by a
cascade: phase 26 has fifteen tickets stacked, and each merge makes the next
child dirty.

## The question, stated so it can be answered

**Should a conform verdict survive a head move that provably adds nothing the
verdict did not already cover?** Yes, and the distinction is mechanical — but
the first draft of this note got the test wrong, and this same cascade step is
the counter-example.

**The wrong test (mine): `git diff <judged-head> <new-head>` is empty.** That
proves the TREE did not move. It does not prove the DIFF did not move, and
`arch-review` judges a diff against a base. A retarget moves the base under an
identical tree: this very tree, measured against `epic/25` BEFORE the merge,
showed **12 files instead of 7**. Tree-equality alone would have carried a
verdict onto a diff nobody had judged — the exact failure the head binding
exists to prevent. Found by the `arch-review` role itself when the rule was put
to it, which is the right place for a rule about its own work to be tested.

**The test, as the pair it has to be** — both mechanical, both cheap:

1. `git diff <judged-sha> <candidate-sha>` is empty, **and**
2. `git diff <old-base>...<judged>` equals `git diff <new-base>...<candidate>`.

**Amended 2026-09-08 — the pair is a PROOF, and there is a better way to check
it.** Put to the `arch-review` role a second time (on T-25-05's own cascade
step, where both conditions held), it accepted them and then improved on them:

- **The pair ENTAILS equal base trees**, so it is a proof rather than a
  heuristic: for paths inside the diff, base = head minus the identical diff;
  for paths outside it, base = head, and the head trees are equal. That settles
  that this ticket should exist.
- **So compare the base TREES directly instead of the diffs.** Condition 2
  compares diff *output* — a rendering that depends on rename detection, context
  size, whitespace handling and `diff.algorithm`, and is only meaningful if both
  invocations are flag-identical. Two object identities have no such surface.
  Measured on T-25-05: the two bases were different COMMITS
  (`0185770` on the ticket branch, `1fc2724` the same content squash-landed on
  the epic) with the SAME merge-base tree `9e2e46695b34…`, and the two head
  trees were the same object `5dbbcea0f41e…`. The judgement's subject is a
  function of exactly those two trees.
- **The real blocker is that the trailer records only `head=`.** `gateConform`
  cannot apply either rule without knowing which base was judged. So the
  trailer must also record the **merge-base TREE** — not the base branch name:
  the old base branch gets reaped (it merely happened to survive here), and a
  rule that must recompute `mergebase(origin/<old-base>, …)` breaks the moment
  it is gone. A tree sha is immortal.

One more property worth having for free: **an identical head tree is
independent proof that `base-merge` was clean.** A duplicating merge — the
`epicKey` case on #56, where git accepted two identical blocks in different
places and `const epicKey` twice was a SyntaxError — cannot leave the tree
unchanged. That is a stronger check than the script's own "merged cleanly" on
stdout, which is a statement about git rather than about the file.

Verified together here: the two trees are the same object
(`2d64461ecc2c006511e4d46e2957bacf59bea102`) and the two diffs are byte-for-byte
identical at 7 files / +120/-46.

**Ancestry is not a substitute.** `git merge-base --is-ancestor <old-base>
<epic>` is FALSE in this very case, because the parent landed by squash — its
content survived and its commit did not. An ancestry rule would have refused a
legitimate carry; the diff comparison gets it right.

Three conditions the same review attached, all of which hold up:

- **Only `arch-review=conform` may carry. `checks=green` must not.** A green
  measured against a base that has since moved is not a green, and the merge
  commit is a new merge base — which is why CI correctly re-ran and passed on
  `eb8030b`. Since the trailer records a single `head=`, a carry then needs
  `arch_reviewed=<judged-sha>` recorded beside it, or a carried verdict becomes
  indistinguishable from a stale one, which is the whole reason `gateConform`
  binds to the head in the first place.
- **The script computes the proof; the caller does not supply it.** Prose rules
  get skipped and mechanical gates hold, so a `gateConform` that re-derives (1)
  and (2) from a recorded sha is safe, while an instruction to "check the diff
  first" is not.
- **The PR BODY is not covered.** An empty tree diff says nothing about the
  body — where the trailer itself lives — nor about threads opened since the
  judgement. Those keep their existing checks.

And what this must NOT become: "a base-merge never invalidates a verdict".
`base-merge.cjs` legitimately resolves conflicts, and a resolution is authored
content nobody has judged. The pair above is the whole of the exception, and it
is exactly as strong as the evidence it reads.

## Shape of the fix (unowned)

`gate-trailer.cjs` already owns the head binding, so it should own the
exception: carry the judged head as today, and add a `covers` predicate that
accepts a candidate head when `git diff <judged> <candidate>` is empty. The
three `sentinel.cjs` call sites then keep their current shape with no new
concept. `log-event.cjs base_merge` (added by T-24-06 so a mechanical merge is
not charged to the repair budget) is the audit trail that says which head moves
were base-merges, so the journal can show whether an accepted carry-over was
honest.

CI is the second half and a separate decision: the checks were green on an
identical tree, so a re-run proves nothing either — but re-running is cheap and
`checks=green` is a claim about a commit GitHub actually built, so leaving that
alone is defensible where the verdict is not.

Also worth measuring while in here: how much of a session's judgment spend is
re-judgement of unchanged trees. It is the number that decides whether this is
a tidy-up or the conveyor's main cost.
