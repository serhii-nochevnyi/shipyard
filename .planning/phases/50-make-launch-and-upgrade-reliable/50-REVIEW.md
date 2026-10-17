---
phase: 50-make-launch-and-upgrade-reliable
reviewed: 2026-10-17T00:00:00Z
depth: deep
iteration: 3
files_reviewed: 37
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/runtime-context.cjs
  - plugins/delivery-pipeline/scripts/refusal-hints.cjs
  - plugins/delivery-pipeline/scripts/role-artifact.cjs
  - plugins/delivery-pipeline/scripts/architecture-target.cjs
  - plugins/delivery-pipeline/scripts/run-contract.cjs
  - plugins/delivery-pipeline/scripts/planning-result-sealer.cjs
  - plugins/delivery-pipeline/scripts/dispatch-record.cjs
  - plugins/delivery-pipeline/scripts/dispatch-boundary.cjs
  - plugins/delivery-pipeline/scripts/deliver-dispatch.cjs
  - plugins/delivery-pipeline/scripts/codex-delivery-host.cjs
  - plugins/delivery-pipeline/scripts/codex-decompose-host.cjs
  - plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs
  - plugins/delivery-pipeline/scripts/codex-runtime-host.cjs
  - plugins/delivery-pipeline/scripts/codex-agent.cjs
  - plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs
  - plugins/delivery-pipeline/scripts/codex-model-remap.cjs
  - plugins/delivery-pipeline/scripts/claude-delivery-host.cjs
  - plugins/delivery-pipeline/scripts/claude-role-host.cjs
  - plugins/delivery-pipeline/scripts/claude-decompose-host.cjs
  - plugins/delivery-pipeline/scripts/claude-runtime-host.cjs
  - plugins/delivery-pipeline/scripts/claude-investigation-host.cjs
  - plugins/delivery-pipeline/scripts/session-observer.cjs
  - plugins/delivery-pipeline/scripts/gsd-tune.cjs
  - scripts/gen-codex-shipyard.cjs
  - Makefile
  - README.md
  - CLAUDE.md
  - .github/workflows/test.yml
  - tests/smoke/claude-hook-smoke.sh
  - tests/smoke/docs-smoke.sh
  - tests/smoke/installed-launch-smoke.sh
  - tests/smoke/installed-launch/lib.cjs
  - tests/smoke/installed-launch/scenario-claude-no-env.cjs
  - tests/smoke/installed-launch/scenario-codex-no-env.cjs
  - tests/smoke/installed-launch/scenario-concurrency.cjs
  - tests/smoke/installed-launch/scenario-ui-smoke.cjs
  - tests/smoke/installed-launch/scenario-upgrade-history.cjs
findings:
  critical: 0
  warning: 6
  info: 4
  total: 10
status: issues_found
---

# Phase 50: Code Review Report (iteration 3)

**Reviewed:** 2026-10-17
**Depth:** deep
**Files Reviewed:** 37
**Status:** issues_found

## Summary

Reviewed `git diff origin/main...HEAD` at `02b29e12` in the epic-50-planning checkout, with the two earlier rounds' fixes treated as given. This round concentrated on interactions between the fixes and on regressions the fixes introduced.

Executed during review: `tests/smoke/installed-launch-smoke.sh` (all five scenarios pass), `tests/smoke/docs-smoke.sh` (passes), and eleven related unit files (`refusal-hints`, `runtime-context`, `host-preflight`, `host-single-hint`, `launch-environment*`, `legacy-*`, `planning-result-sealer`, `architecture-target`, `adoption-ordering`), all of which pass with the runtime markers unset. The defects below are therefore in paths the existing tests do not exercise. No Critical issue was found. Six Warnings and four Info items were confirmed by reading or running the code, and each one cites its evidence.

The five installed-launch scenarios were also read for reliability. Their assertions are real and none passes vacuously: the held-lock cases (1.5 s hold against a 5 s lock wait, 8 s hold for the refusal arm, 6 s margin, 120 s spawn timeout) leave workable margin, every `upgrade-history` case asserts byte identity and adoption state, and `ui-smoke` is a declared gap by design with a stub-driver control that does assert. The scenarios do not cover the Warnings below that concern upgrade-time repository forms (WR-03), provenance crash residue (WR-04) and a damaged authority namespace (WR-06).

Themes:
1. The refusal-hint layer is only fully correct on the preflight path. The host top-level handlers drop the variables the hints need.
2. Preflight does not evaluate some conditions that its own hint catalogue, the writers or the README claim it covers (WR-02, WR-06).
3. Three of the earlier fixes are narrower than the failure class they target: the legacy repository forms, the inert provenance names and the probe classification.

## Warnings

### WR-01: Host top-level handlers call `formatHint(error.code)` without variables, so remedies print a non-runnable command and lose the known pid and path

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs:186-195,210-221`; call sites `codex-decompose-host.cjs:1493`, `codex-delivery-host.cjs:3715`, `claude-delivery-host.cjs:1227`, `claude-role-host.cjs:1649`, `claude-decompose-host.cjs:771`, `claude-investigation-host.cjs:154`, `codex-planning-context-host.cjs:443`, `deliver-dispatch.cjs:1312`; error shape in `dispatch-boundary.cjs:1010-1016`

**Issue:** The fix for unfilled `{placeholders}` added fallbacks. The `host` fallback is the prose `the host script`, and it is substituted unquoted into a command. Every host `main().catch` handler calls `formatHint(error && error.code)` with no vars.

- Errors raised through `boundaryError`, which includes everything `role-artifact.cjs` raises via `fail()`, carry `error.details`, not `error.vars`. Only `HostEnvironmentError` and the `codex-agent` `ENV_CONFLICT` carry `vars`.
- The hosts never pass `error.details` or `error.vars` to `formatHint` in any case.

Reproduced:

```
formatHint('INVALID_STORE', {})   // and ARCHIVE_AUTHORITY_INVALID, BUNDLE_MANIFEST_INVALID, CAPABILITY_EVIDENCE_STALE, RUNTIME_UNAVAILABLE
-> remedy: Run node /…/plugins/delivery-pipeline/scripts/the host script --preflight and report its output
```

Pasting that runs `node …/scripts/the` with extra arguments and fails with "Cannot find module". Other hints degrade the same way:

- `ARCHIVE_AUTHORITY_BUSY` renders "owner pid unknown", although `role-artifact.cjs:4217-4223` computed the pid and put it in `details`.
- `LEGACY_HISTORY_UNSAFE`, `LEGACY_HISTORY_CHANGED` and `LEGACY_HISTORY_UNKNOWN_MEMBER`, raised by `refuseLegacyFinding` (`role-artifact.cjs:4076-4082`), render "the legacy history at an unreported path". The path is only in the message.
- `ENV_CONFLICT` raised from `codex-agent` renders "names an explicitly named home … is a different home", because `error.vars` is dropped.

So on the real refusal path of a launch, the hint contradicts what the earlier rounds intended. Only the preflight path (`emitPreflight`) is correct.

The smoke tests mask this. `scenario-concurrency.cjs` asserts `/pid \d+/` in stderr, which the error message satisfies, while the hint printed beside it says "owner pid unknown". `scenario-upgrade-history.cjs` case 4 asserts only that the message names the file, while the hint says "unreported path".

**Fix:** Give each host a single `printRefusalHint(error, host)` that calls `formatHint(error.code, { host: '<this host file>', ...(error.details || {}), ...(error.vars || {}) })`, and use it in all eight handlers. Make the `host` fallback command-safe by omitting the `--preflight` clause when no host is known. For example, make the remedy templates two-part (`Run node {bundle}/scripts/{host} --preflight` only when `host` is supplied). Alternatively fall back to a host that exists, such as `codex-delivery-host.cjs` or `claude-delivery-host.cjs`. Never substitute prose into a command position.

---

### WR-02: `--preflight` reports `ok` for a repository whose path contains `;` or a control character, although every launch then refuses with `REPOSITORY_IDENTITY_INVALID`

**File:** `plugins/delivery-pipeline/scripts/runtime-context.cjs:509-514,548-660` (no `repositoryIdentity` check); `architecture-target.cjs:93-103`; README "Launch and upgrade" ("collects every incompatibility")

**Issue:** The new `repositoryIdentity` refuses real paths containing `;` or control characters. The refusal is raised from:

- `claude-role-host.cjs` `canonicalWorktree`
- `claude-decompose-host.cjs` `canonicalRequest`
- `deliver-dispatch.cjs` `buildPlanningRequest` and `buildPhaseArchitectureRequest`
- `role-artifact.cjs` `judgmentSubject`
- `codex-planning-context-host.cjs` `waitRecorder`

`LAUNCH_CODES` has a hint for `REPOSITORY_IDENTITY_INVALID`, but `PREFLIGHT_CODES` omits it and `preflight()` never calls `repositoryIdentity`. Reproduced in a temp repo at `…/semi;colon`:

```
preflight({runtime:'claude', worktree, scope:'launch', …}) -> ok=true, findings=[], notes=[]
repositoryIdentity(worktree)                               -> REPOSITORY_IDENTITY_INVALID
```

The README promises that preflight is the check to run before launching and that it collects every incompatibility. For this condition it gives a false green. Because the preflight run is the gate in `deliver-dispatch launch` and in every host's launch gate, the launch is admitted past preflight and then fails mid-launch.

**Fix:** Add a `repository identity` step to `preflight()` that calls `require('./architecture-target.cjs').repositoryIdentity(opts.worktree)` when `opts.worktree` is a string. Add `REPOSITORY_IDENTITY_INVALID` to `PREFLIGHT_CODES` and to the host-preflight test's code list. A step like this, consistent with the other steps, would be:

```js
run('repository identity', () => {
  if (typeof opts.worktree === 'string' && opts.worktree) require('./architecture-target.cjs').repositoryIdentity(opts.worktree);
});
```

---

### WR-03: Resuming a research round started before the upgrade fails for repositories without a GitHub `origin`: the accepted legacy forms omit the old `projectRoot` form

**File:** `plugins/delivery-pipeline/scripts/architecture-target.cjs:105-117`; callers `codex-delivery-host.cjs:1168-1169`, `claude-delivery-host.cjs:464-465`; old behaviour `git show origin/main:…/deliver-dispatch.cjs` `planningRepository` (lines 805-812)

**Issue:** Before this phase, `planningRepository(projectRoot)` returned the lower-cased `owner/repo` only for a `github.com` origin. For every other repository it returned `projectRoot`, which `planningBuildContext` computed as `realpath(graphDir/../..)` (the project root that owns the graph, not necessarily the checkout the host runs in):

- no remote at all
- GitLab, Bitbucket or GitHub Enterprise
- a local fixture

`legacyRepositoryForms` reproduces only the GitHub branch. For any other repository, sibling research lines sealed before the upgrade carry `envelope.repository === <projectRoot>`. The new check is `repositories.has(envelope.repository)` with accepted values `[<realpath of .git>]` only. Reproduced for a repo with `origin = https://gitlab.example.com/team/proj.git`:

```
acceptedRepositoryValues(dir) -> ['/…/proj/.git']      // the old value '/…/proj' is absent
```

So `verifySealedLine` refuses with `RESEARCH_VERIFY_IDENTITY_MISMATCH`. The earlier round's fix for "sealed under the old owner/repo form" covers only half of the old behaviour. A research round that spans the upgrade (the case this phase targets) is unrecoverable for those repositories without re-running research.

**Fix:** Accept the old `projectRoot` form as a legacy value whenever the origin is not a GitHub one. The old fallback applied only in that case. The value is `realpath(<graph dir>/../..)`, so the two hosts must derive it from the same graph project root they already resolve (`inflightGraphDir` in `codex-delivery-host.cjs`, `investigationProject` in `claude-delivery-host.cjs`), not from the worktree. The worktree top-level is a second, weaker candidate to add as well. For example, give `acceptedRepositoryValues(cwd, { graphProjectRoot })` an optional second argument:

```js
function legacyRepositoryForms(cwd, { graphProjectRoot } = {}) {
  const forms = githubForms(cwd);               // today's behaviour
  if (!forms.length) {                          // old fallback: projectRoot
    for (const root of [graphProjectRoot, cwd]) if (root) forms.push(fs.realpathSync(root));
  }
  return [...new Set(forms)];
}
```

Add unit cases with a GitLab origin and with no origin, including a graph whose project root differs from the worktree.

---

### WR-04: The `writeAtomic` temp file in the provenance directory is not recognised as inert, so a crash residue blocks every later trusted mutation permanently

**File:** `plugins/delivery-pipeline/scripts/role-artifact.cjs:3960-3966,4076-4082`; `dispatch-record.cjs:1592-1612`; `lock.cjs:422-433`

**Issue:** The "stray provenance-directory files" fix recognises `<id>.json.<pid>.<uuid>.tmp` (`PROVENANCE_STAGING_NAME`), the name `writeProvenanceOnce` gives its staged file. But that staged file is written with `writeAtomic(staged, …)`, which itself creates `.<basename(staged)>.tmp-<pid>` in the same directory and then renames it. A process killed between the write and the rename leaves `.<id>.json.<pid>.<uuid>.tmp.tmp-<pid>`. Reproduced:

```
provenanceInert(dir, 'T-1.json.<pid>.<uuid>.tmp')              -> true
provenanceInert(dir, '.T-1.json.<pid>.<uuid>.tmp.tmp-<pid>')   -> false
```

Such a file fails `PROVENANCE_MEMBER_PATH` (it does not end in `.json`), so `classifyLegacyProvenance` reports `LEGACY_HISTORY_UNSAFE` ("member name is not allowed"). `trustedBookkeepingMutation` then refuses every later mutation, and `inflightBookkeepingRequired` treats the state as `blocked`. The hint tells the user to "leave the history in place and report it … until the host that wrote it is updated". No remedy lets the user continue short of manually deleting the file.

The README says only that an orphaned `<id>.json.<pid>.<uuid>.tmp` staging file never blocks, so this is not a contradiction of the README. It is a gap in the fix: the residue that `writeAtomic` actually leaves on a crash is not the name the fix recognises.

**Fix:** Extend the inert pattern to the real temp names (`writeAtomic`'s `^\.[A-Za-z0-9_.-]+\.tmp-[0-9]+$`, and the staged name), still requiring a regular file and still never reading or pinning it. Better, have `writeProvenanceOnce` publish with a single temp name that the pattern already covers, instead of nesting `writeAtomic`. Add a fixture with the nested name to `legacy-bookkeeping-adoption.test.cjs`.

---

### WR-05: Probe failures are classified inconsistently, and an outdated Codex CLI is told to reinstall Shipyard instead of upgrading Codex

**File:** `plugins/delivery-pipeline/scripts/runtime-context.cjs:611-620`; `codex-runtime-host.cjs:187-222,3750-3757,3760-3773`; `claude-role-host.cjs` `--capability-only` branch

**Issue:**

- **Misclassification.** `preflight()` maps a probe reason to `RUNTIME_CAPABILITY_MISSING` whenever the reason contains `capability`. `probeCodexRuntime` returns `runtime_capability_missing` and `capability_help_unavailable` when the installed Codex CLI lacks the required `exec` flags. Reproduced with a stub CLI whose `exec --help` lacks them: the finding is `RUNTIME_CAPABILITY_MISSING`, whose remedy says "Installed bundle: its capability evidence is missing or stale, so upgrade and reinstall … or point SHIPYARD_CODEX_CAPABILITIES_FILE at an evidence file". That is the wrong remedy. The cause is the Codex CLI, so the user should upgrade or reinstall Codex.
- **Inconsistent classifier.** `emitProbeHint` in `codex-runtime-host.cjs` uses a stricter test (`capability_evidence_missing` or `RUNTIME_CAPABILITY_MISSING` only). The same probe result therefore prints `RUNTIME_UNAVAILABLE` there and `RUNTIME_CAPABILITY_MISSING` in preflight.
- **Swallowed environment errors.** `probeCodexRuntime` swallows every `capabilitiesFrom` error as `capability_evidence_missing`, including `ENV_CONFLICT`, `BUNDLE_MANIFEST_INVALID` and `CAPABILITY_EVIDENCE_STALE` raised by `resolveHostEnvironment`. The `--capability-only` CLI therefore never shows the specific `ENV_CONFLICT` hint.
- **Circular remedy.** `emitProbeHint` passes `host: 'codex-runtime-host.cjs'`. The `RUNTIME_UNAVAILABLE` remedy then says to run `node …/codex-runtime-host.cjs --preflight`, a flag that script does not accept. Reproduced: `node codex-runtime-host.cjs --preflight` prints `unknown CLI argument "--preflight"` followed by the same hint again. An argument error (`reason: INVALID_INPUT`) is also hinted as "runtime not reachable".

**Fix:**

1. Define one `classifyProbe(reason, code)` in `runtime-context.cjs`, used by the preflight, by `emitProbeHint` and by the `claude-role-host` `--capability-only` branch. Map `capability_evidence_missing` and `RUNTIME_CAPABILITY_MISSING` to `RUNTIME_CAPABILITY_MISSING`. Map `runtime_capability_missing`, `capability_help_unavailable` and `runtime_missing` to `RUNTIME_UNAVAILABLE`, and give that hint a clause about upgrading the Codex CLI.
2. In `probeCodexRuntime`, let a thrown error that has a code in `RESOLVER_CODES` surface as its own `reason`.
3. Do not pass a host that has no `--preflight` into command hints. Use `codex-delivery-host.cjs` for the Codex probe CLI.

---

### WR-06: A catalogue without its HMAC key is a note in `--preflight` but a refusal in every trusted mutation

**File:** `plugins/delivery-pipeline/scripts/role-artifact.cjs:3972-3998` (`legacyAuthoritySide`, the `unreadable` mapping) against `authorityState` at `role-artifact.cjs:1074-1105`; consumer `runtime-context.cjs:626-631`

**Issue:** `legacyAuthoritySide` classifies any error carrying a `syscall` as `unreadable`. In `authorityState` a missing `hmac.key` raises `ENOENT` from `authorityFile`'s `lstat`, so it takes that branch. `preflight()` turns `unreadable` into a not-evaluated note only. Yet `trustedBookkeepingMutation` (which calls `authorityState(worktree, true)`) refuses the identical state with `ARCHIVE_AUTHORITY_INVALID: existing protected records require their original authority key`. Reproduced with a `catalogue.json` and no `hmac.key`:

```
preflight(...)                       -> ok=true, findings=[], notes=[legacy history: not evaluated, authority namespace unreadable (ENOENT)]
trustedBookkeepingMutation(P, ...)   -> ARCHIVE_AUTHORITY_INVALID  existing protected records require their original authority key
```

This is the same false-green class as WR-02, from the catalogue error-mapping fix. A damaged authority namespace (a deleted key beside a surviving catalogue) is exactly the condition the README lists under `ARCHIVE_AUTHORITY_INVALID`, and the preflight is meant to catch it before a launch.

**Fix:** In `legacyAuthoritySide`, treat `ENOENT` on `hmac.key` while `catalogue.json` exists as `ARCHIVE_AUTHORITY_INVALID` (a finding), keeping `unreadable` for genuine permission or I/O errors such as `EACCES` and `EIO`. For example, check `fs.existsSync(path.join(directory, 'hmac.key'))` right after the catalogue `lstat` succeeds and set `side.finding` when the key is absent. Add a case to `host-preflight.test.cjs` and `scenario-upgrade-history.cjs`.

## Info

### IN-01: `observeCodexNotify`'s refusal handling is unreachable in production

**File:** `plugins/delivery-pipeline/scripts/session-observer.cjs:294-309`; `plugins/delivery-pipeline/scripts/codex-notify.cjs:26-29`

**Issue:** The earlier session-observer crash fix changed `observeCodexNotify`. Nothing in production calls it: the only caller is `tests/unit/session-observer.test.cjs`. The actual Codex notify hook (`codex-notify.cjs`) was not changed and computes its home as `process.env.CODEX_HOME || path.resolve(__dirname, '..', '..')`. That value is installed-bundle-correct, but it bypasses `resolveCodexHome` and so never reports `ENV_CONFLICT`. The `{ refused: true, … }` return shape is dead code with a passing test.

**Fix:** Either route `codex-notify.cjs` through `resolveCodexHome` (and decide silently what a refusal means in a notify hook) or delete `observeCodexNotify`'s new branch and its test.

### IN-02: The installed-launch smoke hard-codes `PATH=/usr/bin:/bin` for git

**File:** `tests/smoke/installed-launch/lib.cjs:153,244`; `tests/smoke/installed-launch/scenario-upgrade-history.cjs:12`

**Issue:** CLAUDE.md says `make test-fast` needs only the host shell and Node. `test-installed-launch` is now part of `TEST_FAST_REST`, and it fails with an opaque `assert.equal(result.status, 0)` on any host whose `git` is not under `/usr/bin` or `/bin` (Nix, some container images, Homebrew-only git). `hermeticGit` in `lib.cjs` already uses `process.env.PATH`, so the harness is inconsistent with itself.

**Fix:** Resolve `git` once through `process.env.PATH` (for example `command -v`) and pass its directory, or use the `PATH` that `hermeticGit` uses, in all three places. Fail early with a message that names the missing tool.

### IN-03: Stale or divergent small details around the new whitespace and probe handling

**File:** `plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:1057`; `claude-delivery-host.cjs:1077`; `claude-role-host.cjs:1590`

**Issue:**

- `ticketFromContext` now accepts whitespace inside a parsed subject's repository field, but its refusal still says "whitespace-free string". That misdirects a user who passes an unparseable subject.
- The Claude hosts' preflight probe is `() => hostOptions.probe || probeClaudeRuntime(…)`, so a function-valued `hostOptions.probe` is returned without being called and never evaluated. The Codex hosts handle both a function and a value.

**Fix:** Reword the message ("whitespace-free, or a planning or review subject"). Use `typeof hostOptions.probe === 'function' ? hostOptions.probe() : hostOptions.probe || probeClaudeRuntime(…)` in both Claude hosts.

### IN-04: Subjects are now built with a git-environment-scrubbed identity, but the readers that verify them are not scrubbed

**File:** `plugins/delivery-pipeline/scripts/architecture-target.cjs:11-16,93-103`; readers `role-artifact.cjs:2811-2813` (`reviewGit`), `3699`, `3726`, `3798`

**Issue:** `repositoryIdentity` deletes `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_COMMON_DIR` before it asks git for the common directory, and the integrator subject is now built from it. The verifying side (`currentIntegrationVerdict` and its helpers) derives `common` through `reviewGit` and plain `execFileSync` calls that inherit the environment. If a launch runs with an inherited `GIT_DIR` (for example from a git hook), the writer and the reader can compute different identities for the same repository, and `subject.repository !== common` then skips every authenticated integrator record. This is read from the code only; I did not reproduce it.

**Fix:** Route `reviewGit` and the other `git rev-parse --git-common-dir` calls in `role-artifact.cjs` through `require('./architecture-target.cjs').repositoryIdentity`, or give them the same `GIT_SCOPE_KEYS` scrub.

---

_Reviewed: 2026-10-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
