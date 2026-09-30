---
phase: "46"
slug: "refresh-native-runtime-model-ladder"
status: draft
nyquist_compliant: false
wave_0_complete: true
created: "2026-09-30"
---

# Phase 46 — Validation Strategy

> Execution ledger only. All results below are pending; the v6 baseline run in research does not attest ADR-024. This file is outside the CONTEXT/PLAN seal and needs a separate operator SHA-256 check.

## Test Infrastructure

| Property | Value |
|---|---|
| Framework | Existing Node `node:test` unit files and Bash isolated-home smoke |
| Config file | No new test config; existing `.planning/config.json` is an implementation input for T-46-01/02 |
| Quick run command | Each task's scoped command in the map below |
| Combined phase command | `node --test tests/unit/model-policy.test.cjs tests/unit/model-capability.test.cjs tests/unit/codex-agent.test.cjs tests/unit/codex-dispatch-adapter.test.cjs tests/unit/gen-codex-shipyard.test.cjs tests/unit/claude-dispatch-adapter.test.cjs tests/unit/claude-runtime-host.test.cjs tests/unit/auto-route.test.cjs tests/unit/marketplace-install.test.cjs tests/unit/usage-attribution.test.cjs` |
| Isolated install command | `bash tests/smoke/model-ladder-runtime-smoke.sh` |
| Estimated runtime | Measure during execution; no duration is claimed here |

## Sampling Rate

- After each task commit, run its scoped map command and record exit status and relevant assertions.
- After policy/test wave, run the combined phase command on the integrated branch; after package wave, run the isolated install smoke.
- Before verification, require the scoped tests, package provenance, independent review and automatic native evidence collection; HOLD any unavailable live pair.
- Do not widen to `make test` or the whole repository suite for this phase ledger.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure behavior and failing direction | Test type | Automated command | File exists | Status |
|---|---:|---:|---|---|---|---|---|---|---|
| 46-01-01 | 01 | 1 | P46-A/B/C | T-46-01/02 | Old Codex executor or rolling Claude base tuple must fail exact pair/hash assertions | unit | `node --test tests/unit/model-policy.test.cjs` | Yes | pending |
| 46-01-02 | 01 | 1 | P46-A/B/C/E | T-46-01/02 | Wrong rung, stale fingerprint, unsupported pair and old repair predecessor refuse; copied reviewer overrides are absent | unit/source contract | `node --test tests/unit/model-policy.test.cjs tests/unit/model-capability.test.cjs` | Yes | pending |
| 46-02-01 | 02 | 2 | P46-A/C/E | T-46-04 | Native model/effort mismatch, missing observation, forged predecessor and either reintroduced reviewer override refuse | unit | `node --test tests/unit/codex-agent.test.cjs tests/unit/codex-dispatch-adapter.test.cjs` | Yes | pending |
| 46-02-02 | 02 | 2 | P46-A/C/E | T-46-03 | Stale manifest, old Sol ID or tampered generated agent fails | unit | `node --test tests/unit/gen-codex-shipyard.test.cjs` | Yes | pending |
| 46-03-01 | 03 | 2 | P46-B/C/E | T-46-05/06 | Older Sonnet, lower effort, foreign session and absent transcript refuse | unit | `node --test tests/unit/claude-dispatch-adapter.test.cjs` | Yes | pending |
| 46-03-02 | 03 | 2 | P46-B/C/E | T-46-05/06 | Pinned Sonnet must take exact host match; rolling alias must not attest pinned ID | unit | `node --test tests/unit/claude-runtime-host.test.cjs` | Yes | pending |
| 46-04-01 | 04 | 17 | P46-A/B/C | T-46-07/08 | Managed route/decompose exact tuple test fails for old Sol ID or obsolete Luna/max | unit/source contract | `node --test tests/unit/auto-route.test.cjs` | Yes | pending |
| 46-04-02 | 04 | 17 | P46-A/B/C/D/E | T-46-07/08 | Supported grid assertion fails for Claude old judgment tuple; docs paths remain valid | unit/docs smoke | `node --test tests/unit/auto-route.test.cjs` | Yes | pending |
| 46-05-01 | 05 | 18 | P46-C/D/E | T-46-10/11 | v6 history stays stale; isolated installer rejects mismatched identity | unit/smoke | `node --test tests/unit/usage-attribution.test.cjs` | Yes | pending |
| 46-05-02 | 05 | 18 | P46-C/D/E | T-46-09/11 | Stale mirror, missing parent merge ancestry or missing source blocks package; install remains isolated | unit/smoke | `node --test tests/unit/marketplace-install.test.cjs` | Yes | pending |
| 46-06-01 | 06 | 19 | P46-A..E | T-46-12/14 | Independent review and package/hash checks reject unsupported native evidence | scoped unit | `node --test tests/unit/model-policy.test.cjs tests/unit/model-capability.test.cjs tests/unit/codex-dispatch-adapter.test.cjs tests/unit/claude-dispatch-adapter.test.cjs tests/unit/marketplace-install.test.cjs` | Yes | pending |
| 46-06-02 | 06 | 19 | P46-A..E | T-46-12/13 | Host-owned exact pair receipt or explicit HOLD; older alias, effort downgrade and missing same-session proof refuse | scoped unit plus live host evidence | `node --test tests/unit/codex-dispatch-adapter.test.cjs tests/unit/claude-dispatch-adapter.test.cjs` | Yes | pending |
| 46-06-03 | 06 | 19 | P46-A..E | T-46-13/14 | Operator decision follows collected proof and records approval or HOLD without active-home mutation | isolated smoke plus human checkpoint | `bash tests/smoke/model-ladder-runtime-smoke.sh` | Yes | pending |

The source-contract tests and host observations are distinct: fixture-based unit tests cannot turn a missing live pair into a pass. T-46-05's coordinator prelaunch gate runs `node /Users/serhii/.codex/shipyard/scripts/state-sync.cjs`, `gh pr view <PR> --json state,baseRefName,mergeCommit`, and `git merge-base --is-ancestor <merge-oid> <effective-base-sha>` for each parent before package worktree preparation. Record the actual command outputs; current status is pending.

## Requirement and Threat Coverage

| Requirement | Main proof | Negative/failing direction |
|---|---|---|
| P46-A | 01/02 policy and Codex dynamic/static tests; 06 native Sol low/high/xhigh receipts | Old Sol ID, obsolete Luna/max baseline, unsupported pair, reviewer override |
| P46-B | 01/03 Claude policy/host tests; 06 native Sonnet low/medium/high/xhigh and Opus/high receipts | Older Sonnet alias, effort downgrade, foreign session, absent entitlement |
| P46-C | 01 new hash/predecessors, 02/03 receipt refusal, 05 old history | Forged predecessor, stale manifest, missing native observation |
| P46-D | 04 exact guidance, 05 isolated package/smoke, 06 provenance/rollback | Package mirror drift, foreign installed plugin, active-home mutation |
| P46-E | 01-05 focused regression, 06 independent review and operator decision | Fixture/model list or unsealed report presented as live proof |

## Wave 0 Requirements

Existing `node:test` and Bash smoke infrastructure and every named test file are present. No new framework, stub or Wave 0 task is required. New exact-grid and reviewer compatibility assertions are implementation work in their owning tickets.

## Manual-Only Verifications

| Behavior | Requirement | Why manual | Instructions |
|---|---|---|---|
| Final active rollout or HOLD | P46-D/E | Operator controls active installation | Review 46-ROLLOUT-EVIDENCE.md only after auto collection and independent review; check each real receipt or HOLD, installed provenance, old-policy in-flight ownership and rollback target. |

## Validation Sign-Off

- [ ] Every task's scoped automated command has an execution result recorded.
- [ ] Exact-grid/source-contract tests have a demonstrated failing old-tuple direction.
- [ ] T-46-05 parent merge ancestry and effective base proof is recorded before package preparation.
- [ ] Isolated native receipts or explicit HOLD exist for every distinct new pair; installed Claude provenance is checked.
- [ ] Independent review and operator decision are recorded; no approval is presumed.
- [ ] Operator separately verifies this file's SHA-256 outside the CONTEXT/PLAN seal.

**Approval:** pending
