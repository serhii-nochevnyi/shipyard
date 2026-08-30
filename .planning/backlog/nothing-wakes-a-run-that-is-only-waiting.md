# Nothing wakes a run whose only remaining state is "waiting"

**Found:** 2026-08-30, phase 21 of the pdffiller proving ground.
**Scope:** partially mitigated by the stop gate's resync band (v0.43.0); the
residual case below is untouched and has no owner.

## The mechanism

The babysit loop is not a loop. It is driven by task-notification wake-ups: an
agent finishes, the session is re-invoked, it does a round, it stops. That is
the right design — it costs nothing while agents work — and it has one hole:
**when the last dispatched agent has finished and everything left is `waiting`,
nothing will ever wake the session again.**

The front is explicit that waiting on CI is "not a fixpoint, and not a reason to
block", and the stop gate honours that. Correct, and it means a run whose board
is `ci: 4` stops and never resumes. Only a human typing something restarts it.

## What the 12:30 stop actually was

Both halves fired at once and the resync band closes only the first. The board
was stale (fixed), *and* the last executor had finished with nothing pending
(not fixed). Even with a correct fresh board that day the run would have
dispatched four finalize agents, driven them, and then — with four PRs green and
waiting — stopped again with nobody to wake it.

## Shape of the fix

Something must re-invoke the session on a timer while the board holds `waiting`
entries. The runtime already has the pieces: a background `Monitor` on the PR
checks, or a self-paced wake-up, both of which the conveyor could arm from the
same place it computes the front. The load-bearing property is the one every
durable store here already has — it must **expire on its own**, or a killed run
leaves a timer nagging a board nobody owns.

Note the asymmetry with the stop gate: the gate can only refuse a stop, and
refusing is useless here, because there genuinely is nothing to do this second.
This needs the opposite instrument — something that brings the session BACK.
