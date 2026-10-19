<!-- source: .planning/phases/50-make-launch-and-upgrade-reliable/50-REVIEW.md (tracked, commit 92453193) sha256 21c91b48e7faedba4ddee8549f5cac40043000d3b6528831b6f0b30eff5eec0e -->
<!-- lines 1-7 -->
---
phase: 50-make-launch-and-upgrade-reliable
reviewed: 2026-10-18T00:00:00Z
depth: deep
iteration: 4
scope: "git diff 3d5c385c...b8b20168 (44 fix commits of review rounds 1-3), excluding plugins/shipyard and .planning"
files_reviewed: 51
<!-- lines 60-76 -->
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

<!-- lines 83-87 -->
## Warnings

### WR-01: a hint rendered without a host prints the command `.../scripts/the host script --preflight`

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs:187` (fallback), callers `plugins/delivery-pipeline/scripts/gsd-tune.cjs:804` and `plugins/delivery-pipeline/scripts/session-observer.cjs:302-303` (reached from `codex-notify.cjs:28-29`)
<!-- lines 111-115 -->
### WR-03: `writerPreflight` swallows the refusals it exists to surface, so preflight reports ok while the launch refuses; the Claude variant behaves the opposite way

**File:** `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:911-921` (and `codex-planning-context-host.cjs:318-322` which wraps it again), `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs:692-698`
**Issue:** The Codex `writerPreflight` wraps `phaseDirectory`, `defaultRunStoreDir` and `legacyPlanningWriterRoots` in one `try { ... } catch { return {}; }`. `legacyPlanningWriterRoots` throws `LEGACY_WRITER_STATE` (a `PREFLIGHT_CODES` member) for a symlink in the private Claude writer root, and `defaultRunStoreDir` throws `INVALID_STATE_DIR`. Both become `{}`, so `preflight()` never sees `gsdRole`, skips the "planning writer state" check, and adds no "not evaluated" note. Reproduced with a symlink under `~/.local/state/shipyard/claude-decompose/`: `writerPreflight(...)` returns `{}` while `legacyPlanningWriterRoots(...)` throws `LEGACY_WRITER_STATE: private Claude writer root has a symbolic link`. `--preflight` therefore prints `preflight: ok` and the real launch refuses. The Claude `writerPreflight` only guards `phaseDirectory`, and the inline spread in `codex-delivery-host.cjs:3512` has no guard at all; the same condition there escapes as a raw throw, so `--preflight` produces no report (read, not run). Three hosts, two behaviours. The launch side is confirmed: `codex-decompose-host.cjs:1369-1370` calls `assertNoLegacyPlanningWriter` with `legacyPlanningWriterRoots(...)` after the preflight, so the refusal does occur at launch.
**Fix:** catch only the `phaseDirectory` failure (no phase directory means the check genuinely does not apply). For the rest, either let `preflight()` run the root enumeration inside its `run('planning writer state', ...)` wrapper (pass the inputs `{ worktree, phase, repository, privateRoots }` instead of the computed `writerRoots`), or convert the caught error into a `note('not-evaluated', ...)`/finding. Use the same shape for both hosts.
<!-- lines 117-119 -->
### WR-04: `roleNeedsRepositoryIdentity` excludes `pr-sentinel`, but the Claude role host builds the repository identity for every role

**File:** `plugins/delivery-pipeline/scripts/runtime-context.cjs:555-560`, `plugins/delivery-pipeline/scripts/claude-role-host.cjs:182` (via `canonicalWorktree`, called for every role at `:904`), `tests/unit/host-preflight.test.cjs` ("refuses a path no identity subject can carry only for a launch that builds one")
<!-- lines 144-148 -->
### WR-06: the Claude half of every "upgrade" remedy names `claude plugin install`, which is not the upgrade command

**File:** `plugins/delivery-pipeline/scripts/refusal-hints.cjs:7` (`UPGRADE`, interpolated into 8 remedies)
**Issue:** Round 3 made every upgrade remedy read `Claude: claude plugin install shipyard@shipyard; Codex: codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard`. The verified core: the Codex half names a marketplace refresh and then the add, while the Claude half has no refresh step, and the Claude CLI has dedicated verbs for this that the hint does not use: `claude plugin update <plugin>` ("Update a plugin to the latest version (restart required to apply)") and `claude plugin marketplace update [name]`; `install` is documented only as "Install a plugin from available marketplaces". I did not run `install` against an installed plugin, so whether it refreshes a stale copy is unverified; if it does not, a user following the hint hits the same refusal again. README documents `claude plugin install` only as first-time setup (`README.md:35-37`) and has no Claude upgrade instructions, so the hint is the only guidance. `host-preflight.test.cjs` "words a Claude-reachable remedy for both hosts" pins the exact string.
**Fix:** suggested wording, to be checked against the Claude CLI before adopting: `Claude: claude plugin marketplace update shipyard, then claude plugin update shipyard@shipyard (restart Claude Code); Codex: ...`. Update the pinning test and add the Claude upgrade steps to the README "Launch and upgrade" section. Hints reachable only on Codex (`ENV_CONFLICT`, `STALE_GENERATED_AGENT`) could keep the Codex half only.
<!-- lines 170-182 -->
## Info

### IN-01: `ui-smoke` no longer checks the real environment, so the declared-gap record is justified by a check that cannot find a driver

**File:** `tests/smoke/installed-launch/scenario-ui-smoke.cjs:149-152` (`resolveFixtureRoots`), `README.md:219-222`
**Issue:** The security fix correctly stops executing a driver found under the process `HOME`, but the roots are now only `fixture.home` and `fixture.codexHome`. The first `GAP` record then always reports `absent` with `candidate_roots` inside the temp fixture, while README still says the target "first checks whether a non-interactive driver of the GSD UI path exists". The found-branch is now covered only by the stub driver the scenario writes itself. The `driver_check` carried by the real record proves nothing about the host.
**Fix:** reword the README sentence and the GAP reason to say the check is made against a hermetic fixture, or add a read-only discovery (existence of the verbs, no execution) against the real roots.

### IN-02: audit document line citations are stale at `b8b20168`

**File:** `docs/audits/phase50/launch-upgrade-verification.md:25,30`
**Issue:** The edit updated citations to `role-artifact.cjs:4195`, `:3960-3963`, `:3976-3980`, `:1089`, `refusal-hints.cjs:85-88`, but later commits moved them: `withArchiveAuthorityLock` is at `:4218`, the legacy constants at `:3978-3981`, the malformed-record refusal at `:4002`, the catalogue label at `:1098`/`:1114`, `ARCHIVE_AUTHORITY_BUSY` at `refusal-hints.cjs:87-90`. A reader following the evidence lands on unrelated code.
**Fix:** cite symbols (function names, test titles) rather than line numbers, or regenerate the numbers as the last step.
<!-- lines 208-212 -->
---

_Reviewed: 2026-10-18_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
