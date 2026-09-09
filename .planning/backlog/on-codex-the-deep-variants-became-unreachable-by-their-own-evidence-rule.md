# On Codex the `-deep` variants became unreachable by their own evidence rule

Found 2026-09-09 by the arch-review judge on phase 28's last merge, reported as
informational, and verified here link by link against the epic as it ships. It
is a contradiction BETWEEN two accepted ADRs, each individually sound.

## The chain, every link measured

1. **On Codex the Agent path is the only path.** `deliver.md:495`: "On Codex
   there is no Workflow tool and no model parameter to pass."
2. **`effort_applied` is what the SPAWN carried.** `deliver.md:1508` records
   `effort_applied=<the level the spawn actually carried, or "unknown">`, and
   `:1515` states it is "what the SPAWN carried, never what the resolver"
   decided. The Agent tool has no `effort` parameter, so on Codex every dispatch
   records `unknown`.
3. **`unknown` is deliberately not evidence.** `failure-signature.cjs:90`:
   `repeat_exhausted` requires a prior round "whose `effort_applied` names a real
   level. `unknown` and an absent field are" not that. T-28-02 chose this
   direction on purpose — absent proof reads as depth-not-yet-spent, so the run
   keeps trying rather than escalating early.
4. **So `repeat_exhausted` can never fire on Codex.**
5. **And the four `-deep` agents are selected by exactly that escalation.**
   `deliver.md:503-504` names `$shipyard-ci-fix-deep`,
   `$shipyard-review-fix-deep`, `$shipyard-pr-sentinel-deep` and
   `$shipyard-arch-review-deep`; ADR-005 D8 wrote them because a static `.toml`
   "cannot be re-parameterised per dispatch", and `CLAUDE.md` states the reason
   they exist at all: on Codex "the EFFORT AXIS is two values wide by
   measurement — `low` mechanical, `high` otherwise — **so depth comes from the
   model there**".

So ADR-005 D8 built a model-side escalation because Codex has no effort-side
one, and ADR-007's evidence requirement made the trigger for that escalation
unprovable on the same runtime. Neither decision is wrong. Together, on Codex,
they cancel: the depth that D8 exists to provide is unreachable.

## Failure direction, stated because it decides the urgency

Safe, and therefore quiet. A Codex repair loops at `repeat` — same tier, deeper
effort, which on a two-value axis often means the same effort — until the
attempt backstop at `max_attempts` escalates to a human. So nothing runs away
and nothing merges wrongly. What is lost is the model-side depth, silently, on
the runtime that has no other kind.

## Why it is nobody's ticket yet

Both ADRs are accepted and neither decision should simply be reverted:
ADR-007 D2's requirement is what stops `repeat_exhausted` from being claimed by
a round that never deepened anything, and that mattered — it was the P1 of its
phase. ADR-005 D8's variants are the only depth Codex has.

The shape of a fix, and it is one sentence of policy rather than a mechanism:
**on a runtime where no dispatch can carry an effort, "the spawn carried none"
IS the applied level** — not an unknown. `unknown` should mean "nobody recorded
it", which is the case ADR-007 D2 was defending against; a runtime that
structurally cannot carry one is a different fact and deserves a different
token. Whatever token is chosen, `depth_spent` should count it, and the choice
belongs in an ADR because it decides when a paid escalation fires.

Worth noting who found it and how: neither ticket's arch-review could see this —
each was correct at its own head — and it surfaced only when a judge read the
LAST merge of the phase against the whole. That is the case the integrator exists
for, arriving one step early.
