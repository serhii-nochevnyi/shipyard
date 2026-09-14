# Decisions

<!-- Every accepted position is recorded IMMEDIATELY at the moment of the decision, not at the end. -->
<!-- Record format: -->
<!-- ## <decision, as an affirmative statement> -->
<!-- **Why:** ... -->
<!-- **What was rejected:** ... -->
<!-- **Scope fence:** what this decision explicitly does NOT cover -->
<!-- These sections become the locked decisions in the ADR when Gate 1 is closed. -->

## The pipeline uses the operator-approved role ladder

**Why:** The current two-model Codex policy does not distinguish the roles or
the escalation paths needed by the operator, and it allowed the parent session
model to leak into delivery work.

**What was rejected:** The existing Terra/Astra-only Codex floor/ceiling policy,
the old Claude-centric `opus/sonnet` role defaults as a cross-runtime policy,
and one universal model for all delivery roles.

**Scope fence:** This decision defines the target ladder; the exact machine
signals for each escalation edge remain open until the operator chooses them.

## Claude Code keeps its existing model palette

**Why:** The Claude runtime already has a working, runtime-native palette. The
needed change is to make the canonical role decision reach that palette and be
verified at dispatch, not to replace its model IDs.

**What was rejected:** Replacing Claude's palette with Codex model IDs or
creating a second, independently maintained Claude ladder.

**Scope fence:** The adapter may add role/rung metadata and launch evidence, but
must not rewrite the existing Claude palette or provider configuration.

## Model selection is mandatory at both runtime dispatch boundaries

**Why:** A resolver result recorded after launch is not proof that the runtime
used it. Session inheritance, inline fallback, missing generated files, or an
unsupported override must not silently change the requested model.

**What was rejected:** Advisory-only telemetry, model-less generated agents,
fallback to the parent session model, and accepting a dispatch solely because
it exited successfully.

**Scope fence:** This does not retroactively relabel historical dispatches; it
applies to new routed work after the policy is installed.

## The policy is canonical and adapters are runtime-specific

**Why:** A single role/escalation contract prevents Claude and Codex from
drifting, while adapters can represent each runtime's own concrete model
surface. Static Codex agent files remain generated outputs, not a second source
of truth.

**What was rejected:** Separate static ladders with duplicated escalation logic.

**Scope fence:** Existing Claude palette entries and generated Codex artifacts
remain implementation details of their adapters.

## Escalation is role-scoped and evidence-driven

**Why:** A global risk or context-window promotion currently overrides fixed
Luna roles and can skip the intended Sol repair rung. The ladder must preserve
the operator's role-specific intent while remaining deterministic.

**Decision:** Research starts at Terra/high, `alternatives` advances it to
Sol/medium, and an explicit `very-complex` classification advances it to
Astra/medium. Decomposition starts at Sol/medium and advances to Astra/medium
on an explicit critical/checkpoint classification. CI-fix and review-fix start
at Luna/max, advance to Sol/medium on a verified repeated failure, and to
Astra/medium on `repeat_exhausted`. Integrator and arch-review start at
Sol/medium and advance to Astra/medium for contested judgement, explicit
critical/checkpoint evidence, or a measured input-window ceiling. Executor,
PR sentinel, and drift-check keep their fixed Luna tuples; their signals may
change strategy or gate state but not model selection.

**What was rejected:** A global input-window route for every role, high-risk
promotion that skips repair rungs, and attempt-count-only escalation without
proof that the previous rung was applied.

**Scope fence:** This defines the initial signal matrix for the new policy. A
future measured tuning change must amend this decision and retain the existing
telemetry evidence.
