# The front cannot see "dispatched to an executor"

**Found:** 2026-08-25, minutes into the first `/shipyard:deliver` run on this
repo — by the stop-gate firing on work that was already in flight.
**Scope:** none of phase 20's tickets.

## What happened

Wave 1 (T-20-01, T-20-04, T-20-05) was dispatched to `executors.mjs`. The
executors were running. The stop hook then refused the turn with:

    the delivery front is not empty — 3 item(s) are actionable RIGHT NOW
    (execute: T-20-01, T-20-04, T-20-05)

Formally right, and useless here: those three were not un-taken, they were mid-
implementation. Nothing had been pushed, so `state-sync` — which reads GitHub —
still classified them `execute`.

## The gap

The front's vocabulary is:

    actionable  execute publish fix finalize merge
    waiting     ci merge_human human
    parked      blocked done

There is no state for **dispatched and running**. A ticket handed to a subagent
is indistinguishable from one nobody has touched, because the only evidence of
the dispatch lives in the orchestrator's session — which is exactly the kind of
fact this conveyor has repeatedly learned not to keep there (`--parked` →
`escalation-record`, the drift verdict → `drift.json`).

`deliver.md` has the same hole in prose: step 4 of the loop-back covers the
SENTINEL still working ("wait for its report rather than ending the run") and
says nothing about executors in flight.

## Why it matters beyond a spurious block

The stop gate's whole value is that a block means real work. A block that fires
on work already in progress is the false positive that gets a gate switched off —
the failure mode this repo has now removed twice (`use_worktrees`, the
unguarded-merge warning). It is worth fixing precisely BECAUSE the gate is
otherwise trustworthy.

## Shape of the fix

A dispatch is a durable fact, so it belongs in a file, not a session:

- the main loop records it when it dispatches (ticket, role, started_at, and a
  pid/task id if the runtime gives one);
- `front.cjs` reads it and reports `waiting: executor` — not actionable, not
  parked, and explicitly NOT a fixpoint;
- it EXPIRES on its own, like every other durable park here: the record is stale
  once the ticket's state moves (`branched`/`pr-open`), or after a timeout, so a
  killed run cannot leave a ticket permanently "in flight".

That last property is the load-bearing one. A dispatch record that never expires
would hide a ticket the next run must pick up — trading a spurious block for a
silent stall, which is the worse of the two.

## Second occurrence, same run — and it reveals the SENTINEL half

Later the same day the gate fired again, this time on **five** items:

    the delivery front is not empty — 5 item(s) are actionable RIGHT NOW
    (execute: T-20-02, T-20-03 | finalize: T-20-01, T-20-04, T-20-05)

Every one of the five was verifiably in flight: `execute` with `executors.mjs`
(both agent transcripts still growing, worktrees at 0 commits — mid-research),
`finalize` with the background sentinel (`ListAgents`: running, 2m). A fresh
`state-sync` reproduced the identical board, so this is not staleness — it is
the missing state.

Two things this occurrence adds:

1. **The gap is not executor-specific.** The first sighting was `execute`, and
   the fix above is written in terms of the main loop's dispatch. But `finalize`
   items are dispatched too — to the guard, whose whole design contract is
   "post it and do NOT wait". So the conveyor's own recommended concurrency
   makes the front wrong about the sentinel's bucket by construction, and it
   will fire this way on every healthy run that follows the documented protocol.
   The dispatch record must therefore cover the guard's claim over
   fix/finalize/merge, not just the main loop's over execute/publish. The
   natural key is already in `front.cjs`: it names the OWNER of each bucket.
2. **The escape hatches don't cover it.** The stop gate's five hatches are: no
   front, stale front, nothing actionable, all-left-behind, `stop_hook_active`.
   A busy, correct, fully-dispatched front matches none of them — which is right,
   because the gate cannot currently tell this apart from a run walking away.
   Only the durable record can.

Cost so far: two full interactions spent re-verifying liveness to answer a
block that was factually wrong both times. The gate stays trustworthy only
while its blocks mean something.
