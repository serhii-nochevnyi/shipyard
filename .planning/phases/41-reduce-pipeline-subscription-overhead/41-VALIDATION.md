---
phase: "41"
slug: "reduce-pipeline-subscription-overhead"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-25"
---

# Phase 41 — Validation Strategy

Planning contract only. No implementation tests were run or marked green.

## Test infrastructure

Existing Node.js CommonJS fixtures under tests/unit; each plan names narrow commands.
Use the individual task command below after each implementation task. At a wave
boundary run the touched plans' scoped commands; the integration plan verifies
combined evidence. No full repository suite is required during decomposition.
Latency is not yet measured; record it during execution rather than inventing it.

## Per-task verification map

| Task | Wave | Requirement | Type | Command / procedure | Status |
| --- | --- | --- | --- | --- | --- |
| 41-01-1 | 1 | REQ-151 | unit / scoped contract | `node tests/unit/claude-role-host.test.cjs` | pending |
| 41-01-2 | 1 | REQ-151 | unit / scoped contract | `node tests/unit/claude-role-host.test.cjs` | pending |
| 41-02-1 | 1 | REQ-152 | unit / scoped contract | `node tests/unit/session-handoff.test.cjs` | pending |
| 41-02-2 | 1 | REQ-152 | unit / scoped contract | `node tests/unit/session-handoff.test.cjs` | pending |
| 41-03-1 | 1 | REQ-153 | unit / scoped contract | `node tests/unit/phase41-stop-wake.test.cjs` | pending |
| 41-03-2 | 1 | REQ-153 | unit / scoped contract | `node tests/unit/phase41-stop-wake.test.cjs` | pending |
| 41-04-1 | 1 | REQ-154 | unit / scoped contract | `node tests/unit/codex-runtime-host.test.cjs` | pending |
| 41-05-1 | 1 | REQ-155 | unit / scoped contract | `node tests/unit/gsd-sync.test.cjs` | pending |
| 41-05-2 | 1 | REQ-155 | unit / scoped contract | `node tests/unit/gsd-sync.test.cjs && node tests/unit/gsd-sync-gate.test.cjs` | pending |
| 41-06-1 | 1 | REQ-156 | unit / scoped contract | `node tests/unit/usage-report.test.cjs` | pending |
| 41-06-2 | 1 | REQ-156 | unit / scoped contract | `node tests/unit/orchestration-overhead.test.cjs` | pending |
| 41-07-1 | 1 | REQ-151, REQ-152, REQ-153, REQ-154, REQ-155, REQ-156, REQ-157 | unit / scoped contract | `node tests/unit/phase-integrator-preflight.test.cjs` | pending |
| 41-07-2 | 1 | REQ-151, REQ-152, REQ-153, REQ-154, REQ-155, REQ-156, REQ-157 | unit / scoped contract | `node tests/unit/deliver-phase41-preflight-contract.test.cjs` | pending |
| 41-07-3 | 1 | REQ-151, REQ-152, REQ-153, REQ-154, REQ-155, REQ-156, REQ-157 | manual checkpoint | `node tests/unit/phase-integrator-preflight.test.cjs && node tests/unit/deliver-phase41-preflight-contract.test.cjs` | pending |
| 41-08-1 | 1 | REQ-157 | unit / scoped contract | `node tests/unit/state-sync-yaml.test.cjs` | pending |
| 41-08-2 | 1 | REQ-157 | unit / scoped contract | `node tests/unit/pre-push-gate.test.cjs` | pending |

## Wave 0

Existing test harnesses are present. Implementation tasks create or extend the
specified regression cases using RED/GREEN/REFACTOR. No new framework installation.
The timeout race belongs to T-41-04: test both parent and child verifiers through
the launcher; malformed, missing, duplicate or foreign completion evidence refuses.
The newly required cases remain pending until implementation.

## Manual-only verification

- T-41-01 and T-41-03: installed host/hook hashes, complete-prompt observations and actual model wake counts; source fixtures alone cannot prove installed behavior.
- T-41-02: owned explicit handoff, including collection/startup/cache-warmup observations.
- T-41-04 finalization recovery moved to T-42-01 (phase 42).
- T-41-06/07: matched runtime/model/effort/role cohorts with failures/recovery/unknown attribution retained. Existing 20-completion and 95% attribution criteria gate savings claims, not a verified functional fix. Insufficient observations mean inconclusive savings.
- Phase-level final gate: existing independent integrator on the merged epic and human release gate, after all ticket PRs merge. Before launch, on either runtime: ticket set built from every phase-41 graph ticket, one live merged PR per ticket, and `git merge-base --is-ancestor` of each merge commit against the pinned epic head; otherwise park. The Codex host does not enforce this yet (see CONTEXT.md).

## Sign-off

Task structure is checked separately in PLANNING-GATES.json. Execution coverage,
security behavior, latency and implementation outcomes remain pending. No risk
class is preauthorized by these plans. See each plan's threat_model for mitigation
and the corresponding negative cases.
