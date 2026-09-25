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
| 41-04-2 | 1 | REQ-154 | unit / scoped contract | `node tests/unit/codex-delivery-host.test.cjs` | pending |
| 41-04-3 | 1 | REQ-154 | unit / scoped contract | `node tests/unit/codex-delivery-host.test.cjs && node tests/unit/delivery-commit-finalizer.test.cjs` | pending |
| 41-04-4 | 1 | REQ-154 | manual checkpoint | `node tests/unit/codex-delivery-host.test.cjs && node tests/unit/delivery-commit-finalizer.test.cjs` | pending |
| 41-05-1 | 1 | REQ-155 | unit / scoped contract | `node tests/unit/gsd-sync.test.cjs` | pending |
| 41-05-2 | 1 | REQ-155 | unit / scoped contract | `node tests/unit/gsd-sync.test.cjs && node tests/unit/gsd-sync-gate.test.cjs` | pending |
| 41-06-1 | 2 | REQ-156 | unit / scoped contract | `node tests/unit/usage-report.test.cjs` | pending |
| 41-06-2 | 2 | REQ-156 | unit / scoped contract | `node tests/unit/orchestration-overhead.test.cjs` | pending |
| 41-07-1 | 3 | REQ-151, REQ-152, REQ-153, REQ-154, REQ-155, REQ-156 | manual checkpoint | Human evidence review | pending |
| 41-07-2 | 3 | REQ-151, REQ-152, REQ-153, REQ-154, REQ-155, REQ-156 | unit / scoped contract | `node -e 'const fs=require("node:fs");const p=".planning/phases/41-reduce-pipeline-subscription-overhead/INTEGRATION.md";const s=fs.readFileSync(p,"utf8");for(const x of ["Head","Base","T-41-01","T-41-06","REQ-151","REQ-156","Verdict"])if(!s.includes(x))process.exitCode=1'` | pending |
| 41-07-3 | 3 | REQ-151, REQ-152, REQ-153, REQ-154, REQ-155, REQ-156 | manual checkpoint | `node -e 'const fs=require("node:fs");const s=fs.readFileSync(".planning/phases/41-reduce-pipeline-subscription-overhead/INTEGRATION.md","utf8");if(!/Verdict\|verdict/.test(s)\|\|!/ticket.set\|ticket_set/i.test(s)\|\|!/finding/i.test(s))process.exit(1)'` | pending |

## Wave 0

Existing test harnesses are present. Implementation tasks create or extend the
specified regression cases using RED/GREEN/REFACTOR. No new framework installation.
The timeout race belongs to T-41-04: test both parent and child verifiers through
the launcher; malformed, missing, duplicate or foreign completion evidence refuses.
The newly required cases remain pending until implementation.

## Manual-only verification

- T-41-01 and T-41-03: installed host/hook hashes, complete-prompt observations and actual model wake counts; source fixtures alone cannot prove installed behavior.
- T-41-02: owned explicit handoff, including collection/startup/cache-warmup observations.
- T-41-04: human review of exact candidate, signer/tree/receipt and gates; no stale green or automatic executor replay.
- T-41-06/07: matched runtime/model/effort/role cohorts with failures/recovery/unknown attribution retained. Existing 20-completion and 95% attribution criteria gate savings claims, not a verified functional fix. Insufficient observations mean inconclusive savings.
- T-41-07: independent integrator on the combined epic and human release gate.

## Sign-off

Task structure is checked separately in PLANNING-GATES.json. Execution coverage,
security behavior, latency and implementation outcomes remain pending. No risk
class is preauthorized by these plans. See each plan's threat_model for mitigation
and the corresponding negative cases.
