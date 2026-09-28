---
phase: "45"
slug: "close-residual-pipeline-efficiency-gaps"
pass: first
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-28"
---

# Phase 45 — Validation Strategy (first pass)

This is a planning contract only. No implementation tests were run or marked green.

## Test infrastructure

- Tests are plain Node CommonJS, using `tests/unit/assert-harness.cjs` or `node:test`, plus bash smokes under `tests/smoke/`. `tests/unit/run.sh` discovers `*.test.cjs`.
- Each plan names narrow `node`/`bash` commands scoped to its `files_modified`. They are plain argv with no shell syntax (`plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:351-354`).
- `make test-fast` runs in CI and at the phase gate.
- Tests are hermetic: `os.tmpdir()` realpathed, temporary `CLAUDE_HOME`/`CODEX_HOME`/`HOME`/`XDG_STATE_HOME`, and no wall-clock lease comparisons.
- Every change is committed failing first (RED).

The design-time map is in `45-RESEARCH.md` "Validation Architecture". Its proposed REQ ids are superseded by the ids below (ROADMAP.md:420-431).

## Per-ticket verification map

| Ticket | Wave | Requirements | Type | Verification commands | Extra evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T-45-01 | 1 | REQ-185, REQ-186 | unit / git fixture / installed bundle · human checkpoint | `node tests/unit/stop-gate.test.cjs`; `node tests/unit/stop-gate-arm.test.cjs`; `node tests/unit/stop-gate-installed.test.cjs` | real-home reinstall + sha256 compare at checkpoint | pending |
| T-45-02 | 1 | REQ-187 | unit / smoke | `node --test tests/unit/host-provenance.test.cjs`; `bash tests/smoke/claude-hook-smoke.sh`; `node tests/unit/release-gate.test.cjs` | — | pending |
| T-45-03 | 2 | REQ-188 | unit / docs smoke | `node --test tests/unit/marketplace-installer.test.cjs`; `bash -n scripts/install-shipyard-codex.sh`; `bash tests/smoke/docs-smoke.sh` | — | pending |
| T-45-04 | 1 | REQ-189 | unit (injected clock) | `node tests/unit/codex-decompose-host.test.cjs` | 50-run loop, with and without CPU load, recorded in the commit/PR | pending |
| T-45-05 | 1 | REQ-189 | unit (IPC barriers) | `node tests/unit/session-handoff.test.cjs`; `node tests/unit/dispatch-boundary.test.cjs` | 50-run loop per suite recorded in the commit/PR | pending |
| T-45-06 | 1 | REQ-190 | unit / captured fixture | `node --test tests/unit/usage-report.test.cjs` | — | pending |
| T-45-07 | 1 | REQ-191 | unit / cross-process | `node --test tests/unit/planning-writer-lease.test.cjs` | — | pending |
| T-45-08 | 2 | REQ-191 | unit (stub runtimes) | `node --test tests/unit/claude-decompose-host.test.cjs`; `node --test tests/unit/codex-decompose-host.test.cjs`; `node --test tests/unit/planning-writer-lease.test.cjs` | — | pending |
| T-45-09 | 3 | REQ-192 | unit / captured-shape transcripts · human checkpoint | `node tests/unit/dispatch-boundary.test.cjs`; `node --test tests/unit/codex-decompose-host.test.cjs`; `node --test tests/unit/codex-runtime-host.test.cjs` | refusal-matrix review | pending |
| T-45-10 | 4 | REQ-192 | unit · human checkpoint | `node --test tests/unit/claude-decompose-host.test.cjs`; `node tests/unit/claude-runtime-host.test.cjs` | recovered-vs-live receipt comparison | pending |
| T-45-11 | 4 | REQ-193 | unit / contract | `node tests/unit/decompose-dispatch-wait-contract.test.cjs`; `node --test tests/unit/codex-decompose-host.test.cjs`; `node tests/unit/orchestration-overhead.test.cjs` | efficiency reported `inconclusive` | pending |
| T-45-12 | 1 | REQ-194 | unit / cross-process | `node --test tests/unit/capacity-lease.test.cjs` | — | pending |
| T-45-13 | 1 | REQ-195 | unit (stub dispatch) | `node tests/unit/workflows-args.test.cjs` | — | pending |
| T-45-14 | 1 | REQ-196 | unit / fixture scan | `node tests/unit/boundary-fixtures.test.cjs`; `node --test tests/unit/codex-decompose-host.test.cjs` | committed fixtures byte-unchanged | pending |

Sampling: every ticket has at least one automated command that fails on its own RED case. No wave has three consecutive tickets without one.

## Wave 0

- No framework installation is needed.
- New test files are created in each ticket's RED step:
  - `tests/unit/stop-gate-installed.test.cjs` (T-45-01);
  - `tests/unit/planning-writer-lease.test.cjs` (T-45-07);
  - `tests/unit/decompose-dispatch-wait-contract.test.cjs` (T-45-11).
- R9 reproduction (T-45-04 Scope 1, T-45-05 Scope 1) runs before GREEN and records the failing assertion.

## Not validated in this pass

- Real-home installs (`~/.claude`, `~/.codex`) are not readable in the sandbox; they are the T-45-01 human checkpoint.
- The `deliver.md` / `decompose.md` / `deliver-dispatch.cjs` caller wiring is second pass.
- Any efficiency effect is out of scope here and reported `inconclusive` (ADR-023 Consequences).
