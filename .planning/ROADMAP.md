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

- **REQ-26** — The image and the smokes pin the runtimes the conveyor is
  tested on: Claude Code with Fable 5.1/Opus 5 aliases, gsd-core 1.13.0.
- **REQ-27** — A Codex agent carries EFFORT, not a model baked from a catalog
  that can be stale; a `model =` line appears only when the user's GSD remap
  names one, resolved through GSD's resolver.
- **REQ-28** — Prose names the runtimes as they are: the Agent tool's accepted
  values, `opus` = Opus 5 and its version floor, `fable` = Fable 5.1 and its
  consent hazard, the conveyor's `gate_status:` PR trailer vs GSD's
  `gate-status:` commit trailer.
- **REQ-29** — One ownership matcher decides Gate 2 overlap, the scope gate and
  base-merge conflict resolution; ambiguous declarations are rejected and an
  uncertain owner never authorizes a mechanical resolution.
- **REQ-30** — A corrupt configuration permits no mutation: merge, duty,
  escalation and retarget refuse on an unparseable config and name the file.
- **REQ-31** — Readiness needs positive evidence: an epic comparison that failed
  is `unknown`, not `landed`; availability and path reachability are checked in
  both integration modes.
- **REQ-32** — Worktree gc removes only a worktree PROVEN landed by delivery
  state; a clean local-only branch is reported and kept.
- **REQ-33** — A lock is released only by its owner and taken over atomically;
  a delivery-state snapshot is never overwritten by an older observation.
- **REQ-34** — The Codex config merge produces valid TOML for every valid input,
  detecting headers by grammar and re-parsing before it replaces the file.
- **REQ-35** — GSD tuning merges the delivery-rules skill into `agent_skills`
  and preserves every foreign entry; a missing `~/.gsd/` is created.
- **REQ-36** — Jira idempotency keys are namespaced by repository so two
  repositories exporting the same ticket id never select one issue.
- **REQ-37** — Workflow scripts validate `args` before dispatching: malformed
  input throws, an empty list returns empty, every ticket yields one result.
- **REQ-38** — "Left behind" is decided by the ticket's own phase having landed
  without it, never by phase-number arithmetic.
- **REQ-39** — An unavailable check reading (gh error, malformed JSON) is a
  state of its own, distinct from an observed empty list, and never green.
- **REQ-40** — No role that writes code or renders a judgement is dispatched
  below `opus`; `pr-sentinel` and `drift-check` stay on `sonnet` because
  neither's answer is the gate, and no built-in path reaches `haiku`. Depth is
  expressed by EFFORT keyed on the role and its signals, not on the tier; a
  configured effort override must not silently disable the signature escalation
  it outranks; and **every signal a row is keyed on is passed by the dispatch,
  with an absent signal never resolving upward.** *(Amended 2026-09-08: the
  universal floor is retired for those two roles, and effort is chosen for the
  work rather than for the price — output is 12–19% of a model line, so an
  effort step moves ~3% of a run against ~2.5× for a tier step. ADR-005 D2.)*
- **REQ-41** — `fable` is a ceiling the conveyor reaches mechanically (window
  pressure, exhausted repair depth, contested judgment) and never by default,
  the integrator included; it is never emitted where the runtime would
  resolve it to Fable 5. *(Amended 2026-09-08: the integrator's standing
  exception is withdrawn — its measured run was 291k tokens against a 1M window
  at 2× the price, so it earns `fable` through the window route like every other
  role.)*
- **REQ-45** — Every dispatch records the model and the effort it ran at, so
  the ladder can be revised on evidence instead of judgement.
- **REQ-42** — A wave is cut to a concurrency the session can afford: the front
  reports capacity, the loop dispatches no more than that, and a front held back
  by the cap is never a fixpoint.
- **REQ-43** — Whether a ticket needs a drift check is COMPUTED against the base
  the ticket is cut from, not judged against the integration branch.
- **REQ-44** — A workflow returns a reference to a document, not the document:
  what the orchestrator forwards but never reads must not enter its context.

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

### Phase 25: The conveyor follows the models it runs on
**Requirements**: REQ-26, REQ-27, REQ-28, REQ-40, REQ-41, REQ-42, REQ-45

Decomposed from ADR-003. Three things moved under the conveyor within a
fortnight — Claude Code's aliases (Opus 5 at 2.1.219, Fable 5.1 at 2.1.255, the
Agent tool accepting full ids), Codex's `gpt-6-astra`, gsd-core 1.13.0 — and the
repository records none of them: the image pins Claude Code 2.1.200 and
gsd-core 1.7.0, the Codex generator bakes `gpt-5.6-terra` into all seven agents
over the user's newer default, and four documents state a tool constraint that
no longer exists. The pins ticket runs now; the two prose/generator tickets
wait for phase 24's epic, because they edit files phase 24 owns.

T-25-04 was added on 2026-09-07 from ADR-005, after the releases made the
ladder's own justification stale: `fable` was chosen for the judges because
"the 1M window is what distinguishes their work", and Sonnet 5 now has that
window natively while Anthropic positions Fable 5.1 as the step AFTER Opus 5 at
higher effort falls short. The decision taken was to raise the floor to `opus`,
express depth as effort, and make `fable` something the conveyor earns.

### Phase 26: Positive evidence before a mutation
**Requirements**: REQ-29, REQ-30, REQ-31, REQ-32, REQ-33, REQ-34, REQ-35, REQ-36, REQ-37, REQ-38, REQ-39

Decomposed from ADR-004, the external audit of 2026-09-07. Eleven of its
twenty-eight findings were already phase 24's and were folded into its unstarted
tickets; the seventeen left share one shape — a mutation that proceeds on the
ABSENCE of a signal where it needs the PRESENCE of one: a glob stump owning the
wrong files and base-merge overwriting a ticket's own change on that basis, a
corrupt config defaulting to auto-merge, a failed epic comparison reading as
landed, gc deleting a committed-but-unpushed worktree, a stale lock holder
removing its successor's lock, an installer writing invalid TOML, tuning
deleting a project's skills, Jira labels colliding across repositories,
workflow input errors returning an empty success, and "left behind" decided by
phase arithmetic. Six tickets touch nothing phases 24/25 own and run at once;
five wait for phase 24's epic as one chain.
