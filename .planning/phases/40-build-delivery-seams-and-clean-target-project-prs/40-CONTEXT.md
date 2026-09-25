# Phase 40: Build delivery seams and clean target-project PRs - Context

**Source of decisions:** ADR-017 (`.planning/architecture/ADR-017-delivery-seams-and-pr-hygiene.md`, accepted 2026-09-24; identical ingest copy `.planning/.adr-ingest/ADR-017-delivery-seams-and-pr-hygiene.ingest.md`) and INV-004 `DECISIONS.md`, including the final entry "Phase 40 planning refinements (2026-09-24)", which answers the open questions in `40-RESEARCH.md`.
**Requirements:** REQ-136..REQ-150 (`.planning/REQUIREMENTS.md`).
**Mode:** `--tdd`, granularity standard. Every ticket writes its failing test first.

<decisions>

## Locked decisions (ADR-017 "Decision", one per bullet)

- **D-01 (REQ-136)** Strategy: build the seams first and gate releases on a live round. Point fixes land on top of the seams. The graph encodes this: the seam tickets (captured fixtures T-40-07/08, dispatch entry point T-40-14/15, sentinel preflight T-40-16) come before the tickets that build on them, and the live gate T-40-23 depends on the entry point.
- **D-02 (REQ-137)** Boundary fixtures for registered producer ↔ consumer boundaries are captured from real producers by a manual, scrubbed `make` target that records the CLI version. A contract test refuses inline shapes for those boundaries. CI only replays committed fixtures.
- **D-03 (REQ-138)** One deterministic front → dispatch entry point for Claude and Codex builds host requests from the graph: branch from the graph, plan path from the ticket worktree, ticket `type` mapped and never forwarded as `signals.type`. It launches detached and offers `status` and `wait` through a `dispatch` wait kind. It calls the existing hosts and the ADR-014 boundary; it is not a second boundary.
- **D-04 (REQ-139)** The host writes an in-flight record with pid and TTL at launch. The stop gate honours it, and it fails closed on process exit or expiry. The durable dispatch mark still follows the verified receipt.
- **D-05 (REQ-140)** A sentinel preflight fetches and fast-forwards the base ref, runs and commits state-sync, or refuses naming the exact command. A failed fetch is a refusal and is never swallowed.
- **D-06 (REQ-141)** `make test-live` runs one real research → decompose → executor → sentinel round per runtime on an in-repo fixture project, using each role's base rung of its runtime grid. The release script refuses without a fresh passing live receipt.
- **D-07 (REQ-142)** Target-project PRs carry no conveyor or GSD internals: branches `<type>/<slug>` or `<type>/<JIRA-KEY>-<slug>` stored in the graph, conventional-commit titles, bodies without ticket, phase, ADR or plan identifiers, `.planning/` untracked in target projects, and a publish-time PR hygiene gate over title, body, branch and diff paths. The Shipyard repository is exempt.
- **D-08 (REQ-143)** Ticket ↔ PR matching uses the exact head branch plus the PR number recorded in delivery state at creation. The title and `ticket/<ID>-` fallback stays only for legacy PRs.
- **D-09 (REQ-144)** A supported dogfood mode runs hosts from a worktree through a separate install root, stamps receipts with host source sha and dirty flag, is refused for merges into a target default branch, and doctor reports an installed cache that matches no release.
- **D-10 (REQ-145)** The runtime-file digest pin is refreshed only by a make target and a commit trailer that CI verifies.
- **D-11 (REQ-146)** Research keeps valid lines sealed, names the failed line and its real cause, and re-dispatches only that line. The fan-out stays failed until all four lines are sealed.
- **D-12 (REQ-147)** One shared sealer produces `shipyard.research-result.v1` and `shipyard.decomposition-result.v1` with an artifact index, for Claude and Codex research and decompose hosts. It absorbs the backlog entry `.planning/backlog/decompose-host-returns-no-artifact-index.md`.
- **D-13 (REQ-148)** The Codex GSD researcher writes only its contained artifact path. Codex child tasks are passed by file path plus a digest that the host verifies.
- **D-14 (REQ-149)** Point fixes: the state YAML is header-free and deterministic; the pre-push hook resolves the worktree through git instead of command text; the Codex config refusal names the config fix; `gsd-tune --runtime codex` writes no Claude-only keys; investigate and decompose prose explain the out-of-repo host state directory; doctor reads the Codex agents manifest.
- **D-15 (REQ-150)** Unit fixtures that create git repositories are hermetic against global commit signing and fixed `/tmp` paths.

## Planning refinements (INV-004 DECISIONS "Phase 40 planning refinements", locked)

- **D-16** Target projects make `.planning/` untracked through an explicit, confirmed, one-time migration command. The conveyor never writes `.gitignore` automatically (rejected: automatic `.gitignore` writes by bootstrap).
- **D-17** The REQ-133 warning (T-39-10) is inverted for target projects: it fires when `.planning/` is tracked. In the Shipyard repository it keeps its phase-39 meaning.
- **D-18** Target-project epic branches are `feat/<slug>` or `feat/<JIRA-KEY>-<slug>`, with a neutral epic PR title and body. The phase mapping stays in the graph (rejected: keeping `epic/<phase-dir>` names in target projects).
- **D-19** Commit subjects are in hygiene scope, including the host-finalized commit.
- **D-20** Gate verdicts move from the `gate_status:` PR-body trailer to a commit status (rejected: a `gate_status:` trailer in PR bodies).
- **D-21** The live round uses each role's base rung of its runtime grid. No separate cheap smoke grid (that would be an ADR-014 change).
- **D-22** The live receipt lives under `~/.local/state/shipyard/live/`, keyed by plugin version and tree sha, and is fresh for 7 days.
- **D-23** Host provenance is a sidecar keyed by `dispatch_id`, not a field of the ADR-014 application receipt.
- **D-24** `models.*` tuning keys are written only for Claude.

Resolution of `40-RESEARCH.md` "Open Questions" (all RESOLVED): Q1 untracking and REQ-133 → D-16, D-17; Q2 epic branch naming → D-18; Q3 `gate_status:` trailer → D-20, D-32; Q4 provenance location → D-23, D-33; Q5 live-round model → D-21, D-40; Q6 `models.*` → D-24; Q7 live receipt store → D-22; Q8 commit subjects → D-19, D-38.

## Planner choices (Claude's discretion, recorded so executors do not re-decide)

- **D-25** New module names: `deliver-dispatch.cjs`, `sentinel-preflight.cjs`, `pr-hygiene.cjs`, `pr-ledger.cjs`, `planning-untrack.cjs`, `planning-result-sealer.cjs`, `host-provenance.cjs`, `live-receipt.cjs` under `plugins/delivery-pipeline/scripts/` (shipped to both runtimes by the generator unchanged), and repository tooling `scripts/capture-boundary-fixtures.cjs`, `scripts/refresh-runtime-digests.cjs`, `scripts/check-runtime-digest-trailer.cjs`, `scripts/release.sh`, `tests/live/live-round.sh`.
- **D-26** The Shipyard exemption is `prHygiene.applies({root, ref})`: false only when `plugins/delivery-pipeline/.claude-plugin/plugin.json` exists and its `name` is `shipyard`. Host-side callers pass the committed base `ref`, so the manifest is read from git (`git show <ref>:<path>`) and a worktree edit cannot grant the exemption. Any read or parse failure means hygiene applies (fail closed). Every other hygiene-aware module imports this one predicate. Agents never supply the answer. Executors receive the target-project body guide through the existing `prBodyGuide` argument set by the entry point.
- **D-27** Branch `<type>` is a deterministic map from the ticket's GSD `type`: `implementation`, `tdd`, `execute` → `feat`; `fix`, `bugfix`, `gap_closure` → `fix`; `docs` → `docs`; `refactor` → `refactor`; `test` → `test`; `chore`, `config` → `chore`; anything else → `feat`. `<JIRA-KEY>` comes from `delivery.jira` when the graph row carries one. The same map gives the conventional-commit type for titles.
- **D-28** The pre-push hook (Pitfall 12) takes candidate directories from `git -C <path>` / `cd <path>` in the command and from the payload `cwd`. For each candidate it asks git (`git -C <dir> rev-parse --show-toplevel`) and gates the toplevel git returns. If the command names a target that git cannot resolve (unexpanded variable, missing directory, not a worktree), the hook fails closed with a remedy that names `git -C <absolute worktree> push`. It never falls back to the session cwd when the command names a different target.
- **D-29** The in-flight record lives in `dispatch-record.cjs` beside `reservations`, reuses `DISPATCH_TTL_MS`, and counts as live only while `process.kill(pid, 0)` succeeds. `EPERM` counts as not live (fail closed).
- **D-30** Plan path: the entry point resolves the graph directory from the ticket worktree with `graph-dir.cjs resolveGraphDir`, sets `planPath = path.resolve(graphDir, '..', '..', row.plan)`, and passes that graph directory to the detached host through `SHIPYARD_GRAPH_DIR` (Pitfall 2).
- **D-31** The PR number recorded at creation lives in a locked ledger `<graphDir>/pr-ledger.json` written by `pr-ledger.cjs record`. `state-sync.cjs` reads it and never rebuilds it from GitHub.
- **D-32** The gate commit status uses the context `merge-gate`. Its description carries the existing trailer grammar (`arch-review=…, drift-check=…, tree=<short sha>`), at most 140 characters. A body trailer is read only as a legacy fallback when a PR has no `merge-gate` status.
- **D-33** The provenance sidecar is written by `dispatch-record.cjs recordInflight` to `<graphDir>/provenance/<dispatch_id>.json`, so every host that records an in-flight dispatch stamps it at one site.
- **D-34** Unit hermeticity: `tests/unit/run.sh` exports a hermetic `GIT_CONFIG_GLOBAL` plus `GIT_CONFIG_NOSYSTEM=1`, and `tests/unit/assert-harness.cjs` sets the same environment when it is absent, so a direct `node tests/unit/x.test.cjs` run is hermetic too.
- **D-35** Prose files are edited only in three integration tickets: `deliver.md` (T-40-24), `investigate.md` + `decompose.md` (T-40-25), `Makefile` + `README.md` + `CLAUDE.md` (T-40-26). Each file has exactly one owning ticket, and each prose ticket adds a new contract test instead of editing the phase-39 friction contract tests. A prose ticket depends on the code its contract test resolves; code it only describes lands with it through the epic (plan-check revision, D-36).

## Plan-check revisions (2026-09-24, recorded so executors do not re-decide)

- **D-36** A ticket worktree is cut from its primary parent's branch only (`ticket-worktree.sh create <T> <branch> <base>`, `state-sync.cjs` base resolution); a non-primary same-phase parent reaches it only after landing in the epic. So every ticket has at most one same-phase parent, and each ticket whose code, files or verification needs several tickets finds them all on its primary chain. The graph is one spine, T-40-07 → 02 → 03 → 19 → 17 → 01 → 16 → 10 → 13 → 12 → 14, with branches 17 → 18 / 20, 12 → 25, 14 → 15 → 23 → 26 / 24, 14 → 05 → 04 → 11 → 09, 05 → 21 → 22, 07 → 08, and root T-40-06. Four edges carry no code dependency and exist only for linearization (02←07, 01←17, 10←16, 05←14); each plan names the child that needs them. The T-39-06 order-only warning is expected on them, and on dependencies whose need is an import rather than a shared file.
- **D-37** The Codex agent-stream boundary is registered by T-40-07 with every current inline fabrication in a `migrating` list (`codex-runtime-host.test.cjs`, `codex-decompose-host.test.cjs`, `codex-delivery-host.test.cjs`). The contract test scans every unit test and matches object-literal as well as JSON-string records. T-40-09 re-captures (session files plus the `codex exec --json` stdout) and migrates all three, leaving `migrating` empty.
- **D-38** In target projects the entry point also sets the executor's `deliveryRulesHint` to `pr-hygiene.cjs NEUTRAL_DELIVERY_RULES_HINT`, because the default hint asks for a `(T-id):` commit prefix (D-19).
- **D-39** The hygiene path rule rejects added, modified, copied or renamed `.planning/` and `.shipyard/` paths; deletions are allowed, so the D-16 untrack migration passes the gate.
- **D-40** The live round enforces D-21: it passes no promotion signal, refuses a decomposed ticket that would promote the executor rung, and fails a stage whose ADR-014 application receipt shows a rung other than the role's base rung. It publishes through the deliver publication path, including `pr-ledger.cjs record`. Its human-action run happens after the other phase-40 code tickets have merged into the epic and the epic is merged into its branch.
- **D-41** The Codex research consumer (T-40-12) supports the single-line re-dispatch with `verifySealedLine`, as the Claude path does (REQ-146 on both runtimes).

## Amendment after user review (2026-09-24)

- **D-42 (T-40-27, REQ-138, REQ-136)** The graph carries real dependencies instead of the D-36 linearization, so a ticket may have several same-phase parents. A diamond child's primary parent still only needs to be `branched`, but every non-primary same-phase parent must have landed in the phase epic before the child is ready (`state-sync.cjs`, with the reason on the board). `ticket-worktree.sh create` merges the epic into the fresh child branch so its tree holds every parent, and the scope gates measure the child against the merge of its base and the epic. This supersedes D-36's single-parent rule and the "Deliberately NOT the fix" paragraph of `.planning/backlog/diamond-child-base-is-materially-incomplete.md`. Phase-40 diamond children are dispatched only once T-40-27 runs in the delivering conveyor (40-PLAN-CHECK "Amendment after user review").

</decisions>

## Scope fences (verbatim intent from INV-004 DECISIONS)

- No change to the ADR-014 grid, the resolver input (`normalizeSignals` keeps `type ∈ {facts, alternatives}`), the application receipt shape, or fail-closed receipt verification.
- The entry point calls the existing hosts and boundary. It does not resolve models or verify receipts itself.
- The in-flight record is host-issued at launch. The model never writes it, and the stop gate never reads process tables directly.
- PR hygiene applies to target projects only. The Shipyard repository's own PRs, branches (`ticket/<ID>-<slug>`, `epic/<phase-dir>`), `Ticket:` markers and tracked `.planning/` are unchanged.
- `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs` are digest-pinned. No phase-40 ticket edits them.
- Codex artifacts are generated from the canonical plugin. No ticket lists `.build/` or installed Codex homes; regeneration is `make install-shipyard-codex`, and parity is the network-bound `make test-codex-shipyard` (operator/CI only).
- Installer changes go only into `scripts/install-shipyard-claude-hook.sh` and `scripts/install-shipyard-codex.sh`.
- New code lines follow the comment policy: no explanatory, historical or ticket comments; at most one-line `@invariant:`/`@security:`/`@contract:` markers of 120 characters or less.
- New tests are hermetic: `os.tmpdir()`, their own `GIT_CONFIG_GLOBAL` with `commit.gpgsign=false`, no network.
- Live capture and the live round need real CLIs and credentials. They are `checkpoint:human-action` steps inside their tickets (risk high, `human_checkpoint: true`), and each has an offline replay test that runs without network.

## Out of scope (ADR-017 "Out of scope", deferred)

- The ADR-014 model/effort grid, the resolver input schema, the receipt shape and fail-closed receipt verification.
- Work already planned as T-39-01..T-39-12.
- The Codex plan-checker lease flake backlog entry (`.planning/backlog/codex-plan-checker-lease-test-flakes-on-ci.md`).
- Exporting this phase's tickets to Jira.
- Applying PR hygiene to the Shipyard repository's own PRs.
- Automatic retitling of already-open legacy target-project PRs. They merge under the legacy matcher fallback.

## Cross-phase gating

Tickets whose `files_modified` meets a phase-39 plan's `files_modified` declare that exact `T-39-NN` in `depends_on` (map: `40-RESEARCH.md` "Cross-phase map"). They start only after phase 39 is on `main`. The tickets with no overlap are T-40-02, T-40-03, T-40-07, T-40-15, T-40-17, T-40-18, T-40-19 and T-40-23. Of these only T-40-07 is a root; T-40-02, 03, 19, 17 and 18 follow it on the spine and can run before phase 39 lands, while everything from T-40-01 on is gated by phase 39 directly or through its chain (D-36).

## Ticket map

| Ticket | Requirements | Wave | Same-phase depends_on | Cross-phase |
|---|---|---|---|---|
| T-40-01 hermetic git unit fixtures | REQ-150 | 2 | — | T-39-01 |
| T-40-02 header-free state YAML + pre-push via git | REQ-149 | 1 | — | — |
| T-40-03 PR ledger and head-branch matching | REQ-143 | 2 | 02 | — |
| T-40-04 Codex config refusal remedy | REQ-149 | 3 | 05 | T-39-01 |
| T-40-05 Codex tune keys + doctor manifest | REQ-149 | 2 | — | T-39-07, T-39-04 |
| T-40-06 digest pin refresh + CI trailer | REQ-145 | 2 | — | T-39-12 |
| T-40-07 boundary capture harness + contract test | REQ-137, REQ-136 | 1 | — | — |
| T-40-08 captured Claude stream fixtures | REQ-137 | 2 | 07 | T-39-12 |
| T-40-09 Codex task by file + digest, Codex consumer migration | REQ-148, REQ-137 | 8 | 11 (primary), 07, 14 | T-39-01 |
| T-40-10 shared planning-result sealer (Claude) | REQ-147 | 3 | 01 | T-39-01, T-39-08 |
| T-40-11 Codex decompose sealing + researcher scope | REQ-148, REQ-147 | 7 | 14 (primary), 04 | T-39-01, T-39-07 |
| T-40-12 Codex research consumer + single-line re-dispatch | REQ-147, REQ-148 | 5 | 13 | T-39-01 |
| T-40-13 per-line research recovery | REQ-146 | 4 | 10 | T-39-08 |
| T-40-14 in-flight record + host request validators | REQ-139, REQ-138 | 6 | 12 | T-39-03, T-39-08, T-39-01 |
| T-40-15 deliver-dispatch entry point | REQ-138, REQ-136 | 7 | 14 (primary), 17, 16 | — |
| T-40-16 sentinel preflight | REQ-140, REQ-136 | 3 | 01 | T-39-12 |
| T-40-17 PR hygiene gate + `.planning/` untrack migration | REQ-142 | 4 | 19 | — |
| T-40-18 clean executor PR artifacts | REQ-142 | 5 | 17 | — |
| T-40-19 gate verdict as commit status | REQ-142 | 3 | 03 | — |
| T-40-20 neutral ticket and epic branches | REQ-142 | 5 | 17 | T-39-06 |
| T-40-21 dogfood install root + doctor cache check | REQ-144 | 3 | 05 | T-39-04 |
| T-40-22 provenance sidecar + dogfood merge refusal | REQ-144, REQ-139 | 7 | 14 (primary), 21, 16, 19 | T-39-03, T-39-12 |
| T-40-23 live round + release gate | REQ-141, REQ-136 | 8 | 15 (primary), 17 | — |
| T-40-24 deliver prose on the seams | REQ-138, REQ-139, REQ-140, REQ-142, REQ-143, REQ-136 | 8 | 15 (primary), 17, 16 | T-39-03 |
| T-40-25 investigate/decompose prose | REQ-149, REQ-146, REQ-147, REQ-148, REQ-142 | 6 | 12 (primary), 17 | T-39-10, T-39-11 |
| T-40-26 command surface (Makefile, README, CLAUDE.md) | REQ-137, REQ-141, REQ-144, REQ-145, REQ-136 | 9 | 23 (primary), 07 | T-39-04 |
| T-40-27 diamond child readiness + epic base-merge | REQ-138, REQ-136 | 6 | 18 | — |

## Source audit

| Source | ID | Item | Ticket(s) | Status |
|---|---|---|---|---|
| GOAL | — | Seams, live-gated releases, Codex loops repaired, dogfood provenance, clean target PRs | all | COVERED |
| REQ | REQ-136 | Seams before point fixes; releases gated on a live round | graph + T-40-07, 15, 16, 23, 24, 26 | COVERED |
| REQ | REQ-137 | Captured fixtures, make target, contract test (all Codex consumers migrated, D-37) | T-40-07, 08, 09, 26 | COVERED |
| REQ | REQ-138 | Entry point, detached launch, status/wait; diamond children dispatched only into a complete tree (D-42) | T-40-14, 15, 24, 27 | COVERED |
| REQ | REQ-139 | In-flight record | T-40-14, 22, 24 | COVERED |
| REQ | REQ-140 | Sentinel preflight | T-40-16, 24 | COVERED |
| REQ | REQ-141 | `make test-live`, release gate | T-40-23, 26 | COVERED |
| REQ | REQ-142 | Target PR hygiene | T-40-17, 18, 19, 20, 24, 25 | COVERED |
| REQ | REQ-143 | Recorded PR number + head branch matching | T-40-03, 24 | COVERED |
| REQ | REQ-144 | Dogfood mode | T-40-21, 22, 26 | COVERED |
| REQ | REQ-145 | Digest pin refresh | T-40-06, 26 | COVERED |
| REQ | REQ-146 | Per-line research recovery (Claude T-40-13, Codex T-40-12) | T-40-12, 13, 25 | COVERED |
| REQ | REQ-147 | Shared sealer | T-40-10, 11, 12, 25 | COVERED |
| REQ | REQ-148 | Researcher write scope; task by file + digest | T-40-09, 11, 12, 25 | COVERED |
| REQ | REQ-149 | Six point fixes a-f | a,b T-40-02; c T-40-04; d,f T-40-05; e T-40-25 | COVERED |
| REQ | REQ-150 | Hermetic git fixtures | T-40-01 | COVERED |
| CONTEXT | D-16..D-24 | Planning refinements | T-40-17/25 (16,17), 20 (18), 15/17/18 (19), 19 (20), 23 (21,22), 22 (23), 05 (24) | COVERED |
| CONTEXT | D-36..D-41 | Plan-check revisions | graph (36), 07/08/09 (37), 15/17 (38), 17 (39), 23 (40), 12 (41) | COVERED |
| CONTEXT | D-42 | Real graph + diamond-child readiness and epic base-merge | graph, T-40-27 | COVERED |
| RESEARCH | Pitfalls 1-13 | Addressed in the owning tickets' Scope | T-40-15 (1,2,3), 06 (4), 16 (5), 18 (6), 25 (7), 20 (8), 19 (9), 22 (10), 01 (11), 02 (12), 05 (13) | COVERED |

## ADR-018 additions (2026-09-25)

Source: `.planning/architecture/ADR-018-worktree-conditions-and-residual-seams.md`, INV-005, `40-RESEARCH-ADR018.md`. These decisions extend ADR-017's; they do not re-decide them.

- **D-43** ADR-018 work lands as tickets T-40-28..T-40-38. Each one is ordered after every phase 40 ticket that modifies the same files, directly or through its ancestors (Gate 2 checks transitive order). The owners are: `claude-role-host.cjs` T-40-16 → T-40-22 → T-40-30 → T-40-31 → T-40-32; `role-artifact.cjs` T-40-18 → T-40-36; `gate-trailer.cjs` T-40-19 → T-40-35; `ticket-worktree.sh` and the finalizer T-40-27 → T-40-34; the four hosts T-40-11 → T-40-33, and their existing test files T-40-09 → T-40-33; `tests/unit/files-contract.test.cjs` and `tests/smoke/sentinel-smoke.sh` T-40-19 → T-40-35; `deliver.md` T-40-24 → T-40-37; `decompose.md` T-40-25 → T-40-38. No new ticket edits `state-sync.cjs`, `sentinel.cjs` or `deliver-dispatch.cjs`.
- **D-44** A single module, `worktree-conditions.cjs` (T-40-28), holds the scratch and host-owned registry (built from the `role-artifact.cjs` exports), the per-profile launch preconditions (the RESEARCH Pattern 1 matrix) and the copyable remedies. The hosts are the check sites: role host T-40-32, delivery and decompose hosts T-40-33, worktree scripts T-40-34. There is no additional check at the dispatch entry point.
- **D-45** The host-owned set includes T-40-22's `<graphDir>/provenance/` and T-40-03's `pr-ledger.json`, added in T-40-29 after T-40-22. `ticket-worktree.sh` writes repo-global `info/exclude` entries, including `.shipyard-role-artifacts/`. New phase evidence committed there in the Shipyard repository therefore needs `git add -f`.
- **D-46** Hosts detect mutations with an lstat and digest snapshot that ignores `info/exclude`. An out-of-scope mutation is restored by the host (tracked restore, deletion of new untracked files, atomic rewrite of changed bytes, compare-and-swap HEAD restore on an unchanged branch) and reported as `WORKTREE_MUTATED` with the affected paths in `details`. This also runs on the failure path. Restore never runs `git clean` and never follows a symlink.
- **D-47** Target projects keep `.planning/` untracked, so `ticket-worktree.sh create` copies only the ticket's plan into the worktree. The hosts then accept that copy when its sha256 matches the source plan. Executors read the graph host-side. This is the answer to RESEARCH Open Question 1, and the operator confirms it at T-40-33's checkpoint.
- **D-48** The integrator reviews the code diff with `.planning/` and `.shipyard-role-artifacts/` excluded, plus a summary of `.planning` changes as name-status with full blob ids. Both come from `integrator-diff.cjs` (T-40-31), which the Claude host imports and which `references/integrator.md` names for Codex. When a bound is still exceeded, the refusal names the command that measures the size and the remedy.
- **D-49** Arch-review accepts draft PRs. The sentinel and the merge gate keep refusing drafts, and `tests/unit/sentinel-draft-merge.test.cjs` pins that (T-40-30).
- **D-50** A sentinel round leaves out, without reporting them, any non-member PRs opened after its snapshot. A member that gains a second PR expires. A gh failure still refuses (T-40-30).
- **D-51** A verdict carries across a sibling merge only on a tree-object delta-identity proof (`diff-tree --no-renames`) with a base move disjoint from the ticket's changed and declared paths (`carry-proof.cjs`, T-40-35). This extends D-32: the `merge-gate` description carries a full 40-hex `base_tree` within 140 characters, and a carried status records the new merge-base tree.
- **D-52** Executor artifacts are validated in historical mode only when the caller passes `--historical`, at publication. That mode binds the recorded base commit and tree, the base's ancestry to HEAD, and the live head (T-40-36). `deliver.md` passes the flag, opens the PR against the live base and names base-merge as the follow-up (T-40-37).
- **D-53** `seed-delivery-state.cjs` (T-40-38) writes `pending` rows offline for ticket ids that are absent from the state; decompose runs it after Gate 2. `gsd-sync --check` still refuses a ticket with no observation, and its refusal now names the seeder. Seeding shows as `RESYNC_REQUIRED` until the next state-sync. D-35 is extended: `references/integrator.md` is owned by T-40-31.
- **D-54 (plan-check 2026-09-25)** Worktree conditions cover every role that runs in a ticket worktree, `drift-check` included (Claude `drift-gate` workflow and Codex, T-40-28 profile, T-40-33 wiring). For executors and repairs, REQ-154 means this: after the run, and also after a finalizer scope refusal, the host restores and reports uncommitted paths outside the ticket's declared files. It never resets HEAD or rewrites a host-finalized commit. D-47 is extended to every profile: when `.planning/` is untracked at the worktree HEAD, the graph stays host-side and `check` requires a resolvable host-side graph outside the worktree instead of refusing `GRAPH_OUTSIDE_WORKTREE`. Gitignored non-registry paths never count as unknown untracked files. The seeder (T-40-38) writes inside the `state-sync` lock. The operator confirms the graph rule at T-40-33's checkpoint.
- Resolution of `40-RESEARCH-ADR018.md` "Open Questions" (all RESOLVED): Q1 plan and graph in target worktrees → D-47, D-54; Q2 full `base_tree` in the status → D-51, with T-40-35 escalating if it cannot fit in 140 characters; Q3 repo-wide archive exclude → D-45; Q4 draft refusals before T-40-30 is in a running build → operational (the phase 39 workaround stays until the dogfood install carries T-40-30); Q5 entry-point check → D-44 (none).
- Operational note: until T-40-38 ships, the planning PR that adds T-40-28..T-40-38 must write `pending` rows for those ids into `.planning/graph/delivery-state.json`, and then regenerate the gsd-sync projections.

| Ticket | Requirements | Wave | Same-phase depends_on | Risk |
|---|---|---|---|---|
| T-40-28 worktree-conditions module | REQ-152, REQ-154 | 3 | 01 | medium |
| T-40-29 provenance and PR ledger host-owned | REQ-152, REQ-154 | 8 | 28, 22 | medium |
| T-40-30 draft arch-review, late-PR round exclusion | REQ-157, REQ-158 | 8 | 22 | medium |
| T-40-31 scoped integrator diff | REQ-156 | 9 | 30 | medium |
| T-40-32 role-host conditions and restore | REQ-152, REQ-154 | 10 | 31, 29 | high |
| T-40-33 delivery and decompose host conditions | REQ-152, REQ-154 | 9 | 09, 11, 29 | high |
| T-40-34 worktree excludes, plan copy, verify | REQ-153, REQ-152 | 7 | 27, 28 | medium |
| T-40-35 tree-object verdict carry | REQ-151 | 4 | 19 | high |
| T-40-36 historical executor validation | REQ-155 | 6 | 18 | high |
| T-40-37 deliver prose | REQ-155, REQ-152, REQ-153, REQ-157 | 9 | 24, 34, 36 | low |
| T-40-38 offline pending seeder | REQ-159 | 7 | 25 | low |
