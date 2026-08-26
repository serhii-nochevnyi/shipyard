# Phase 22 follow-ups

**Status: all four entries are STILL LIVE.** None was closed by phase 22's or
phase 23's merges. Two have an owner — §1 is T-23-03's and §3 is T-23-01's, both
in phase 23 — and §2 and §4 have none. Each was re-measured against the shipped
code by T-23-02 on 2026-08-26; silence is not how a reader should have to infer
any of this.

**Found:** 2026-08-25, delivering phase 22.

## 1. A comment in `failure-signature.test.cjs` becomes false when T-22-05 lands

**STILL LIVE — the prediction in this heading came true; owned by T-23-03.**
Re-measured 2026-08-26: T-22-05 shipped in v0.40.0 and the harness now awaits an
async body, while `tests/unit/failure-signature.test.cjs:516-518` still carries
the parenthetical below verbatim. So the file is now prose asserting a defect the
code no longer has — this repository's own recurring shape, sitting in a test.
T-23-03 corrects it.

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

**STILL LIVE — not adopted, no owner.** Re-measured 2026-08-26:
`plugins/delivery-pipeline/skills/delivery-rules/SKILL.md` contains no mention of
the backlog and no rule about recording a defect the work was shaped around. The
suggestion at the end of this section stands exactly as written.

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

**STILL LIVE — owned by T-23-01, delivering now in phase 23.** The tally below
stands; the entry it belongs to is `front-has-no-in-flight-state.md`, and T-23-01
implements the durable dispatch record described there, including the expiry that
keeps a killed run from hiding a ticket.

Tally for `front-has-no-in-flight-state.md`: the stop gate fired on fully
dispatched fronts five times across phases 20 and 22 — on 3, 5, 6, 4 and 5
items, covering both owners (executors and the guard). Every one was verified in
flight before being reported. This is no longer an occasional annoyance; it is
the normal outcome of following the documented protocol, which is the strongest
argument yet that the fix belongs in `front.cjs` rather than in operator
patience.

## 4. The front reads phase ORDER from the phase NUMBER — VERIFIED, STILL LIVE

**STILL LIVE — no owner.** Re-measured 2026-08-26: `front.cjs` still derives
"left behind" from the phase NUMBER — `phaseNum` at line 317, and `leftBehind` at
line 321 comparing it against the highest landed phase number — so a phase
delivered out of order is still reported as one the run has moved past, and the
stop gate's all-left-behind hatch still opens for it.

Delivering phase 22 before phase 21 (deliberate: 22 was repair debt that 21's
work should not be built on) makes `state-sync` report, of five live phase-21
tickets:

    fixpoint: NO — but ALL 4 actionable item(s) are in phases already moved past
    (T-21-02, T-21-03, T-21-05, T-21-04). Nothing live remains.

Nothing had moved past them; phase 22 merged and 21 < 22. The heuristic treats a
lower phase number as earlier in time, which is true of most projects and false
whenever a phase is delivered out of order — which the roadmap here explicitly
does, and says so in its own phase-22 entry ("Sequenced BEFORE phase 21 despite
the higher number").

Consequence is narrow but wrong in the dangerous direction: the message invites
the operator to record why the work is NOT being taken, i.e. to park live work
as abandoned. It also flips the stop-gate's "all-left-behind" escape hatch on
for a phase that is mid-delivery.

The graph already knows the truth — a phase whose tickets are unmerged and whose
epic is open is not "moved past", whatever its number. Judge by state, not by
ordinal.
