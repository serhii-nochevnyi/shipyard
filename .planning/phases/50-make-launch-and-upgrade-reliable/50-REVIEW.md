---
phase: 50-make-launch-and-upgrade-reliable
reviewed: 2026-10-17T00:00:00Z
depth: deep
files_reviewed: 29
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/runtime-context.cjs
  - plugins/delivery-pipeline/scripts/refusal-hints.cjs
  - plugins/delivery-pipeline/scripts/role-artifact.cjs
  - plugins/delivery-pipeline/scripts/architecture-target.cjs
  - plugins/delivery-pipeline/scripts/run-contract.cjs
  - plugins/delivery-pipeline/scripts/planning-result-sealer.cjs
  - plugins/delivery-pipeline/scripts/dispatch-record.cjs
  - plugins/delivery-pipeline/scripts/deliver-dispatch.cjs
  - plugins/delivery-pipeline/scripts/codex-delivery-host.cjs
  - plugins/delivery-pipeline/scripts/codex-decompose-host.cjs
  - plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs
  - plugins/delivery-pipeline/scripts/codex-runtime-host.cjs
  - plugins/delivery-pipeline/scripts/codex-agent.cjs
  - plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs
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
  - tests/smoke/installed-launch/ (lib.cjs and scenario-*.cjs)
  - tests/smoke/installed-launch-smoke.sh
  - tests/smoke/docs-smoke.sh
findings:
  critical: 0
  warning: 6
  info: 8
  total: 14
status: issues_found
---

# Phase 50: Code Review Report

**Reviewed:** 2026-10-17
**Depth:** deep
**Files Reviewed:** 29 (the explicit scope; the diff is `origin/main...HEAD` of `epic/50-make-launch-and-upgrade-reliable`)
**Status:** issues_found

## Summary

The diff was read in full for every scoped file, then the call chains between the resolver, preflight, the legacy-history classifier, the trusted bookkeeping writer and the host entries were traced. `tests/smoke/installed-launch-smoke.sh` was run to completion and passes (all scenarios); several refusal paths were also reproduced by hand against the real scripts.

No Critical defect was found. A malformed catalogue fails closed: `recordInflight` is not wrapped in a try/catch in any of the three hosts, so the native exec does not proceed. The accepted items from the brief (no production verifier of stored seals, lock stale-owner semantics) and the items fixed by the earlier review are not repeated here.

Six Warnings remain. They are all in the L-6 "report every incompatibility in one pass with a remedy that runs" and L-9 "one identity" contracts, plus one test that is not hermetic. The Info items are smaller inconsistencies.

## Warnings

### WR-01: A malformed archive catalogue passes preflight, then the launch dies with an unmapped raw error

**File:** `plugins/delivery-pipeline/scripts/role-artifact.cjs:1091-1093` (cause), `:3983-3989` (`legacyAuthoritySide` catch), `plugins/delivery-pipeline/scripts/runtime-context.cjs:558-563` (`run()` downgrade)
**Issue:** `authorityState` calls `JSON.parse(stableAuthorityFile(file))` unwrapped, and computes the HMAC over `envelope.payload` before the `object(envelope.payload)` and mac-format checks run. `legacyAuthoritySide` only maps `ARCHIVE_AUTHORITY_*` codes and errors that carry a syscall; any other throw is re-thrown. `preflight().run()` then turns an error whose code is not in `PREFLIGHT_CODES` into a `not-evaluated` note, so the result stays `ok: true`.

Reproduced against the real modules with an isolated HOME:
- `catalogue.json` containing `garbage`: `classifyLegacyProvenance` throws `SyntaxError: Unexpected token 'g'`; `preflight()` returns `ok: true` with the only note `legacy history: check not evaluated (UNKNOWN)`.
- `catalogue.json` containing `{}`: throws `TypeError [ERR_INVALID_ARG_TYPE]: The "data" argument must be of type string...` from `createHmac().update(stable(undefined))`.

The launch then fails later in `trustedBookkeepingMutation` -> `authorityState` with the same raw error, no `hint[...]` line and no named code. A forged catalogue (valid JSON, bad MAC) is mapped correctly; only the malformed shapes escape. This contradicts L-6 (every incompatibility reported in one pass, hints on every entry point) and the README, which promises `ARCHIVE_AUTHORITY_INVALID` for a "malformed" catalogue. It also means `--preflight` exits 0 for a launch that will refuse.

**Fix:**
```js
// role-artifact.cjs authorityState
let envelope;
try { envelope = JSON.parse(stableAuthorityFile(file)); }
catch (error) {
  if (error instanceof SyntaxError) fail('ARCHIVE_AUTHORITY_INVALID', 'archive catalogue is not valid JSON');
  throw error;
}
if (!object(envelope) || !object(envelope.payload) || !/^[a-f0-9]{64}$/.test(envelope.mac || ''))
  fail('ARCHIVE_AUTHORITY_INVALID', 'archive catalogue envelope is malformed');
// then compute the HMAC
```
Optionally, in `preflight().run()`, report an unexpected throw from the legacy-history check as an `ARCHIVE_AUTHORITY_INVALID` finding (or at least set `ok: false`) instead of a silent note, since a check that crashed is not evidence of compatibility. An unreadable provenance directory (`readdirSync` EACCES in `classifyLegacyProvenance`, `role-artifact.cjs:3984`) takes the same path and deserves the same handling.

### WR-02: `deliver-dispatch.cjs launch` remedies tell the operator to run a `--preflight` flag the script does not have

**File:** `plugins/delivery-pipeline/scripts/deliver-dispatch.cjs:336` (with `refusal-hints.cjs:60-62, 79, 124-131, 145-147, 151-153`)
**Issue:** The in-process gate is called with `host: 'deliver-dispatch.cjs'`, so every `{bundle}/scripts/{host} --preflight` remedy (`BUNDLE_MANIFEST_INVALID`, `CAPABILITY_EVIDENCE_STALE`, `ARCHIVE_AUTHORITY_INVALID`, `INVALID_STORE`, `RUNTIME_CAPABILITY_MISSING`) renders as `node .../scripts/deliver-dispatch.cjs --preflight`. That command exits 1 with `usage: deliver-dispatch.cjs build|launch|status|wait` (reproduced), and the README itself states the script "has no `--preflight` flag of its own". L-6 requires a remedy that actually runs from the installed bundle; here the first thing a refused operator is told to run is a usage error.
**Fix:** Do not pass `host` for the deliver-dispatch gate so the runtime default (`DELIVERY_HOSTS[runtime]`: `codex-delivery-host.cjs` or `claude-delivery-host.cjs`) applies, or pass the actual child host script for the requested role (`hostScript`). Add a test that every `{host}` rendered by a launch refusal names a script that implements `--preflight`.

### WR-03: A second, degraded hint is printed after the preflight hints, with an unfilled `{host}` and a broken command

**File:** `plugins/delivery-pipeline/scripts/claude-role-host.cjs:1618, 1648`; `claude-delivery-host.cjs:1161, 1224`; `codex-decompose-host.cjs:1488` (via `runHostPreflight` -> `fail`); `codex-planning-context-host.cjs:443`
**Issue:** `emitPreflight` already prints `hint[CODE]` for every finding with its variables filled. These four hosts then throw with `error.code` set to the first finding's code and no `hintPrinted` flag, and their `main` catch prints `formatHint(error.code)` again without variables. Reproduced with `claude-role-host.cjs --args-file <request>` on an unauthenticated fixture:

```
hint[RUNTIME_UNAVAILABLE]: ... Run node /.../scripts/claude-role-host.cjs --preflight ...
claude-role-host: preflight found 1 incompatibilities: RUNTIME_UNAVAILABLE
hint[RUNTIME_UNAVAILABLE]: ... Run node /.../scripts/the host script --preflight ...
```

The last line is a command that cannot run. This is the "unfilled placeholder in preflight hints" class the earlier review fixed, reintroduced in the refusal path. Only `claude-decompose-host.cjs:715` and `codex-delivery-host.cjs:3389` set `hintPrinted`.
**Fix:** Set `error.hintPrinted = true` on the refusal error in every host that has already called `emitPreflight` (`claude-role-host.cjs:1618`, `claude-delivery-host.cjs:1161`, `runHostPreflight` in `codex-decompose-host.cjs:921-937`) and skip `formatHint` in each `main` catch when it is set. Better, factor the throw into one shared helper in `runtime-context.cjs` so the five copies cannot drift again.

### WR-04: `repositoryIdentity()` does not scrub inherited `GIT_*` variables, so it can name a different repository than the rest of the same launch

**File:** `plugins/delivery-pipeline/scripts/architecture-target.cjs:87-99`
**Issue:** L-9 makes `repositoryIdentity()` the single canonical identity, but it runs `git -C cwd rev-parse --git-common-dir` with the inherited environment. `codex-delivery-host.cjs:146-153` (`git()`) and the former call sites it replaced in `codex-arch-review-context.cjs` explicitly delete `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_COMMON_DIR`. Reproduced: with `GIT_DIR=<repo B>/.git` exported and `cwd` = repo A, `repositoryIdentity(A)` returns `B/.git`. A host launched from a git hook, `git rebase --exec`, or a shell with `GIT_DIR` set therefore builds subjects and identities for the wrong repository, while `canonicalCliScope` (which scrubs) resolves the right one, and the two disagree inside one launch. The old arch-review call sites were not exposed to this; the migration introduced it.
**Fix:**
```js
const env = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
common = String(run('git', [...], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }))...
```
Apply the same scrub to the `git rev-parse --show-toplevel` in `runtime-context.cjs:524` and to `legacyRepositoryForms`.

### WR-05: The UI-smoke scenario is not hermetic, and its `found` branch runs an invented command against the operator's real GSD install

**File:** `tests/smoke/installed-launch/scenario-ui-smoke.cjs:13-16, 144, 151-165`
**Issue:** `candidateRoots(process.env, os.homedir())` inspects the real `~/.claude/gsd-core` and `~/.codex/gsd-core` (the recorded GAP line in the smoke run lists `/Users/<user>/.claude/gsd-core` as an examined root), contradicting L-10's "isolated HOME" and the CLAUDE.md description of `test-fast` as deterministic. `test-installed-launch` is now part of `TEST_FAST_REST`, so every developer and CI job runs it. Worse, when the regex finds the strings `'ui-phase'` and `'ui-review'` anywhere in the real `gsd-tools.cjs`, the scenario reports `found`, builds the invocation `node <tools> {ui-phase|ui-review} --non-interactive`, and executes the user's real tool with a `--non-interactive` flag that was never verified to exist. A match is a substring grep, not evidence of a non-interactive driver. The most likely outcomes are a spurious non-zero exit that fails `make test-fast` on machines with a newer GSD, or an unintended real run. On this machine the check reports `absent`, so the branch is untested.
**Fix:** Read candidate roots only from the fixture (installed layout under the fixture HOME), or from an explicit `SHIPYARD_UI_SMOKE_GSD_ROOT`. Treat `found` as "a driver is declared by the install's own manifest or `--help` output" (parse `gsd-tools.cjs --help`), never as a grep over source, and take the flag from that output. Until a real driver is proven, always emit the GAP record.

### WR-06: The `RUNTIME_CAPABILITY_MISSING` remedy is circular and wrong for the source-checkout and direct-installer case

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs:91-94`
**Issue:** The remedy is `Run node {bundle}/scripts/{host} --preflight; if evidence is missing, upgrade the bundle (...)`. It is printed by `--preflight` itself, so an operator who just ran that command is told to run it again. For a source checkout or a direct `install-shipyard-codex.sh` run, which the README says "still need explicit evidence through `SHIPYARD_CODEX_CAPABILITIES_FILE`; this is the only case that does", there is no marketplace bundle to upgrade and the hint never mentions the variable. Reproduced from a bare git directory: the finding's remedy was exactly this text. L-6 asks for a remedy that works.
**Fix:** Branch the remedy on the resolved mode: installed -> marketplace upgrade; source -> "set `SHIPYARD_CODEX_CAPABILITIES_FILE` to the evidence file written by the installer, or install the bundle". Do not tell `--preflight` output to run `--preflight`.

## Info

### IN-01: Each preflight finding's detail is printed twice

**File:** `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:3368-3392`, `plugins/delivery-pipeline/scripts/runtime-context.cjs:671`
**Issue:** `emitPreflight` appends `(detail: ...)` to every hint line, then `runHostPreflight` prints `preflight: detail[CODE] ...` again (both the `--preflight` report path and the refusal path). Reproduced: the `RUNTIME_CAPABILITY_MISSING` output carries the same detail on consecutive lines.
**Fix:** Delete the `details()` helper; `emitPreflight` already carries the detail.

### IN-02: Explicit `--agent-dir` and `--capabilities-file` flags bypass the "disagreeing explicit value refuses" contract

**File:** `plugins/delivery-pipeline/scripts/codex-agent.cjs:73-80, 98-108`
**Issue:** `agentDirFrom` returns the explicit `--agent-dir` before calling the resolver, and `capabilitiesFrom` reads an explicit `--capabilities-file` directly. Only when `--agent-dir` is omitted does `resolveCodexHome` run `checkExplicitSources`. So `--agent-dir X --capabilities-file Y` against an installed bundle is accepted without the `ENV_CONFLICT` naming both values that L-2 specifies for every host entry.
**Fix:** Call `resolveHostEnvironment` first and run `checkExplicitSources` on the explicit values whenever the script runs from an installed bundle.

### IN-03: Hand-built subjects bypass `buildSubject`, and the one character class is not actually one

**File:** `plugins/delivery-pipeline/scripts/deliver-dispatch.cjs:1027`, `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:157`, `plugins/delivery-pipeline/scripts/architecture-target.cjs:8` vs `plugins/delivery-pipeline/scripts/run-contract.cjs:101`
**Issue:** L-9 requires one `repositoryIdentity()`, one character class and one parse for every subject family. The planning-input subject in `deliver-dispatch.cjs` and the seal subject in `codex-decompose-host.cjs` are still built by string concatenation, so a repository value is not validated against `REPOSITORY_CLASS` at build time. Separately, `REPOSITORY_CLASS` rejects only `\x00-\x1f`, but `safeString` in `run-contract.cjs` also rejects `\x7f`, so a repository path containing DEL builds a valid subject and is then refused by `normalizeTicketIdentity` as `INVALID_INPUT` instead of the named `REPOSITORY_IDENTITY_INVALID`.
**Fix:** Build both subjects with `buildSubject('planning-input', ...)` and a decomposition-seal family call, and add `\x7f` to `REPOSITORY_CLASS`.

### IN-04: The `AMBIGUOUS_RUNTIME` remedy is wrong when the runtime was passed explicitly

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs:103-106`
**Issue:** The remedy is "Pass the runtime explicitly for this command". In preflight the runtime is already passed (`opts.runtime`); the conflict comes from environment markers (`CLAUDE_CODE_ENTRYPOINT`, a `.claude` or `.codex` bundle path). Reproduced: `preflight({ runtime: 'codex', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } })` yields `AMBIGUOUS_RUNTIME: claude-session-env: runtime claude conflicts with option.runtime (codex)`, and the remedy is a no-op. The refusal itself predates this phase (`loadConfig(..., routed: true)` refuses the same environment), so only the wording is in scope.
**Fix:** Say which marker conflicted (the finding detail already names it) and that the remedy is to run the host from the matching runtime's session or unset the foreign marker.

### IN-05: The smoke harness maps raw error text to a named refusal label

**File:** `tests/smoke/installed-launch/lib.cjs:196`
**Issue:** `launchLabels` pushes `ARCHIVE_AUTHORITY_INVALID` when stderr matches `key is malformed|changed while reading`. That turns an unnamed raw failure into a classified `refused` outcome, so a launch that crashes with no `hint[...]` still satisfies `classifyLaunch`. The concurrency scenario's strict `['ARCHIVE_AUTHORITY_BUSY']` assertion limits the exposure there, but the upgrade scenarios do not.
**Fix:** Count only `hint[CODE]` labels; if a raw message must be tolerated, return a separate `unnamed` kind that the scenarios do not accept.

### IN-06: A brittle count assertion in the docs smoke

**File:** `tests/smoke/docs-smoke.sh:110`
**Issue:** `grep -c 'SHIPYARD_CODEX_CAPABILITIES_FILE' README.md` must be `<= 2`. It counts lines, not accounts, so any legitimate extra mention (an installer example, a troubleshooting row) fails the gate and invites the next editor to reword rather than document.
**Fix:** Assert the property that matters (the retired "still needs `SHIPYARD_CODEX_CAPABILITIES_FILE`" sentence is gone and the section names the single case), not a line count.

### IN-07: `codex_cli_version` records the generating machine's CLI, not the CLI that produced the evidence

**File:** `scripts/gen-codex-shipyard.cjs:375` (and `:257-266`)
**Issue:** When evidence comes from an explicit `--capabilities`/`SHIPYARD_CODEX_CAPABILITIES_FILE` file, `capabilitiesRaw` is that file, but `readCodexCliVersion()` still records the local `codex --version`. `CAPABILITY_SNAPSHOT_AGED` then compares installed CLI to a version the evidence never came from, so it can warn spuriously or stay silent when the evidence is old.
**Fix:** Record the version only when the generator itself captured the evidence (`readCodexCliCapabilities()`), and write `null` for an explicit file.

### IN-08: The decompose host's preflight probe is skipped when a function is injected

**File:** `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:925`
**Issue:** `probe: () => options.probe || probeCodexRuntime(...)` returns `options.probe` itself when set. `codex-delivery-host.cjs:3362-3366` (`hostProbe`) calls it when it is a function. A function injected through the decompose host is returned unevaluated, `result.status` is `undefined`, and the probe can never report `RUNTIME_UNAVAILABLE`. This is an inconsistency between sibling hosts rather than a production failure.
**Fix:** Reuse `hostProbe` semantics: `typeof options.probe === 'function' ? options.probe() : options.probe || probeCodexRuntime(...)`.

---

_Reviewed: 2026-10-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
