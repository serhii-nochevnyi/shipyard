---
phase: "50"
slug: "make-launch-and-upgrade-reliable"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-15"
---

# Phase 50 — Validation Strategy

Derived mechanically and verbatim from the "Validation Architecture" section of `50-RESEARCH.md` (sha256 `31aa50f96e15dc87c31ae48904eea61e3673d9dc197980b2a9f498b54fad54dc`), the sealed output of the phase-50 `gsd-phase-researcher`. It adds no requirement of its own; per-ticket verification commands live in each PLAN.md and are scoped to its `files_modified`. Wave 0 files below do not exist yet; `wave_0_complete` stays false until the tickets that create them land.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` + `node:assert/strict`; shell smokes under `tests/smoke/` |
| Config file | none; shard weights `tests/unit/shard-weights.json` (default weight 5, `shard-files.cjs:10`) |
| Quick run command | `env -u CODEX_HOME -u SHIPYARD_CODEX_CAPABILITIES_FILE HOME="$(mktemp -d)" node tests/unit/<file>.test.cjs` (files that touch authority also override `os.homedir` in-test — `role-artifact.test.cjs:7-13`) |
| Full suite command | `make test-fast` (CI: `UNIT_SHARD=<i>/4 ./tests/unit/run.sh` + `make test-fast-rest`, `CLAUDE.md:39`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-197 | bundle self-location, digest, grid, conflict; child env | unit | `node tests/unit/launch-environment.test.cjs` | ❌ Wave 0 |
| REQ-197 | installed bundle launches with no env (Codex) | smoke | `./tests/smoke/installed-launch-smoke.sh codex` | ❌ Wave 0 |
| REQ-198 | adopt once; never pinned; changed/unknown block; no dir on refusal | unit | `node tests/unit/legacy-bookkeeping-adoption.test.cjs` | ❌ Wave 0 |
| REQ-198 | linked-worktree sidecar covered; collision refused | unit | `node tests/unit/dispatch-record.test.cjs` | ✅ extend |
| REQ-199 | one-pass findings, read-only; hints from every entry | unit | `node tests/unit/host-preflight.test.cjs`, `node tests/unit/refusal-hints.test.cjs` | ❌ / ✅ extend |
| REQ-199 | every entry calls preflight; `--capability-only` exits 0 | unit | `node tests/unit/host-entry-contract.test.cjs` | ❌ Wave 0 |
| REQ-200 | round-trip each subject family (space, non-ASCII, `;`, old `owner/repo`) | unit | `node tests/unit/subject-contract.test.cjs`, `node tests/unit/run-contract.test.cjs`, `node tests/unit/decomposition-adr.test.cjs` | ❌ / ✅ extend |
| REQ-201 | concurrent Codex + Claude incl. during adoption; live-owner refusal named | smoke + unit | `./tests/smoke/installed-launch-smoke.sh concurrent`, `node tests/unit/role-artifact.test.cjs` | ❌ / ✅ extend |
| REQ-202 | core scenarios + real state unchanged + UI gap record | smoke | `make test-installed-launch` (target name `[ASSUMED]`; add to `TEST_FAST_REST`, `Makefile:65`) | ❌ Wave 0 |
| REQ-203 | each L-11 item has evidence or a recorded limitation | unit + doc | `node tests/unit/role-artifact.test.cjs`; `docs/audits/<date>-launch-upgrade-verification.md` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the ticket's own test file(s) (scoped to `files_modified`).
- **Per wave merge:** `make test-unit` (+ `make test-docs` when `README.md` changes).
- **Phase gate:** `make test-fast` green, regenerated package on the epic, then live receipts on both runtimes at release (`make test-live`; `scripts/release.sh` requires them).

### Wave 0 Gaps
- [ ] `tests/unit/launch-environment.test.cjs` — REQ-197 (synthetic bundle builder; consider a shared helper because several tests need an installed-layout fixture — no helper module exists today: `tests/unit` has only `*.test.cjs`, `run.sh`, `shard-*`, `runtime-file-digests.json`)
- [ ] `tests/unit/legacy-bookkeeping-adoption.test.cjs` — REQ-198/201
- [ ] `tests/unit/host-preflight.test.cjs`, `tests/unit/host-entry-contract.test.cjs` — REQ-199
- [ ] `tests/unit/subject-contract.test.cjs` — REQ-200
- [ ] `tests/smoke/installed-launch-smoke.sh` + Makefile target — REQ-202 (fake `codex`/`claude`, isolated HOME/XDG/`SHIPYARD_GRAPH_DIR`)
- [ ] no framework install needed.
