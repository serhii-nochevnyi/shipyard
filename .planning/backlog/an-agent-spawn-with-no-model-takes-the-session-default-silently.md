# An Agent spawn with no `model` takes the session default, silently

Found 2026-09-10, phase 29, by the guard that did it and reported itself.

## What happened

A sentinel needed a review-fix on PR #87. It dispatched the fixer with the
`Agent` tool and did not pass a `model` parameter. The spawn did not fail, did
not warn, and did not fall back to anything documented — it ran at **the
spawning session's own model**, which was `sonnet`, while the ladder had
resolved `opus` for that role.

The guard caught it afterwards and recorded it honestly: the attempt row says
`model=sonnet`, while `dispatch-record`'s `--model opus` records what the ladder
decided. Two different fields, two different facts, and the pair is what made
the divergence visible at all.

## Why it is worth a mechanism rather than a reminder

This is the `effort_applied` problem one level up, and it is worse in the same
way that a tier is worse than a rung.

`effort` is already known to be unenforceable on the Agent path — the tool has
no such parameter, so the conveyor writes `effort_applied=unknown` and that
absence is honest. **`model` is different: the parameter EXISTS, it is simply
optional, so omitting it produces a confident wrong answer instead of a
recorded unknown.** The dispatch record then says `opus` because that is what
the resolver returned, and nothing anywhere says the spawn disagreed.

The cost direction is not symmetric either. A tier step is ~2.5x, so a judge or
a fixer silently demoted from `opus` to `sonnet` is the cheap-first-strike
policy applied where the ladder deliberately refused it — and the whole reason
ADR-005's floor exists is that the conveyor's expensive failure is a wrong green
reaching an epic.

## What would close it

Nothing in `pipeline-config.cjs` can help: the gap is between the resolver's
answer and the spawn, not inside the resolver. Three candidate shapes, none
adopted:

- **`references/pr-sentinel.md` states it** — cheapest, and it is the file the
  guard actually reads. It already says "RESOLVE model and effort from the
  ladder, never assumed"; it does not say "and PASS the model explicitly on
  every spawn, because the parameter is optional and its absence is silent".
- **`dispatch-record.cjs` cross-checks** — it already refuses a route that does
  not match the pair. It cannot see the spawn, so it could at most require the
  caller to assert the model was passed, which is a claim rather than a check.
- **The journal answers it after the fact** — `attempt.model` and the dispatch
  row's `--model` are both recorded, so a query can find every round where they
  disagree. That turns a silent event into a countable one without needing to
  prevent it, which may be the honest first step.

The third is the one that fits this repository's habit: measure the size of the
problem before spending a mechanism on it.

Related: [[the-dispatch-records-periphery]], and the `effort_applied` half in
ADR-007's Codex depth-starvation item.
