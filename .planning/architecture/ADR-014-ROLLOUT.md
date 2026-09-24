# ADR-014 rollout

1. Add the canonical policy and exhaustive pure resolver matrix, including the
   decomposition role and all fixed/repair/judgement lanes.
2. Add Codex GPT-6 Luna/Sol entries and generated static variants; validate CLI
   capability and fail closed on stale/missing output.
3. Pin the Claude Opus route to `claude-opus-5-5` while retaining the existing
   Sonnet/Fable aliases and Anthropic provider configuration.
4. Put the launch gate in front of GSD decomposition, Shipyard executor/fix,
   sentinel, drift, review, and integrator paths. Remove inline/session model
   fallback for routed work.
5. Add application receipts, telemetry reconciliation, and negative tests for
   every bypass discovered by INV-002.
6. Run the full scoped unit/smoke suite on both runtime surfaces, then install
   the generated Codex bundle only through the existing installer.

Rollback is a versioned compatibility mode with explicit launch selections;
there is no rollback to implicit session inheritance.
