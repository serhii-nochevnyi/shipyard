---
status: closed
closed: 2026-09-12
adr: .planning/architecture/ADR-014-mandatory-runtime-model-ladder.md
---

# Problem

## What we are solving

Replace the obsolete single-floor model policy with an explicit role-specific
model ladder for the Shipyard delivery pipeline. The ladder must resolve the
requested model and effort for each stage, apply escalation signals, and be
mandatory at the actual dispatch boundary for both Codex and Claude Code.

## For whom

For maintainers and agents running Shipyard through Codex or Claude Code, and
for operators who need the model used for each delivery stage to be deliberate,
auditable, and reproducible rather than inherited from the parent session.

## Current pain

- `delivery_pipeline.model_ladder: adaptive` describes policy but does not
  reliably control the model selected by real dispatches.
- Codex child agents and inline/fallback paths can inherit the parent session
  model, bypassing the generated agent palette.
- The accepted ADR-005/ADR-012 policy does not match the requested Codex role
  ladder: it omits distinct Sol/Luna/Astra/medium and Luna/max lanes.
- Claude's existing palette is valid and must remain unchanged while its
  dispatch path becomes equally mandatory and observable.

## What success will be

1. Each pipeline role has a documented base model/effort and explicit
   escalation order matching the approved policy.
2. Codex resolves concrete Terra/Sol/Luna/Astra selections and Claude Code
   resolves through its existing palette without changing that palette.
3. Every spawned or process-dispatched agent carries a resolved model and
   effort; inline fallback or session inheritance is refused when the
   pipeline requires a routed agent.
4. Escalation triggers and applied selections are recorded in dispatch
   telemetry, and tests prove both runtimes cannot silently bypass the ladder.
5. Existing delivery behavior remains compatible outside model selection and
   the generated/installed surfaces are kept synchronized.

## What is definitely out of scope

- Changing Claude Code's existing model palette or its provider credentials.
- Rewriting historical PR attribution or claiming that past Luna runs used the
  new ladder retroactively.
- Changing product behavior unrelated to model routing.
- Hand-editing generated Codex artifacts as the source of truth.
- Allowing a missing runtime, model, effort, or dispatch identity to degrade to
  the current session's inherited model.
