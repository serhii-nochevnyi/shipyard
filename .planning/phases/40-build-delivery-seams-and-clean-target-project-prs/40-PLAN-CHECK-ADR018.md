# Phase 40 — ADR-018 additions (T-40-28..T-40-38): plan check

**Checked:** 2026-09-25 · **Plans:** 40-28..40-38 · **Inputs:** ADR-018, 40-CONTEXT.md "ADR-018 additions" (D-43..D-53), 40-RESEARCH-ADR018.md, REQUIREMENTS.md REQ-151..REQ-159, CLAUDE.md
**Mode:** goal-backward, adversarial. The Gate 2 result was not used as the verdict. 3 convergence cycles were run.

## Verdict

**PASSED WITH ADVISORIES, after revision.** Cycle 1 found 4 blockers and 6 warnings in the plans. All were fixed in the plan files and in the ADR-018 section of 40-CONTEXT.md. Cycle 2 re-read the edited plans and found one remaining inconsistency (T-40-33 scope 2), which was fixed. Cycle 3 found no new plan-level issues. Two warnings remain outside the files this check may edit, and are listed under "Open (outside edit scope)".

`validate-graph.cjs` on the revised plans: `OK — 196 ticket(s), 20 wave(s)`. It showed no ordering error and no unordered overlap for T-40-28..38. It only warned about new files that the tickets create. The run regenerated `.planning/graph/tickets.{json,yaml}`. That change was reverted, because those files are outside this check's edit scope (see Open).

## Requirement coverage

| Req | Tickets (code → prose) | Status |
|---|---|---|
| REQ-151 tree-object carry on the T-40-19 carrier | T-40-35 (→ T-40-37 describes it) | COVERED |
| REQ-152 one conditions module, every host checks it, copyable remedy | T-40-28, 29 (module); T-40-32 (role host); T-40-33 (Claude/Codex delivery, including drift-check, and decompose); T-40-34 (ticket-worktree, finalizer, base-merge); T-40-37 | COVERED (drift-check added in cycle 1) |
| REQ-153 `info/exclude` entries and `verify` | T-40-34, T-40-37 | COVERED |
| REQ-154 out-of-scope mutation restored and reported | T-40-28/29 helpers; T-40-32 (Claude roles); T-40-33 (Codex judgment roles, Claude drift-check, and executor/repair out-of-scope paths) | COVERED (executor, repair and drift-check added in cycle 1) |
| REQ-155 historical executor validation, PR against the live base | T-40-36, T-40-37 | COVERED |
| REQ-156 scoped integrator diff, `.planning` digest, named remedy | T-40-31 | COVERED |
| REQ-157 draft accepted for arch-review only; sentinel and merge refuse | T-40-30 (with a pin test), T-40-37 | COVERED |
| REQ-158 late PRs excluded, changed members expire | T-40-30 | COVERED |
| REQ-159 offline deterministic pending seeding | T-40-38 | COVERED |

## Scope fences

| Fence | Evidence | Result |
|---|---|---|
| No weakening of head, base or round binding | T-40-30 keeps the head, base and membership refusals and splits their messages. T-40-35 now states that `readGate` binds `head` to the queried sha with exact comparison. T-40-36 keeps head, head tree and base name live-equal. | OK (T-40-35 made explicit) |
| Carry on tree objects, built on T-40-19 | T-40-35: `diff-tree --no-renames --raw --full-index` delta identity, declared-path disjointness via `path-owner`, full 40-hex `base_tree` ≤ 140 chars, escalation if it does not fit | OK |
| One scratch registry consumed by all hosts | T-40-28 builds it from the role-artifact exports. T-40-32, 33 and 34 delete the local lists, and T-40-33 has a grep acceptance for this. | OK |
| Evidence path absent before launch | T-40-28 `EVIDENCE_BY_PROFILE` (added) plus move-aside with sha256 | OK (per-profile set added) |
| Restore of out-of-scope mutations | Snapshot is lstat/digest based, independent of `info/exclude`. No `git clean`, no symlink follow. Restore runs on the failure path too. | OK |
| Historical executor mode keeps the base binding | Explicit `--historical` only. It binds the recorded base commit, base tree, ancestry to HEAD, and the base name. There is no fallback. | OK |
| Integrator code diff, `.planning` digest, refusal with remedy | T-40-31, including the measure command | OK |
| Draft accepted only for arch-review | T-40-30; `sentinel-draft-merge.test.cjs` pins the merge refusal | OK |
| Sentinel excludes late PRs | T-40-30: excluded tickets never reach the result, record or artifact; a gh failure still refuses | OK |
| gsd-sync stays offline and fail-closed | T-40-38: blockers kept, remedy appended, seeder writes inside the state lock (added) | OK |

## Dependency and ownership check (shared files)

`claude-role-host.cjs` and its test: 16 → 22 → 30 → 31 → 32 ✓. `role-artifact.cjs`: 18 → 36 ✓. `gate-trailer.cjs`/`trailer.test.cjs`: 19 → 35 ✓. `ticket-worktree.sh`/finalizer: 18 → 27 → 34 ✓. The four hosts: 10/13/14/12 → 11 → 33 ✓. The existing Codex host tests: 09 → 33 (edge **added**). `deliver.md`: 24 → 37 ✓. `decompose.md`: 25 → 38 ✓. `worktree-conditions.cjs`: 28 → 29 ✓. No new ticket edits `state-sync.cjs`, `sentinel.cjs` or `deliver-dispatch.cjs` (T-40-14/15), which matches D-43/D-44. Among new tickets, `files_modified` overlap only along the chains above. Waves are consistent with `depends_on`. Diamond children 29, 32, 33, 34 and 37 carry the D-42 note (added for 29).

## Issues found in cycle 1, all fixed

```yaml
issues:
  - plan: "40-33"
    dimension: requirement_coverage
    severity: blocker
    required_property: "Every role that runs in a ticket worktree is checked before launch and has its out-of-scope mutations restored (REQ-152, REQ-154)"
    description: "Claude drift-check runs through claude-delivery-host.cjs (workflow drift-gate, driftPreflight) with no conditions check and no restore, and T-40-28 had no drift-check profile, although T-40-33 listed Codex drift-check as a judgment role."
    fix_hint: "Add a drift-check profile (T-40-28) and wire drift-gate check, snapshot and restore (T-40-33)."
    resolution: "Fixed: T-40-28 profile plus EVIDENCE_BY_PROFILE; T-40-33 scope 1, tests and acceptance; CONTEXT D-54."
  - plan: "40-33"
    dimension: scope_reduction
    severity: blocker
    required_property: "A role's out-of-scope worktree mutation is restored by the host and never left for the next launch, for executors and repairs as well"
    description: "The plan said 'Executors and repairs keep the finalizer-based scope check'. The finalizer only refuses (delivery-commit-finalizer.cjs:147-148 'out-of-scope paths'), so the paths stay and the next launch refuses."
    resolution: "Fixed: host restores and reports uncommitted paths outside the declared files, even after a finalizer refusal. HEAD and host commits are untouched. There is a test and CONTEXT D-54."
  - plan: "40-33"
    dimension: dependency_correctness
    severity: blocker
    required_property: "A ticket whose verification runs a test file that a phase-40 ticket edits is ordered after that ticket, and owns the file if its change breaks it"
    description: "T-40-33 required codex-delivery-host.test.cjs and codex-decompose-host.test.cjs (T-40-09) to 'stay green unmodified' with no edge to T-40-09. The new executor base-freshness precondition needs an origin remote, and the Codex fixture has none (grep -c origin → 0)."
    resolution: "Fixed: depends_on adds T-40-09. The four existing host tests are in files_modified for fixture adaptation only, and no assertion may be weakened."
  - plan: "40-35"
    dimension: task_completeness
    severity: blocker
    required_property: "Tests that encode the behaviour a ticket changes are in its files_modified and its verification"
    description: "tests/unit/files-contract.test.cjs:401-420 asserts that a sibling squash on an undeclared, unchanged path refuses the carry, which D-51 reverses. Its stub gh does not serve the statuses endpoint. tests/smoke/sentinel-smoke.sh carries T-40-19's description grammar. Neither file was listed or run."
    resolution: "Fixed: both files added, scope 6-7 and verification added. The old-grammar description stays readable, never carries."
  - plan: "40-28"
    dimension: task_completeness
    severity: warning
    required_property: "classify never makes gitignored non-registry paths refuse a launch"
    description: "classify ran 'git status --ignored' without a rule for '!!' entries, such as the target .planning copy, node_modules, or the stop-gate ledger."
    resolution: "Fixed: only '??' entries outside the registry are unknown; there is a test."
  - plan: "40-28"
    dimension: context_compliance
    severity: warning
    required_property: "Every precondition is satisfiable in a target project with untracked .planning/ by following its remedy"
    description: "The graph-inside-worktree precondition for roles had no answer in target projects (D-47 only covered executors). The ticket-worktree remedy copies only the plan, so the refusal could never clear."
    resolution: "Fixed: GRAPH_OUTSIDE_WORKTREE only applies when .planning is tracked; otherwise a host-side graph is required. materializePlan refreshes a stale copy. D-54, with tests in T-40-28 and T-40-32."
  - plan: "40-32/40-33"
    dimension: verification_derivation
    severity: warning
    required_property: "The refusal the operator sees carries the module's copyable remedy"
    description: "Hosts format refusals through refusal-hints.cjs, which knows none of the new codes. No test asserted that the remedy reaches the printed refusal."
    resolution: "Fixed: test cases and acceptance in both plans."
  - plan: "40-38"
    dimension: task_completeness
    severity: warning
    required_property: "delivery-state.json is written only inside the state lock, and seeding is deterministic across machines"
    description: "state-sync.cjs:89 declares a single writer inside the 'state' lock (lock.cjs). The seeder only wrote atomically, and its row order was unspecified."
    resolution: "Fixed: withLock/writeAtomic, ascending id order, and tests for both."
  - plan: "40-35"
    dimension: context_compliance
    severity: warning
    required_property: "Dropping head= from the status description keeps exact head binding"
    description: "'head is implicit' did not say where readGate gets head from."
    resolution: "Fixed: readGate sets head to the queried full sha, and a status on another sha is never conform."
  - plan: "phase"
    dimension: research_resolution
    severity: warning
    required_property: "RESEARCH.md open questions are resolved before execution"
    description: "40-RESEARCH-ADR018.md '## Open Questions' (5) had no resolution marker."
    resolution: "Fixed in 40-CONTEXT.md ADR-018 section: a resolution line maps Q1-Q5 to D-44/45/47/51/54 and the operational note."
  - plan: "40-29"
    dimension: dependency_correctness
    severity: info
    required_property: "Diamond children state the D-42 dispatch precondition"
    resolution: "Fixed."
  - plan: "40-31"
    dimension: task_completeness
    severity: info
    required_property: "The new module has no circular import with its caller"
    resolution: "Fixed: maxBytes is passed by the caller."
```

## Open (outside edit scope), for the orchestrator or planner

```yaml
issues:
  - plan: "phase"
    dimension: requirement_coverage
    severity: warning
    required_property: "The planning PR that adds T-40-28..38 passes gsd-sync --check offline (CONTEXT operational note)"
    description: ".planning/graph/delivery-state.json has no row for any of T-40-28..T-40-38 (grep count 0 for each), and tickets.json/tickets.yaml predate this revision (T-40-33 now depends on T-40-09)."
    fix_hint: "Re-run validate-graph.cjs, add pending rows for T-40-28..38, and regenerate the gsd-sync projections in the planning commit."
  - plan: "40-19"
    dimension: task_completeness
    severity: warning
    required_property: "T-40-19 keeps tests/unit/files-contract.test.cjs green"
    description: "T-40-19 moves carry to the statuses endpoint, but files-contract.test.cjs's stub gh answers only pr view/pr edit, and T-40-19 does not list that file. The suite goes red from T-40-19 until T-40-35 lands."
    fix_hint: "T-40-19 lists files-contract.test.cjs and switches the stub, or accepts T-40-35 as the owner and runs it."
```

## Advisories (no revision needed)

- T-40-33 now touches 9 files across four hosts. That is within the limit (below 10), but it is the heaviest ADR-018 ticket. Its human checkpoint stays.
- A carried status keeps `drift-check=` and `degenerate-green=` from the judged status, as today. A sibling that changes `.planning/architecture/` is not in the ticket's declared paths, so the carry does not re-owe drift. That matches ADR-018 ("a conform verdict carries"), and drift freshness stays with the merge gates.
- Codex parity is by construction: the scripts are copied wholesale by `gen-codex-shipyard.cjs`, and the prose (`deliver.md`, `decompose.md`, `references/integrator.md`) is regenerated. The operator runs `make install-shipyard-codex && make test-codex-shipyard` after the merge.

## Changes made (files)

- 40-28-PLAN.md: drift-check profile, `EVIDENCE_BY_PROFILE`, ignored-entry rule, target-project graph rule, predicate `allowed`, refreshing `materializePlan`, tests, acceptance.
- 40-29-PLAN.md: D-42 diamond note.
- 40-31-PLAN.md: `maxBytes` parameter.
- 40-32-PLAN.md: remedy-surfacing and target-project test cases and acceptance.
- 40-33-PLAN.md: `depends_on` + T-40-09; four existing host tests in `files_modified` (fixture-only); drift-gate wiring; executor/repair out-of-scope restore; tests; acceptance.
- 40-34-PLAN.md: `files-contract.test.cjs` regression run.
- 40-35-PLAN.md: `files-contract.test.cjs` and `sentinel-smoke.sh` owned and run; head binding; legacy-grammar compatibility; test strategy.
- 40-38-PLAN.md: state lock, deterministic order, tests.
- 40-CONTEXT.md (ADR-018 section only): D-43 owner list, new D-54, Open Questions resolution, T-40-33 row.
