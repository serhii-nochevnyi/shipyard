# A wiring line no test asserts — delete it and every suite stays green

**Found:** 2026-09-08 by `arch-review` on PR #55 (T-26-10), which checked
whether the diff's central plumbing was actually covered rather than trusting
the suite counts.
**Scope:** none of the current tickets. `tests/unit/front.test.cjs` belongs to
several of them, so this needs its own small ticket rather than smuggling.

## The gap

T-26-10 made `left_behind` evidence-based by passing `state-sync.cjs`'s
`epicInfo` into `computeFront` as `epics`. That single argument is the whole
mechanism: without it `leftBehind()` sees no epic records and answers 0 for
everything.

**Nothing asserts the argument is passed.** Measured: delete `epics: epicInfo`
from the `computeFront` call and `front.test.cjs` (114), `stop-gate.test.cjs`
(55), `ci-wait.test.cjs` (32) and `make test-sentinel` (108) all stay green.
The unit tests construct `epics` by hand, `sentinel-smoke.sh` stubs `gh` but
never asserts `left_behind_count` off a real sync, and
`dispatch-record.test.cjs:334` hand-writes the field.

The failure direction is safe — the flag would read 0, the stop gate would
block instead of hatching — so this is not a live defect. It is the shape this
repository already knows costs it: a gate that quietly stops enforcing. The
same class as the stop gate reading a stale front for twelve stops in one day
while looking perfectly healthy.

## The fix, which the review supplied

There is already a precedent for asserting wiring in the same file:
`front.test.cjs:1132` asserts the sibling `ci_estimates:` wiring against the
SOURCE of `state-sync.cjs`. Mirror it, one line:

    assert.ok(/epics:\s*epicInfo/.test(src), 'state-sync must pass epicInfo into computeFront')

Better, if the ticket that takes this can afford it: assert
`left_behind_count` off a front produced by a REAL `state-sync` under the
stubbed `gh` in `sentinel-smoke.sh`, with an epics fixture. That is the
assertion the hand-built unit tests cannot make, and it is the same argument
T-26-15's plan made about its own acceptance criteria — a board fact must be
tested against a board a real sync wrote.

## Two behaviour notes from the same review, worth keeping with it

- `leftBehind` is also the FIRST ordering key of the front's buckets, so a
  `refreshFront`-rewritten board loses the demotion as well as the count for one
  round. Bounded, self-correcting, and biased toward doing work — but undeclared
  in the ticket that introduced it.
- `epicInfo` is only built under `epic-stacked`, so **direct-to-main projects
  now never open the all-left-behind hatch**. Deliberate and consistent with
  ADR-004 D10, but it is a behaviour change for a whole integration mode and it
  is recorded nowhere.

## And one hollowed test fixture

`front.test.cjs:385` — "live work still demands motion, even alongside
left-behind tickets" — still calls `computeFront(tickets, state, {})`. Under the
old arithmetic that board was genuinely mixed (`1 of 2`); under the new rule it
is `0 of 2`, so nothing in the suite now asserts `formatFront`'s verdict for a
board that really does mix live and left-behind work. Not vacuous, not blocking,
and a one-line fixture change.
