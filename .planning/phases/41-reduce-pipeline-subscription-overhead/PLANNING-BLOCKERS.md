# Phase 41 planning admission

Status: BLOCKED before formal research/decomposition callbacks.
Checked: 2026-09-25. Runtime: Codex.
Planning branch: plan/41-subscription-overhead.
Baseline: aa5def7931d08b7f789586a8d83a4e452ff2a8fa (phase 39 epic).

## What passed

The explicit-capability CLI probe reports codex-cli 0.156.1 available with the
required model/effort selection. Project delivery-rule preflight passes with
SHIPYARD_DELIVERY_RULES_SOURCE pointing to this checkout's canonical
plugins/delivery-pipeline/skills/delivery-rules/SKILL.md. Remaining heavy-effort
tuning is advisory; no model policy or configuration was changed.

Commands:

- `node /Users/serhii/.codex/shipyard/scripts/codex-runtime-host.cjs --capability-only --capabilities-file /Users/serhii/.codex/shipyard/codex-capabilities.json`
- `SHIPYARD_DELIVERY_RULES_SOURCE="$PWD/plugins/delivery-pipeline/skills/delivery-rules/SKILL.md" node /Users/serhii/.codex/shipyard/scripts/gsd-tune.cjs --check --runtime codex`

A successful capability probe proves available CLI selections, not that the
planning artifact contract is implemented.

## Blocking source evidence

1. `codex-decompose-host.cjs:18` makes gsd-phase-researcher read-only. Its
   `requestValue` accepts only gsd_role, prompt, signals and dispatch_id; the
   host returns the launchAgent result without sealing planning artifacts.
2. `codex-dispatch-adapter.cjs:98` also enforces the read-only researcher/checker
   selection. The installed shipyard-inv-research.toml uses read-only.
3. `codex-delivery-host.cjs` has executor commit finalization but no investigation
   research consumer sealing the required research-result envelope.
4. Existing phase-40 plans explicitly describe these missing paths:
   - T-40-10: shared research/decomposition artifact sealer.
   - T-40-12: Codex investigation consumer.
   - T-40-11: writable contained researcher and sealed Codex decomposition.
   These are not independent one-line fixes. T-40-11 depends on T-40-04 and
   T-40-14; its plan describes the sealer chain through T-40-12/13/10/01.

Evidence comes from source inspection and existing plans, not a failed model
call. No expensive launch was made with a contract known to be incomplete.
No workaround changed sandbox policy or manufactured receipts/artifacts.

## Required workflow rule

The installed shipyard-decompose SKILL.md says:
“Missing or failed evidence is a refusal, not a fallback.”
It requires a boundary-verified receipt and a trusted consumer sealing the
materialized planning files before Gate 2. shipyard-investigate likewise says
there is no inline or direct researcher fallback.

Consequently this PR captures scope, evidence and the admission blocker. It
contains no executable 41-xx-PLAN.md files, accepted ADR or claimed Gate 1/2
pass. Handwritten plans or ordinary subagents would not satisfy those contracts.

## Sequencing decision needed

The requested phase 39 → 41 → 40 delivery order conflicts with the existing
placement of Codex planning prerequisites in phase 40. Recommended next change:
extract the minimal Codex planning prerequisite dependency closure into a
separate preparatory delivery scope, or explicitly revise the phase ordering.
Retain the existing ticket ownership/contracts while resolving this; do not
silently re-number or implement phase-40 tickets inside a documentation PR.
Switching to Claude is not an automatic fallback, and its decomposition sealer
is itself part of T-40-10; capability must be checked rather than assumed.

After prerequisite delivery and installation, rerun admission, complete formal
INV-006 → ADR → researcher/planner/checker, and update this draft with validated
plans and dependency ordering. T-39-17 remains phase 39's packet fix; do not
implement it again here.
