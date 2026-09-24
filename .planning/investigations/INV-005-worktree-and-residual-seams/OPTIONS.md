# Options

Detail: `research/alternatives.md` §2–§3 (per-defect sub-options 4a–Nd, Wa–Wd).

## Option A — Point fixes plus a conditions reference
One ticket per defect in its own file; conditions documented as prose.

## Option B — Point fixes plus one executable worktree-conditions module
A shared module (scratch registry, leftovers, base ref freshness, plan/graph
readability, signing) that every host checks before launch with a named remedy.

## Option C — Rebind review, round and artifact identity to the ticket's own patch
Treat (6), (7), (8) as one root cause; carry verdicts/artifacts when the ticket's
own change is provably identical and the base move is disjoint.

## Comparison

| | A | B | C |
|---|---|---|---|
| Complexity | low–medium | medium | high (+ADR) |
| Named-remedy checks in one place | no | yes | only with A/B |
| Removes serial review (7) | only with a carry sub-option | same | yes |
| Risks | condition drift | allowlist hides leftovers | cross-ticket semantics unjudged |
| What it forecloses | nothing | ad hoc per-host checks | strict commit-bound verdicts |
