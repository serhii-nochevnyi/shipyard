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
