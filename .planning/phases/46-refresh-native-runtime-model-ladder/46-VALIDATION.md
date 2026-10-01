---
phase: "46"
slug: "refresh-native-runtime-model-ladder"
status: draft
nyquist_compliant: false
wave_0_complete: true
created: "2026-09-30"
---

# Phase 46 — Validation Strategy

All new-policy implementation, PR CI/review, package and native application results remain pending. Signed T-46-01 commit `1ca29f3658717efc8c212f6a5e81d33cfb2557f5` passed pre-commit under installed v6 Luna/max, but emitted no complete executor role files and has no PR, CI, review or new-model receipt. This ledger is outside the CONTEXT/PLAN seal and needs a separate operator SHA-256 check.

## Why the core must be atomic

`.github/workflows/test.yml:70` runs `make test-fast`; `Makefile:72` reaches `tests/unit/run.sh`, which runs every `tests/unit/*.test.cjs`. Former policy-only T-46-01 could not pass while 02/03 current-policy fixtures remained old, and those tickets could not start before 01 merged. All known current-policy fixtures therefore belong to revised T-46-01. Former T-46-02/03 are retired as executable plans and their scopes are included in 01; they were not executed. `marketplace-install.test.cjs:70-75` skips source-package freshness on ticket/epic bases, so T-46-05 can remain separate. Full CI still gates T-46-01 PR merge; no local full suite is authorized.

## Test infrastructure and scoped verification

Existing Node `node:test`, assert-harness and Bash isolated-home smoke are used. No dependency install or Wave 0 scaffold is needed. Commands below are ordinary plain argv. Run only the listed scoped commands locally; CI owns the full suite and review.

| Ticket | Focus | Automated command | Expected failing direction | Status |
|---|---|---|---|---|
| T-46-01 | Canonical matrix and capabilities | `node --test tests/unit/model-policy.test.cjs tests/unit/model-capability.test.cjs tests/unit/codex-agent.test.cjs tests/unit/codex-dispatch-adapter.test.cjs tests/unit/gen-codex-shipyard.test.cjs` | Old executor, fixer, research, reviewer or static role tuple and unsupported pair refuse | pending |
| T-46-01 | Codex current host/boundary/config | `node --test tests/unit/codex-decompose-host.test.cjs tests/unit/codex-runtime-host.test.cjs tests/unit/codex-delivery-host.test.cjs tests/unit/dispatch-boundary.test.cjs tests/unit/pipeline-config.test.cjs` | Old current-policy tuple, forged predecessor and copied reviewer override refuse; historical parser cases remain | pending; T-45-09 ownership barrier |
| T-46-01 | Claude current host/decomposition/research | `node --test tests/unit/claude-dispatch-adapter.test.cjs tests/unit/claude-runtime-host.test.cjs tests/unit/claude-decompose-host.test.cjs tests/unit/claude-delivery-host.test.cjs tests/unit/investigation-research.test.cjs` | Older pinned Sonnet, lower effort, foreign session and old current-role selection refuse | pending; T-45-10 ownership barrier |
| T-46-01 | Current instructions/source contract | `node --test tests/unit/source-contract.test.cjs tests/unit/workflows-args.test.cjs tests/unit/claude-instructions.test.cjs tests/unit/auto-route.test.cjs` | Old active grid in CLAUDE, commands, sentinel or managed route fails; historical prose stays labeled | pending |
| T-46-01 | Isolated source install | `bash tests/smoke/model-ladder-runtime-smoke.sh` | Old policy/manifest or altered agent refuses; fixture capabilities are not live proof | pending |
| T-46-04 | Exact supported grid | `node --test tests/unit/source-contract.test.cjs` | Old active tuple in the supported table fails; historical examples remain valid | pending |
| T-46-04 | Operator docs/runbook | `bash tests/smoke/docs-smoke.sh` | Broken documentation paths or missing required file fail | pending; independent matrix review required |
| T-46-05 | Package mirror and v6 attribution | `node --test tests/unit/marketplace-install.test.cjs tests/unit/usage-attribution.test.cjs` | Stale mirror fails on ticket/epic base; v6 history remains stale | pending |
| T-46-05 | Final isolated package install | `bash tests/smoke/model-ladder-runtime-smoke.sh` | New package/source/manifest mismatch or altered static agent refuses | pending |
| T-46-06 | Independent regression review | `node --test tests/unit/model-policy.test.cjs tests/unit/model-capability.test.cjs tests/unit/codex-dispatch-adapter.test.cjs tests/unit/claude-dispatch-adapter.test.cjs tests/unit/marketplace-install.test.cjs` | Any old-grid, mismatch or package drift remains visible | pending |
| T-46-06 | Authentic native evidence | `node --test tests/unit/codex-dispatch-adapter.test.cjs tests/unit/claude-dispatch-adapter.test.cjs` | Fixture passes cannot replace host-owned same-session receipt; missing real pair becomes HOLD | pending |

## Native integration barriers

1. Before T-46-01 resume, reconcile `dispatch-boundary.test.cjs` with active T-45-09/PR369 and `claude-decompose-host.test.cjs` with active T-45-10. The coordinator records owner approval and actual reviewed merge/base ancestry. `pr-open` alone fails the barrier. No active owner checkout/controller edit is authorized. Do not publish the private PR369 transport proposal.
2. T-46-01 executor writes full `.shipyard-pr-body.md` and `.shipyard-evidence.md` itself with signed reuse, actual scoped command exits and downstream pending state; the trusted finalizer creates the receipt/commit and sealed artifact. Old missing files are not invented or retroactively attributed.
3. Before T-46-05 worktree preparation, state-sync and fetch the phase epic. Require real merged T-46-01 and T-46-04 PRs and prove each merge SHA is an ancestor of the refreshed effective package base; check every required parent output there. Merely branched/actionable or locally merged parents fail. Record exact state generation, base/merge SHAs and command exit codes.
4. Before epic/default acceptance, source and copied `plugins/shipyard/` bytes, package digest/version, isolated installed manifest and Claude plugin provenance must agree. Current T-46-01 PR may temporarily omit package projection because the ticket/epic test explicitly skips freshness; final acceptance may not.

## Native rollout proof and HOLD

T-46-06's automatic task attempts each distinct new pair through an authorized canonical role with real ticket/PR/complexity evidence: Codex Sol 6.1 low/high/xhigh; Claude Sonnet 5.5 low/medium/high/xhigh and Opus 5.5/high. It records current policy hash, source/package/installed provenance, exact same-session requested/applied/observed model and effort, dispatch/session IDs and durable receipt reference. Unknown entitlement, missing authentic signal, alias/older model, effort downgrade, foreign session or missing Claude installed provenance is a specific HOLD. No synthetic repair predecessor, model list, fixture or unsealed report is accepted. The unchanged Luna/medium sentinel and Fable window are regression checks. Only after automatic collection and independent review does the single T-46-06 operator checkpoint decide activation or HOLD. Old-policy in-flight runs retain their original ownership and evidence; D6 outer coordination remains separate.

## Requirement/source audit

| Source | Item | Owner | Status |
|---|---|---|---|
| GOAL | Exact pinned native ladder, generation, installation and observed application | 01, 04-06 | COVERED |
| REQ | P46-A Codex role matrix and identity | 01, 04, 06 | COVERED |
| REQ | P46-B Claude role matrix and native pair compatibility | 01, 04, 06 | COVERED |
| REQ | P46-C version/hash, adapters, generated roles, receipt and history | 01, 05, 06 | COVERED |
| REQ | P46-D isolated install, provenance and rollback | 04-06 | COVERED |
| REQ | P46-E scoped regression, independent review, honest outcome | 01, 04-06 | COVERED |
| RESEARCH | Shared policy source, adjacent repair, pinned exact-match, source generator | 01 | COVERED |
| RESEARCH | Package mirror, isolated installed identity, historical v6 classification | 05 | COVERED |
| RESEARCH | Unknown account entitlement and installed Claude provenance | 06 | COVERED |
| CONTEXT | Locked P46-A, P46-B, P46-C, P46-D, P46-E | 01, 04-06 | COVERED |

Context-deferred executor failure promotions, D6 activation and economy cohorts remain excluded. Original 02/03 scopes are preserved privately as historical plans; no active canonical task depends on them.

## Sign-off

- [ ] T-45-09/10 owner barrier resolved and recorded before core edit.
- [ ] T-46-01 scoped checks, authentic role files, CI and independent review pass before merge.
- [ ] T-46-05 parent ancestry and complete package equality are recorded.
- [ ] T-46-06 independently reviews actual source/package and records exact live receipts or explicit HOLD before operator decision.
- [ ] Operator verifies this ledger's separate SHA-256 and decides active rollout or HOLD.

**Approval:** pending
