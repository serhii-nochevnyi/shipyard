# Phase 20 — Autonomy of the drive-to-green loop

**Source:** ADR Ingest Express Path (.planning/architecture/ADR-001-unattended-drive-to-green.md)

## Domain

The conveyor's repair loop: what happens between "a PR is open and red" and "it is
green or a person is asked". Today the loop has two terminal outcomes and one
escalation input — the attempt counter — and both are the wrong shape for a run
left alone overnight.

## Locked decisions

- **D1 — A failure is identified by a normalized SIGNATURE, not by an attempt count.** Error class + test/job id + file, hashed. The repair policy reads the signature's history: changed → progress, hold the tier; same twice → change STRATEGY, not tier; K distinct with no progress → D2. The attempt counter stays as telemetry and stops being an input to the model ladder for repair roles.
- **D2 — `plan_defect` is the third terminal outcome, reached mechanically from D1.** It is not `failed`: `failed` needs a person NOW and stops the night, `plan_defect` needs a person in the MORNING — the ticket parks with its reason, is flagged for re-decomposition, and the cascade continues. It reuses the two existing stores rather than adding a third: park and journal are one act (escalation-record), and the verdict expires when the plan changes (drift-record's plan_hash rule).
- **D3 — A flake is not an attempt.** The same job failing intermittently on an unchanged tree is instability, not a defect: quarantine it and do not charge the attempt, or a night burns on someone else's CI.
- **D4 — The front is ordered, not just filtered.** `front.cjs` answers what is actionable; unattended, the ORDER decides how much work remains available at 04:00. Order by descendants in the DAG, then by expected CI length. The graph is already in hand.
- **D5 — Prior attempts are an INPUT, not a memory.** A fresh subagent per attempt is correct for context hygiene and is exactly why attempt 3 can re-propose attempt 1's fix. The remedy is a deterministic per-ticket record — signature, hypothesis, diff summary, outcome — handed to the next attempt as data. Learning persists, context stays clean.
- **D6 — Permissions move from runtime to plan.** Every high-risk approval arriving at 3am is a decision a person could have made while approving the ticket set. Risk classes are pre-authorized at decomposition; anything not pre-authorized defers to the morning front rather than blocking.
- **D7 — Degenerate green is detected on the diff and REPORTS first.** The failure modes that pass under bots at night are enumerable: weakened assertion, skip, rewritten snapshot, raised timeout, `any`/`@ts-ignore`, swallowed catch, narrowed matcher. This belongs in the deterministic layer beside validate-graph.cjs — diff in, verdict out, recorded as a `gate_status:` trailer. It ships NON-BLOCKING: it is the only item that can be wrong about legitimate work, and in this repository a blocking gate with false positives gets switched off (use_worktrees, the unguarded-merge warning — both removed in this same programme). It earns blocking status from field data, not from argument.

## Canonical references

- `CLAUDE.md` — the deterministic layer, one paragraph per script; the standing
  rule "prose rules get skipped, mechanical gates hold".
- `plugins/delivery-pipeline/scripts/pipeline-config.cjs` — the role × risk ×
  attempt ladder that D1 changes the input of.
- `plugins/delivery-pipeline/scripts/front.cjs` — classification today, ordering
  after D4.
- `plugins/delivery-pipeline/scripts/escalation-record.cjs`,
  `drift-record.cjs` — the two durable stores D2 reuses instead of adding a third.
- `plugins/delivery-pipeline/workflows/fix-round.mjs` +
  `references/ci-fix.md`, `references/review-fix.md` — where D5's input must
  arrive, because the Workflow path bypasses command-doc prose.

## Specifics

- Every new verdict is written by a SCRIPT and read back from a file. No decision
  that can differ between runtimes may live in a prompt.
- `make test-fast` is the verification command: seconds, offline, deterministic.
- The plugin and its capability version together.
- A change to a command doc or script reaches BOTH runtimes and must not assume
  Claude-only capabilities.

## Success criteria

- The model ladder loses `attempt` as an input for repair roles and gains a
- `front.cjs` gains an ordering responsibility on top of classification.
- The escalation store gains a second verdict kind; no new subsystem.
- D7 adds a script and a trailer, and deliberately changes no gate outcome until
- its false-positive rate is measured.

## Risk summary

- signature-history input. `role × risk` remains.

## Scope fence

IN — the repair loop's inputs and verdicts: failure signature, the plan_defect
outcome, flake quarantine, front ordering, attempt history as input.

OUT — REQ-06 (permissions at decomposition) and REQ-07 (degenerate-green
detector) are phase 21 by ADR. Do not implement them here; a ticket that reaches
for either is out of scope.
