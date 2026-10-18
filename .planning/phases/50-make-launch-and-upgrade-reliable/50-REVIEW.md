---
phase: 50-make-launch-and-upgrade-reliable
reviewed: 2026-10-18T00:00:00Z
depth: deep
iteration: 4
scope: "git diff 3d5c385c...b8b20168 (44 fix commits of review rounds 1-3), excluding plugins/shipyard and .planning"
files_reviewed: 51
files_reviewed_list:
  - README.md
  - docs/audits/phase50/launch-upgrade-verification.md
  - plugins/delivery-pipeline/scripts/architecture-target.cjs
  - plugins/delivery-pipeline/scripts/claude-decompose-host.cjs
  - plugins/delivery-pipeline/scripts/claude-delivery-host.cjs
  - plugins/delivery-pipeline/scripts/claude-investigation-host.cjs
  - plugins/delivery-pipeline/scripts/claude-role-host.cjs
  - plugins/delivery-pipeline/scripts/codex-agent.cjs
  - plugins/delivery-pipeline/scripts/codex-decompose-host.cjs
  - plugins/delivery-pipeline/scripts/codex-delivery-host.cjs
  - plugins/delivery-pipeline/scripts/codex-model-remap.cjs
  - plugins/delivery-pipeline/scripts/codex-notify.cjs
  - plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs
  - plugins/delivery-pipeline/scripts/codex-runtime-host.cjs
  - plugins/delivery-pipeline/scripts/deliver-dispatch.cjs
  - plugins/delivery-pipeline/scripts/dispatch-boundary.cjs
  - plugins/delivery-pipeline/scripts/dispatch-record.cjs
  - plugins/delivery-pipeline/scripts/gsd-tune.cjs
  - plugins/delivery-pipeline/scripts/planning-result-sealer.cjs
  - plugins/delivery-pipeline/scripts/refusal-hints.cjs
  - plugins/delivery-pipeline/scripts/role-artifact.cjs
  - plugins/delivery-pipeline/scripts/runtime-context.cjs
  - plugins/delivery-pipeline/scripts/session-observer.cjs
  - tests/smoke/docs-smoke.sh
  - tests/smoke/installed-launch/lib.cjs
  - tests/smoke/installed-launch/scenario-claude-no-env.cjs
  - tests/smoke/installed-launch/scenario-ui-smoke.cjs
  - tests/unit/architecture-target.test.cjs
  - tests/unit/archive-lock-liveness.test.cjs
  - tests/unit/claude-decompose-host.test.cjs
  - tests/unit/claude-delivery-host.test.cjs
  - tests/unit/claude-role-host.test.cjs
  - tests/unit/codex-agent.test.cjs
  - tests/unit/codex-decompose-host.test.cjs
  - tests/unit/codex-delivery-host.test.cjs
  - tests/unit/codex-planning-context-host.test.cjs
  - tests/unit/codex-runtime-host.test.cjs
  - tests/unit/configure-codex-notify.test.cjs
  - tests/unit/deliver-dispatch.test.cjs
  - tests/unit/dispatch-boundary.test.cjs
  - tests/unit/dispatch-record.test.cjs
  - tests/unit/gsd-tune.test.cjs
  - tests/unit/host-preflight.test.cjs
  - tests/unit/host-single-hint.test.cjs
  - tests/unit/launch-environment.test.cjs
  - tests/unit/legacy-bookkeeping-adoption.test.cjs
  - tests/unit/planning-result-sealer.test.cjs
  - tests/unit/refusal-hints.test.cjs
  - tests/unit/session-observer.test.cjs
  - tests/unit/subject-contract.test.cjs
  - tests/unit/ui-smoke-record.test.cjs
findings:
  critical: 0
  warning: 8
  info: 6
  total: 14
status: issues_found
---

# Phase 50: Code Review Report (iteration 4)

**Reviewed:** 2026-10-18
**Depth:** deep
**Files Reviewed:** 51
**Status:** issues_found

## Summary

Scope was the 44 fix commits since `3d5c385c`. All 24 touched unit-test files and the docs smoke and the installed-launch smoke pass at `b8b20168` (run locally), so every finding below is a defect the existing tests do not catch; several are pinned by a test that was edited to match the new behaviour.

No data-loss or authentication defect was found in the security-sensitive changes. I checked these specifically and found them sound: `provenanceInert` (names match the real `writeAtomic` temp `.<id>.json.<pid>.<uuid>.tmp.tmp-<pid>` and the staging name, `lstat().isFile()` guard, never read), `protectedRecordsWithoutKey` (never re-keys), the catalogue error mapping, the lock `lstat` race handling, `verifySealedLine` `acceptedRepositories` (only widens to forms of the same worktree), `legacyRepositoryForms` path forms, the `\x7f` repository class (a single definition), and `ticketFromContext` (consistent with `run-contract.normalizeTicketIdentity`, which allows whitespace only for `phase=` subjects).

The weaknesses are in the hint and preflight layer: a literal placeholder fallback that renders a non-existent command, hint codes that disagree with the real cause, preflights that report "ok" for launches that then refuse, and one inter-host inconsistency.

## Warnings

### WR-01: a hint rendered without a host prints the command `.../scripts/the host script --preflight`

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs:187` (fallback), callers `plugins/delivery-pipeline/scripts/gsd-tune.cjs:804` and `plugins/delivery-pipeline/scripts/session-observer.cjs:302-303` (reached from `codex-notify.cjs:28-29`)
**Issue:** `TOKEN_FALLBACKS.host` is the literal `'the host script'`. `hintForError` was fixed to avoid it, but `formatHint` still substitutes it, and two of the new refusal channels call `formatHint(error.code, error.vars)` with no `host`. `BUNDLE_MANIFEST_INVALID` and `CAPABILITY_EVIDENCE_STALE` (raised by `resolveHostEnvironment` with no vars) both contain `node {bundle}/scripts/{host} --preflight`. Reproduced on an installed fixture whose `codex-capabilities.json` was removed:

```
$ node codex-home/shipyard/scripts/gsd-tune.cjs --global --runtime codex --json   (blocker "why")
hint[CAPABILITY_EVIDENCE_STALE]: ... then run node /private/tmp/.../codex-home/shipyard/scripts/the host script --preflight.
$ node codex-home/shipyard/scripts/codex-notify.cjs '{"cwd":"..."}'   (stderr, every turn end)
hint[CAPABILITY_EVIDENCE_STALE]: ... node /private/tmp/.../scripts/the host script --preflight.
```
The tests that were meant to prevent this do not: `refusal-hints.test.cjs` "hintForError names a script only when it implements --preflight" only exercises `hintForError`; `host-preflight.test.cjs` "never leaves a raw placeholder" only asserts the absence of `{...}`, which the fallback satisfies; `gsd-tune.test.cjs` and `session-observer.test.cjs` assert the placeholder check only for `ENV_CONFLICT`, whose remedy has no `{host}`, and only assert the code for the stale case.
**Fix:** make the unspecified-host case produce the same prose as `hintForError` (move the `PREFLIGHT_COMMAND` to `DELIVERY_PREFLIGHT_PROSE` rewrite into `fillText`/`formatHint` so no caller can skip it), or at minimum give `TOKEN_FALLBACKS.host` a real default (`codex-delivery-host.cjs`) and have gsd-tune and session-observer pass `{ host: 'codex-delivery-host.cjs', ...error.vars }`. Add `assert.doesNotMatch(text, /the host script/)` to the placeholder test over every code, and a stale-evidence case to the gsd-tune and session-observer tests.

### WR-02: an ENV_CONFLICT in the Codex capability probe is reported as `RUNTIME_UNAVAILABLE`, and a test pins the wrong label

**File:** `plugins/delivery-pipeline/scripts/codex-runtime-host.cjs:196` (rethrow), `:3751-3756` and `:3761-3773` (CLI), `tests/unit/codex-runtime-host.test.cjs` (the "installed bundle resolves its own evidence ..." test, assertion `hint\[RUNTIME_UNAVAILABLE\]`)
**Issue:** Round 3 made `probeCodexRuntime` rethrow `ENV_CONFLICT` instead of reporting `capability_evidence_missing`. The `--capability-only` CLI catches it and prints `reason: "ENV_CONFLICT"`, but `emitProbeHint` maps every reason other than two capability strings to `RUNTIME_UNAVAILABLE`. Reproduced (installed fixture, `CODEX_HOME=/tmp/elsewhere`):

```
{"status":"unavailable","reason":"ENV_CONFLICT","detail":"... CODEX_HOME=/tmp/elsewhere disagrees with the Codex home ..."}
hint[RUNTIME_UNAVAILABLE]: The runtime this host needs is not reachable right now. — remedy: ... a missing CLI needs installing and authenticating ...
```
The user is told the CLI is unreachable when the cause is an environment disagreement with a precise remedy (`ENV_CONFLICT`). The unit test was edited from `RUNTIME_CAPABILITY_MISSING` to `RUNTIME_UNAVAILABLE`, which asserts the wrong label rather than the right one.
**Fix:** in `emitProbeHint` render a resolver code with its own hint and the error's vars, e.g. in the CLI catch call `formatHint(error.code, { host: 'codex-delivery-host.cjs', ...error.vars })` when `RESOLVER_CODES.includes(error.code)`; change the test to expect `hint[ENV_CONFLICT]` naming both values.

### WR-03: `writerPreflight` swallows the refusals it exists to surface, so preflight reports ok while the launch refuses; the Claude variant behaves the opposite way

**File:** `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:911-921` (and `codex-planning-context-host.cjs:318-322` which wraps it again), `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs:692-698`
**Issue:** The Codex `writerPreflight` wraps `phaseDirectory`, `defaultRunStoreDir` and `legacyPlanningWriterRoots` in one `try { ... } catch { return {}; }`. `legacyPlanningWriterRoots` throws `LEGACY_WRITER_STATE` (a `PREFLIGHT_CODES` member) for a symlink in the private Claude writer root, and `defaultRunStoreDir` throws `INVALID_STATE_DIR`. Both become `{}`, so `preflight()` never sees `gsdRole`, skips the "planning writer state" check, and adds no "not evaluated" note. Reproduced with a symlink under `~/.local/state/shipyard/claude-decompose/`: `writerPreflight(...)` returns `{}` while `legacyPlanningWriterRoots(...)` throws `LEGACY_WRITER_STATE: private Claude writer root has a symbolic link`. `--preflight` therefore prints `preflight: ok` and the real launch refuses. The Claude `writerPreflight` only guards `phaseDirectory`, and the inline spread in `codex-delivery-host.cjs:3512` has no guard at all; the same condition there escapes as a raw throw, so `--preflight` produces no report (read, not run). Three hosts, two behaviours. The launch side is confirmed: `codex-decompose-host.cjs:1369-1370` calls `assertNoLegacyPlanningWriter` with `legacyPlanningWriterRoots(...)` after the preflight, so the refusal does occur at launch.
**Fix:** catch only the `phaseDirectory` failure (no phase directory means the check genuinely does not apply). For the rest, either let `preflight()` run the root enumeration inside its `run('planning writer state', ...)` wrapper (pass the inputs `{ worktree, phase, repository, privateRoots }` instead of the computed `writerRoots`), or convert the caught error into a `note('not-evaluated', ...)`/finding. Use the same shape for both hosts.

### WR-04: `roleNeedsRepositoryIdentity` excludes `pr-sentinel`, but the Claude role host builds the repository identity for every role

**File:** `plugins/delivery-pipeline/scripts/runtime-context.cjs:555-560`, `plugins/delivery-pipeline/scripts/claude-role-host.cjs:182` (via `canonicalWorktree`, called for every role at `:904`), `tests/unit/host-preflight.test.cjs` ("refuses a path no identity subject can carry only for a launch that builds one")
**Issue:** `IDENTITY_ROLES` is `research, decomposition, integrator, arch-review`. In `claude-role-host.cjs`, `canonicalWorktree` calls `repositoryIdentity(worktree)` unconditionally and `prepareInvocation` calls `canonicalWorktree` for `arch-review`, `integrator` and `pr-sentinel`. Reproduced in a clean git repo under `.../semi;colon` with the runtime probe injected:

```
role=pr-sentinel  -> preflight: ok
                     THROWN REPOSITORY_IDENTITY_INVALID repository identity: path contains ";" or a control character
role=integrator   -> preflight: 1 incompatibilities / hint[REPOSITORY_IDENTITY_INVALID]
```
So a Claude pr-sentinel launch passes preflight and is then refused, which is exactly the false-green the `needsRepositoryIdentity` option was added to remove. The unit test asserts `launch('pr-sentinel').ok === true`, enshrining the wrong classification. (`host-single-hint.test.cjs` separately pins that `claude-role-host.cjs --preflight` with no request does not evaluate the identity; that is a deliberate contract and is not part of this finding.)
**Fix:** when a request names a role, the Claude role host should pass `needsRepositoryIdentity: true` for every one of its `ROLES` (all three call `canonicalWorktree`); keep `roleNeedsRepositoryIdentity` for the Codex delivery host, whose roles differ. Replace the `pr-sentinel` assertion with a per-host expectation.

### WR-05: `claude-decompose-host --preflight --request-file` throws instead of reporting for a repository path no launch can use; Codex reports it

**File:** `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs:757` (`canonicalRequest` before any preflight), `:128-133` (identity moved out of the `SCOPE_MISMATCH` wrapper)
**Issue:** `main()` calls `canonicalRequest(request)` before `launchPreflight`. With a `;` worktree path `canonicalRequest` now throws `REPOSITORY_IDENTITY_INVALID` (the wrapper that turned it into `SCOPE_MISMATCH` was removed in this round), so the `needsRepositoryIdentity: true` option passed on that path can never fire. Reproduced:

```
$ node claude-decompose-host.cjs --preflight --request-file req.json     (worktree .../semi;colon)
REPOSITORY_IDENTITY_INVALID: repository identity: path contains ";" or a control character
hint[REPOSITORY_IDENTITY_INVALID]: ...
exit 1
```
No `preflight:` header and no `shipyard.host-preflight.v1` JSON, contrary to README ("prints ... a `shipyard.host-preflight.v1` JSON result on stdout"). `codex-decompose-host.cjs --preflight` reports the same condition as a finding. `host-single-hint.test.cjs` omits `claude-decompose-host.cjs` from its identity cases, so this is untested.
**Fix:** in preflight-only mode run `launchPreflight(request.worktree, { needsRepositoryIdentity: true, stdout: process.stdout })` before `canonicalRequest`, or catch `REPOSITORY_IDENTITY_INVALID` around `canonicalRequest` there and turn it into the report. Add the host to the identity test list.

### WR-06: the Claude half of every "upgrade" remedy names `claude plugin install`, which is not the upgrade command

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs:7` (`UPGRADE`, interpolated into 8 remedies)
**Issue:** Round 3 made every upgrade remedy read `Claude: claude plugin install shipyard@shipyard; Codex: codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard`. The verified core: the Codex half names a marketplace refresh and then the add, while the Claude half has no refresh step, and the Claude CLI has dedicated verbs for this that the hint does not use: `claude plugin update <plugin>` ("Update a plugin to the latest version (restart required to apply)") and `claude plugin marketplace update [name]`; `install` is documented only as "Install a plugin from available marketplaces". I did not run `install` against an installed plugin, so whether it refreshes a stale copy is unverified; if it does not, a user following the hint hits the same refusal again. README documents `claude plugin install` only as first-time setup (`README.md:35-37`) and has no Claude upgrade instructions, so the hint is the only guidance. `host-preflight.test.cjs` "words a Claude-reachable remedy for both hosts" pins the exact string.
**Fix:** suggested wording, to be checked against the Claude CLI before adopting: `Claude: claude plugin marketplace update shipyard, then claude plugin update shipyard@shipyard (restart Claude Code); Codex: ...`. Update the pinning test and add the Claude upgrade steps to the README "Launch and upgrade" section. Hints reachable only on Codex (`ENV_CONFLICT`, `STALE_GENERATED_AGENT`) could keep the Codex half only.

### WR-07: `codex-agent.cjs select` reports a `CODEX_HOME` conflict with no remedy, while `--agent-dir` gets one

**File:** `plugins/delivery-pipeline/scripts/codex-agent.cjs:296-299` (`agentDir: agentDirFrom(flags)` evaluated in `main()` outside `selectAgent`'s catch), `:221-228`, `:336-354`
**Issue:** The remedy for `ENV_CONFLICT` is appended only inside `selectAgent`'s catch. `main()` evaluates `agentDirFrom(flags)` as an argument expression before `selectAgent` is entered, so a `HostEnvironmentError` from `resolveHostEnvironment` (the common case: `CODEX_HOME` disagrees) escapes without it. Reproduced on an installed fixture:

```
CODEX_HOME=/tmp/elsewhere codex-agent.cjs select executor
codex-agent: runtime-context: CODEX_HOME=/tmp/elsewhere disagrees with the Codex home .../codex-home of the installed bundle that is running
--agent-dir /tmp/elsewhere
codex-agent: --agent-dir=/tmp/elsewhere disagrees ... Either unset the variable, or reinstall into the named home (Claude: ...) so both agree.
```
The same conflict gets a remedy for one input and none for the other, and the remedy for the flag case says "unset the variable" although the offender is a flag. `codex-agent.test.cjs` covers the flag/option path only.
**Fix:** compute `agentDir` inside the `try` (pass `flags` and let `selectAgentInternal` resolve it; `options.agentDir` is already honoured there), or wrap the whole of `main()`'s resolution in the same repair mapping. Reword the `ENV_CONFLICT` remedy to "unset the variable or flag".

### WR-08: `RUNTIME_CAPABILITY_MISSING` raised by the Claude runtime host gets a Codex-capability remedy

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs` (`RUNTIME_CAPABILITY_MISSING`), thrown at `plugins/delivery-pipeline/scripts/claude-runtime-host.cjs:383-401`, `:709-710`, reached through the typed launch at `:734`
**Issue:** Round 3 rewrote this remedy around Codex capability evidence: "Installed bundle: its capability evidence is missing or stale ... Source checkout or direct installer run: point `SHIPYARD_CODEX_CAPABILITIES_FILE` at a capability evidence file ... If the runtime CLI itself reports an unsupported option, upgrade that CLI instead." The Claude runtime host raises the same code for a missing or invalid GSD agent definition (`gsdAgentDefinition`) and for an unsupported Claude model alias or effort. A Claude launch that fails this way prints, via the host's top-level `hintForError(error)`, `hint[RUNTIME_CAPABILITY_MISSING]` with a remedy about a Codex environment variable that has no meaning on that host, and nothing about reinstalling GSD or fixing the agent definition. I confirmed the rendered text and the throw sites by reading and by `hintForError({ code: 'RUNTIME_CAPABILITY_MISSING' }, 'claude-delivery-host.cjs')`; I did not drive a Claude launch to the failure end to end. `host-preflight.test.cjs` "words a Claude-reachable remedy for both hosts" only checks that the upgrade sentence is present for both hosts, not that the remainder applies.
**Fix:** give the Claude host its own code or sub-text (for example `GSD_AGENT_UNAVAILABLE`, remedy: reinstall the GSD plugin/runtime payload) or make the remedy host-conditional via `{host}`; keep the Codex wording on the Codex path only.

## Info

### IN-01: `ui-smoke` no longer checks the real environment, so the declared-gap record is justified by a check that cannot find a driver

**File:** `tests/smoke/installed-launch/scenario-ui-smoke.cjs:149-152` (`resolveFixtureRoots`), `README.md:219-222`
**Issue:** The security fix correctly stops executing a driver found under the process `HOME`, but the roots are now only `fixture.home` and `fixture.codexHome`. The first `GAP` record then always reports `absent` with `candidate_roots` inside the temp fixture, while README still says the target "first checks whether a non-interactive driver of the GSD UI path exists". The found-branch is now covered only by the stub driver the scenario writes itself. The `driver_check` carried by the real record proves nothing about the host.
**Fix:** reword the README sentence and the GAP reason to say the check is made against a hermetic fixture, or add a read-only discovery (existence of the verbs, no execution) against the real roots.

### IN-02: audit document line citations are stale at `b8b20168`

**File:** `docs/audits/phase50/launch-upgrade-verification.md:25,30`
**Issue:** The edit updated citations to `role-artifact.cjs:4195`, `:3960-3963`, `:3976-3980`, `:1089`, `refusal-hints.cjs:85-88`, but later commits moved them: `withArchiveAuthorityLock` is at `:4218`, the legacy constants at `:3978-3981`, the malformed-record refusal at `:4002`, the catalogue label at `:1098`/`:1114`, `ARCHIVE_AUTHORITY_BUSY` at `refusal-hints.cjs:87-90`. A reader following the evidence lands on unrelated code.
**Fix:** cite symbols (function names, test titles) rather than line numbers, or regenerate the numbers as the last step.

### IN-03: shared tables were introduced but not used by all consumers

**File:** `plugins/delivery-pipeline/scripts/runtime-context.cjs:568`, `plugins/delivery-pipeline/scripts/deliver-dispatch.cjs:28`, `plugins/delivery-pipeline/scripts/refusal-hints.cjs` (`PREFLIGHT_HOSTS`), `plugins/delivery-pipeline/scripts/conveyor-coverage.cjs:21`, `plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:358`
**Issue:** The runtime-to-delivery-host map exists twice (`DELIVERY_HOSTS` in `runtime-context.cjs`, re-declared inside `preflight()` on every call, and in `deliver-dispatch.cjs`) next to the third list `PREFLIGHT_HOSTS`. `GIT_SCOPE_KEYS` was exported from `architecture-target.cjs` and adopted by `codex-delivery-host.cjs`, but `conveyor-coverage.cjs` and `delivery-commit-finalizer.cjs` still carry their own copies of the same four keys. Adding a host or a scrubbed variable now needs several edits.
**Fix:** export one `DELIVERY_HOSTS` from `refusal-hints.cjs` (or `runtime-context.cjs`) and one git-scrub helper; consume them everywhere.

### IN-04: dead code left by the fixes

**File:** `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:3397,3481,3514`; `plugins/delivery-pipeline/scripts/role-artifact.cjs:1109`; `plugins/delivery-pipeline/scripts/codex-runtime-host.cjs:3755`
**Issue:** `runHostPreflight` now throws on any failing non-report preflight and returns `code: 0` otherwise, so `if (gate.code !== 0) return gate.result;` at `:3397` and `:3481`, and the `|| gate.code !== 0` at `:3514`, can never be true. `role-artifact.cjs:1109` repeats `!object(envelope.payload)` that the new check at `:1106` already made. `emitProbeHint` passes a `reason` token no remedy uses.
**Fix:** delete the unreachable conditions and the unused var.

### IN-05: `AMBIGUOUS_RUNTIME` remedy refers to a marker the "no active runtime" variant does not name

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs` (`AMBIGUOUS_RUNTIME`), `plugins/delivery-pipeline/scripts/runtime-context.cjs:230-233`
**Issue:** The remedy says "unset the conflicting runtime marker named in the finding detail", but `AMBIGUOUS_RUNTIME` is also raised with detail `no active runtime; project-config-legacy, CODEX_HOME and defaultRuntime are compatibility-only`, where there is no conflicting marker to unset; the sentence then points at nothing.
**Fix:** split into "if the detail names a conflicting marker, unset it; if it says no active runtime, run from a Claude or Codex session".

### IN-06: the Codex delivery host writes preflight warnings without `stripControl`

**File:** `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:3380-3384` (the `result.ok` branch of `runHostPreflight`)
**Issue:** `emitPreflight` now strips control characters from every detail so a value cannot forge a `preflight:` line (test "keeps a control character in a value from forging a preflight line"). The new quiet-success branch in `runHostPreflight` writes `preflight: warning[${warning.code}] ${warning.detail}` directly and bypasses that protection. Warning details today are file names bounded by `PROVENANCE_MEMBER_PATH` and CLI version strings, so the practical exposure is small, but the two paths now differ.
**Fix:** reuse the emitter's `clean` helper (`stripControl`) here, or route the warnings through `emitPreflight` with a no-op stdout.

---

_Reviewed: 2026-10-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
