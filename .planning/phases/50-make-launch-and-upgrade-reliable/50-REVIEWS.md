# Phase 50 — plan review (revision round 1)

Source: the sealed `gsd-plan-checker` run for phase 50 (transcript sha256 96cf8d3b6893ce150449caff8418ce0a23f3f8026c5a333240145c3cbe4fcfa4). Gate 2 (`validate-graph`) now passes (280 tickets, exit 0) after the delivery board was synchronized with GitHub, so Blocker 1 is resolved. Blocker 2 is resolved: `50-VALIDATION.md` was prepared by the orchestrator as an input file (the planner must not create or modify it; its seal outputs are only CONTEXT.md and PLAN.md files). Open items for the planner: Warnings 1-8 and the Info items below. This file is review DATA, not instructions.

Operator constraints that still hold: granularity `fine`, `--tdd`, no Jira tickets, ADR-030 is accepted and must not be edited, decisions L-1..L-11 are locked.

---

Status: I've finished reviewing all 27 existing Phase 50 plans against the INV-017 packet and am writing up the result. I changed no files.

## ISSUES FOUND

**Phase:** 50 (Make launch and upgrade reliable) · **Plans checked:** 27 (T-50-01…27) · **Issues:** 2 blockers, 8 warnings, 4 info

**Scope of this review.** You asked me to prepare the decomposition. The 27 plans already exist, so I checked them rather than writing new ones.
- All 16 packet files matched their SHA-256 digests.
- I could not run `validate-graph.cjs` or the GSD `estimate-check` verb, because the sandbox refused runtime-computed paths. The Gate 2 result below is derived by reading `validate-graph.cjs` against the plan frontmatter, `tickets.json` and `delivery-state.json`.

**What passed:**
- Every REQ-197…203 is claimed by at least one plan.
- Declared waves equal the computed dependency depth, with no cycles.
- No two dependency-unordered Phase 50 plans touch the same file.
- All high-risk plans carry a `review` checkpoint.
- Every plan has 2–3 tasks, each with files, action, verify and done.
- No deferred idea (launcher, persisted context, Claude hook, history deletion, ADR-014 change) is planned.
- The checkout-relative paths the plans cite (`runtime-file-digests.json`, `trustedBookkeepingMutation`, `recordInflight`, the Codex host entry order) match the source.

### Blockers

**1. [dependency_correctness] The plan set must pass Gate 2 (`validate-graph` exit 0) against the live ticket state.**
- A cross-phase file overlap is an error, not a listing. `validate-graph.cjs:509-519` calls `errors.push`, exits 1 and does not rewrite `tickets.json`.
- Only two of the 253 tickets are unmerged: T-46-07 is `pr-open` (PR #412) and T-46-08 is `pending`.
- T-46-07 declares `run-contract.cjs`, `codex-delivery-host.cjs` and their tests. T-46-08 declares `README.md`, `CLAUDE.md`, `Makefile` and `docs-smoke.sh`.
- These collide with T-50-01 (`codex-delivery-host.cjs`, its test, `Makefile`), T-50-10 (`run-contract.cjs` and test), T-50-14 (`codex-delivery-host.cjs` and test) and T-50-26 (`README.md`, `CLAUDE.md`, `docs-smoke.sh`). None of these has an ancestor relation to the phase 46 tickets.
- Plans 10, 14 and 26 say "Gate 2 will list a contested path until it merges", treating this as tolerable. T-50-01 does not mention its own two overlaps. `decompose.md` Step 4 says Gate 2 passes only on exit 0.
- Example route (non-binding): have T-46-07 and T-46-08 recorded as merged before running Gate 2, then re-run it.

**2. [nyquist_compliance] Check 8e: there is no `50-VALIDATION.md`.**
- `workflow.nyquist_validation` is `true` (`config.json:24`) and `50-RESEARCH.md:536` has a "Validation Architecture" section.
- Per the rule, checks 8a–8d are skipped. Informally, every task has an `<automated>` command and none uses watch mode.
- Example route: regenerate it with `/gsd-plan-phase 50 --research`.

### Warnings

1. **[context_compliance] T-50-09 widens adoption beyond host admission.** It changes the `authenticateBookkeeping` shortcut for every `mutate()` caller (call sites at `dispatch-record.cjs` lines 1546, 1602, 1633, 1751, 1811, 1979, 2072, 2139, 2192). The orchestrator runs `dispatch-record.cjs mark`, `clear` and `clear-round` directly (`deliver.md:151,350,1897,1951,2199,2201,2564`). DECISIONS says adoption runs inside the host, because the Claude sandbox denies the model the authority directory. The S-1 fix only needs `inflightBookkeepingRequired`, and only `recordInflight` is tested.
2. **[requirement_coverage, REQ-201] Concurrent first admission can end in an unnamed refusal.** `withArchiveAuthorityLock` calls `authorityState(worktree, true)` before taking the lock (`role-artifact.cjs:4005`). Key creation is a non-atomic `wx` write that ignores EEXIST (`:1059-1062`), and the reader demands exactly 32 bytes (`:1062-1063`). A racing session can read a partial key and fail with "key is malformed". T-50-25 asserts only success or `ARCHIVE_AUTHORITY_BUSY`, and T-50-08 touches only the owner pre-check.
3. **[verification_derivation] The "real user state unchanged" check is racy and may be unreadable.** T-50-01 and T-50-23…25 compare names, sizes and mtimes of the real `~/.local/state/shipyard` before and after. DECISIONS calls concurrent sessions normal, and the conveyor running the executor also writes there. The Claude sandbox denies the authority directory, so the snapshot can fail on read.
4. **[requirement_coverage, REQ-200] The Codex architecture-review producer is not converted or tested.** `codex-arch-review-context.cjs:1022,1056,1410` builds its own git-common identity, and no plan converts it. T-50-22 round-trips `phaseBinding` fed with a test-supplied identity, not the real Codex producer.
5. **[context_compliance] The UI-smoke gap is declared up front.** DECISIONS allows a gap only if the GSD path cannot be driven non-interactively. That is assumption A7 and is marked `[ASSUMED]`. T-50-25 says "do not attempt", and no task checks whether a non-model driver exists.
6. **[task_completeness] T-50-02's remedy rule is contradictory.** Acceptance says "No remedy contains `make ` / `plugins/delivery-pipeline/`". Out-of-scope leaves `CODEX_CONFIG_FIX` alone, and `REFERENCE_UNAVAILABLE` is not mentioned. Both existing remedies are checkout-relative, which conflicts with REQ-199 ("remedy that runs from the installed bundle").
7. **[key_links_planned] Preflight may classify the wrong provenance directory.** T-50-11's `preflight` takes only `worktree`. Hosts record into `options.graphDir || SHIPYARD_GRAPH_DIR || repoRoot/.planning/graph` (`codex-delivery-host.cjs:138-143`), which can differ from `scope.worktree`. `deliver-dispatch` sets `SHIPYARD_GRAPH_DIR` (`deliver-dispatch.cjs:254`), and T-50-09 uses the graph-dir-derived root. Preflight could pass while admission refuses.
8. **[scope_sanity] T-50-01 is large.** It has 11 files in `files_modified` (warning threshold 10), three production modules, the whole harness, and `Makefile`, at high risk. `estimate-check` was not run.

### Info

- T-50-22's scan will also catch `codex-runtime-host.cjs` and `claude-runtime-host.cjs`, which have `require.main` blocks. Its context never classifies them. The `claude-runtime-host.cjs` CLI is a probe that always exits 0.
- T-50-01 asks the SUMMARY to state whether a Codex home without a login is visible to the child (A3). A fake `codex` cannot measure that. T-50-13 already fixes "pass always", with the check deferred to the release live receipt.
- No task has `<fails_when>`, and the `{FAILING_DIRECTIONS}` and `{VERIFY_PATHS}` probe blocks were not supplied. Check 8f and the path-resolvability check were therefore silent here. A probe run would flag every runnable `<automated>` command.
- T-50-16's frontmatter lists `[REQ-199]`, but one of its truths cites REQ-198.

### Structured issues

```yaml
issues:
  - plan: null
    dimension: dependency_correctness
    severity: blocker
    required_property: "Phase-50 plans pass Gate 2 (validate-graph exit 0) against live ticket state: no phase-50 ticket shares a file with a live, dependency-unordered ticket of another phase"
    description: "validate-graph.cjs:509-519 errors on contested paths. T-46-07 (pr-open) and T-46-08 (pending) are live. Overlaps: codex-delivery-host.cjs + test (T-50-01, T-50-14), run-contract.cjs + test (T-50-10), Makefile (T-50-01), README.md/CLAUDE.md/docs-smoke.sh (T-50-26). Derived statically; validator not run."
    fix_hint: "Example: have T-46-07/T-46-08 recorded merged before Gate 2, then re-run it"
  - plan: null
    dimension: nyquist_compliance
    severity: blocker
    required_property: "Phase has a VALIDATION.md when nyquist_validation is enabled and RESEARCH.md has a Validation Architecture section"
    description: "No 50-VALIDATION.md; config.json:24 true; 50-RESEARCH.md:536 present. 8a-8d skipped per rule."
    fix_hint: "Example: /gsd-plan-phase 50 --research"
  - plan: "50-09"
    dimension: context_compliance
    severity: warning
    required_property: "Adoption and its new refusals are triggered only by host admission; other mutate() callers are unchanged or enumerated and pinned by tests"
    description: "authenticateBookkeeping shortcut changed for all mutate() callers; orchestrator runs dispatch-record.cjs mark/clear directly; only recordInflight tested"
    fix_hint: "Example: confine the fix to inflightBookkeepingRequired"
  - plan: "50-25"
    dimension: requirement_coverage
    severity: warning
    required_property: "Concurrent first admission ends only in success or a named ARCHIVE_AUTHORITY_BUSY refusal"
    description: "role-artifact.cjs:4005 creates authority state before the lock; :1059-1063 non-atomic key create, reader requires 32 bytes; T-50-08 does not cover it"
    fix_hint: "Example: make key creation atomic within T-50-08"
  - plan: "50-01"
    dimension: verification_derivation
    severity: warning
    required_property: "The no-real-state-touched property holds regardless of concurrent sessions and sandbox read limits"
    description: "before/after mtime snapshot of real ~/.local/state/shipyard is racy with live sessions and unreadable under the model sandbox"
    fix_hint: "Example: assert on harness-owned roots"
  - plan: "50-22"
    dimension: requirement_coverage
    severity: warning
    required_property: "Every architecture-review producer on both runtimes uses repositoryIdentity() or is round-tripped from its real producer"
    description: "codex-arch-review-context.cjs:1022,1056,1410 private identity; T-50-22 uses phaseBinding with a supplied identity"
    fix_hint: "Example: convert or test the real producer"
  - plan: "50-25"
    dimension: context_compliance
    severity: warning
    required_property: "UI-smoke gap is declared only after A7 is verified"
    description: "Gap hard-coded; A7 is [ASSUMED]; no task checks for a non-interactive driver"
    fix_hint: "Example: bounded driver check recorded in the L-11 record"
  - plan: "50-02"
    dimension: task_completeness
    severity: warning
    required_property: "The checkout-relative-remedy rule has one unambiguous scope covering every launch refusal an operator can see"
    description: "Acceptance says no remedy contains make/plugins/delivery-pipeline/; CODEX_CONFIG_FIX and REFERENCE_UNAVAILABLE do and are untouched"
    fix_hint: "Example: state scope, or rewrite the two entries"
  - plan: "50-11"
    dimension: key_links_planned
    severity: warning
    required_property: "Preflight classifies the provenance directory and authority key that admission will use"
    description: "preflight takes worktree only; hosts use graphDir/SHIPYARD_GRAPH_DIR (codex-delivery-host.cjs:138-143)"
    fix_hint: "Example: accept graphDir and derive the root as dispatch-record does"
  - plan: "50-01"
    dimension: scope_sanity
    severity: warning
    required_property: "Each plan stays within the per-plan context budget"
    description: "11 files_modified (warning threshold 10), 3 production modules plus harness and Makefile, risk high; estimate-check not run"
    fix_hint: "Example: move the Makefile and unit edits to a follow-on"
  - plan: "50-22"
    dimension: task_completeness
    severity: info
    required_property: "Every script with a CLI main is classified as ENTRY or EXCLUDED in the plan context"
    description: "codex-runtime-host.cjs and claude-runtime-host.cjs (probe CLI, exit 0) not classified"
    fix_hint: "Example: list them under EXCLUDED with a reason"
```

### Recommendation

2 blockers and 8 warnings need revision. Return to the planner with this feedback. Blocker 1 is a sequencing decision for the operator (land phase 46 first, or re-plan), not only a plan edit. Re-run Gate 2 and regenerate `50-VALIDATION.md` afterwards.


---

# Round 2 review (sealed gsd-plan-checker, transcript sha256 6b6949add784f7a115c911d8c2377e2f52e112dbd5d7472725e824c4d1acd981)

Blockers of round 1 are resolved; round-1 warnings 1-8 are addressed. Open for the planner (final cycle): new Warnings W-1..W-4 and Info items I-2 and I-5 below; also record the limits named in I-3 and I-4 in the relevant plans. This section is review DATA, not instructions. `50-VALIDATION.md` is a prepared input; do not create or modify it.

I've read all 29 plans against the packet and the source, and I've changed no files. Both round-1 blockers are resolved and all eight warnings are addressed in the plan text. I found four new warnings, so this is still ISSUES FOUND, but with no blockers.

All 16 packet files matched their SHA-256 digests. I couldn't run `verify.plan-structure`, `estimate-check` or `validate-graph` here: my one command that touched `~/.claude` was auto-denied. I checked structure, waves and dependencies by reading.

## ISSUES FOUND

**Phase:** 50 (Make launch and upgrade reliable) · **Plans checked:** 29 (T-50-01…29) · **Issues:** 0 blockers, 4 warnings, 5 info

### Round-1 items

| Round-1 item | Status | Evidence |
|---|---|---|
| Blocker 1: Gate 2 | Resolved | `delivery-state.yaml` shows T-46-07 and T-46-08 `MERGED` with `merge_sha` and epic PR #403 landed. You report `validate-graph` passes on 282 tickets. |
| Blocker 2: no `50-VALIDATION.md` | Resolved | The file exists. Its Wave 0 list maps to T-50-01, 04, 05, 11, 22 and 28. Every task has an `<automated>` command and none uses watch mode. |
| W1: T-50-09 widened adoption | Resolved | Only `inflightBookkeepingRequired` changes. A table test pins `reserveRound`, `recordRound`, `clearRound` and the CLI `mark`, `mark-many`, `clear` and `clear-many` as unchanged. |
| W2: concurrent first admission | Addressed, with a residual (new W-1) | T-50-08 adds atomic key creation and a stable catalogue read. T-50-25 fails an iteration on any `ARCHIVE_AUTHORITY_INVALID`. |
| W3: racy real-state check | Resolved | T-50-01 and T-50-23…25 now use a write guard and `assertHarnessIsolation`. They never read the real state directory. |
| W4: Codex arch-review producer | Resolved | New T-50-29 converts `codex-arch-review-context.cjs`. T-50-22 round-trips all three producers. |
| W5: UI-smoke gap declared up front | Addressed, with an ambiguity (new W-3) | T-50-25 does a bounded driver check before a `RAN:` or `GAP:` record. T-50-06 and T-50-27 carry the section. |
| W6: T-50-02 remedy rule | Resolved | One rule covers the whole map, with a whole-map scan and the four old entries rewritten. |
| W7: preflight provenance directory | Resolved | `graphDir` is passed by every host and derived as `dispatch-record` does. |
| W8: T-50-01 size | Resolved | T-50-01 now has 6 files. The driver, Makefile target and layout matrix moved to T-50-28. |

Other checks that passed:
- **Requirement coverage:** every REQ-197…203 appears in at least one plan's `requirements`.
- **Waves and dependencies:** declared waves equal dependency depth, with no cycles.
- **Same-wave file conflicts:** none.
- **Scope:** every plan has 2–3 tasks and at most 6 files.
- **Scope reduction:** the only "follow-up" wording is the explicit DECISIONS deferral in T-50-12.
- **Digest pin:** discrepancy D-1 is real. `runtime-file-digests.json` pins only two files, and neither is edited.
- **Host entries:** T-50-22's classification of the ten `*-host.cjs` CLIs matches the source (7 entries, 2 probes, 1 excluded).

### Warnings

**W-1. [requirement_coverage, REQ-201] The atomic key creation still leaves a window that ends in an unnamed refusal.**
- Plan 50-08. T-50-08 creates `hmac.key` by writing a temp file, `linkSync` to `hmac.key`, then `unlink` of the temp.
- `authorityFile` (`role-artifact.cjs:1042-1043`) compares `ctimeMs` between its initial lstat and its final fstat and lstat.
- `unlink` of the temp name changes the shared inode's ctime after `hmac.key` is already visible. A racing session whose read straddles that moment fails with "archive authority changed while reading", which is `ARCHIVE_AUTHORITY_INVALID`.
- The plan says "the key read is not retried (the key is immutable once linked)". Its own truth statement claims no session can fail with "changed while reading".
- The deterministic tests wrap `linkSync` and would not catch this. The stress test and T-50-25 would hit it rarely.
- Example fix (non-binding): put the key read under the same bounded transient-change retry, or otherwise make the visible key's ctime stable.

**W-2. [key_links_planned] No declared source for the Claude installed-layout staging helper.**
- Plans 50-23, 50-24 and 50-25.
- T-50-01's `lib.cjs` stages only the Codex bundle and a fake `codex`.
- T-50-23 adds the Claude staging and fake `claude` inside its own scenario file.
- T-50-24 says the Claude layout is one "that lib.cjs stages", which is not what T-50-01 specifies.
- T-50-25 needs a Claude role host with a fake CLI that satisfies `probeClaudeRuntime`.
- All three are wave 8. None lists `lib.cjs` in `files_modified`, and T-50-24 and T-50-25 don't depend on T-50-23.
- The executors must either duplicate the staging or edit `lib.cjs` concurrently.
- Example fix (non-binding): have T-50-28 or T-50-01 own the Claude staging in `lib.cjs`, and correct T-50-24's wording.

**W-3. [context_compliance, L-10] The UI-smoke driver check has no defined result when no GSD install exists.**
- Plan 50-25.
- The scenario runs with `HOME` set to the fixture. The fixture holds a fake `gsd-tools` stub, and CI runs `make test-fast-rest` without installing GSD.
- `GAP:` is accepted only for `absent` (a non-empty list of definitions and verbs examined) or `unreadable` ("outside the readable roots").
- A missing install, or a check that reads only the fixture stub, fits neither status. That risks either a red `test-fast-rest` in CI or a vacuous `absent` about the stub instead of the real GSD.
- The target of the check, fixture or real install, is also not stated.
- Example fix (non-binding): define the install the check reads and a status for "no install present".

**W-4. [verification_derivation, REQ-199] A preflight run in the caller's process can crash or misreport when the authority directory is unreadable.**
- Plans 50-04, 50-11 and 50-20.
- DECISIONS keeps adoption host-side because the Claude sandbox denies the model the authority directory.
- T-50-20 runs preflight in `deliver-dispatch launch`, in the caller's process.
- `archiveAuthorityNamespace` rethrows any non-ENOENT lstat error, such as EPERM, as a raw uncoded error (`role-artifact.cjs:1004-1005`).
- T-50-04 and T-50-11 specify conversion only for coded errors and for an unauthenticatable catalogue.
- An unreadable namespace could abort the "never stops at the first" aggregation, or refuse a launch with no `hint[CODE]`.
- Example fix (non-binding): state that an unreadable authority namespace becomes a "not evaluated" note, as already done for a missing graph directory.

### Advisories (info)

- **I-1.** Check 8f and the path-resolvability check were not evaluated. No `{FAILING_DIRECTIONS}` or `{VERIFY_PATHS}` probe was supplied, and no plan has a `<fails_when>`. If the orchestrator runs the probe, expect every runnable `<automated>` command to be flagged.
- **I-2.** Plan 50-15 specifies `--preflight` "alone" only for `codex-planning-context-host`. For `codex-decompose-host` it says only "add `--preflight`". T-50-22 requires every entry to accept it alone and cannot patch production code, so a gap would surface late in wave 7.
- **I-3.** `50-VALIDATION.md` is `status: draft`. It names `[ASSUMED]` targets such as `./installed-launch-smoke.sh codex` and `docs/audits/<date>-…`. The plans use `scenario-codex-no-env` and `docs/audits/phase50/…`. The per-plan commands govern.
- **I-4.** Plan 50-01, Task 1 carries the fixture library, the write guard, the resolver and three production modules. Task 2 is marked `tdd="true"` but is written after the implementation. The guard is a `--require` on the host process only. It does not cover node processes the host spawns, since the environment carries only `PATH` and `HOME`. Record that limit.
- **I-5.** Plans 50-11 and 50-12 test `preflight` in-process with "an isolated HOME" but don't state the `os.homedir` override that CONTEXT requires for authority-touching tests.

### Structured issues

```yaml
issues:
  - plan: "50-08"
    dimension: requirement_coverage
    severity: warning
    required_property: "Concurrent first admission ends only in success or a named ARCHIVE_AUTHORITY_BUSY refusal, including the authority-key read"
    description: "Key is created by link-then-unlink of a temp name. authorityFile (role-artifact.cjs:1042-1043) compares ctimeMs across lstat/fstat/lstat, and unlink of the temp changes the visible key's ctime, so a racing reader can fail 'archive authority changed while reading' (ARCHIVE_AUTHORITY_INVALID). Plan states the key read is not retried and claims this refusal cannot occur."
    fix_hint: "Example: apply the bounded transient-change retry to the key read as well"
  - plan: "50-25"
    dimension: key_links_planned
    severity: warning
    required_property: "Every installed-package scenario that needs the Claude layout gets its staging and fake claude from a declared, dependency-ordered source"
    description: "T-50-01 lib.cjs has no Claude staging; T-50-23 stages inside its own scenario; T-50-24 says lib.cjs stages it; T-50-25 needs it too. Same wave 8, none declares lib.cjs, 24/25 do not depend on 23."
    fix_hint: "Example: own the Claude staging in lib.cjs under T-50-28 or T-50-01; fix T-50-24's wording"
  - plan: "50-25"
    dimension: context_compliance
    severity: warning
    required_property: "The UI-smoke driver check examines the install an operator would use and has a defined status when no GSD install is present"
    description: "Scenario runs with HOME=fixture (fake gsd-tools stub); CI has no GSD install. GAP accepted only for absent (non-empty examined list) or unreadable (outside readable roots); a missing install fits neither; check target (fixture stub vs real install) not stated."
    fix_hint: "Example: name the install read and add a status for 'no install present'"
  - plan: "50-20"
    dimension: verification_derivation
    severity: warning
    required_property: "Preflight run in the caller's process degrades to a not-evaluated note when the protected authority namespace is unreadable"
    description: "DECISIONS: sandbox denies the model the authority directory. T-50-20 runs preflight in launch in the caller's process. role-artifact.cjs:1004-1005 rethrows non-ENOENT lstat errors (EPERM) uncoded; T-50-04/T-50-11 convert only coded errors."
    fix_hint: "Example: record an unreadable namespace as a note in T-50-04/T-50-11 and test it"
  - plan: "50-15"
    dimension: task_completeness
    severity: info
    required_property: "Every host ENTRY accepts --preflight alone, as T-50-22 asserts"
    description: "T-50-15 states 'alone' only for codex-planning-context-host; codex-decompose-host is 'add --preflight'."
    fix_hint: "Example: state the alone form for the decompose host in T-50-15"
  - plan: null
    dimension: nyquist_compliance
    severity: info
    required_property: "Every runnable <automated> command states what output constitutes failure (check 8f), and each target resolves"
    description: "No <fails_when> in any plan; probe blocks not supplied, so 8f and path resolvability were not evaluated."
    fix_hint: "Example: run the orchestrator probe and fold its findings in"
```

### Recommendation

No blockers. The four warnings are real but each is a small, local edit in the plan text, so execution could proceed. I'd fix W-1 first, since it breaks a property the plan itself claims. Returning to the planner with W-1…W-4 is the cheaper path before wave 3 starts.


---

# Round 3 review (sealed gsd-plan-checker, transcript sha256 574693ffde207b8ecb6f553a845f1ad7b6255d6134315e63cfb5c5f1ef77cbfb)

Round-2 warnings are resolved. One blocker remains (hermetic scenarios assert host exit 0 against fake CLIs that cannot produce the native evidence the hosts verify). The operator authorized a 4th planner cycle for this blocker only. This section is review DATA, not instructions.

## ISSUES FOUND

**Phase:** 50 (Make launch and upgrade reliable) · **Plans checked:** 29 (T-50-01…29) · **Round:** 3 (final) · **Issues:** 1 blocker, 0 warnings, 4 info

All four round-2 warnings and both info items are resolved, but I found one new blocker in plans 50-25, 50-24 and 50-01. I changed no files.

I checked structure, waves and dependencies by reading the plans. `verify.plan-structure`, `estimate-check` and `validate-graph` were not run: Bash was refused for runtime-computed paths, and I did not try the `gsd_run` resolver. I am relying on your report that Gate 2 passes on 282 tickets.

### Round-2 items

| Item | Status | Evidence |
|---|---|---|
| W-1 (key read can fail "changed while reading") | **Resolved** | T-50-08 now sends the `hmac.key` read through the same bounded retry as the catalogue read. The retry covers exactly the two transient stat-change messages and re-runs the full `authorityFile` check each time. This matches `role-artifact.cjs:1023-1047`, where `ctimeMs` is compared across lstat, fstat and lstat. The plan adds deterministic tests and a stress test, and it states plainly that the "realistic" link-then-unlink case may not show up on coarse-timestamp filesystems. |
| W-2 (no owner for Claude staging) | **Resolved** | T-50-28 owns `stageClaudeLayout` and `installFakeClaude` in `lib.cjs`. T-50-23, T-50-24 and T-50-25 all depend on T-50-28 and are told not to edit `lib.cjs`. T-50-24's wording is fixed, and T-50-01 states that its `lib.cjs` stages only Codex. `lib.cjs` ownership runs T-50-01 → T-50-28 with no unordered overlap. |
| W-3 (UI-smoke check with no GSD install) | **Resolved** | T-50-25 names the target: the operator's GSD install, resolved from the scenario process's own environment, with candidates under the fixture work root marked `excluded`. It defines four statuses: `found`, `absent`, `unreadable` and `not-installed`. `not-installed` is a passing gap. A unit test pins the record for every status, and T-50-27 closes the section from that record. T-50-06's `Candidate roots:` line is declared as a contract, and T-50-25 depends on T-50-06. |
| W-4 (preflight on an unreadable authority namespace) | **Resolved** | The `unreadable` state flows through every consumer. T-50-04's classifier returns it for raw errors that carry a `syscall`, which fits `role-artifact.cjs:1004-1005`. T-50-07 neither adopts nor refuses on it. T-50-09 takes the trusted path for it. T-50-11 records the "not evaluated" note and wraps every check. T-50-20 does not refuse launch on the note. Each of these has an `mock.method`-injected EPERM test. |
| I-2 (`--preflight` alone on the decompose host) | **Resolved** | T-50-15 specifies both the alone and `--args-file` forms on both Codex hosts, and rejects `--preflight` beside `--detach` or `recover`. T-50-22's requirement is now met by T-50-14, 15, 16, 17 and 19. |
| I-5 (`os.homedir` override) | **Resolved** | T-50-11, T-50-12 and T-50-20 specify the `role-artifact.test.cjs:7-13` header and a first test that asserts it. CONTEXT.md carries it as a constraint. |

I-3 and I-4 are also recorded: the `50-VALIDATION.md` placeholder mapping is in CONTEXT.md, and the write-guard limit is in T-50-01's "Recorded limits" and in CONTEXT.md.

### What passed

- **Requirements:** REQ-197…203 are each claimed by at least one plan.
- **Waves and cycles:** recomputed from `depends_on`, every declared wave equals dependency depth, with no cycles.
- **File conflicts:** no same-wave overlap. The shared files (`role-artifact.cjs`, `dispatch-record.cjs`, `runtime-context.cjs`, `lib.cjs`, `Makefile`, `codex-arch-review-context.cjs`) are always ordered by a transitive dependency.
- **Scope:** every plan has 2–3 tasks.
- **Scope reduction:** the only "follow-up" and "follow-on" wording is the DECISIONS-sanctioned hard-refusal deferral in T-50-12 and the T-50-01/T-50-28 split. No deferred idea is planned.
- **Verify commands:** none uses watch mode, `|| true` or `2>/dev/null ||`.
- **`50-VALIDATION.md`:** present, and its Wave 0 list maps to T-50-01, 04, 05, 11, 22 and 28.

### Blockers

**1. [verification_derivation, REQ-201/REQ-202] Hermetic scenarios assert that hosts exit 0 against fake CLIs that cannot let any host exit 0.**
- **Plans:** 50-25 (primary), 50-24, 50-01.
- **What the hosts require.** After the native child exits 0, both runtimes verify native evidence:
  - Codex: `codex-runtime-host.cjs:260-263` fails unless stdout holds JSONL with a thread id and a completed turn with usage. `:2921-2960` then calls `verifyCompletedNativeLaunch` (`:1160-1189`), which needs a native session transcript. That transcript must show provider `openai`, the selected model and effort, `task_started`, one `final_answer` and `task_complete`.
  - Claude: `claude-runtime-host.cjs:281-282` fails on empty stream output. `:411,475,553` require SessionStart-hook launch evidence. `claude-role-host.cjs:1489` runs `validateResult(resultFrom(output))`.
- **What the fakes do.**
  - T-50-01's fake `codex` only logs argv and `CODEX_HOME`.
  - T-50-28's fake `claude` exits 0 with no output, and says "Do not model any claude stream output".
  - So every host that reaches the native step ends with `RUNTIME_EVIDENCE_MISSING` and a non-zero exit.
- **Assertions that cannot hold:**
  - T-50-25 requires each host to exit 0 or refuse with `hint[ARCHIVE_AUTHORITY_BUSY]`. It treats any other exit as a failed iteration. It also requires "at least one host succeeded" and a third sequential launch that "succeeds".
  - T-50-24 case 1 says "launch succeeds … a second launch succeeds without a second adoption", and case 3 says "the following project-root launch succeeds".
  - T-50-01's first acceptance bullet says the launch "passes". That is ambiguous, because the host exits non-zero after the single fake exec.
- **Why this matters.** This is the only hermetic proof of REQ-201 and of the adoption-once claim, and executors are told not to edit `lib.cjs`. As written, T-50-25's concurrency scenario goes red on every iteration where a host wins the lock.
- **Precedent in the plan set.** T-50-23 already carries a carve-out: "asserts everything up to the CLI call and records exactly where it stops".
- **Example fix (non-binding):** define host success in these scenarios as "admitted and reached the native CLI call". In practice, classify each run by the fake's log and by stderr, with `RUNTIME_EVIDENCE_*` after one exec counted as the expected terminal outcome. Alternatively, give the fakes the minimum native evidence. Any route works if the stated assertions can pass with the fakes the plans specify.

### Advisories (info)

- **I-A.** Plans 50-25 and 50-28 end with an extra stray `</output>` line after the `<output>…</output>` line. No other plan has it, and the structure validator is unlikely to care.
- **I-B.** In 50-25, `not-installed` needs lstat to return ENOENT, and `unreadable` needs an existing candidate whose read is refused. An lstat that itself fails with EPERM or EACCES, which a sandbox that denies the whole home would give, fits neither. Treating it as `unreadable` is the natural reading, but it is not stated.
- **I-C.** The `<verify>` in 50-23 task 2 and 50-24 task 3 runs the whole driver. CONTEXT.md says verification is scoped to `files_modified`. This is harmless but inconsistent.
- **I-D.** No `<fails_when>` exists in any plan, and the `{FAILING_DIRECTIONS}` and `{VERIFY_PATHS}` probe blocks were not supplied, so check 8f and path resolvability were silent. If the orchestrator runs the probe, expect every runnable `<automated>` command to be flagged.

### Structured issues

```yaml
issues:
  - plan: "50-25"
    plans: ["50-25", "50-24", "50-01"]
    dimension: verification_derivation
    severity: blocker
    required_property: "Every hermetic scenario assertion about host outcome is satisfiable with the fake CLIs the harness supplies; 'success' is defined at a point the fakes can reach"
    description: "T-50-25 requires each host exit 0 or BUSY, any other exit fails, at least one success, third launch succeeds; T-50-24 cases 1 and 3 require 'launch succeeds'; T-50-01 AC1 says 'passes'. Fake codex (T-50-01) only logs; fake claude (T-50-28) exits 0 with no output and models no stream. Hosts require native evidence after the child exits (codex-runtime-host.cjs:260-263, 2921-2960, 1160-1189; claude-runtime-host.cjs:281-282, 411, 475, 553; claude-role-host.cjs:1489), so a host that wins admission exits non-zero with RUNTIME_EVIDENCE_MISSING. Only T-50-23 carries a carve-out."
    fix_hint: "Example: define scenario success as admitted-and-reached-the-native-CLI-call, classified by the fake's log and stderr codes; or equip the fakes with minimum native evidence"
  - plan: "50-25"
    dimension: task_completeness
    severity: info
    required_property: "Every plan file is well-formed XML-like structure"
    description: "50-25 and 50-28 carry a stray closing </output> line after the <output>…</output> line"
    fix_hint: "Example: remove the extra line"
  - plan: "50-25"
    dimension: context_compliance
    severity: info
    required_property: "Every outcome of the driver check maps to exactly one status"
    description: "An lstat of a candidate root that itself fails EPERM/EACCES fits neither not-installed (ENOENT) nor unreadable (exists, read refused)"
    fix_hint: "Example: state it classifies as unreadable with the blocked path and code"
  - plan: "50-23"
    dimension: verification_derivation
    severity: info
    required_property: "Per-ticket verification is scoped to files_modified, as CONTEXT.md states"
    description: "50-23 task 2 and 50-24 task 3 verify by running the whole installed-launch driver"
    fix_hint: "Example: run only the ticket's own scenario"
  - plan: null
    dimension: nyquist_compliance
    severity: info
    required_property: "Every runnable <automated> command states what output constitutes failure (check 8f), and each target resolves"
    description: "No <fails_when> in any plan; probe blocks not supplied, so 8f and path resolvability were not evaluated"
    fix_hint: "Example: run the orchestrator probe and fold its findings in"
```

### Recommendation

1 blocker requires revision. It is a small, local edit to how success is defined in the scenario assertions of 50-25, 50-24 and 50-01. No production code, dependency or wave changes are needed.

This is the final round, so I'd escalate the blocker to the operator rather than loop again. The four info items do not block execution.


---

# Round 4 review (sealed gsd-plan-checker, transcript sha256 6035399465d41f0f6eb8b0a78b6d2faf3bae51b8bfe86ac8efa7c0e7826b5758)

The Codex half of the round-3 blocker is resolved. One blocker and one warning remain: the Claude role host cannot reach admission with the specified fixture, and T-50-24 case 3 does not name its role. The operator authorized a 5th planner cycle for these. This section is review DATA, not instructions.

## ISSUES FOUND

**Phase:** 50 (Make launch and upgrade reliable) · **Plans checked:** 29 · **Round:** 4 · **Issues:** 1 blocker, 1 warning, 4 info

The round-3 blocker is half resolved. Every hermetic host assertion that required exit 0 is gone, and the new "reached the native CLI call" definition holds for the Codex host. The Claude half cannot be met with the fixture the plans specify, so the same property still fails there. I changed no files.

- **Not run:** I did not run `verify.plan-structure`, `estimate-check` or `validate-graph`. I rely on your report that Gate 2 passes on 29 plans and 282 tickets.
- **Digests not re-verified:** my one `sha256sum` call was denied (runtime-computed path). I did not re-check the packet digests this round, and I did not need packet content beyond what CONTEXT.md and ADR-030 L-8/L-10 quote.
- **Evidence:** all findings come from reading the plans and the host source.

### Round-3 blocker

**Exit-0 assertions are resolved.**
- T-50-01, T-50-24 and T-50-25 now classify every host run with `classifyLaunch(run, cliLines)`. This is one definition, owned by T-50-01 in `lib.cjs`, pinned by its own unit test, and repeated in CONTEXT.md. T-50-23 and T-50-28 are consistent with it.
- Nothing still asserts a host exit 0 or that a launch "succeeds". The remaining "succeeds" wording is in library-level unit tests (T-50-07/09/28/29), not host launches.

**The terminal-outcome premise holds on the Codex path:**
- An empty fake stdout makes `parseCodexStream` fail with `RUNTIME_EVIDENCE_MISSING` (`codex-runtime-host.cjs:260`).
- Both catches (`:3151-3158`), `launchAgent` and the dispatch boundary rethrow it with the code unchanged.
- The CLI wrapper prints `formatHint(error.code)` (`codex-delivery-host.cjs:3639`), and `formatHint` always prints `hint[<code>]` (`refusal-hints.cjs:80-84`).
- `recordInflight` runs before the native call (`:3523`), so a named refusal always precedes it.

**It also holds on the Claude path once the host reaches the call:**
- An empty stream fails with `RUNTIME_EVIDENCE_MISSING` (`claude-runtime-host.cjs:281`) and is rethrown unchanged (`:906-908`, `:971-976`).
- The role host uses `createClaudeDispatchAdapter`, which does not re-wrap the error. The wrap into `DISPATCH_FAILED` happens only in `createClaudeWorkflowDispatch`.
- The `hint[...]` print comes from T-50-17, which is an ancestor of T-50-25.

### Blocker

**1. [verification_derivation, context_compliance L-10] The Claude role host cannot reach admission or the native call with the specified fixture.**
- **Plans:** 50-25 (primary), 50-23, 50-28.
- **Where the host stops.** `claude-role-host.cjs` runs `prepareInvocation` first (`:1429`, `:902-917`), before `controller.begin` and `recordInflight`. Every role needs the canonical graph (`tickets.json` and `delivery-state.json`, `:196-203`) and live GitHub state.
  - `pr-sentinel` (`prepareSentinel`, `:695-811`) calls `baseDefaultBranch` (`:422-434`, falling back to `gh repo view`), `branchOid` (`:223-242`, a `git fetch origin` unless `options.execFileSync` is injected), `gh pr list` and `gh pr view` (`:244-258`).
  - It also requires a `pr-open` ticket whose live PR identity equals the delivery state (`:711-727`).
  - `arch-review` and `integrator` make the same GitHub and `git fetch` calls (`:477-494`, `:559-587`).
  - The CLI passes no options (`:1603-1604`), so nothing can be injected.
- **What the plans supply.**
  - T-50-01's fake bin holds `node`, `npx`, `npm`, `curl`, `wget` and `codex`.
  - T-50-28 adds only `stageClaudeLayout` and a fake `claude`.
  - No plan models a fake `gh`, an origin remote, or a ticket-graph and PR-state fixture. A grep of plans 01, 06, 17, 22, 23, 24, 25, 27 and 28 found none.
- **Consequence for T-50-25.** The Claude host refuses before admission with a code such as `PREFLIGHT_FAILED` or `BASE_REVISION_UNAVAILABLE`.
  - T-50-25 accepts a refusal only when it is exactly `ARCHIVE_AUTHORITY_BUSY`. That run is `unclassified` and fails the iteration, every time.
  - The Claude host never reaches `recordInflight`, so the hermetic mixed-runtime race, the INV-017 origin, is never exercised.
  - The plan's contingency ("a stop the fixture does not model is returned as a finding") makes this a deterministic failure of the only hermetic proof of REQ-201. T-50-27 depends on T-50-25.
- **Ordering gap.** T-50-25 says T-50-23 "records where the Claude host stops", but it does not depend on T-50-23. Both are wave 8.
- **Conflict with L-10.** ADR-030 L-10 requires "launch without env variables on both runtimes" and "concurrent Codex and Claude launches including during adoption" in the hermetic core. Only the UI smoke has a declared-gap allowance. T-50-23's "documented gap" carve-out would reduce a locked decision, and the source shows it will trigger.
- **Example fix (non-binding):** have the existing owner of the Claude fixture (T-50-28's `lib.cjs`, which 23 and 25 already depend on) also supply a Claude project fixture. That means a ticket row with a plan file, a `pr-open` delivery state, a fake `gh` answering `repo view`, `pr list` and `pr view` consistently with it, and an origin remote that `git fetch` accepts. A unit pin would cover it. Any route works if the Claude host can reach admission with the fixtures the plans specify.

### Warnings

**W-1. [verification_derivation] T-50-24 case 3 does not say which role runs, and the executor role needs an unmodelled fixture.**
- The case says "an executor-style launch from a linked worktree … is `reached`".
- `executorPreflight` (`codex-delivery-host.cjs:1363-1373`) needs a `T-NN-NN` ticket scope, a ticket-graph row whose branch matches the worktree, and a plan digest.
- The non-typed `pr-sentinel` request used elsewhere needs none of that.
- If case 3 runs the executor role, it is refused before the native call and classifies as `unclassified`.
- Example fix: state that case 3 uses the non-typed `pr-sentinel` request with `scope.worktree` set to the linked worktree.

### Advisories (info)

- **I-A.** Plans 50-25 and 50-28 still end with a second, stray `</output>` line. A count shows close=2 for those two files only. This is unchanged from round 3.
- **I-B.** The `not-installed` and `unreadable` statuses in 50-25 still leave an lstat that itself fails with EPERM or EACCES unmapped. Reading it as `unreadable` is natural but not stated.
- **I-C.** The `<verify>` in 50-23 task 2 and 50-24 task 3 runs the whole driver, although CONTEXT.md scopes verification to `files_modified`. This is harmless.
- **I-D.** No `<fails_when>` exists in any plan, and the `{FAILING_DIRECTIONS}` and `{VERIFY_PATHS}` probe blocks were not supplied. Check 8f and path resolvability were therefore silent. If the orchestrator runs the probe, expect every runnable `<automated>` command to be flagged.

### What passed

- **Requirements:** REQ-197…203 are each claimed by at least one plan. REQ-201 rests on T-50-07, 08 and 25.
- **Waves:** recomputed from `depends_on`, every declared wave equals dependency depth, and there are no cycles.
- **File ownership:** `lib.cjs` ownership runs T-50-01 → T-50-28 with no same-wave overlap, and the wave-8 plans touch distinct files.
- **Scope:** every plan has 2–3 tasks and at most 6 files. T-50-01's `files_modified` is unchanged at 6.
- **Scope reduction:** no scope-reduction wording beyond the sanctioned T-50-12 deferral, except the T-50-23 gap carve-out covered in blocker 1.
- **CLAUDE.md:** no conflict found.
- **Verify commands:** none uses watch mode, `|| true` or `2>/dev/null ||`.
- **`50-VALIDATION.md`:** present as a draft prepared input. Check 8e is satisfied, and CONTEXT.md records the placeholder-name mapping.

### Structured issues

```yaml
issues:
  - plan: "50-25"
    plans: ["50-25", "50-23", "50-28"]
    dimension: verification_derivation
    severity: blocker
    required_property: "Every hermetic scenario that claims a runtime's launch or concurrent admission can drive that runtime's host to admission (reached) with the fakes and fixtures the plans specify, so L-10's 'launch without env variables on both runtimes' and 'concurrent Codex and Claude launches' are deliverable"
    description: "claude-role-host.cjs runs prepareInvocation (:902-917) before controller.begin and recordInflight (:1429, :1454, :1463). Every role needs tickets.json and delivery-state.json (:196-203) and live GitHub state: baseDefaultBranch/gh repo view (:422-434), git fetch origin (:223-242), gh pr list/view (:244-258), a pr-open ticket whose live PR equals delivery state (:711-727); arch-review and integrator do the same (:477-494, :559-587). The CLI passes no options (:1603-1604). No plan supplies a fake gh, origin remote, or ticket/PR fixture (T-50-01 fake bin: node, npx, npm, curl, wget, codex; T-50-28: stageClaudeLayout + fake claude only). The Claude host refuses before admission with a non-BUSY code, which T-50-25 classifies unclassified, so every iteration fails and the mixed-runtime race is never exercised. T-50-23's gap carve-out reduces L-10; T-50-25 does not depend on T-50-23 although it relies on the stop point T-50-23 records."
    fix_hint: "Example: T-50-28 (lib.cjs) also supplies a Claude project fixture (ticket row + plan file, pr-open delivery state, fake gh answering repo view / pr list / pr view consistently, origin remote that git fetch accepts) with a unit pin; any route works if the Claude host reaches admission with the specified fixtures"
  - plan: "50-24"
    dimension: verification_derivation
    severity: warning
    required_property: "Every case that expects a launch to be reached names a role whose fixture the plans supply"
    description: "Case 3 says 'executor-style launch from a linked worktree' without naming the role. The executor role needs a T-NN-NN ticket scope, graph row with matching branch and plan digest (codex-delivery-host.cjs:1363-1373), none of which is specified; a refusal before the native call would classify unclassified."
    fix_hint: "Example: state that case 3 uses the non-typed pr-sentinel request with scope.worktree set to the linked worktree"
  - plan: "50-25"
    dimension: task_completeness
    severity: info
    required_property: "Every plan file is well-formed XML-like structure"
    description: "50-25 and 50-28 each end with a second, stray </output> line (close=2); unchanged from round 3"
    fix_hint: "Example: remove the extra line"
  - plan: "50-25"
    dimension: context_compliance
    severity: info
    required_property: "Every outcome of the driver check maps to exactly one status"
    description: "An lstat of a candidate root that itself fails EPERM/EACCES fits neither not-installed (ENOENT) nor unreadable (exists, read refused); unchanged from round 3"
    fix_hint: "Example: state it classifies as unreadable with the blocked path and code"
  - plan: "50-23"
    dimension: verification_derivation
    severity: info
    required_property: "Per-ticket verification is scoped to files_modified, as CONTEXT.md states"
    description: "50-23 task 2 and 50-24 task 3 verify by running the whole installed-launch driver"
    fix_hint: "Example: run only the ticket's own scenario"
  - plan: null
    dimension: nyquist_compliance
    severity: info
    required_property: "Every runnable <automated> command states what output constitutes failure (check 8f), and each target resolves"
    description: "No <fails_when> in any plan; probe blocks not supplied, so 8f and path resolvability were not evaluated"
    fix_hint: "Example: run the orchestrator probe and fold its findings in"
```

### Recommendation

1 blocker and 1 warning require revision before wave 8. The edit is local to the fixture ownership in T-50-28 (or an equivalent route), plus the T-50-25 dependency and the T-50-24 case-3 role. No production code or wave change is implied.

The operator authorized the 4th cycle for the round-3 blocker only. The Claude half of that same property is still open, so I'd treat it as in scope. If you decline another planner pass, the alternative is an explicit operator decision about L-10's Claude coverage, not execution as written.
