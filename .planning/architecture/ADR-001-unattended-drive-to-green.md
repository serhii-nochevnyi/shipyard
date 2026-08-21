# ADR-001 — Unattended drive-to-green: verdicts, not effort

- **Status**: accepted
- **Date**: 2026-08-21
- **Supersedes**: nothing. Extends the rule already recorded in `CLAUDE.md`:
  prose rules get skipped, mechanical gates hold.

## Context

The conveyor reaches green reliably. It does not survive a night: a run either
stops for a person, or spends its attempt budget repeating the same wrong fix.
Both failures were observed in the proving ground and are visible in its journal.

Phase 19 is the concrete record. Five tickets, five escalations, a 12.8h median
to merge against phase 18's 4.6h. Three of the five escalations were manual holds
on ONE missing gate (a child merging into an open `human_checkpoint` parent),
already fixed in v0.37.0. The remaining shape is the interesting one: T-19-05
consumed four attempts and three escalations on a deterministically failing job.

Two facts about the current design explain that:

1. **The ladder escalates by TIER, not by strategy.** `attempt >= 2 → opus` is
   "try harder", and the dominant loss is the same wrong hypothesis re-tried by
   three models in sequence.
2. **A ticket has two terminal outcomes** — green, or a human. A bad ticket
   therefore either eats the whole budget or stops the run.

A third fact bounds everything else: as autonomy rises, the bottleneck moves from
*will it arrive* to *is this green real*. Investing only in throughput buys a
faster path to bad merges.

## Decision

- **D1 — A failure is identified by a normalized SIGNATURE, not by an attempt count.** Error class + test/job id + file, hashed. The repair policy reads the signature's history: changed → progress, hold the tier; same twice → change STRATEGY, not tier; K distinct with no progress → D2. The attempt counter stays as telemetry and stops being an input to the model ladder for repair roles.
- **D2 — `plan_defect` is the third terminal outcome, reached mechanically from D1.** It is not `failed`: `failed` needs a person NOW and stops the night, `plan_defect` needs a person in the MORNING — the ticket parks with its reason, is flagged for re-decomposition, and the cascade continues. It reuses the two existing stores rather than adding a third: park and journal are one act (escalation-record), and the verdict expires when the plan changes (drift-record's plan_hash rule).
- **D3 — A flake is not an attempt.** The same job failing intermittently on an unchanged tree is instability, not a defect: quarantine it and do not charge the attempt, or a night burns on someone else's CI.
- **D4 — The front is ordered, not just filtered.** `front.cjs` answers what is actionable; unattended, the ORDER decides how much work remains available at 04:00. Order by descendants in the DAG, then by expected CI length. The graph is already in hand.
- **D5 — Prior attempts are an INPUT, not a memory.** A fresh subagent per attempt is correct for context hygiene and is exactly why attempt 3 can re-propose attempt 1's fix. The remedy is a deterministic per-ticket record — signature, hypothesis, diff summary, outcome — handed to the next attempt as data. Learning persists, context stays clean.
- **D6 — Permissions move from runtime to plan.** Every high-risk approval arriving at 3am is a decision a person could have made while approving the ticket set. Risk classes are pre-authorized at decomposition; anything not pre-authorized defers to the morning front rather than blocking.
- **D7 — Degenerate green is detected on the diff and REPORTS first.** The failure modes that pass under bots at night are enumerable: weakened assertion, skip, rewritten snapshot, raised timeout, `any`/`@ts-ignore`, swallowed catch, narrowed matcher. This belongs in the deterministic layer beside validate-graph.cjs — diff in, verdict out, recorded as a `gate_status:` trailer. It ships NON-BLOCKING: it is the only item that can be wrong about legitimate work, and in this repository a blocking gate with false positives gets switched off (use_worktrees, the unguarded-merge warning — both removed in this same programme). It earns blocking status from field data, not from argument.

## Notes on the decisions
### D1 — A failure is a signature, not a count

Normalize each failure to `error class + test/job identifier + file`, hashed. The
repair policy reads the signature's HISTORY, not the attempt number:

- signature changed → progress; hold the tier, continue
- same signature twice → change STRATEGY, not tier: re-read the plan, widen the
  context, raise the hypothesis above the symptom
- K distinct signatures with no progress → D2

The attempt counter stays as telemetry. It stops being an input to the model
ladder for repair roles.
### D2 — `plan_defect` is the third terminal outcome

Reached mechanically from D1. It is NOT `failed`:

- `failed` is a state that needs a person **now** — it stops the night;
- `plan_defect` is a conclusion that needs a person **in the morning** — the
  ticket is parked with its reason, flagged as a re-decomposition candidate, and
  the cascade continues.

It reuses the two stores that already exist rather than adding a third: the park
and its journal entry are one act (`escalation-record`), and the verdict expires
when the PLAN changes, which is `drift-record`'s existing `plan_hash` rule.
### D3 — A flake is not an attempt

The same job failing intermittently on an unchanged tree is instability, not a
defect. Quarantine it and do not charge the attempt, or a night burns on someone
else's CI.
### D4 — The front is ordered, not just filtered

`front.cjs` answers *what is actionable*. Unattended, *in what order* decides how
much work remains available at 04:00. Order by descendants in the DAG (unblocking
power), then by expected CI length. The graph is already in hand.
### D5 — Prior attempts are an INPUT, not a memory

A fresh subagent per attempt is correct for context hygiene and is why attempt 3
can re-propose attempt 1's fix. The fix is not a longer-lived agent: it is a
deterministic per-ticket record — signature, hypothesis, diff summary, outcome —
handed to the next attempt as data. Learning persists; context stays clean.
### D6 — Permissions move from runtime to plan

Every "high-risk approval" arriving at 3am is a decision a person could have made
while approving the ticket set. Risk classes are pre-authorized at decomposition.
Anything not pre-authorized is deferred to the morning front rather than blocking
the run.
### D7 — Degenerate green is detected on the diff, and REPORTS first

Drive-to-green optimizes the signal it is measured by. The failure modes that pass
under bots at night are known and enumerable: weakened assertion, skip, rewritten
snapshot, raised timeout, `any`/`@ts-ignore`, swallowed catch, narrowed matcher.

This belongs in the deterministic layer beside `validate-graph.cjs`: diff in,
verdict out, recorded as a `gate_status:` trailer like `arch-review`.

**It ships non-blocking.** It is the only item here that can be wrong about
legitimate work — a relaxed assertion is sometimes right. In this repository a
blocking gate with false positives has a documented fate: it gets switched off
(`use_worktrees`, the unguarded-merge warning; both removed in this same
programme). It earns blocking status from field data, not from argument.

## Consequences

- The model ladder loses `attempt` as an input for repair roles and gains a
  signature-history input. `role × risk` remains.
- `front.cjs` gains an ordering responsibility on top of classification.
- The escalation store gains a second verdict kind; no new subsystem.
- D7 adds a script and a trailer, and deliberately changes no gate outcome until
  its false-positive rate is measured.

## Rejected

- **Escalating to a stronger model on repeat failure.** That is the current
  behaviour and the thing being replaced: it is "try harder", not "try
  differently".
- **A longer-lived repair agent that remembers its attempts.** It would trade the
  context hygiene that makes a cold start cheap for the same information D5
  supplies as data.
- **Making D7 blocking on day one.** Highest value, highest false-positive risk;
  a gate that gets disabled enforces nothing.
