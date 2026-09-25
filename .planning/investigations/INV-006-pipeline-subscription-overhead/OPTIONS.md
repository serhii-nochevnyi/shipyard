# Options

Full comparison: [research/alternatives.md](research/alternatives.md).

## Recommended narrow scope

Extend the existing mechanisms within approved P41-A–F: verify phase-39 packet
and arming behavior after installation; use bounded handoff; persist and resume
trusted finalization; localize projection fingerprints; join existing telemetry
to verified outcomes. Preserve model floors and independent review.

The alternative is a larger redesign: a new prompt assembler, automatic session
rotation, persistent sentinel daemon, general projection cache and new ledger.
That increases rollout/ownership risk and exceeds the approved phase scope.

## Choices still to make concrete during planning

- Handoff trigger: explicit safe phase/long-wait boundary first; automatic
  thresholds only after measuring startup/cache-warmup cost.
- Changed finalization base: conservative refusal by default, or a precisely
  specified set of affected gates that the trusted host can rerun.
- First measurement cohort: a matched runtime/model/effort and role scope,
  retaining the existing 20-completion/95%-attribution floor and quality window.

These choices must be recorded before execution. No accepted ADR is claimed by
this comparison; full tradeoffs and excluded capabilities remain in the report.
