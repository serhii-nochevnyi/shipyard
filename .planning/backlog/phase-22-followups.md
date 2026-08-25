# Phase 22 follow-ups

**Found:** 2026-08-25, delivering phase 22.

## 1. A comment in `failure-signature.test.cjs` becomes false when T-22-05 lands

`tests/unit/failure-signature.test.cjs:516-518`:

    // (Spawned through bash rather than from an async test body: this harness's
    // `test()` is synchronous and `done()` exits the process, so an awaited body
    // would be marked green before its assertions ever ran.)

Accurate today, false the moment T-22-05 ships. Out of scope for that ticket
(another test file), so it needs its own small change: either correct the
parenthetical, or drop the bash-spawn workaround now that an async body is safe.
Prefer correcting the comment over rewriting a working test — the bash form is
not wrong, only differently motivated.

## 2. The pattern worth noticing, not just the line

That comment means the harness defect was KNOWN during phase 20, by the author
of T-20-01, in enough detail to describe the mechanism exactly. It was worked
around correctly and never recorded as a defect anywhere a later reader would
look — so the two vacuous tests in `record-stores.test.cjs` kept reporting
safety, and the `lock.cjs` race they were written to guard stayed live until
phase 22 measured it.

The workaround was the right local call. What was missing is the second act:
a defect you route around is still a defect, and the note costs a minute. This
repo already has the mechanism — `.planning/backlog/` — and the standing lesson
("prose rules get skipped, mechanical gates hold") suggests the durable version
is a gate, not an exhortation: an executor that writes "this is broken, so I
avoided it" into a comment has, by that act, found something the project should
be told about.

Worth considering for `delivery-rules`: when a plan's work is shaped AROUND a
defect in code outside its scope, recording that defect is part of the ticket,
not optional politeness.

## 3. The front still has no in-flight state — five occurrences in one session

Tally for `front-has-no-in-flight-state.md`: the stop gate fired on fully
dispatched fronts five times across phases 20 and 22 — on 3, 5, 6, 4 and 5
items, covering both owners (executors and the guard). Every one was verified in
flight before being reported. This is no longer an occasional annoyance; it is
the normal outcome of following the documented protocol, which is the strongest
argument yet that the fix belongs in `front.cjs` rather than in operator
patience.
