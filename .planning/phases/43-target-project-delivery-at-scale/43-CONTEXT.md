# Phase 43: Target-project delivery at scale - Context

**Source of decisions:** ADR-020 (`.planning/architecture/ADR-020-target-project-delivery-at-scale.md`, accepted 2026-09-26; identical ingest copy `.planning/.adr-ingest/ADR-020-target-project-delivery-at-scale.ingest.md`) and INV-007 `DECISIONS.md` (scope fences, binding). Planning answers to the `43-RESEARCH.md` Open Questions were given by the user on 2026-09-26 and are recorded below as P-01..P-05.
**Requirements:** REQ-159..REQ-175 (`.planning/REQUIREMENTS.md`, ROADMAP Phase 43), one requirement per ADR decision, in ADR order.
**Mode:** `--tdd`, granularity standard, one ticket = one PR. Every ticket writes its failing test first and shows it failing on base.
**Research:** `43-RESEARCH.md` (seams at revision `22ef429b`; phase 40 rewrites several files first, so plans anchor on function names and cite lines "at 22ef429b").

<decisions>

## Locked decisions (ADR-020 "Decision", one per bullet)

- **D-01 (REQ-159)** Executor work is verified host-side. The trusted host, outside the agent sandbox, runs only the verification commands declared in the approved plan that match a project allow-list, as argument arrays with timeouts and bounded output. It records the result as finalization evidence (or a sealed artifact referenced by digest), finalizes only on pass, and returns failures to a bounded executor or fixer round. The agent sandbox is not widened and the receipt shape does not change. Codex reuses the same host path.
- **D-02 (REQ-160)** The merge gate refuses a head the conveyor does not cover, for PRs opened after this phase is released. Every commit since the ticket's base must be a verified executor or fixer receipt with trusted finalization, a journalled base-merge, or a declared remedy-workflow commit. Any other commit refuses with the command that brings it under the conveyor. PRs opened earlier keep today's rule and are marked legacy in the journal. Both runtimes' merge paths.
- **D-03 (REQ-161)** A conform verdict carries across a base-merge when the ticket's own patch is identical (`git patch-id --stable`, or identical blobs for every `files_modified` path) and every other path equals the new base. Any other difference re-owes arch-review. The carry posts the `merge-gate` commit status introduced by T-40-19.
- **D-04 (REQ-162)** `human_checkpoint` takes `review` (a human approves the PR, then the guard merges into the epic) or `merge` (the human merges, also used for external-dependency holds). `true` keeps meaning `merge`, `preauthorized: true` keeps working, Gate 2 states the consequence of each value, and `pipeline-stats` keeps attributing guard merges separately.
- **D-05 (REQ-163)** Target repositories may declare extra allowed comment markers as exact tokens in the project's `.planning/config.json`, keyed by `owner/repo` and read through `loadConfig`. A changed line whose pre-image was already a comment is not an addition. Net-new free comments still block. The built-in markers and Shipyard defaults are unchanged.
- **D-06 (REQ-164)** Pre-existing Jira issues are bound by key. Decompose proposes the ticket-to-issue mapping, the human approves it with the ticket set at Gate 2, and a recorded key is authoritative: lookup by key, never create, refuse an unknown key. Issues without the shipyard label are only transitioned and commented.
- **D-07 (REQ-165)** Only operator-declared repository remedy workflows (per repository: failure signature, workflow, inputs) run before a human escalation, bounded by the attempt budget and journalled. A commit such a workflow pushes is a declared link of the merge gate's chain and still goes through arch-review and CI. Nothing undeclared is discovered or run.
- **D-08 (REQ-166)** One exported definition of the conveyor's scratch files is used by the role host, the finalizer, the Codex delivery host, base-merge and gc. Any other untracked file still blocks the role host, whose status read no longer fails on large output. No `.gitignore` or `info/exclude` writes.
- **D-09 (REQ-167)** A stale approval from a declared bot does not block a merge when the target branch requires no review or a human approval exists on the current head. A stale human approval still blocks. Otherwise the guard re-requests the review once and escalates with the command. Bot identities become configurable.
- **D-10 (REQ-168)** A CANCELLED check superseded by a newer run is ignored, and a lone cancelled latest run gets one journalled `gh run rerun` that is never green and does not count against `max_attempts`. On Claude one `ci-wait.cjs` call returns within 540 s unless `--timeout` is explicit, with the window budget accumulated across calls.
- **D-11 (REQ-169)** `pipeline.gsd_sync` is honoured as a deprecated alias with the warning on the state-sync summary line. Decompose writes its phase into ROADMAP in the shape gsd-sync reads. Plans of a phase absent from ROADMAP produce one summarised warning instead of a per-plan block.
- **D-12 (REQ-170)** `publish-gate.cjs` resolves the base from the ticket's recorded base and then the repository's `origin/HEAD` before the `origin/main`/`main` fallback. The pre-push hook passes the ticket for ticket branches. An unresolved base still refuses.
- **D-13 (REQ-171)** Reachability checks ask bounded questions: `run-reachability.cjs` uses O(1)-output git forms with a large `maxBuffer`, and `sentinel.cjs` compares only declared paths through local git when the repository is checked out, with a path-scoped API fallback that still refuses a truncated listing.
- **D-14 (REQ-172)** `deliver-dispatch.cjs` builds research, decomposition, arch-review, ci-fix and review-fix requests from the graph and the investigation directory, each round-tripping through the host's exported validator, with Codex parity or a named reason.
- **D-15 (REQ-173)** `state-sync.cjs` lists PRs by ticket head and open state instead of `--state all --limit <pr_fetch_limit>`, and does not re-derive tickets whose merge into a landed epic is recorded immutably. `--full` re-derives everything.
- **D-16 (REQ-174)** An arch-review finding of unknown type is kept as an informational note with its original type and never changes the verdict. A violation or an incomplete blocking finding still fails the artifact.
- **D-17 (REQ-175)** Phase 43 is delivered in parallel with phases 40 and 42: each ticket starts as soon as its graph dependencies have landed, and a ticket that shares a file with a pending phase-40 or phase-42 ticket waits for that ticket through a cross-phase dependency (user decision 2026-09-26, replacing "one wave after phases 40, 41 and 42 are released"). Every fix carries unit or fixture tests that fail on base. The before/after measurements come from a later proving-ground rerun by the operator, outside the phase.

## Planning decisions (user, 2026-09-26; answers to 43-RESEARCH Open Questions, locked)

- **P-01 (Q1, T-43-16 runner profile)** The default runner is T-42-01's OS-sandboxed verification runner. An allow-list entry may explicitly opt into a `host` profile: it runs without the OS sandbox through `runBounded`, with argv, timeout and bounded output; the profile is recorded in the verification evidence; it is never the default. This relaxes T-42-01's "never bare `runBounded`" only for explicitly declared entries (operator authority, ADR-020).
- **P-02 (Q2, base-merge coverage)** Only a clean or mechanically resolved base-merge committed by `base-merge.cjs` itself is a covered link. A base-merge whose conflicts were resolved by hand (`base-merge.cjs` result `conflicts remain`, then a model or human commit) is NOT covered; the resolution goes through a fixer round with a receipt.
- **P-03 (Q4, "opened after release")** A PR is "opened after release" when its `createdAt` is later than a sealed rollout marker written at the first recorded trusted finalization in the project. T-43-17 writes the marker; T-43-19 reads it. No config flag.
- **P-04 (Q6, children of a `review` parent)** Children of a `review` checkpoint parent cascade under today's rule, unchanged (`sentinel.cjs` hold on merges into an open checkpoint parent, at 22ef429b `:966-983`).
- **P-05 (Q3, pre-push hook project root)** The pre-push hook finds the project root from `SHIPYARD_PROJECT_ROOT` or `--project-root`, else the pushing repository's main worktree (`git rev-parse --path-format=absolute --git-common-dir`, parent directory). With no config found it uses the built-in markers and the `origin/HEAD` base (fail safe).

Q5 (remedy commit attribution) stays [ASSUMED] as researched: a remedy commit is recorded only when its parent was the head at dispatch, its author is the declared workflow bot, and the run id matches; anything else is uncovered and refused by T-43-19 (fail closed). Q7 (phase-40 export renames) is handled by every plan re-reading its seams after release.

## Planner choices (Claude's discretion, recorded so executors do not re-decide)

- **C-01** New config keys (T-43-01), all registered in `pipeline-config.cjs` with default `null`, shape-validated at load with warn-and-fallback naming the key, merged `delivery_pipeline.*` wins, kept out of `capability.json` (object shapes, as T-40-17 does for `pr_title_format`):
  - `comment_markers`: `{"<owner/repo>"|"default": ["<token>", …]}`.
  - `reviewer_bots`: `{"<owner/repo>"|"default": ["<login or login-prefix*>", …]}`; unset means today's CodeRabbit and Copilot rules.
  - `repo_remedies`: `{"<owner/repo>": [{"signature": "<normalized failure signature>", "workflow": "<file.yml>", "inputs": {"k": "v"}, "ref"?: "<branch>"}]}`.
  - `verification_commands`: `{"<owner/repo>"|"default": [{"argv": ["<tok>", …], "profile"?: "sandbox"|"host", "timeout_s"?: <int 1..3600>}]}`; `profile` defaults to `sandbox` (P-01).
  - One exported helper `repoValue(cfg, key, repo)` returns the `owner/repo` entry, else `default`, else `null`.
- **C-02** New module names under `plugins/delivery-pipeline/scripts/`: `conveyor-scratch.cjs` (T-43-06), `host-verification.cjs` (T-43-16), `conveyor-coverage.cjs` (T-43-17), `repo-remedy.cjs` (T-43-18).
- **C-03** The graph keeps `human_checkpoint` boolean (true for both `review` and `merge`) and adds `checkpoint: 'review'|'merge'|null` to `tickets.json`, so the existing boolean readers (`run-contract.cjs`, `run-controller.cjs`, `run-waker.cjs`, `claude-role-host.cjs`, `parent-moving.cjs`) keep their meaning (T-43-12).
- **C-04** The scratch set is an exact list of names, not a `.shipyard-` prefix: a prefix would let an agent-written `.shipyard-x.js` reach the judge. base-merge and gc keep the tracked-only (`--untracked-files=no`) question and import or call the shared module (T-43-06).
- **C-05** Coverage records are sealed with the `dispatch-boundary.cjs` durable-envelope pattern (HMAC-SHA256, `timingSafeEqual`, host-owned key file mode 0600 outside the worktree), one record per commit; a journal line alone never covers a commit, and a commit signature is not proof of coverage (T-43-17).
- **C-06** A lone latest CANCELLED run counts in `pending` plus a new `cancelled` tally, so `sentinel.mergeOne`'s direct `checks.failing`/`checks.pending` tests keep refusing and `isGreen` stays false (T-43-07).
- **C-07** New journal events: `ci_rerun` (T-43-07), `review_rerequest` (T-43-08), `remedy_dispatch` (T-43-18), `merge_gate_legacy` and `merge_gate_uncovered` (T-43-19). None is a repair event in `attempt-history.cjs`, so none charges `max_attempts`.

</decisions>

## Scope fences (INV-007 DECISIONS.md, binding)

- Host verification: commands are never taken from agent output; the receipt shape does not change; no sandbox widening; Codex reuses T-42-01's candidate seam.
- Merge gate: reads existing receipts, adds no new receipt fields; legacy PRs are journalled.
- Carry: built after T-40-19; a merge that duplicated a block re-owes review; CI and the epic PR remain the interaction checks.
- Comment markers: anchored and length-bounded; read from trusted configuration through `loadConfig(projectRoot)`, never from the ticket worktree.
- Jira: status transitions stay the phase-29 projection.
- Remedies: nothing undeclared runs; when nothing is declared, escalation names the candidate remedy.
- Stale bot approval: GitHub's own `BLOCKED` merge state still refuses.
- ci-wait: the stop gate keeps the turn alive between calls.
- gsd_sync: `delivery_pipeline.*` precedence unchanged; built after T-41-05 (merged) and T-40-17.
- Point fixes take their cheapest correct shape (F2, F8, F10, F11, F14); raising buffers or limits alone and lists of known branch names are rejected.
- Out of scope (ADR-020): everything in phases 40 and 41; the ADR-014 grid, resolver input schema and receipt shape; widening any agent sandbox; target-project code changes; the proving-ground rerun (no live or proving-ground ticket).
- Shipyard's own behaviour is unchanged under its defaults: `prHygiene.applies` false, tracked `.planning/`, base `main`, no new config keys set.

## Ticket map

| Ticket | Title (short) | Requirements | Wave | Same-phase depends_on (primary first) | Cross-phase depends_on | Risk / HC |
|---|---|---|---|---|---|---|
| T-43-01 | Per-repo config keys | REQ-163, REQ-165, REQ-167, REQ-159, REQ-175 | 5 | — | T-40-17 | medium / false |
| T-43-02 | publish-gate base resolution, hook passes ticket | REQ-170, REQ-175 | 1 | — | — | medium / false |
| T-43-03 | Configured comment markers, comment edits not additions | REQ-163, REQ-175 | 6 | T-43-01, T-43-02 | — | medium / false |
| T-43-04 | Bounded reachability | REQ-171, REQ-175 | 8 | — | T-40-19, T-40-22 | medium / false |
| T-43-05 | Unknown arch-review finding type → informational | REQ-174, REQ-175 | 6 | — | T-40-18 | medium / false |
| T-43-06 | One exported scratch set | REQ-166, REQ-175 | 9 | T-43-05 | T-40-16, T-40-22, T-42-01, T-40-18, T-40-27, T-40-12, T-40-14, T-40-28, T-40-01, T-40-09 | high / true |
| T-43-07 | Cancelled checks, ci-wait 540 s | REQ-168, REQ-175 | 1 | — | — | high / true |
| T-43-08 | Stale bot approval | REQ-167, REQ-175 | 9 | T-43-04, T-43-01, T-43-07 | T-40-19, T-40-22 | high / true |
| T-43-09 | Targeted state-sync listing | REQ-173, REQ-175 | 7 | — | T-40-03, T-40-19, T-40-27 | medium / false |
| T-43-10 | gsd_sync alias, ROADMAP, summarised warning | REQ-169, REQ-175 | 8 | T-43-09, T-43-01 | T-40-17, T-40-03, T-40-19, T-40-27 | medium / false |
| T-43-11 | Jira bound by key | REQ-164, REQ-175 | 7 | — | T-40-25 | medium / false |
| T-43-12 | `human_checkpoint: review\|merge` | REQ-162, REQ-175 | 10 | T-43-08, T-43-11 | T-40-19, T-40-22, T-40-20, T-40-03, T-40-25 | high / true |
| T-43-13 | Verdict carry on identical own patch | REQ-161, REQ-175 | 10 | T-43-06 | T-40-19 | high / true |
| T-43-14 | Builders: arch-review, ci-fix, review-fix | REQ-172, REQ-175 | 10 | — | T-40-15, T-40-24 | medium / false |
| T-43-15 | Builders: research, decomposition | REQ-172, REQ-175 | 11 | T-43-12, T-43-14 | T-40-15, T-40-25 | medium / false |
| T-43-16 | Host-side verification, both runtimes | REQ-159, REQ-175 | 10 | T-43-06, T-43-01 | T-42-01, T-40-10, T-40-13, T-40-14, T-40-28, T-40-12, T-40-01, T-40-09 | high / true |
| T-43-17 | Sealed coverage records + rollout marker | REQ-160, REQ-159, REQ-175 | 11 | T-43-13, T-43-16 | T-42-01, T-40-18, T-40-27, T-40-10, T-40-13, T-40-14, T-40-28, T-40-12, T-40-01, T-40-09 | high / true |
| T-43-18 | Declared remedy workflows | REQ-165, REQ-175 | 12 | T-43-17, T-43-08 | — | high / true |
| T-43-19 | Merge gate refuses uncovered heads | REQ-160, REQ-175 | 13 | T-43-18, T-43-12 | T-40-19, T-40-22 | high / true |

Waves are `1 + max(parent wave)` over the whole graph, including cross-phase parents at their graph waves (T-40-17 4, T-40-18 5, T-40-19 3, T-40-22 7, T-40-24 9, T-40-25 6, T-40-27 6, T-40-09 8, T-40-15 8, T-42-01 1); `validate-graph.cjs` reports no wave disagreement and computes the same `primary_parent` for every ticket (deepest same-phase parent, lower id on a tie). REQ-175 is on every ticket: each plan's RED step must fail on base, and no ticket measures the proving-ground numbers.

### Graph shape (phase-40 D-42: real dependencies only)

Phase-40 D-36 linearization is superseded by D-42 (user, 2026-09-24): every same-phase `depends_on` is a shared `files_modified` path or an import of something the parent introduces, and a ticket may have several same-phase parents. T-40-27 (lands with phase 40, before this phase) cuts a diamond child from its primary parent and makes it ready only when every other same-phase parent has landed in the epic. The eight order-only edges of the earlier draft (02←01, 07←01, 04←07, 09←01, 11←08, 05←12, 14←12, 16←13) are removed.

Roots in phase 43: T-43-02 and T-43-07 (wave 1, no parent at all), and T-43-01, T-43-04, T-43-05, T-43-09, T-43-11, T-43-14 (cross-phase parents only).

Diamond children (primary parent → other parents that must be in the epic first):

| Child | Primary parent | Must land in the epic first | Why each edge is real |
|---|---|---|---|
| T-43-03 | T-43-01 | T-43-02 | 01: imports `repoValue`; 02: `publish-gate.cjs` and its test |
| T-43-08 | T-43-04 | T-43-01, T-43-07 | 04: `sentinel.cjs` and test; 01: imports `repoValue`; 07: `log-event.cjs` and test |
| T-43-10 | T-43-09 | T-43-01 | 09: `state-sync.cjs`; 01: `pipeline-config.cjs` and test |
| T-43-12 | T-43-08 | T-43-11 | 08: `sentinel.cjs` and test, imports `reviewers.cjs` exports; 11: `decompose.md` |
| T-43-15 | T-43-12 | T-43-14 | 12: `decompose.md`; 14: `deliver-dispatch.cjs` and test |
| T-43-16 | T-43-06 | T-43-01 | 06: `codex-delivery-host.cjs` and test; 01: imports `repoValue` |
| T-43-17 | T-43-13 | T-43-16 | 13: `base-merge.cjs`; 16: both delivery hosts and tests, the verification evidence digest |
| T-43-18 | T-43-17 | T-43-08 | 17: `conveyor-coverage.cjs` and test; 08: `log-event.cjs` and test |
| T-43-19 | T-43-18 | T-43-12 | 18: `conveyor-coverage.cjs`, `log-event.cjs`, `pr-sentinel.md`; 12: `sentinel.cjs` and test |

Single-parent children: T-43-06 ← T-43-05 (`role-artifact.cjs`), T-43-13 ← T-43-06 (`base-merge.cjs`).

`validate-graph.cjs` warns "shares no files_modified" on exactly three edges, all imports of T-43-01's `repoValue`: 03←01, 08←01, 16←01.

Phase depth: 13 waves (T-43-02/T-43-07 at wave 1 through T-43-19 at wave 13; previously 18). Critical path: T-40-09 (wave 8) → T-43-06 (9) → T-43-13 / T-43-16 (10) → T-43-17 (11) → T-43-18 (12) → T-43-19 (13). The recorder (T-43-17) still lands before the enforcer (T-43-19).

## Cross-phase ownership notes

Checked against `.planning/graph/tickets.json` and `delivery-state.json` on 2026-09-26: every T-40-xx and T-42-01 is `pending`; T-41-01..09 are `merged` and create no edges. A cross-phase edge means "after that ticket lands on main"; it cannot cascade through an epic, so these tickets start only after the parent phase is released, which is the ADR's one-wave shape.

| File | Pending owners | Phase-43 order |
|---|---|---|
| `scripts/sentinel.cjs` | T-40-19, T-40-22 | 04 → 08 → 12 → 19 |
| `tests/unit/sentinel.test.cjs` | T-40-22 | 04 → 08 → 12 → 19 |
| `scripts/claude-role-host.cjs` + test | T-40-16, T-40-22 | 06 |
| `scripts/state-sync.cjs` | T-40-03, T-40-19, T-40-27 | 09 → 10 |
| `scripts/gate-trailer.cjs`, `tests/unit/trailer.test.cjs` | T-40-19 | 13 |
| `scripts/role-artifact.cjs` + test | T-40-18 | 05 → 06 |
| `scripts/pipeline-config.cjs` + test | T-40-17 | 01 → 10 |
| `scripts/deliver-dispatch.cjs` + test | T-40-15 | 14 → 15 |
| `scripts/claude-delivery-host.cjs` | T-40-10, T-40-13, T-40-14, T-40-28 | 16 → 17 |
| `tests/unit/claude-delivery-host.test.cjs` | T-40-01, T-40-13, T-40-14, T-40-28 | 16 → 17 |
| `scripts/codex-delivery-host.cjs` | T-42-01, T-40-12, T-40-14, T-40-28 | 06 → 16 → 17 |
| `tests/unit/codex-delivery-host.test.cjs` | T-42-01, T-40-01, T-40-12, T-40-14, T-40-28, T-40-09 (last) | 06 → 16 → 17 |
| `scripts/delivery-commit-finalizer.cjs` | T-42-01, T-40-18, T-40-27 | 06 → 17 |
| `tests/unit/delivery-commit-finalizer.test.cjs` | T-42-01, T-40-18 | 06 → 17 |
| `scripts/command-runner.cjs` + test | T-42-01 | 16 |
| `scripts/ticket-worktree.sh` (gc) | T-40-27 | 06 |
| `scripts/validate-graph.cjs`, `tests/smoke/graph-validator-smoke.sh`, `skills/delivery-rules/SKILL.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md` | T-40-20 | 12 |
| `scripts/pipeline-stats.cjs` | T-40-03 | 12 |
| `commands/deliver.md` | T-40-24 | 14 only |
| `commands/decompose.md` | T-40-25 | 11 → 12 → 15 |
| `commands/investigate.md` | T-40-25 | 15 |

Phase-43 chains on files no other phase owns: `publish-gate.cjs` and `tests/unit/publish-gate.test.cjs` 02 → 03; `base-merge.cjs` 06 → 13 → 17; `log-event.cjs` and `tests/unit/log-event.test.cjs` 07 → 08 → 18 → 19; `conveyor-coverage.cjs` and its test 17 → 18 → 19; `references/pr-sentinel.md` 18 → 19. Every pair is ordered by a dependency edge (directly or through an ancestor).

Avoided on purpose: `tests/smoke/sentinel-smoke.sh` (T-40-19), `tests/smoke/claude-hook-smoke.sh` (T-40-05, T-40-21), `workflows/executors.mjs` and `fix-round.mjs` (T-40-28). Tickets 16 and 19 do not edit `deliver.md`.

Each phase-43 ticket lists every pending phase-40/42 owner of each file it touches directly in `depends_on`, even when that owner is already an ancestor, so the ordering stays explicit if phase 40 slips.

## Release notes for the operator (not tickets)

- Reinstall the Claude pre-push hook (`make install-shipyard-claude-hook`) after release so T-43-02/03 take effect, and reinstall the Codex bundle (`make install-shipyard-codex`).
- The proving-ground rerun that measures state-sync time, arch-review launches per ticket and orchestrator-authored commits is the operator's, outside this phase (D-17).
