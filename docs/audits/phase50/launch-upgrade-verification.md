# Launch and upgrade verification record (ADR-030 L-11, REQ-203)

Opened by T-50-06 against `be7ab4f3` (v0.72.2) and closed by T-50-27. Each obligation section ends in `closed` or `limitation`; the contract test forbids `pending`.

## Pin-reader audit

Status: closed
Evidence: `grep -rnE "historicalBookkeepingPins|bookkeeping_state|readProvenance|legacyBookkeepingMembers|legacy_bookkeeping" plugins/delivery-pipeline scripts --include='*.cjs' --include='*.mjs'` lists every reader. Adopted legacy members live only in the catalogue field `legacy_bookkeeping` (`role-artifact.cjs` `LEGACY_BOOKKEEPING_FIELD`); `historicalBookkeepingPins` returns `bookkeeping_state` (or the pre-pin `records[].bookkeeping`), which adoption never writes legacy paths into (`trustedBookkeepingMutation` builds `bookkeeping_state` from authenticated pins and `writtenPaths` only). `node --test tests/unit/legacy-pin-readers.test.cjs` passes 10/10 and fails if a new file starts reading any of these names.

| Reader | Location | Driven how | Result |
|---|---|---|---|
| `historicalBookkeepingPins` | `role-artifact.cjs` | directly, after real adoption through `recordInflight` | returns the store and authenticated sidecar only; no legacy path or sha256 |
| `legacyBookkeepingMembers` | `role-artifact.cjs` | directly | disjoint from the pins |
| `trustedBookkeepingMutation` | `role-artifact.cjs` | directly | published `bookkeeping_state` excludes legacy; a changed legacy member refuses `LEGACY_HISTORY_CHANGED` and the catalogue bytes are unchanged |
| `authenticateBookkeeping` | `dispatch-record.cjs` | through `recordInflight` (not exported) | pins after a second admission exclude legacy |
| `refuseLegacyCollision` | `dispatch-record.cjs` | through `recordInflight` | a dispatch id equal to a legacy sidecar refuses `LEGACY_HISTORY_COLLISION`, sidecar bytes unchanged |
| `readProvenance` | `dispatch-record.cjs` | directly | returns raw file content with no digest or authenticated flag; its only callers are the test `recordInflight writes a provenance sidecar once and never overwrites it` in `tests/unit/dispatch-record.test.cjs` and a stamp assertion in `tests/unit/claude-role-host.test.cjs`, none in `plugins/` |
| pin consumers in `codex-arch-review-context.cjs` | every call of `roleArtifact.historicalBookkeepingPins(` | at the shared accessor plus a source audit | the context builder cannot be run in isolation (it needs a live PR identity and a fetched base), so the assertion is at the accessor it calls twice (`roleArtifact.historicalBookkeepingPins(`), and the file references none of `legacy_bookkeeping`, `legacyBookkeepingMembers`, `classifyLegacyProvenance`, `bookkeeping_state` |

No reader treats a legacy member as authenticated, so `codex-arch-review-context.cjs` and its test were not changed.

## catalogue.lock under pid reuse

Status: limitation
Evidence: `withArchiveAuthorityLock` (`role-artifact.cjs`) refuses at once with `ARCHIVE_AUTHORITY_BUSY` only when `owner.json` names a live pid and the record is older than the lock TTL or has no readable time; `lock.cjs` TTL takeover is never consulted for that pid. A live owner with a fresh record is waited on for `ARCHIVE_LOCK_WAIT_MS` (5 s) and then refused as held. In `tests/unit/archive-lock-liveness.test.cjs`, `a live pid holding an owner record older than the lock TTL is refused at once without takeover` pins a live pid with a record older than the TTL as refused without takeover; `measurement: lock.cjs alone takes over a live pid whose record is older than the TTL` measures that `lock.cjs` alone would take it over; `a dead pid with a stale record is taken over exactly as before` pins a dead pid taken over as before. An owner record older than the TTL whose pid was reused by an unrelated live process therefore blocks until that process exits. The remedy is the named refusal: the `ARCHIVE_AUTHORITY_BUSY` entry of `refusal-hints.cjs` says to wait for the other session and that a process that reused a crashed owner's pid must end first. Accepted as a known limitation, not a hazard: the failure is a refusal, never a mutation.

## Legacy schema marker and version

Status: closed
Evidence: the catalogue label `shipyard.role-archive-catalogue.v1` is unchanged (`authorityState` in `role-artifact.cjs`) and the legacy block carries its own marker: `LEGACY_BOOKKEEPING_FIELD = 'legacy_bookkeeping'`, schema `shipyard.legacy-bookkeeping.v1`, version 1, status `historical-unverified` (`LEGACY_BOOKKEEPING_FIELD`, `LEGACY_BOOKKEEPING_SCHEMA`, `LEGACY_BOOKKEEPING_VERSION` and `LEGACY_STATUS` in `role-artifact.cjs`), asserted by `tests/unit/legacy-bookkeeping-adoption.test.cjs` ("constants are defined once and the catalogue label is unchanged"). A malformed block is `ARCHIVE_AUTHORITY_INVALID` (`legacyAuthoritySide`).

## Run-store and lease ordering during adoption

Status: closed
Evidence: `grep -nE "controller\.begin|recordInflight\(" plugins/delivery-pipeline/scripts/{claude-delivery-host,claude-role-host,codex-delivery-host}.cjs` gives `controller.begin` before `recordInflight` in each host: Claude delivery in `runClaudeDeliveryCli`; Claude role in `createClaudeRoleHost`; Codex delivery in `runCli` (the begin in `runResumeCli` is the finalization-recovery path, which does not admit a launch). Adoption runs inside `recordInflight` through `trustedBookkeepingMutation`, under the catalogue lock only. `node --test tests/unit/adoption-ordering.test.cjs` asserts that adoption and a refused adoption leave a populated run store and planning-writer root byte-identical and untouched (no read or write of either root) and that a refusal leaves no lock held.

## Claude launch without CLAUDE and SHIPYARD variables

Status: closed
Evidence: `bash tests/smoke/installed-launch-smoke.sh scenario-claude-no-env` printed `MEASURE: {"claudeVariablesSeen":["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"],"shipyardVariablesSeen":[],"configRoot":"<fixture home>/.claude","claudeHomeReaders":[],"terminal":"runtime-evidence"}` then `PASS scenario-claude-no-env`. The only `CLAUDE_*` variable the host process saw was the harness's own scrub marker; no `SHIPYARD_*` variable; the host reached the fake `claude` once and ended in the expected `RUNTIME_EVIDENCE_*` terminal. The scenario scans the staged scripts for `CLAUDE_HOME` outside comment lines and asserts `claudeHomeReaders` is empty. `CLAUDE_HOME` has no reader in the scripts directory (`grep -nE "CLAUDE_HOME|CLAUDE_CONFIG_DIR" plugins/delivery-pipeline/scripts/*.cjs`: `CLAUDE_CONFIG_DIR` readers have a `~/.claude` fallback; `CLAUDE_HOME` appears only in a comment in `runtime-context.cjs`). The Codex launch and the concurrent launch passed in the same run: `PASS scenario-codex-no-env` and `PASS scenario-concurrency` ("5 iterations codex/claude: reached/reached ×5; held-lock reached and refused"). The hermetic scenarios use fake CLIs; native evidence belongs to the live receipts below.

## .git/info/exclude writer and fresh clone

Status: closed
Evidence: `grep -rn "info/exclude" plugins scripts capabilities tests` finds no writer in `plugins/`, `scripts/` or `capabilities/` (only `tests/live/live-round.sh` writes a fixture); adoption must not depend on any exclude entry (ADR-020 forbids exclude writes). `bash tests/smoke/installed-launch-smoke.sh scenario-upgrade-history` printed `MEASURE: {"case":"fresh-clone","provenance_directory":true,"run_directory":false,"tracked_store":true}` and `PASS scenario-upgrade-history` (cases 1-7 and the Claude case). The linked-worktree case (`scenario-upgrade-history.cjs` case 3) launches first from a linked worktree, asserts the project history is adopted once (3 members), then asserts a launch from the project root reaches the CLI with the legacy block unchanged.

## Reusable GSD preflight

Status: limitation
Evidence: the host and installers resolve GSD core under the runtime home: `scripts/ensure-gsd-core.sh` (`CORE="$HOME_DIR/gsd-core"`), `scripts/install-shipyard-capability.sh` (the `GSD_TOOLS` paths ending `gsd-core/bin/gsd-tools.cjs`), `claude-decompose-host.cjs` (`<configRoot>/gsd-core` in the inlined references), `runtime-context.cjs` (`GSD_CORE_HOME` marker `.gsd-runtime`, read by `markerFromCoreHome`) and `gsd-agent-root.cjs` (plugin cache under `<config>/plugins/cache`). `grep -in "doctor\|preflight" scripts/ensure-gsd-core.sh` returns nothing. The installed GSD core lives under the user's home directory, which the execution sandbox denies for reading, so whether it exposes a doctor or preflight verb could not be read: blocked read is any path under `~/.claude/gsd-core` and `~/.codex/gsd-core` (the `ls` of those directories was refused). Decision: do not reuse; Shipyard preflight stays self-contained and checks only what a host needs (bundle, manifest, capability digest, authority state), avoiding a dependency on an unverified GSD verb.
Candidate roots: ${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}/gsd-core; ${CODEX_HOME:-$HOME/.codex}/gsd-core; ${GSD_CORE_HOME}

## Upgrade, downgrade, upgrade

Status: closed
Evidence: baseline `be7ab4f3` (v0.72.2) extracted with `git archive be7ab4f3 plugins/delivery-pipeline | tar -x -C <scratch>` outside the repository (the extracted `role-artifact.cjs` has 0 occurrences of `legacy_bookkeeping`). Each step is a separate `node --require <preload that sets os.homedir to one isolated HOME> step.cjs <scripts dir> <project> <step>` process on one scratch git project with three legacy sidecars `dispatch-0..2.json` in `.planning/graph/provenance/`; every step calls `trustedBookkeepingMutation(project, fn, [<one new provenance path>])`.
1. Upgrade (current code): `RESULT ok`; `legacy_bookkeeping` has 3 members, `adopted_at 2026-10-17T10:15:59.819Z`, `bookkeeping_state` is `[seed-id.json]`; catalogue sha256 prefix `1cb79c0059cc`.
2. Downgrade (baseline scripts, same HOME and project): `RESULT refused ARCHIVE_AUTHORITY_INVALID unknown host provenance member before trusted mutation`; catalogue sha256 prefix unchanged (`1cb79c0059cc` before and after); the legacy block (3 members, same `adopted_at`) and every sidecar hash (`dispatch-0.json:f3013f933b9f`, `dispatch-1.json:2bfd14f43d17`, `dispatch-2.json:363379742f80`, `seed-id.json:5b3c4aad23e7`) unchanged.
3. Control: the baseline run alone against a never-adopted project holding one legacy sidecar refuses with the identical code and message, so the downgraded host refuses a legacy-bearing project exactly as v0.72.2 always did.
4. Re-upgrade (current code): `RESULT ok`; `legacy_bookkeeping` still 3 members with the same `adopted_at` (no second adoption); `bookkeeping_state` gained `reupgrade-id.json`; legacy sidecar hashes unchanged. A further admission (`again`) also succeeded with the same `adopted_at` and legacy hashes.
Conclusion: a known limitation, not a hazard. After a downgrade the project is refused by the older host but nothing is altered, and the next upgrade works without another adoption. Operator remedy for a downgraded host: upgrade again; do not delete the legacy sidecars.

## Snapshot staleness reporting

Status: closed
Evidence: `plugins/delivery-pipeline/scripts/runtime-context.cjs` (the preflight check `capability snapshot age` inside `preflight`) compares the bundle manifest's `codex_cli_version` with the installed Codex CLI and, when they differ, adds a warning `CAPABILITY_SNAPSHOT_AGED` ("capability evidence was recorded with Codex CLI <recorded>; installed is <current>"); it is a warning and never a refusal, and it is skipped when the manifest records no version. The hint is the `CAPABILITY_SNAPSHOT_AGED` entry of `refusal-hints.cjs`. Recorded by T-50-12 (`dbb7ca2f`).

## UI-smoke driver check

Status: limitation
Evidence: `bash tests/smoke/installed-launch-smoke.sh scenario-ui-smoke` printed `GAP: {"scenario":"ui-smoke","commands":["gsd-ui-phase","gsd-ui-review"],"status":"declared-gap","reason":"the fixture GSD core carries no non-interactive driver for either command; this scenario checks only the driver-lookup plumbing against a fixture, and A7 on a real install is established by the release live receipt, not by this scenario","driver_check":{"status":"absent","candidate_roots":[...],"examined":[".../codex-home/gsd-core/bin/gsd-tools.cjs"],"verbs":[]}}` then `ui-smoke control: fixture stub driver ran 2 commands` and `PASS scenario-ui-smoke`. Environment that produced the record: the hermetic fixture, whose home and Codex home are scratch directories. The scenario reads GSD roots only from that fixture (`resolveFixtureRoots`), never from the operator's home or the process environment, so it can say nothing about the GSD install on the machine running it. What it does establish is the plumbing: the driver lookup classifies a missing, unreadable, absent or present driver correctly, and a stub driver placed in the fixture is found and run for both commands. Assumption A7 (no non-model driver exists in a real GSD install) is not established or refuted here; it is established by the release's live receipt, or by an explicit opt-in check of a real install, and stays open until one of them runs on a machine that has the GSD install and can read it.

## Release checklist: package regeneration

Status: checklist
Evidence: before the epic to main PR, regenerate the package once on the epic (`CLAUDE.md` rule): `make package-shipyard-codex`. Then confirm `git status --short plugins/shipyard` shows only generated output and commit it with the epic. Never edit generated files by hand.

## Release checklist: digest-pin conclusion

Status: checklist
Evidence: `git diff --stat be7ab4f3 HEAD -- tests/unit/runtime-file-digests.json plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs plugins/delivery-pipeline/scripts/runtime-adapters.cjs` prints nothing (exit 0): the pin file and both pinned files are unchanged by this phase, so `make refresh-runtime-digests` is not needed and `node scripts/check-runtime-digest-trailer.cjs` is run only if a pinned file changes before release. `role-artifact.cjs` and `dispatch-record.cjs` did change in this phase (`git diff --stat be7ab4f3 HEAD` on both: 259 insertions, 47 deletions) but they are not pinned.

## Release checklist: live receipts on both runtimes

Status: checklist
Evidence: from an installed bundle, in a shell with no exported `CLAUDE_*`, `SHIPYARD_*`, `CODEX_HOME` or similar variables, run `make test-live` (it runs `bash tests/live/live-round.sh --runtime claude` then `--runtime codex`). Attach both receipts to the epic to main PR. Hermetic scenarios use fake CLIs, so these receipts are the only measurement of native evidence on either runtime.

## Release checklist: assumption A3

Status: checklist
Evidence: A3 is that a Codex home without a Codex login is visible to the child. No hermetic test can observe it because every scenario uses a fake `codex`; the live receipt on the dogfood install is the only measurement and confirms or refutes it. Likewise A7 is not measured by the hermetic UI-smoke scenario (see the UI-smoke section); the release live receipt, or an explicit opt-in check of a real install, is the only measurement.

## Release checklist: Discrepancy D-1

Status: checklist
Evidence: CONTEXT.md and ADR-030 say that `role-artifact.cjs` and `dispatch-record.cjs` changes need `make refresh-runtime-digests`. `tests/unit/runtime-file-digests.json` pins only `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs`, so that statement does not match the pin (Discrepancy D-1 of 50-RESEARCH). Operator action: treat the digest refresh as required only when a pinned file changes; the check above is the conclusion for this phase. Correcting CONTEXT.md and ADR-030 is out of scope for T-50-27.
