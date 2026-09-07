# Roadmap: shipyard

## Overview

The conveyor reaches green reliably. What it does not yet do is survive a night
unattended: a run either stops for a person or spends its budget repeating the
same wrong fix. This milestone closes that gap, in the order that buys the most
safety first.

The programme behind it is one rule, stated in two places: **a decision that can
differ between runtimes, or that decides whether work continues, belongs in a
script — not in a prompt.** Every requirement below is an instance of it.

## Requirements

- **REQ-01** — A failure is identified by a normalized SIGNATURE (error class +
  test/job id + file), not by an attempt counter, so the policy can tell progress
  from repetition.
- **REQ-02** — A ticket has a third terminal outcome besides green and
  human: `plan_defect`, reached mechanically from K distinct signatures without
  progress. It blocks the ticket and lets the cascade continue.
- **REQ-03** — A job that fails intermittently on an unchanged tree is a FLAKE:
  quarantined, and its attempts are not charged against the budget.
- **REQ-04** — The actionable front is ORDERED by unblocking power (descendants
  in the DAG) and CI length, so an unattended run does not narrow to one item.
- **REQ-05** — A fixer receives the prior attempts for its ticket (signature,
  hypothesis, outcome) as INPUT, so a fresh subagent cannot re-propose a fix that
  already failed, without polluting its context.
- **REQ-06** — Risk classes are pre-authorized at decomposition time, so a
  runtime interruption at 3am becomes a design-time decision. Anything not
  pre-authorized is deferred to the morning front rather than blocking.
- **REQ-07** — Degenerate green is detected on the diff (weakened assertion,
  skip, rewritten snapshot, raised timeout, `any`/`@ts-ignore`, swallowed catch,
  narrowed matcher) and REPORTED as a `gate_status:` trailer. Reporting first,
  blocking only once field data shows the false-positive rate.

- **REQ-08** — A park is described to the human by the STORE that owns it, so a
  new park kind cannot be rendered with another kind's lifting rule.
- **REQ-09** — A guard that rejects an unusable value checks the VALUE, not the
  shape of the argument list around it.
- **REQ-10** — Every script sharing the `--graph` spelling shares its parsing,
  including the refusal to swallow a following flag as the value.
- **REQ-11** — A lock is held from the instant it exists, so a writer still
  announcing itself is never mistaken for a dead one.
- **REQ-12** — A test that cannot fail is a defect: the harness must fail an
  asynchronous test that throws, rather than reporting it green.

- **REQ-13** — A ticket handed to an agent is VISIBLE as dispatched: the front
  reports it as waiting rather than offering it again, and the record expires by
  itself so a killed run cannot hide work from the next one.
- **REQ-14** — The backlog states what is true now. An entry describing a defect
  that has since been fixed is the same class of error the programme exists to
  remove: prose asserting a state the code does not have.

- **REQ-15** — A dispatch or escalation record is lifted only by a fact its
  OWNER moves: a guard's output for a dispatch, a human's fields for a park —
  never by CI tallies.
- **REQ-16** — The stop gate blocks every stop a cascade needs (one per round,
  under a cap), and never blocks a session for a run that has ended or for a
  dispatch that outlived a plausible launch.
- **REQ-17** — Check state has ONE vocabulary, read from gh's own `bucket`;
  anything unclassified is pending, never green.
- **REQ-18** — Every wait the guard imposes is a bucket the front reports and an
  owner the loop can dispatch: `waiting.parent` exists, and a moved base is a
  `base-merge` duty with a workflow flag.
- **REQ-19** — A gate verdict is bound to the head it judged; a trailer for a
  head that is no longer the PR's is absent for duty, merge and front alike.
- **REQ-20** — Merge verifies what the cache cannot know: no reported checks is
  not green, the merged head is pinned, the stack is the phase's own, children
  are retargeted from live PR data.
- **REQ-21** — Review feedback is the CURRENT state (comments since the last
  push, last verdict per reviewer), and `CHANGES_REQUESTED` with nothing to
  resolve belongs to a person, not to a fixer.
- **REQ-22** — `plan_defect` requires K distinct signatures with no green between
  them, `unknown` never counts, and the attempt counter survives the session.
- **REQ-23** — The CI waiter distinguishes a stalled pipeline from an unreachable
  `gh`, clears only the settled ticket's record, and sizes its window from the
  observed CI.
- **REQ-24** — Prose names only what the scripts implement: no instruction
  sanctions a wait, a bucket or an order of operations the code does not have.
- **REQ-25** — Every writer of `delivery-front.json` writes the SAME front: a
  resync must carry the dispatch overlay, so the board and the stop gate never
  read work in flight as actionable between one `mark` and the next.

## Phases

### Phase 20: Autonomy of the drive-to-green loop
**Requirements**: REQ-01, REQ-02, REQ-03, REQ-04, REQ-05

The night-survival core. REQ-01 and REQ-02 are one unit — a signature without a
verdict is telemetry, a verdict without a signature is unreachable. REQ-03 rides
with them because a flake charged as an attempt is the fastest way to burn a
budget on someone else's instability. REQ-04 and REQ-05 are independent and
cheap.

### Phase 21: Verdicts a human would have made anyway
**Requirements**: REQ-06, REQ-07

Deferred deliberately. REQ-07 is the largest value in the programme and the only
item that can be WRONG about correct work, so it ships as a report and earns its
blocking status with evidence. REQ-06 needs phase 20 first: pre-authorization is
only worth having once the night reliably reaches morning.

### Phase 22: Close what phase 20 left open
**Requirements**: REQ-08, REQ-09, REQ-10, REQ-11, REQ-12

Repair debt surfaced BY delivering phase 20 — five defects the run found in
code phase 20 touched or stood next to, all recorded in
`.planning/backlog/phase-20-followups.md` and re-verified against the merged
epic before being planned. Sequenced BEFORE phase 21 despite the higher number:
21 ships a judgement (REQ-07) that must not be built on a harness which cannot
fail a test, nor on a park message that states its own opposite.

Two of the five are worse than they were reported. The renderer contradiction
(REQ-08) is a rule stated backwards to the one person who has to act on it. And
the harness (REQ-12) does not merely have vacuous tests: `test(name, fn)` calls
`fn()` inside a `try`, so ANY asynchronous body reports green before its
assertions run — proven with two async tests asserting `1 === 2`, both of which
print a tick. Today that hides exactly two cases, and both pass once made to run;
the value is closing the class before the next async test is written.

### Phase 23: The board tells the truth about itself
**Requirements**: REQ-13, REQ-14

Housekeeping with one real defect in it. The conveyor's own board has been
lying in two directions, and both were measured rather than suspected.

The front cannot see "dispatched", so it re-offers work already in flight —
five times in a single session, across BOTH owners, every one verified live
before being reported. That is not an occasional annoyance: the documented
protocol says "post the guard and do NOT wait", so the front is wrong by
construction on every healthy run, and the stop gate's blocks stop meaning
anything. A gate whose blocks are usually false gets switched off, which this
repository has done twice already.

The backlog lies the other way: six of its seven phase-20 entries describe
defects that phases 21 and 22 fixed. A reader trusting it would re-do finished
work — and the entry claiming this repository has no CI is now read by a
repository that gained CI two releases ago.

### Phase 24: The conveyor stops interrupting itself
**Requirements**: REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25

Decomposed from ADR-002. Phases 20–23 added the mechanisms a night needs; a
full read of the result found that the interruptions left are mechanisms
DISAGREEING about one fact, or deciding from the wrong datum. Three stores
expire against a hash of the CI tallies, so every finished check lifts a
guard's dispatch and every retarget lifts a human's park (REQ-15). The stop
gate blocks once per turn where a cascade needs once per round, and reads
journal events of any age (REQ-16). The guard says `wait-parent`, the front
says `finalize`, and the waiter refuses to wait (REQ-18). Three hand-written
check-state lists let `ACTION_REQUIRED` and `STARTUP_FAILURE` read as green
(REQ-17), no checks at all is green (REQ-20), and a conform verdict outlives
the diff it judged (REQ-19). `plan_defect` fires on three sequentially FIXED
failures because the "no green" clause exists only in a comment (REQ-22).

Everything crossing `sentinel.cjs`/`front.cjs` lands as one stacked chain —
those two files are the seam every finding touches; the stores, the stop gate
and the CI waiter land beside it. Every ticket carries a unit test that fails
on the current code.

Found while delivering this phase (REQ-25, T-24-11): `state-sync.cjs` writes
`delivery-front.json` WITHOUT the dispatch overlay that `front.cjs` and
`dispatch-record.cjs` apply, so every resync while agents hold tickets turns
the board back into `execute: …, finalize: …` until the next `mark` rewrites it
— measured on the first wave of this very phase, with four tickets out.
