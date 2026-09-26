---
phase: "43"
slug: "target-project-delivery-at-scale"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-26"
---

# Phase 43 — Validation Strategy

Planning contract only. No implementation tests were run or marked green.

## Test infrastructure

Plain Node CommonJS tests with `tests/unit/assert-harness.cjs` and bash smokes under `tests/smoke/`;
`tests/unit/run.sh` discovers `*.test.cjs`. Each plan names narrow commands scoped to its
`files_modified`; the full `make test-fast` runs only in CI and at the phase gate. Every test is hermetic
(`os.tmpdir()`, own `GIT_CONFIG_GLOBAL`, `commit.gpgsign=false`) and is committed failing first (RED) —
REQ-175. The requirement-to-test map is in `43-RESEARCH.md` "Validation Architecture".

## Per-ticket verification map

| Ticket | Wave | Requirements | Type | Commands (besides `node --check` and publish-gate) | Status |
| --- | --- | --- | --- | --- | --- |
| T-43-01 | 5 | REQ-163, REQ-165, REQ-167, REQ-159, REQ-175 | unit / fixture | `node tests/unit/pipeline-config.test.cjs` | pending |
| T-43-02 | 1 | REQ-170, REQ-175 | unit / fixture | `bash -n scripts/shipyard-pre-push-gate.sh`; `node tests/unit/pre-push-gate.test.cjs` | pending |
| T-43-03 | 6 | REQ-163, REQ-175 | unit / fixture | `node tests/unit/comment-policy.test.cjs` | pending |
| T-43-04 | 8 | REQ-171, REQ-175 | unit / fixture | `node tests/unit/run-reachability.test.cjs`; `node tests/unit/sentinel.test.cjs` | pending |
| T-43-05 | 6 | REQ-174, REQ-175 | unit / fixture | `node tests/unit/role-artifact.test.cjs` | pending |
| T-43-06 | 9 | REQ-166, REQ-175 | unit / fixture · human checkpoint | `bash -n plugins/delivery-pipeline/scripts/ticket-worktree.sh`; `node tests/unit/conveyor-scratch.test.cjs`; `node tests/unit/claude-role-host.test.cjs`; `node tests/unit/delivery-commit-finalizer.test.cjs`; `node tests/unit/codex-delivery-host.test.cjs`; `bash tests/smoke/worktree-gates-smoke.sh` | pending |
| T-43-07 | 1 | REQ-168, REQ-175 | unit / fixture · human checkpoint | `node tests/unit/check-state.test.cjs`; `node tests/unit/ci-wait.test.cjs`; `node tests/unit/log-event.test.cjs`; `node tests/unit/stop-gate.test.cjs` | pending |
| T-43-08 | 9 | REQ-167, REQ-175 | unit / fixture · human checkpoint | `node tests/unit/reviewers.test.cjs`; `node tests/unit/sentinel.test.cjs`; `node tests/unit/log-event.test.cjs` | pending |
| T-43-09 | 7 | REQ-173, REQ-175 | unit / fixture | `node tests/unit/state-sync-listing.test.cjs`; `node tests/unit/state-sync-yaml.test.cjs` | pending |
| T-43-10 | 8 | REQ-169, REQ-175 | unit / fixture | `node tests/unit/pipeline-config.test.cjs`; `node tests/unit/gsd-sync-gate.test.cjs`; `node tests/unit/gsd-sync.test.cjs`; `node tests/unit/adr-bootstrap.test.cjs` | pending |
| T-43-11 | 7 | REQ-164, REQ-175 | unit / fixture | `node tests/unit/jira-export.test.cjs`; `node tests/unit/jira-binding-contract.test.cjs`; `bash tests/smoke/docs-smoke.sh` | pending |
| T-43-12 | 10 | REQ-162, REQ-175 | unit / fixture · human checkpoint | `bash tests/smoke/graph-validator-smoke.sh`; `node tests/unit/front.test.cjs`; `node tests/unit/sentinel.test.cjs`; `node tests/unit/pipeline-stats.test.cjs`; `node tests/unit/stop-gate.test.cjs` | pending |
| T-43-13 | 10 | REQ-161, REQ-175 | unit / fixture · human checkpoint | `node tests/unit/trailer.test.cjs`; `node tests/unit/verdict-carry.test.cjs`; `bash tests/smoke/worktree-gates-smoke.sh` | pending |
| T-43-14 | 10 | REQ-172, REQ-175 | unit / fixture | `node tests/unit/deliver-dispatch.test.cjs`; `node tests/unit/deliver-builders-contract.test.cjs`; `bash tests/smoke/docs-smoke.sh` | pending |
| T-43-15 | 11 | REQ-172, REQ-175 | unit / fixture | `node tests/unit/deliver-dispatch.test.cjs`; `node tests/unit/planning-builders-contract.test.cjs`; `bash tests/smoke/docs-smoke.sh` | pending |
| T-43-16 | 10 | REQ-159, REQ-175 | unit / fixture · human checkpoint | `node tests/unit/host-verification.test.cjs`; `node tests/unit/command-runner.test.cjs`; `node tests/unit/claude-delivery-host.test.cjs`; `node tests/unit/codex-delivery-host.test.cjs` | pending |
| T-43-17 | 11 | REQ-160, REQ-159, REQ-175 | unit / fixture · human checkpoint | `node tests/unit/conveyor-coverage.test.cjs`; `node tests/unit/delivery-commit-finalizer.test.cjs`; `node tests/unit/claude-delivery-host.test.cjs`; `node tests/unit/codex-delivery-host.test.cjs`; `bash tests/smoke/worktree-gates-smoke.sh` | pending |
| T-43-18 | 12 | REQ-165, REQ-175 | unit / fixture · human checkpoint | `node tests/unit/repo-remedy.test.cjs`; `node tests/unit/escalation-record.test.cjs`; `node tests/unit/conveyor-coverage.test.cjs`; `node tests/unit/log-event.test.cjs`; `bash tests/smoke/docs-smoke.sh` | pending |
| T-43-19 | 13 | REQ-160, REQ-175 | unit / fixture · human checkpoint | `node tests/unit/sentinel.test.cjs`; `node tests/unit/conveyor-coverage.test.cjs`; `node tests/unit/log-event.test.cjs`; `bash tests/smoke/docs-smoke.sh` | pending |

## Wave 0

No framework installation. New test files (`publish-gate`, `conveyor-scratch`, `verdict-carry`,
`state-sync-listing`, `host-verification`, `conveyor-coverage`, `repo-remedy`, contract tests) are created in
each ticket's RED step. Live-only behaviour — docker/php host verification on a target project, real bot
re-review, Jira transitions, 27k-file trees, state-sync wall time — is not validated in this phase; it belongs
to the operator's later proving-ground rerun (ADR-020, REQ-175).
