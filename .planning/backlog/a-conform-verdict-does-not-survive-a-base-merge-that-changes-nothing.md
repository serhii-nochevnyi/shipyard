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
verdict did not already cover?** The honest answer is "sometimes", and the
distinction is mechanical:

- the verdict SURVIVES when `git diff <judged-head> <new-head>` is empty — the
  tree is the same tree, so the verdict describes it exactly. That is the case
  measured above, and it is the common case for a base-merge whose parent's work
  the branch already contained;
- the verdict is OWED when the diff is non-empty, which includes every
  conflict resolution that actually chose something. A base-merge is mechanical
  in intent and can still author content, so intent is not the test — the diff
  is.

Note what this must NOT become: "a base-merge never invalidates a verdict".
`base-merge.cjs` legitimately resolves conflicts, and a resolution is authored
content that nobody has judged. The empty-diff test is the whole of the
exception, and it is exactly as strong as the evidence it reads.

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
