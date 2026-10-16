# Launch and upgrade verification record (ADR-030 L-11, REQ-203)

Opened by T-50-06 against `be7ab4f3` (v0.72.2). Each section ends in `closed`, `limitation` or `pending (T-50-NN)`.
T-50-27 closes every pending entry and tightens the contract test to forbid `pending`.

## Pin-reader audit

Status: pending (T-50-27)
Evidence: not started here; needs the adoption design of T-50-04. Starting point: `grep -n "ARCHIVE_AUTHORITY_INVALID" plugins/delivery-pipeline/scripts/role-artifact.cjs` (pin checks at lines 968-975 in `role-artifact.cjs`).

## catalogue.lock under pid reuse

Status: pending (T-50-08)
Evidence: static reading of `plugins/delivery-pipeline/scripts/role-artifact.cjs:4002-4026` (`withArchiveAuthorityLock`) and `plugins/delivery-pipeline/scripts/lock.cjs:48,59,310-396`. The function reads `catalogue.lock/owner.json`, and when `owner.pid` passes `process.kill(pid, 0)` it fails at once with `ARCHIVE_AUTHORITY_BUSY` ("archive catalogue lock has a live owner"); the TTL takeover in `lock.cjs` is never consulted for a live pid. An owner whose pid was reused by an unrelated live process therefore holds the lock until that process exits. T-50-08 characterises and bounds it.

## Legacy schema marker and version

Status: pending (T-50-04)
Evidence: `grep -n "role-archive-catalogue" plugins/delivery-pipeline/scripts/*.cjs` finds the label `shipyard.role-archive-catalogue.v1` only at `role-artifact.cjs:1065` (default payload) and `:1074` (schema check); that label was kept when pins were added, so it cannot distinguish pre-pin from pinned catalogues. T-50-04 defines the separate versioned legacy field.

## Run-store and lease ordering during adoption

Status: pending (T-50-09)
Evidence: call order read from source.
- Codex delivery host (`codex-delivery-host.cjs`): with `gsd_role`, `assertNoLegacyPlanningWriter` and `writerLease.acquire` (3468-3480); then `createRunController` (3482) and `controller.begin(run)` (3504); `recordInflight` (3523). On failure `finishDeliveryRun` (3401-3420) calls `controller.fail` then `controller.release`. The writer lease is taken before the controller begins.
- Claude delivery host (`claude-delivery-host.cjs`): `createRunController` then `controller.begin(scope)` (1137), then `recordInflight` (1147).
- Claude role host (`claude-role-host.cjs`): `controller.begin(scope)` (1454), then `recordInflight` (1463).
- `recordInflight` is in `dispatch-record.cjs:1536`; the catalogue lock is taken inside `role-artifact.cjs` publication functions (`withArchiveAuthorityLock` call sites, e.g. 1218, 1806), so it is acquired after `controller.begin` and nothing orders it against the run-store lease. T-50-09 adds the ordering test for adoption.
Commands: `grep -nE "controller\.begin|recordInflight|withArchiveAuthorityLock" plugins/delivery-pipeline/scripts/{claude-delivery-host,claude-role-host,codex-delivery-host,role-artifact}.cjs`.

## Claude launch without CLAUDE and SHIPYARD variables

Status: pending (T-50-23)
Evidence: `grep -nE "CLAUDE_HOME|CLAUDE_CONFIG_DIR" plugins/delivery-pipeline/scripts/*.cjs` shows `CLAUDE_CONFIG_DIR` read in `claude-decompose-host.cjs:362,615,701`, `claude-runtime-host.cjs:363,371` and `role-artifact.cjs:3066`, each with a `~/.claude` fallback. `CLAUDE_HOME` has no reader in the scripts directory: its single mention is a comment at `runtime-context.cjs:82`. `CLAUDE_HOME` is read only by shell installers (`scripts/ensure-gsd-core.sh:352,359`, `scripts/install-shipyard-capability.sh:34`). The end-to-end launch measurement is T-50-23's.

## .git/info/exclude writer and fresh clone

Status: pending (T-50-24)
Evidence: search `grep -rn "info/exclude" plugins scripts capabilities tests` returns one hit, `tests/live/live-round.sh:159` (a test fixture moving a prepared file into place, line 154 writes `.planning/` and `.shipyard/`). No writer in `plugins/`, `scripts/` or `capabilities/`; `grep -n "exclude" plugins/delivery-pipeline/scripts/*.cjs` finds only `--exclude-standard` reads (`claude-role-host.cjs:1203`, `planning-result-sealer.cjs:552`). In this checkout `git check-ignore -v .planning/graph/provenance/x .planning/graph/runs/x` reports both ignored by `.git/info/exclude` lines 10 and 11, so those entries are local and hand-made. A fresh clone does not contain them: provenance and runs directories are untracked-and-absent, while `.planning/graph/dispatches.json` is tracked (`git ls-files .planning/graph/dispatches.json`) and byte-pinned after the first trusted mutation. Conclusion: adoption must not depend on any exclude entry (ADR-020 line 35 forbids exclude writes). T-50-24 measures again.

## Reusable GSD preflight

Status: limitation
Evidence: the host and installers resolve GSD core under the runtime home: `scripts/ensure-gsd-core.sh:352-366` (`CORE="$HOME_DIR/gsd-core"`), `scripts/install-shipyard-capability.sh:34-35` (`.../gsd-core/bin/gsd-tools.cjs`), `claude-decompose-host.cjs:94` (`<configRoot>/gsd-core`), `runtime-context.cjs:128` (`GSD_CORE_HOME` marker `.gsd-runtime`) and `gsd-agent-root.cjs` (plugin cache under `<config>/plugins/cache`). `grep -in "doctor\|preflight" scripts/ensure-gsd-core.sh` returns nothing. The installed GSD core lives under the user's home directory, which the execution sandbox denies for reading, so whether it exposes a doctor or preflight verb could not be read: blocked read is any path under `~/.claude/gsd-core` and `~/.codex/gsd-core` (the `ls` of those directories was refused). Decision: do not reuse; Shipyard preflight stays self-contained and checks only what a host needs (bundle, manifest, capability digest, authority state), avoiding a dependency on an unverified GSD verb.
Candidate roots: ${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}/gsd-core; ${CODEX_HOME:-$HOME/.codex}/gsd-core; ${GSD_CORE_HOME}

## Upgrade, downgrade, upgrade

Status: pending (T-50-27)
Evidence: not measured here; needs the adoption record of T-50-04 and the release checklist.

## Snapshot staleness reporting

Status: pending (T-50-12)
Evidence: not started here; T-50-12 reports snapshot staleness against the installed Codex CLI in preflight (ADR-030 L-3).

## UI-smoke driver check

Status: pending (T-50-25)
Evidence: not started here; T-50-25 examines the Candidate roots above for a non-interactive driver of `gsd-ui-phase` then `gsd-ui-review`, and T-50-27 closes this section from its record (ADR-030 L-10).
