---
phase: "44"
slug: "optimize-subscription-efficiency-per-runtime"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-27"
---

# Phase 44 — Validation Strategy (first pass: P44-A, P44-D, P44-G)

Planning contract only. No implementation tests were run or marked green.

## Test infrastructure

Plain Node CommonJS tests with `tests/unit/assert-harness.cjs` or `node:test`, and bash smokes under
`tests/smoke/`; `tests/unit/run.sh` discovers `*.test.cjs`. Each plan names narrow commands scoped to its
`files_modified`; the full `make test-fast` runs only in CI and at the phase gate. Tests use temp homes and
state roots only and never touch the operator's `~/.claude` or `~/.local/state`. Every test is committed
failing first (RED). The requirement-to-test map is in `44-RESEARCH.md` "Validation Architecture"; its
T-44-07/T-44-08 labels correspond to tickets T-44-06/T-44-07 after the planner merged the two P44-D tickets.

## Per-ticket verification map

| Ticket | Wave | Requirements | Type | Commands (besides `node --check` and publish-gate) | Status |
| --- | --- | --- | --- | --- | --- |
| T-44-01 | 1 | REQ-176, REQ-178, REQ-179, REQ-181, REQ-184 | unit / captured fixture | `node tests/unit/subscription-observation.test.cjs`; `node tests/unit/boundary-fixtures.test.cjs` | pending |
| T-44-02 | 2 | REQ-176, REQ-178, REQ-179, REQ-184 | unit / captured fixture / hook smoke | `node tests/unit/usage-report.test.cjs`; `node tests/unit/subscription-observation.test.cjs`; `node tests/unit/boundary-fixtures.test.cjs`; `make test-hooks` | pending |
| T-44-03 | 2 | REQ-180, REQ-181, REQ-179, REQ-184 | unit | `node tests/unit/subscription-store.test.cjs`; `node tests/unit/subscription-observation.test.cjs` | pending |
| T-44-04 | 3 | REQ-177, REQ-178, REQ-181, REQ-184 | human capture, then unit | `node tests/unit/statusline-collector.test.cjs`; `node tests/unit/boundary-fixtures.test.cjs`; `node tests/unit/subscription-store.test.cjs` | pending |
| T-44-05 | 4 | REQ-177, REQ-180, REQ-181, REQ-184 | smoke (isolated homes) | `bash -n scripts/install-shipyard-claude-statusline.sh`; `bash tests/smoke/claude-statusline-smoke.sh`; `make test-docs` | pending |
| T-44-06 | 2 | REQ-182, REQ-184 | unit | `node tests/unit/rotation-recommendation.test.cjs`; `node tests/unit/session-handoff.test.cjs`; `node tests/unit/orchestration-overhead.test.cjs`; `node tests/unit/boundary-fixtures.test.cjs` | pending |
| T-44-07 | 1 | REQ-183, REQ-184 | unit | `node tests/unit/effort-experiment.test.cjs`; `node tests/unit/orchestration-overhead.test.cjs` | pending |

Sampling: every ticket has an automated command per task; no three consecutive tasks lack one.

## Wave 0

- `tests/fixtures/captured/claude-statusline.jsonl`: operator capture at the start of T-44-04 (human action). No other fixture is new; the Claude and Codex quota shapes are already in `tests/fixtures/captured/`.
- No framework install.

## Manual-only

- T-44-04 statusline capture (interactive Claude session in an isolated settings file).
- T-44-05 human checkpoint: review of the installer diff and smoke output before merge.

## Not measured in this pass (REQ-184)

Every report stays `inconclusive`; installed, behaviourally verified and efficiency-measured states are recorded separately. No acceptance criterion contains a savings percentage.
