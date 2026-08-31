# Nothing wakes a run whose only remaining state is "waiting"

**Found:** 2026-08-30, phase 21 of the pdffiller proving ground.
**CLOSED 2026-08-31 by `ci-wait.cjs` + the stop gate's CI branch (v0.45.0).**
The fix is not a waker: **waiting in the FOREGROUND means the turn never ends, so
nothing has to wake it** — and blocking is free precisely because the script only
ever runs when the board has no other move. The `gh pr checks --watch` ban was
about opportunity cost, and there is none at that moment.

**v0.44.0 shipped only half of this and claimed the whole.** The foreground trick
holds only WHILE THE SCRIPT IS RUNNING, so something must make the loop call it —
and v0.44.0 left that in `deliver.md` as prose, i.e. it traded "nothing wakes a
waiting run" for "the loop must remember to wait", which is the trade this
repository's own standing lesson forbids. v0.45.0 adds the mechanical half: the
stop gate refuses a stop whose board holds nothing but `waiting.ci`. Two
mechanisms, one hole. See `deliver.md` loop-back item 5.

Termination is structural rather than a second special case: `ci-wait.cjs` counts
empty windows against escalation-record's fingerprint and escalates itself after
three, and an escalation park drops the ticket from the front — so the CI bucket
empties and the gate goes quiet through the rule it already had.

The rest of this entry is kept as the record of the measurement.

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

## What actually shipped, against the shape guessed below

The sketch below reached for a timer — `Monitor`, a self-paced wake-up, something
that brings the session BACK — and reasoned that a stop gate "can only refuse a
stop, and refusing is useless here". Both halves were true and the conclusion was
wrong, because the premise was that the turn had to end. It does not.

Also noted below and now measured: the 12:30 stop had TWO independent halves. The
stale board is fixed by the journal-evidence branch in `stop-gate.cjs` (same
release); the wait is fixed here. Neither would have been enough alone.
