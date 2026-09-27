# Phase 44 — Plan check (first pass: P44-A, P44-D, P44-G)

- **Checker:** gsd-plan-checker (Claude, claude-opus-5-5), 2026-09-27
- **Source revision:** `26da3b2cac96d7fbafd6f2e2c488d9497c36e122` (worktree `plan44-decompose`)
- **Inputs:** CONTEXT.md (binding), ADR-021, INV-009 DECISIONS/RESEARCH, 44-RESEARCH.md, 44-01..07-PLAN.md, all 19 `43-*-PLAN.md`, CLAUDE.md
- **Verdict:** **PASSED after revision.** One checker revision cycle. Four issues fixed in the plans (one blocker, three warnings) and two INFO references corrected. No blocker is left open. Two advisories remain (below).

## Gate 2

`node ~/.claude/plugins/cache/shipyard/shipyard/0.67.0/scripts/validate-graph.cjs` exits 0 before and after the edits: `validate-graph: OK — 228 ticket(s), 20 wave(s)`. `tickets.json`/`tickets.yaml` are unchanged by the edits. Phase-44 warnings are expected ones only: new files that the tickets create, and import-only `depends_on` (T-44-02/03/06 → T-44-01 for `subscription-observation.cjs`, T-44-04 → T-44-03 for `subscription-store.cjs`, T-44-05 → T-44-04 for the collector bundle). Each of those edges is a real code import.

## Phase-43 file ownership

The 25 unique phase-44 `files_modified` paths were compared with the parsed `files_modified` of all 19 `43-*-PLAN.md` files (113 entries). **There is no overlap.** Each file on the CONTEXT avoid list (`install-shipyard-claude-hook.sh`, `runtime-context.cjs`, `docs-smoke.sh`, `claude-hook-smoke.sh`, `claude-role-host.cjs`, `role-artifact.cjs`, `validate-graph.cjs`, `deliver-dispatch.cjs`, `pipeline-config.cjs`, `commands/*.md`, delivery-rules skills, `claude-dispatch-adapter.cjs`, `runtime-adapters.cjs`, both runtime hosts) appears only as a read-only or excluded reference.

## Requirement and decision coverage

| Req / decision | Plans | Status |
|---|---|---|
| REQ-176 / D-A1 | 01 (parser), 02 (usage-report wiring) | Covered; no host edit, no process or network |
| REQ-177 / D-A2 | 04 (collector, capture), 05 (own installer and make targets) | Covered; isolated homes; restores only owned settings |
| REQ-178 / D-A3 | 01, 02, 04 | Covered; no positional mapping, no sums, closed discontinuity set |
| REQ-179 / D-A4 | 01 (`COVERAGE` constants), 02, 03 | Covered; no app-server client or daemon |
| REQ-180 / D-A5 | 03 (store), 05 | Covered; 0700/0600, retention, `.planning`/git-tree refusal |
| REQ-181 / D-A6 | 01, 03, 04, 05 | Covered; label map, `unattributed`, negative fixture |
| REQ-182 / D-D1 | 06 | Covered; 7-key comparison, shadow dedupe, 4 lifecycle classes, `automatic_transfer.allowed: false` |
| REQ-183 / D-G1 | 07 | Covered; new versioned schemas, human-only decision, nothing active |
| REQ-184 / D-X1 | all | Covered; tri-state status and `inconclusive` in every report; no savings percentage in any acceptance text (scanned) |

No task implements P44-B, C, E or F, or anything ADR-021 lists as out of scope. `instruction_digest` is only consumed (06), and 06 states the resulting `unknown` explicitly. Verification commands are all `node`, `bash` or `make` and scoped to each plan's files. `make test-fast` does not appear in any plan's verification list. Every plan has a RED step that fails on base.

## Issues fixed in this pass

### Blocker (fixed)

**1. [task_completeness] T-44-07: the report's metrics must be computable from real overhead-row fields.**
- Evidence: overhead rows (`orchestration-overhead.cjs:168-238`) have no `ticket` and no rung field. The plan joined repair rows "for the same ticket" and defined escalation as "rows whose rung is not the base rung". It also filtered eligibility per row by role and model. That filter would drop exactly the `ci-fix`/`review-fix` and `critical`-rung (opus/low) rows the metrics must count, so the "one repair round and one escalation" acceptance could not pass.
- Fix applied: outcomes carry `run_ids` and rows join through `run_id`. Eligibility and arm assignment are per work unit. Every row of an eligible unit counts. Escalation is (model, effort) ≠ the arm's. A new acceptance line covers this. The contradictory `policy_hash` refusal-vs-report wording is also clarified.

### Warnings (fixed)

**2. [verification_derivation] T-44-03 `resolveRoot` must accept OS-level symlinked temp roots and still refuse owned symlinks.**
- Evidence: "every component is checked with `lstat`" and "refuses a path through a symlink" would refuse every `os.tmpdir()`/`mktemp -d` root on macOS (`/var` → `/private/var`). That breaks the T-44-03 unit tests and the T-44-05 smoke case 3 on the development host.
- Fix applied: the store canonicalizes the deepest existing ancestor with `realpathSync`. It `lstat`-refuses only the store-owned components, then runs the `.planning`/git-tree checks on the canonical path. Acceptance adds a symlinked `subscription/` case and a macOS temp-root case.

**3. [cross-plan data contract] The new `inline_shapes` apply to every unit test, so later tickets must not write quota records inline.**
- Evidence: `boundary-fixtures.test.cjs` `scanInlineShapes` scans all `tests/unit/*.test.cjs`. The T-44-01 patterns (`rate_limit_event`, `rate_limits`/`used_percent`) would fail CI when T-44-02's malformed-record case or T-44-06's `quota` input is hand-written. Neither ticket may edit the boundary manifests.
- Fix applied: 44-01 defines the key-form pattern (it never matches `used_percentage`) and the build-by-mutating-fixture rule. 44-02 and 44-06 state the rule and add `node tests/unit/boundary-fixtures.test.cjs` to their verification.

**4. [nyquist 8e] VALIDATION.md must exist for the phase.**
- Evidence: `nyquist_validation: true`, and 44-RESEARCH has a Validation Architecture section, but there was no `44-VALIDATION.md` (phases 41 and 43 have one).
- Fix applied: wrote `44-VALIDATION.md` in the phase-43 format. It is mechanically derived from the plans' verification lists and waves, and marked draft with `nyquist_compliant: false` until execution.

### Info (fixed)

- 44-07: the `POLICY` re-export reference now points to `model-policy.cjs:45-48` and `model-policy-internal.cjs:1027-1045` (the old `model-policy.cjs:1027-1039` does not exist; that file has 71 lines).
- 44-05: the Makefile `test-fast` list is at `:58`, not `:60`.

## Remaining advisories (not blocking)

- **[research_resolution] WARNING:** the `44-RESEARCH.md` `## Open Questions` heading has no `(RESOLVED)` marker. All six questions are resolved in the binding CONTEXT.md planning notes (OQ1 by the host check, OQ2–6 adopted), and the plans implement those resolutions. This checker did not edit research artifacts. Marking the heading `(RESOLVED)` is housekeeping.
- **[scope] INFO:** REQ-180's "tracked reports carry only derived per-outcome and per-cohort values" is met as a constraint: no plan writes quota data to a tracked path, and `usage-report` output goes to stdout. This pass produces no per-outcome quota join, and `account_scope` in the overhead cohort key stays unfilled. That join belongs to later measurement work, not to a stated first-pass deliverable.
- **INFO:** T-44-03's git-working-tree refusal also fails closed when the operator's home directory is itself a git working tree (a dotfiles repository). That is safe, but the operator must then pass `--state-root`. T-44-05's README text could mention it.
- **INFO:** the 44-RESEARCH validation table labels P44-D/P44-G as T-44-07/T-44-08 (from the original eight-ticket proposal). The actual tickets are T-44-06/T-44-07; `44-VALIDATION.md` records the mapping.

## Structured issues

```yaml
issues:
  - plan: "44-07"
    dimension: task_completeness
    severity: blocker
    status: fixed
    required_property: "Every report metric is computable from fields overhead rows and outcomes actually carry, and eligibility never drops the work the metrics count"
    description: "Rows carry no ticket or rung; per-row role/model eligibility excluded ci-fix/review-fix and critical-rung rows"
    fix_hint: "Join by run_id; eligibility per work unit; escalation as (model, effort) != arm"
  - plan: "44-03"
    dimension: verification_derivation
    severity: warning
    status: fixed
    required_property: "The store accepts canonical temp roots on the development host and refuses only store-owned symlinks"
    description: "lstat on every component refuses macOS /var and /tmp aliases, breaking the store tests and the T-44-05 smoke"
    fix_hint: "realpath the deepest existing ancestor; lstat only owned components"
  - plan: "44-01, 44-02, 44-06"
    dimension: cross_plan_data_contracts
    severity: warning
    status: fixed
    required_property: "No unit test written after T-44-01 matches the new inline_shapes unless it is registered"
    description: "scanInlineShapes applies to every unit test; 02/06 could not register without editing manifests outside their files_modified"
    fix_hint: "Mutate fixture-loaded rows; add boundary-fixtures.test to 02/06 verification"
  - plan: null
    dimension: nyquist_compliance
    severity: warning
    status: fixed
    required_property: "A phase VALIDATION.md exists when nyquist_validation is enabled"
    description: "No 44-VALIDATION.md was present"
    fix_hint: "Derive it from plan verification lists"
  - plan: null
    dimension: research_resolution
    severity: warning
    status: open
    required_property: "RESEARCH.md open questions are marked resolved"
    description: "44-RESEARCH.md Open Questions heading lacks (RESOLVED); resolutions are recorded in CONTEXT.md"
    fix_hint: "Mark the heading (RESOLVED) with a pointer to the CONTEXT planning notes"
```

## Recommendation

No blocker is left open. The plans can proceed to state-sync and Gate 2 on the planning branch. The one open warning is a research-artifact marker that the binding CONTEXT.md already resolves.
