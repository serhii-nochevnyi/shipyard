# Risks

<!-- Record format: -->
<!-- ## <risk> -->
<!-- severity: low|medium|high -->
<!-- mitigation: <what we do> -->
<!-- A question without an answer is not a risk, it is OPEN-QUESTIONS.md. -->

## Existing ADRs encode a superseded Codex policy

severity: high

mitigation: Produce an explicit ADR amendment/superseding decision before
decomposition, then update resolver, generators, installers, and tests from
that single source.

## Runtime dispatch can silently inherit the parent model

severity: high

mitigation: Require a resolved dispatch record at the boundary and fail closed
when model, effort, runtime, or agent identity is missing.

## Claude palette changes accidentally while adding enforcement

severity: medium

mitigation: Treat Claude palette files/configuration as read-only inputs and
test that only selection/enforcement wiring changes on the Claude side.

## An underspecified escalation signal promotes the wrong role

severity: high

mitigation: Require a role-scoped signal matrix in the ADR. Never apply the
global input-window or high-risk route to fixed Luna roles, and retain every
fired signal in the resolution record.

## Codex model availability differs by CLI version or installation

severity: high

mitigation: Validate Terra, Sol, Luna, and Astra availability at install and
dispatch time; fail closed when a requested rung cannot be applied rather than
falling back to the session default.

## Old GSD model overrides outrank the new policy

severity: high

mitigation: Make the canonical pipeline resolution authoritative for routed
roles, reject conflicting per-role overrides, and test both GSD decomposition
and Shipyard delivery paths.
