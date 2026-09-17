---
phase: 33
slug: reduce-orchestration-context-and-transfer-sessions-safely
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-16
---

# Phase 33 Validation Strategy

This is the executable validation contract, not implementation proof. No product tests added or phase behavior implemented in the planning callback.

## Test infrastructure

Node's dependency-free tests/unit/assert-harness.cjs; existing filesystem/process fixtures. New quick slices use injected clock/observation/host I/O and target under 30 seconds. Existing ci-wait/generator integration tests may exceed 60 seconds. Do not install a test framework or run the whole suite on every task.

## Task verification map

| Ticket / wave | Requirement | New quick command | Negative contract |
| --- | --- | --- | --- |
| T-33-01 / 1 | REQ-90 | node tests/unit/wait-events.test.cjs | unchanged/reordered/outage replay, crash/ack race, interrupted snapshot publication, actionable wake |
| T-33-02 / 2 | REQ-91 | node tests/unit/role-artifact.test.cjs | wrong digest/head/dispatch, path escape, missing evidence, duplicate/lost result |
| T-33-03 / 3 | REQ-91 | node tests/unit/repair-artifacts.test.cjs | complete overflow findings, stale base, forged receipt, preserved attempt history |
| T-33-04 / 4 | REQ-91 | node tests/unit/judgment-artifacts.test.cjs | hidden blocker, changed tree, contradictory passed/conform |
| T-33-05 / 5 | REQ-91 | node tests/unit/planning-artifacts.test.cjs | lost research line, inline overflow, nonmaterialized/altered plan |
| T-33-06 / 6 | REQ-91 | node tests/unit/context-packet.test.cjs | missing policy, stale backlog hash, host injection, required-input overflow |
| T-33-07 / 7 | REQ-90,REQ-91 | node tests/unit/orchestration-overhead.test.cjs | polls-as-turns, duplicate measurements, mixed backend, incomplete attribution |
| T-33-08 / 8 | REQ-92 | node tests/unit/session-handoff.test.cjs | competing successor, stale owner, launch ambiguity, dirty work, active child, all crash points |
| T-33-09 / 9 | REQ-92 | node tests/unit/rotation-recommendation.test.cjs | unknown capability, stale host version, fabricated savings, unsafe boundary |

Each ticket's first tracer creates its listed test before production behavior. That is its Wave 0 test obligation, embedded in the vertical slice rather than a separate foundation-only ticket. These files intentionally do not exist yet; their exact paths are owned by the plans. New test import/fixture failure is not valid RED.

## Sampling and gates

Run the quick command after every behavior change, then the exact existing integration commands in that PLAN before handback. Record RED failing assertion, command and exit; GREEN must prove the same behavior. Retain scoped evidence for independent review. Use the installed GSD tdd-red-evidence gate for RED records; end-of-phase TDD review checks ordered RED/GREEN commits and reports gate violations before phase verification.

Generated runtime: canonical bundle/installer fixtures are required; they stub the converter and do not prove official converter compatibility or a live transfer. Official converter smoke uses tests/smoke/codex-shipyard-smoke.sh in a disposable installation at phase integration.

## Human checks at phase end

- Review T-33-04 false-green prevention and T-33-08 ownership/crash evidence before their high-risk merge checkpoints.
- Exercise a real clean-phase manual handoff on the proving ground; record exact runtime/version, checkpoint, prior/current owner epoch, acknowledgment, fresh live state, one subsequent applied dispatch, and no orphaned PR.
- Independently evaluate OPT-06, OPT-07, manual OPT-08 and combined treatment using ADR-011 cohort/window/quality gates.
- Automatic transfer remains unproven/recommendation-only. Synthetic callbacks and CLI help do not close that capability.
- Unknown economics or unavailable runtime proof stays explicitly unverified; never mark nyquist_compliant or phase passed merely because planning checks passed.

## Planning-only validation

Canonical schemas, XML task structure, source/decision coverage, graph ownership and executable-command path grounding are checked before the planning commit. These are distinct from the future implementation tests above.
