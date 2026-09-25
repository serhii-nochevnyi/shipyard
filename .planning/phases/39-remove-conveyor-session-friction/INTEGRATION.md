# Phase 39 integration — remove conveyor session friction

- **Outcome:** needs-fix (1 blocking finding, 6 informational)
- **Phase:** 39-remove-conveyor-session-friction
- **Combined head / tree:** `2b438e80278910d9556dd1dc46617fc94e995aec` / `8b4f495d63cfdccc6fc7bf8ef2ca4d0a5bce566b`
  (`git rev-parse HEAD HEAD^{tree}` in the integration worktree)
- **Base:** `origin/main` = `56f462312102c978541f489940c0042588737b60`, tree `d7a8c592d830b8367d85475e5cd0e4a134d7556e`
  (`git rev-parse origin/main origin/main^{tree}`)
- **Ticket set:** T-39-01 … T-39-12 (PRs #204–#213, #216, #217), digest
  `bdb3c12f7bee3b50e031dcfc677da2ba6bbb0355d1541ddea5c1ccc055b71ec6`
- **Governing ADRs checked:** ADR-016 (this phase), ADR-004 D8 (Jira identity), ADR-008/009 (Jira), ADR-014 (dispatch boundary), ADR-013 (GSD projection)

## Verdict

Twelve tickets are merged. Their acceptance criteria hold in the merged code, and
every check that could run in this sandbox passes, except failures that fail the
same way on `origin/main`. There is one cross-ticket seam that no single PR
review could see:

T-39-05 moved the Jira lookup into `jira-export.cjs` and said the lookup follows
the "legacy-label fallback in the documented order". T-39-10 then deleted the
documented order from `decompose.md`. Now nothing implements ADR-004 D8's
legacy migration or its rule that an issue belonging to another repository is
never updated. The remedy is one fix ticket, F1.

## Findings

### F1 — BLOCKING — fix-ticket: the Jira export lost ADR-004 D8's legacy migration and foreign-repo refusal

- **Seam:** T-39-05 × T-39-10.
- **Before this phase:** `decompose.md` Step 5 (removed lines, visible in the combined diff hunk `@@ -496,139 +527,96 @@`) defined the lookup order:
  1. Search for the namespaced label.
  2. If that fails, treat a bare legacy label only as a candidate. Claim it only when the `Source of truth` line carries this repo's `<owner>/<repo>` prefix, or carries no prefix yet.
  3. On a legacy match, add the new label, rewrite the pointer line and comment "label migrated".
  4. "Never update an issue whose source-of-truth line names another repository."
- **Now:**
  - `plugins/delivery-pipeline/scripts/jira-export.cjs` `lookupOf` (≈lines 103-108) emits only `{ jql, legacy_jql }`.
  - The issue step (≈lines 172-182) carries the single new label.
  - No field says when `legacy_jql` applies, what to check on a match, or how to migrate.
  - `plugins/delivery-pipeline/commands/decompose.md:580-598` now says "Execute each step of that plan verbatim … Do not reinterpret" and nothing more.
  - Checked with the Read tool on decompose.md lines 566-601. A Grep for `legacy|Source of truth|another repository` in `decompose.md` matched none of the old rules.
- **Label spelling:** ADR-004 D8 and ADR-009 name the label `shipyard-<owner>-<repo>-T-<phase>-<plan>` with an uppercase `T` (`.planning/architecture/ADR-004-…md:100`, `ADR-009-…md:55`). `jira-export.cjs` `issueLabels` emits `…-${ticketId.toLowerCase()}` (T-39-05 chose lowercase on purpose). The fallback only covers the bare `shipyard-T-NN-MM` label. An issue exported under the ADR-004 D8 spelling is therefore not a lookup candidate at all.
  - **Assumption (unverified):** if Jira matches `labels = "…"` case-sensitively, re-running export duplicates such issues. Next check: run one JQL query against a project that has an ADR-004-era label.
- **Why it matters:**
  - This is an outward-facing idempotency contract. A mistake here duplicates issues, or updates another repository's issue, in someone's tracker.
  - ADR-016 did not supersede ADR-004 D8, so D8's "the old label is searched as a fallback and migrated with a note" is still in force and is now implemented nowhere.
- **Fix ticket:**
  - **title:** Carry the ADR-004 D8 legacy lookup and foreign-repo refusal into the Jira export plan
  - **scope:**
    - Each epic/issue step gets an ordered `lookup` list:
      1. the primary lowercase label
      2. the ADR-004 D8 uppercase-`T` namespaced label
      3. the bare legacy label
    - Each legacy entry carries `requires_source_of_truth: "<owner>/<repo>:<plan>"` (claim only on a matching or absent prefix), and on a match the step says: add the primary label, rewrite the pointer line, comment "label migrated".
    - An issue whose pointer names another repository is never updated; the step falls through to create.
    - `decompose.md` Step 5 states how the agent executes that ordered lookup.
    - The output must stay byte-deterministic. The network-token sweep must stay clean.
    - Contract tests pin the new fields and the prose.
  - **files:**
    - `plugins/delivery-pipeline/scripts/jira-export.cjs`
    - `tests/unit/jira-export.test.cjs`
    - `plugins/delivery-pipeline/commands/decompose.md`
    - `tests/unit/decompose-friction-contract.test.cjs`
  - **depends_on:** [] (phase 39 is merged; these files have no other live owner)
  - **risk:** medium

### F2 — informational: duplicated summary-cap helper (T-39-08)

- The T-39-08 plan says "apply that rule, via the exported `SUMMARY_MAX_CHARS`, instead of writing a new truncation".
- `plugins/delivery-pipeline/scripts/claude-delivery-host.cjs:35-38` defines its own `capSummary`. It duplicates `role-artifact.cjs:90-95`, which is not exported: Grep over role-artifact.cjs shows `SUMMARY_MAX_CHARS` at the exports (line 2688) but no `capSummary` there.
- The behaviour is identical: 497 code points plus `...`, confirmed by the `planning-artifacts` test "an over-long research summary is bounded to 500 code points".
- Suggested follow-up: export `capSummary` from role-artifact.cjs and import it.

### F3 — informational: the role output schema describes only `blocking_count` (T-39-12 amendment 2)

- `plugins/delivery-pipeline/scripts/claude-role-host.cjs` `roleOutputSchema` gives the integrator and pr-sentinel roles only `blocking_count`. `validateResult` then requires `phase`, `head`, `head_tree`, `base`, `base_tree`, `ticket_set`, `ticket_set_digest` (integrator) and `outcome`, `ticket_set`, `head` (sentinel).
- Seen directly: this integrator dispatch received a StructuredOutput tool whose schema listed only `blocking_count`.
- The check fails closed (`ARTIFACT_IDENTITY_MISMATCH`), so it is not unsafe. It does invite refusals, the exact friction ADR-016 targets.
- Suggested follow-up: declare the full per-role result schema.

### F4 — informational: stop-gate arming reads the environment, not `${CLAUDE_SESSION_ID}` (T-39-03)

- The plan specified `stop-gate-arm.cjs arm --session-id "${CLAUDE_SESSION_ID}"`. The merged code reads `CLAUDE_CODE_SESSION_ID` when `--session-id` is absent (`stop-gate-arm.cjs` CLI block), and `deliver.md` Step 0 uses bare `arm`.
- In this session `echo $CLAUDE_CODE_SESSION_ID` printed `ab44bc73-4060-4d5c-9929-20a92944a8aa`. That equals the harness session directory `/private/tmp/claude-502/…/ab44bc73-4060-4d5c-9929-20a92944a8aa/tasks`, which supports the design.
- The literal `${CLAUDE_SESSION_ID}` refusal is still tested (`stop-gate-arm.test.cjs`, 12/12 passed).
- **Unknown:** the host-probe evidence the acceptance criterion requires lives in PR #207. `gh pr view 207` failed in this sandbox ("open ~/.config/gh/config.yml: operation not permitted"). Next check: read PR #207's body.

### F5 — informational: failures that are not caused by phase 39

- `node tests/unit/dispatch-record.test.cjs` → 90 passed, 1 failed ("deliver.md's ladder query runs, and UNCONFIRMED is a bucket"). The same single failure occurs on an `origin/main` archive (`git archive origin/main | tar -x -C $TMPDIR/base39`).
  - The 3 tests this phase added for the armed `gate` helper (negative control blocks, silent when dispatched, clear re-arms) pass.
- `node tests/unit/gsd-tune.test.cjs` → 63 passed, 9 failed on head. The same 9 fail on the base archive. The cause is the Claude session environment resolving the runtime to `claude`.
  - T-39-07's test "a project with no GSD config at all is refused" passes.
- `tests/unit/codex-delivery-host.test.cjs` does `mkdtempSync('/tmp/scds-')` (a pre-existing line), which fails with EPERM in this sandbox, so the file could not run.
  - The new behaviour was reproduced directly: `node plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` → exit 1, line 1 `codex-delivery-host: codex-delivery-host: usage: …`, line 2 `hint[INVALID_INPUT]: …`.
- **Not run here:** `tests/smoke/claude-hook-smoke.sh` and `tests/smoke/graph-validator-smoke.sh`. mktemp EPERM, then a denied approval. `codex-shipyard-smoke.sh` is CI/network-only by plan.
  - The graph warning behaviour was checked with a node fixture instead (see T-39-06).
  - The installer, doctor and `--remove` behaviour of T-39-04 is **unverified here**. Next check: CI results on PR #208, or a local `bash tests/smoke/claude-hook-smoke.sh`.

### F6 — informational: stale local delivery state

- `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json --phase 39` → `ok: true`, but phase 39 reads "1 plan(s) are not merged".
- `39-03-SUMMARY.md` records T-39-03 as `pr-open`, while the authenticated ticket set has PR #207 merged. The local `delivery-state` predates that merge.
- Next step: run `state-sync.cjs` (it also refreshes the projection) before closing the phase.

### F7 — informational: cross-ticket coherence confirmed

- **Auto-route text has one source.** `AUTO_ROUTE_BEGIN/END` and both policy texts live only in `auto-route.cjs`. The Codex installer and the doctor import `codexBlock` from it (diff: `install-shipyard-codex.sh`, `shipyard-doctor.cjs`).
- **One refusal-hint map.** All four hosts `require('./refusal-hints.cjs')` (`refusal-hints.test.cjs` "all four hosts share this one map").
- **The bootstrap reuses the ADR parser.** `adr-bootstrap.cjs` imports `decisionEntries` from `adr-ingest.cjs` (`adr-bootstrap.test.cjs` "requires ./adr-ingest.cjs").
- **The three bootstrap texts agree.**
  - T-39-07's gsd-tune message, T-39-09's script and T-39-10's Step 0 prose describe the same bootstrap.
  - T-39-04's README text matches T-39-03 (arming) and T-39-09/10 (bootstrap).
  - `docs-smoke.sh` passed.

## Acceptance sweep

| Ticket | Result | Evidence |
|---|---|---|
| T-39-01 | met | `refusal-hints` pass. `claude-decompose-host` pass: line 2 `hint[UNSUPPORTED_ROLE]:`, and capability JSON keeps the old keys and adds `hint`. `claude-investigation-host` pass. `codex-decompose-host` pass. Codex delivery reproduced directly (F5). `claude-workflow-host` 10/10. All four spawns were also re-run by hand: exit 1 with a `hint[` second line. |
| T-39-02 | met | `adr-ingest.test.cjs` 15/15. `adr-ingest.cjs --check --input templates/adr/ADR.md` → `OK (1 decisions)`, exit 0. ADR-016 → `OK (12 decisions)`, exit 0. |
| T-39-03 | met (probe evidence unknown, F4) | `stop-gate-arm` 12/12. `stop-gate` 76/0 (unarmed, foreign, malformed and armed-cross-worktree cases). `dispatch-record` armed-gate cases pass (F5). `source-contract` 42/0. `.gitignore` entry present in the diff. |
| T-39-04 | met in unit and docs tests; smoke not run (F5) | `auto-route.test.cjs` 21/21: plain, `prompt_text`, slash, `<command-name>`, `<task-notification>`, invalid JSON, empty stdin, exit 0. `docs-smoke.sh` passed. `bash -n` on all four scripts clean. `codexBlock` asserted for phases 1 and 2. |
| T-39-05 | criteria met; ADR-004 D8 seam open (F1) | `jira-export.test.cjs` 20/20: determinism, topological order, link direction, lowercase namespaced labels, `--epic-issue-type none`, `record` line edit and idempotency, refusals, network-token sweep. |
| T-39-06 | met | Node fixture: disjoint same-phase → warning, exit 0. Overlapping → no warning. Cross-phase → no warning. Cross-repo → no warning. Projection equality → exit 0. |
| T-39-07 | met | `gsd-tune.test.cjs` "project with no GSD config" passes: exit 2, prefix, path, both commands, no file created. The 9 unrelated failures also occur on base (F5). |
| T-39-08 | met (helper duplicated, F2) | `planning-artifacts` 8/8: the 1106-character summary becomes 500 code points with a stderr notice; a 500-character summary is unchanged. `investigation-research` 9/9 (prompt sentence). `inv-research.md` contains "at most 500 characters" (diff). |
| T-39-09 | met | `adr-bootstrap.test.cjs` 9/9, including partial-project `skipped_existing`, the no-decisions refusal, nested decisions, and gsd-tune REQUIRED drift absent. |
| T-39-10 | criteria met; the removed prose is the F1 seam | `decompose-friction-contract` 6/6. `source-contract` 42/0. `docs-smoke` passed. |
| T-39-11 | met | `investigate-friction-contract` 4/4. `source-contract` 42/0. `docs-smoke` passed. |
| T-39-12 | met (schema breadth, F3) | `claude-runtime-host.test.cjs` 24/24 (`--json-schema` last, refusals before spawn, cyclic schema, versioned scope). `claude-workflow-host` 10/10 (structured output reaches the workflow). `claude-role-host` passed. Adapter digest pin in `source-contract` passes. |

## Commands run (worktree root, `GIT_CONFIG_*` gpgsign=false)

- `node --check` on 17 scripts and on `scripts/shipyard-doctor.cjs`: no failures.
- `bash -n` on the four shell scripts: no failures.
- `node tests/unit/<name>.test.cjs` for 21 files: 18 exit 0. `codex-delivery-host`, `dispatch-record` and `gsd-tune` exit 1, explained in F5.
- `bash tests/smoke/docs-smoke.sh`: passed.
- `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --json`: `ok: true`, 0 violations.
- Baseline comparison of `dispatch-record` and `gsd-tune` on the `origin/main` archive in `$TMPDIR/base39`.
- `gsd-sync.cjs --check --json --phase 39`: `ok: true`, `blockers: []`.
