# Integration — phase 39: remove conveyor session friction

- **Verdict:** needs-fix (1 blocking finding)
- **Combined head:** `06f3edc6b1f137a277872f76170193d1eda1935f` (tree `0cf3b0290790e08ad2cd526c8e55f84387c3a6bc`), branch `epic/39-remove-conveyor-session-friction`
- **Base:** `origin/main` = `56f462312102c978541f489940c0042588737b60` (tree `d7a8c592d830b8367d85475e5cd0e4a134d7556e`)
- **Ticket set:** T-39-01 … T-39-14 (PRs 204–225). I recomputed the digest with `node -e '…createHash("sha256").update(JSON.stringify(ticket_set))…'` and got `b13719921f68749319494c46810af8213718060a98d4349d60092066251ce8f7`, which matches the host value.
- **Checked by:** `git rev-parse HEAD HEAD^{tree} origin/main origin/main^{tree}` in the integration worktree

## Summary

Every ticket's acceptance criteria hold in the merged code on their own.
Each unit and smoke check either passes, or fails the same way on `origin/main`
(see Environment). The combination has one blocking seam. The phase promises
that a repeat of MYD-17627 can go investigate → decompose → deliver without a
`/gsd-new-project` detour. That path does not work yet: the minimal project
that `adr-bootstrap.cjs` (T-39-09) creates and `decompose.md` Step 0 (T-39-10)
invokes is refused by the ADR-013 GSD projection (`gsd-sync.cjs`). That
projection runs from the `plan:post` capability gate during `/gsd-plan-phase`,
and again from `state-sync.cjs` on every delivery round.

## Findings

### F1 — BLOCKING (fix-ticket): the bootstrapped GSD project is refused by gsd-sync

The seam is T-39-09 + T-39-10 against the existing ADR-013 projection owner.

- `plugins/delivery-pipeline/scripts/adr-bootstrap.cjs:48` (`requirementsContent`) and `:90` write
  `.planning/REQUIREMENTS.md` with no gsd-sync ownership marker. `gsd-sync.cjs:1013-1022`
  (`generatedFileContent`) treats REQUIREMENTS.md as a wholly owned projection file. It
  throws `exists but is not owned by shipyard:gsd-sync generated` unless `--adopt-native`
  is passed. Lifecycle gates and state-sync never pass that flag.
- `adr-bootstrap.cjs:36` (`roadmapContent`) writes only `**Requirements**: REQ-01, …`.
  `gsd-sync.cjs:346-368` (`parseRoadmap`) reads requirement definitions only from
  `- **REQ-NN** — <text>` lines. Even if the file were adopted, the regenerated
  REQUIREMENTS.md would lose every decision text.
- `adr-bootstrap.cjs` never creates `.planning/PROJECT.md`. `gsd-sync.cjs:595` reports
  `PROJECT.md is missing` as a blocker.
- Where the refusal fires:
  - `capabilities/delivery-pipeline/capability.json:128,141,154` run
    `gsd-sync-gate.cjs write` at `plan:post` / `execute:post` / `verify:post`.
    `gsd-sync-gate.cjs:94-108` fails on any non-zero exit.
  - `state-sync.cjs:383-403` (`publishGsdProjection`) runs `gsd-sync.cjs --json` and
    calls `fail(...)` on refusal.
  - `deliver.md` Step 0.2 says "a projection refusal is a delivery error".

**Evidence (reproduced).** I ran a scratch project under the gitignored `workspace/`
(removed afterwards). The steps were: `adr-bootstrap.cjs --adr ADR-016 --json`, then
one delivery PLAN (`T-01-01`), then `validate-graph.cjs` (exit 0).

- `gsd-sync.cjs --check --json` → `{"ok":false,"error":".planning/REQUIREMENTS.md exists but is not owned by shipyard:gsd-sync generated"}`, rc=1
- `gsd-sync.cjs --json` (write mode, same as state-sync and the gate) → same error, rc=1
- With REQUIREMENTS.md removed, it was refused next with `PROJECT.md is missing`.

**Fix ticket (ready for validate-graph):**

- **Title:** Make the ADR bootstrap produce a project the GSD projection accepts
- **Files:** `plugins/delivery-pipeline/scripts/adr-bootstrap.cjs`, `tests/unit/adr-bootstrap.test.cjs`
- **depends_on:** [] (all phase-39 parents are merged into the epic)
- **Scope:**
  - The bootstrap ROADMAP phase block also lists each requirement as a
    `- **REQ-NN** — <decision>` line, the shape `gsd-sync.cjs parseRoadmap` reads.
    Keep the existing `### Phase N:` / `**Status**` / `**Requirements**` lines.
  - Create a minimal `.planning/PROJECT.md` (title from the ADR, plus a
    `**Core Value:**` line) only when it is missing, with the same `wx` no-clobber rule.
  - Write REQUIREMENTS.md so that `gsd-sync.cjs` write mode accepts it without
    `--adopt-native`. Recommended: carry the gsd-sync ownership marker on line 3 in
    gsd-sync's own format, which works because gsd-sync regenerates the file from the
    ROADMAP declarations. Keep the T-39-09 contract: REQ ids 1:1 and in ADR order, and
    `| REQ-NN | Phase N | Pending |` rows.
  - Pre-existing files keep T-39-09's rule: never read-modified or truncated, and
    reported under `skipped_existing`.
- **Acceptance:**
  1. In a temp project, run `adr-bootstrap.cjs` → one delivery PLAN →
     `validate-graph.cjs` → a delivery-state observation (or `state-sync`-equivalent
     fixture). Then `gsd-sync.cjs --json` exits 0, or fails only on a blocker unrelated
     to REQUIREMENTS.md ownership, PROJECT.md, or roadmap requirement parsing. It must
     not report `not owned by shipyard:gsd-sync generated` or `PROJECT.md is missing`.
  2. The regenerated REQUIREMENTS.md still lists every ADR decision text.
  3. The existing adr-bootstrap tests stay green, including the
     `gsd-tune --check` REQUIRED-drift test.
- **Verification:** `node --check plugins/delivery-pipeline/scripts/adr-bootstrap.cjs`; `node tests/unit/adr-bootstrap.test.cjs`; `node tests/unit/adr-ingest.test.cjs`

**Unknown / assumption.** A project created by `/gsd-new-project` probably has the
same unowned REQUIREMENTS.md, so this refusal may predate phase 39. I did not run GSD
here to check. Next check: run `gsd-sync.cjs --json` in a `/gsd-new-project` scratch
project. The finding blocks this phase because phase 39's own decision (ADR-016 D3)
introduces the bootstrap path as the route that replaces that detour.

### F2 — informational: test failures that are the same on origin/main

I ran each test in the integration worktree and in a scratch worktree of
`origin/main` (`git worktree add --detach … origin/main`, removed afterwards).

- `node tests/unit/gsd-tune.test.cjs`: 63 passed, 9 failed on BOTH trees. The failures
  are the Codex-floor/registration and fable-pin groups, which read host Codex state.
  The phase-39 case `a project with no GSD config at all is refused` passes.
- `node tests/unit/dispatch-record.test.cjs`: 90 passed, 1 failed on BOTH trees
  (`deliver.md's ladder query runs, and UNCONFIRMED is a bucket rather than a hole`).
  The armed `gate` helper tests from T-39-03, including the negative control, pass.
- `node tests/unit/codex-delivery-host.test.cjs` cannot load in this sandbox:
  `EPERM mkdtemp '/tmp/scds-XXXXXX'`, from `tests/unit/codex-delivery-host.test.cjs:30`,
  a pre-existing hard-coded `/tmp` path (ADR-017's hermetic-fixture item). I checked
  the T-39-01 acceptance directly instead:
  `node plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` → rc=1, line 1
  `codex-delivery-host: codex-delivery-host: usage: …`, line 2 `hint[INVALID_INPUT]: …`.
- `tests/smoke/codex-shipyard-smoke.sh` needs the network (CI/host-only per the T-39-04
  plan). Not run. `bash -n` passes.

### F3 — informational: duplicated summary cap (T-39-08)

`plugins/delivery-pipeline/scripts/claude-delivery-host.cjs:35` adds a local
`capSummary` that re-implements `role-artifact.cjs:90-95`. `role-artifact.cjs:2688`
exports only `SUMMARY_MAX_CHARS`, not the function. The behaviour is identical: 497
code points plus `...`, pinned by the `planning-artifacts` 1,106-character test. Fold
it into ADR-017's shared sealer rather than opening a separate ticket.

### F4 — informational: T-39-08 Codex seal-path evidence not recorded

T-39-08 asked the executor to confirm in evidence that Codex research summaries are
bounded by `role-artifact.cjs capSummary`. I found no such statement:
`git log origin/main..HEAD` has no T-39-08 message mentioning Codex, and no
`codex-*.cjs` script requires `role-artifact.cjs` (`grep -ln role-artifact
plugins/delivery-pipeline/scripts/codex-*.cjs` → none). So Codex has no research
consumer at all. That gap is already an accepted decision in ADR-017 ("One shared
sealer … for Claude and Codex research and decompose hosts"), so it is owned and not
blocking here.

### F5 — informational: T-39-03 arming source changed on measured evidence

Instead of the planned `--session-id "${CLAUDE_SESSION_ID}"`,
`deliver.md:1229` runs `stop-gate-arm.cjs arm` and `stop-gate-arm.cjs:53` reads
`CLAUDE_CODE_SESSION_ID`. The human-checkpoint probe is recorded in commit `f50cafa1`:
Claude Code 2.1.282, where `CLAUDE_CODE_SESSION_ID` equals the Stop-hook `session_id`
and `CLAUDE_SESSION_ID` is unset in Bash. Stop-gate side:
`stop-gate.cjs:516` `if (!sessionId || !isArmed(cwd, sessionId)) allow();`, in the
unscoped branch only. The two sides agree. The literal `${CLAUDE_SESSION_ID}` and
`../x` are still refused (`node tests/unit/stop-gate-arm.test.cjs` 12/0).

### F6 — informational: target-project leakage in gsd-sync (not phase 39)

`gsd-sync.cjs:661,665` hard-codes `# Requirements: shipyard` and
`**Defined:** 2026-09-10` into every project's REQUIREMENTS.md. This predates phase 39
and belongs to ADR-017's PR-hygiene scope. The F1 fix will make it visible in
bootstrapped projects.

## Cross-ticket coherence

- **Hints (T-39-01) ↔ relay prose (T-39-10, T-39-11):** the wire format
  `hint[<CODE>]: … — remedy: …` from `refusal-hints.cjs formatHint` matches what
  `decompose.md` Step 0.5 item 6 and the `investigate.md` runtime section tell the model
  to read. All four hosts require the one map (`refusal-hints.test.cjs` source
  assertion passes), so the hint text is not duplicated.
- **Template / `--check` (T-39-02) ↔ Gate 1 (T-39-11):** Gate 1 names the shipped
  template and `adr-ingest.cjs --check --input` before the close step.
  `adr-ingest.cjs --check --input plugins/delivery-pipeline/templates/adr/ADR.md` →
  `OK (1 decisions)`; the same on ADR-016 → `OK (12 decisions)`.
- **decisionEntries (T-39-02) ↔ bootstrap (T-39-09):** the bootstrap reuses the parser
  (`require('./adr-ingest.cjs')`, pinned by a test), so there is no second parser.
- **Jira plan (T-39-05, T-39-13) ↔ decompose Step 5 (T-39-10, T-39-13):** the documented
  flags `--repo --project --issue-type --epic-issue-type --json`, `record <T> <KEY>`,
  lookup/migrate semantics and `is blocked by` match `jira-export.cjs parsePlanArgs` and
  `resolveLookup`. `decompose-friction-contract` passes 6/0.
- **Order-only warning (T-39-06) ↔ linearization prose (T-39-10, SKILL.md):** the
  warning text "shares no files_modified" matches in `validate-graph.cjs`, `SKILL.md §7`
  and `decompose.md` Step 3. The projection equals source + marker (node projection
  check rc=0).
- **Schema forwarding (T-39-12) ↔ role schema and result shape (T-39-14):** the role
  host passes `roleOutputSchema(role)` in place of T-39-12 amendment 2's
  `{type:'object'}`, and the runtime host appends `--json-schema` after `--settings`.
  They are consistent. The `claude-dispatch-adapter.cjs` output unwrap changed the
  runtime-owned digest, which is pinned in `source-contract.test.cjs` (42/0).
- **Research bound (T-39-08) ↔ schema forwarding (T-39-12):** the `OUT` schema's
  `maxLength: 500` now reaches the CLI, and the host-side cap stays as a backstop. They
  are consistent.
- **Route hook (T-39-04):** the policy text moved into `auto-route.cjs` and both
  installers and the doctor consume that one module, so no copy of the policy remains
  in a heredoc.
- **gsd-tune message (T-39-07):** points at `/shipyard:decompose`, which bootstraps via
  T-39-09/T-39-10. The pointer is consistent, but see F1 on what that bootstrap produces.

## Acceptance sweep

| Ticket | Result | Command evidence |
|---|---|---|
| T-39-01 | met | `node tests/unit/refusal-hints.test.cjs`, `claude-decompose-host`, `claude-investigation-host`, `codex-decompose-host` rc=0; both Codex CLIs checked directly (F2) |
| T-39-02 | met | `node tests/unit/adr-ingest.test.cjs` 15/0; both `--check` commands OK |
| T-39-03 | met | `stop-gate-arm` 12/0, `stop-gate` 76/0, dispatch-record arm tests pass (1 failure also on base, F2); probe in `f50cafa1` |
| T-39-04 | met (Codex smoke is CI-only) | `auto-route` 21/0; `claude-hook-smoke.sh` passed (install, filtering, registration, doctor ok, --remove); `docs-smoke.sh` passed |
| T-39-05 | met | `jira-export` 26/0 (determinism, ordering, record, network sweep) |
| T-39-06 | met | `graph-validator-smoke.sh` 75/0, including the four order-only cases; projection check rc=0 |
| T-39-07 | met | gsd-tune case `a project with no GSD config at all is refused` passes (exit 2, prefix, path, both commands) |
| T-39-08 | met, see F3/F4 | `planning-artifacts` 8/0 (1106→500 and 500 unchanged), `investigation-research` 9/0 |
| T-39-09 | met in isolation, **seam F1** | `adr-bootstrap` 9/0 |
| T-39-10 | met | `decompose-friction-contract` 6/0, `source-contract` 42/0, docs smoke |
| T-39-11 | met | `investigate-friction-contract` 4/0, `source-contract` 42/0, docs smoke |
| T-39-12 | met | `claude-runtime-host` 24/0, `claude-workflow-host` 10/0 |
| T-39-13 | met | `jira-export` 26/0, `decompose-friction-contract` 6/0 |
| T-39-14 | met | `claude-role-host` rc=0; `integrator.md` carries the object-shaped `ticket_set` and "copied verbatim" |

Syntax checks: `node --check` passes on all 16 touched scripts plus `scripts/shipyard-doctor.cjs`,
and `bash -n` passes on the four shell scripts.

## Environment notes

- The sandbox blocks the macOS default temp dir. `/usr/bin/mktemp -d` ignores
  `TMPDIR`, so I ran the smoke scripts with a PATH shim mapping `mktemp -d` to
  `$TMPDIR/tmp.XXXXXX`. The scripts themselves are unchanged.
- `gh` could not read its config in the sandbox, so PR bodies were not read. I used
  git commit messages instead.
- While cleaning up I ran `git worktree prune`. It tried to prune other stale
  worktree registrations in the shared repo, the sandbox denied every deletion
  (EPERM), and nothing was removed. `git worktree list --porcelain` still shows
  registrations such as `.wt-inv-003/T-39-09`.
