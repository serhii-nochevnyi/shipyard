# INV-007 — research line 3: constraints

- Line: `constraints` (→ RESEARCH.md "Constraints" + seeds for CONSTRAINTS)
- Source revision: `d8a7146e2150dde25a456532a075d0012718df8d` (`git -C <worktree> rev-parse HEAD`)
- Policy hash: `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968` (ADR-014 `adr-014.v6`); policy signals passed to this line: `{}`
- Runtime selection (resolved by the caller, preserved as evidence): `claude-opus-5-5` / `medium`
- Plugin version on this revision: `0.63.0` (`grep '"version"' plugins/delivery-pipeline/.claude-plugin/plugin.json` → line 4), the same version the pdffiller session ran.
- Read-only. No product code, plan or graph was changed. The only file written is this one.

## 0. Method and evidence commands

| # | Command (run from the worktree root) | What it established |
|---|---|---|
| C1 | `node -e` over `.planning/graph/tickets.json` (`files` field) and `.planning/graph/delivery-state.json` (`status`), filtered by a list of file substrings | Which open tickets declare each file (§3). Every phase-40/41 ticket is `pending`. |
| C2 | `awk` over the front matter of `.planning/phases/4{0,1}-*/4?-*-PLAN.md` for `files_modified` | The same ownership taken from the plans. It matches C1, except for the D-43/D-45 amendment. |
| C3 | Read `intake/phase40-amendment.diff` (309 lines) | The amendment adds `workflows/executors.mjs`, `tests/unit/workflows-args.test.cjs`, both delivery hosts and their tests to T-40-15, and `pipeline-config.cjs` plus its test to T-40-17. It is **not** in `tickets.json` on this branch (C1 shows no open owner for `executors.mjs` or `pipeline-config.cjs`). |
| C4 | Read/Grep on the code sites cited in §2 | The current behaviour behind each constraint. |
| C5 | `grep -c` / `grep -m` over `intake/transcript-timeline.txt` (1019 lines) | Transcript timestamps cited below (UTC as the timeline records them). |
| C6 | `git log --oneline -5 -- scripts/shipyard-pre-push-gate.sh plugins/delivery-pipeline/scripts/publish-gate.cjs` | The last change to either file is `9b1af4d5`. T-41-08 is not on this branch (state `pending`). |
| C7 | Read `.planning/architecture/ADR-014-mandatory-runtime-model-ladder.md:100-201`, grep `ADR-017-delivery-seams-and-pr-hygiene.md` | The boundary rules quoted in §1. |

Denied during research. Two compound `cd … && sed …` shell commands were refused by the permission layer; their reads were redone with the Read and Grep tools. One `ls` with a computed path was also refused. Nothing depends on the denied commands.

## 1. Cross-cutting hard constraints

### K1 — ADR-014 boundary: receipts, not new launch authority (confidence: high)
Source: `ADR-014-mandatory-runtime-model-ladder.md:119-143` (§4 "Mandatory dispatch boundary"), `:107-110`, `:196-200`.
- Every routed launch must run `resolve → validate → launch with explicit selection → verify application receipt → record`. "A successful process exit alone is not evidence of compliance" (`:135-136`). "If the host cannot carry the required selection, the dispatch is refused" (`:142-143`).
- Rollback "must not restore silent inheritance" (`:199-200`). A missing adapter or receipt "never falls back to a parent session" (`:196-197`).
- Consequences for phase 42:
  - **F7** Refusing merges of commits that no receipt covers *strengthens* the boundary, and is allowed. Giving the executor docker, network or a wider filesystem *widens launch authority*, which is a new ADR-level decision. D-43 already rejected `--add-dir` ("widens the sandbox", `phase40-amendment.diff:271`). Any verification environment has to run **host-side, outside the agent's permissions**: the trusted host runs the declared verification commands after the agent exits and records their result in the receipt or finalization. Otherwise the ADR for phase 42 has to amend ADR-014 explicitly.
  - **F10** New request builders (research, decompose, arch-review, fix-round) may only *build and validate* requests through each host's exported validator, following the T-40-15 pattern (`phase40-amendment.diff:78`). They must not launch outside the host, choose a model or effort, or copy a ticket `type` into `signals` (T-40-15 Pitfall 1).
  - **F12, F18** Re-running CI (`gh run rerun`) or dispatching a repository's own regeneration workflow is a GitHub mutation, not a model launch. It still needs positive evidence (ADR-004) and a journal record. It must not create a new, unreceipted agent path.
  - **F14** An arch-review artifact is a sealed role artifact. Tolerating an unknown finding type must never turn it into `conform`, and must never drop a `violation` or `adr-outdated` finding.
- Out of scope per PROBLEM.md: the model/effort grid, the resolver input schema and the **receipt shape**. Phase 42 can add a *consumer* of receipts (the merge gate). It cannot add fields to the receipt. A host-side verification result therefore goes into finalization evidence or a separate sealed artifact that the receipt already references by digest. This conflict needs a Gate-1 decision; see §5 Q1.

### K2 — Codex parity (confidence: high)
Source: `ADR-014 §4` ("Every routed launch, on either runtime"), the PROBLEM.md "For whom" line ("Claude or Codex"), and T-40-15 building both runtimes' requests (`phase40-amendment.diff:78`, `:88`).
- Each fix to a host or builder must land for both `claude-*-host.cjs` and `codex-*-host.cjs`, or explicitly record why one runtime is unaffected. Scratch-file handling already differs by runtime: `codex-delivery-host.cjs:20` has `SCRATCH_STATUS` (an exact `?? name` set), `delivery-commit-finalizer.cjs:8` has `SCRATCH`, and `claude-role-host.cjs:131` has no exemption. **F5 should use one shared definition, not add a fourth.**
- Codex has no `pr-sentinel` role host of its own. The Claude-only paths are `claude-role-host.cjs` for sentinel, arch-review and fix-round. F5/F10 parity means the Codex role path (`codex-dispatch-adapter.cjs`, owned by T-40-04 and T-40-11) must get the same request builder, or be named as a follow-up.
- Tests for Codex host behaviour must replay captured streams, not hand-authored records (T-40-09 rule, `phase40-amendment.diff:27-31`). T-40-09 is the last editor of `tests/unit/codex-delivery-host.test.cjs` and `codex-decompose-host.test.cjs`, so phase-42 edits to those files must come **after T-40-09**.

### K3 — Shipyard repository backward compatibility (confidence: high)
Source: ADR-017 Decision (`ADR-017…md:49`, "the Shipyard repository is exempt"), and D-26 `prHygiene.applies({root, ref})` (`phase40-amendment.diff:207`).
- Shipyard has a single repository, `main`, tracked `.planning/`, a small tree, and CodeRabbit disabled (backlog `a-disabled-reviewer-has-no-way-to-say-so.md`). Every phase-42 change must leave `make test-fast` and the Shipyard path byte-identical, or behaviour-identical, when:
  - the base resolves to `main`;
  - `.planning/` is tracked;
  - there is one repository;
  - no `pr_title_format`, `repos` or Jira-binding keys are set.
- Target-project behaviour switches on `prHygiene.applies` (T-40-17), computed from the **committed base**, never from worktree files (T-40-18 acceptance: "The exemption cannot be obtained by writing files in the ticket worktree"). Phase-42 target-only branches (F13 annotations, F15 binding, F7 host-side verification) must use the same predicate, not a new one.
- New config keys follow the D-45 pattern (`phase40-amendment.diff:223`): register the key in `pipeline-config.cjs`, and on a bad shape warn and fall back to the default. Precedence: `delivery_pipeline.*` wins over `pipeline.*` (`pipeline-config.cjs:922-926`).

### K4 — Fail-closed merge gate (confidence: high)
Source: `sentinel.cjs:1003-1056` (live re-verification before merge, "an unknown is not a pass", `:1013-1025`) and ADR-004 ("positive evidence before a mutation").
- F8, F9, F12 and F14 all relax a refusal. Each relaxation has to replace the refusal with **positive evidence**, never with an absence. For example:
  - F8 must still refuse a truncated tree listing (`sentinel.cjs:210`), even after it stops reading the full recursive tree.
  - F9 may ignore a stale bot approval only when no human reviewer's decision depends on it.
  - F12 may retry a CANCELLED check, but must never count it as a pass.

### K5 — Comment policy applies to phase-42's own diff (confidence: high)
Source: `comment-policy.cjs:382` (`allowed_markers: ['@invariant:', '@security:', '@contract:']`), and every 40/41 plan ends with "Comment policy on added lines" plus `publish-gate.cjs --base origin/main --working-tree --json` (e.g. `41-08-PLAN.md:103`).
- Phase-42 code follows the same policy. For F13, a per-repository allowlist must be read from trusted configuration (the committed base or the project `.planning/config.json`), never from the ticket worktree, or an agent could widen its own allowlist.

### K6 — Delivery conventions and CI gates (confidence: high)
- The graph is the source of truth for ownership. `files_modified` is enforced by `scope-gate.cjs` (owned by T-40-27). A phase-42 ticket that touches a file owned by an open 40/41 ticket must `depends_on` that ticket, and becomes a diamond child under D-42 (`phase40-amendment.diff:264`).
- Phase 41 releases before phase 40 (`phase40-amendment.diff:309`). Phase 42 lands after phase 41 and "alongside phase 40" (PROBLEM.md front matter). **In practice every phase-42 ticket that shares a file with phase 40 has to wait for that phase-40 ticket to merge into the phase-40 epic, and for the phase-40 epic to reach `main`.** A cross-phase parent must land on main first (backlog `a-cross-phase-dependency-never-reaches-the-childs-tree.md`).
- CI runs `make test-fast` via `.github/workflows/test.yml` (backlog `no-ci-in-the-conveyors-own-repo.md`, closed). T-40-06 edits that workflow. Live or docker targets are not in CI.
- Plan-check gate: every test named must be one that can fail on base (backlog `an-acceptance-criterion-that-cannot-fail.md`). A pure-function test cannot witness a writer.

## 2. Per-finding constraints: files, 40/41 overlap, ordering, tests, compatibility

"Owner" means an open (`pending`) ticket that declares the file (C1/C2/C3). "None" means no open 40/41 ticket declares it.

### F2 — publish-gate base resolution
- Current: `publish-gate.cjs:24-40` `baseFor` tries `--base`, `COMMENT_POLICY_BASE`, `SHIPYARD_COMMENT_BASE`, `origin/$GITHUB_BASE_REF`, `origin/main`, `main`, and otherwise throws `cannot resolve a base ref`. The hook `scripts/shipyard-pre-push-gate.sh:35` calls it **without `--base`**. Transcript: at 14:00:48 the hook reported `publish-gate: cannot resolve a base ref in …/pdffiller`.
- Files: `plugins/delivery-pipeline/scripts/publish-gate.cjs` (owner: none). Possibly `scripts/shipyard-pre-push-gate.sh` (owner **T-41-08**), plus a new `tests/unit/publish-gate.test.cjs`, or an extension of `tests/unit/pre-push-gate.test.cjs` (T-41-08, new).
- Ordering: after T-41-08. T-41-08 rewrites the hook's target resolution (`41-08-PLAN.md:56`) and explicitly leaves base resolution alone.
- Constraints:
  - Resolve the base from git facts: the branch's upstream PR base recorded in `delivery-state.json` `base`, else `origin/HEAD`, else `git symbolic-ref refs/remotes/origin/HEAD`.
  - Keep `origin/main` as the last fallback so Shipyard behaves the same.
  - Never guess `master` or `develop` from a list (the "list of known homes" anti-pattern in backlog `the-pin-has-eleven-sites…`).
  - An unresolved base keeps exiting 2 (fail closed).
- Tests: unit tests on hermetic repositories with default branch `master` and with default branch `develop`. Assert the chosen `base` in the `--json` output. Add a Shipyard-shaped repository that still chooses `origin/main`.

### F5 — conveyor scratch files make the role host refuse
- Current: `claude-role-host.cjs:131` runs `git status --porcelain=v1 --untracked-files=all` with a **256 KiB `maxBuffer`** and rejects on any output. `base-merge.cjs:141-167` is already fixed (`--untracked-files=no`), with the rationale "not a list of names".
- Transcript: at 15:07:49 `claude-role-host: worktree has local changes before role dispatch`.
- Files: `claude-role-host.cjs` and `tests/unit/claude-role-host.test.cjs`. Owners: **T-41-01, T-40-16, T-40-22** (declared order T-41-01 → T-40-16 → T-40-22, `phase40-amendment.diff:309`). Possibly a shared scratch module that `delivery-commit-finalizer.cjs` reuses; its owners are **T-41-04, T-40-18, T-40-27**.
- Ordering: last editor after T-40-22.
- Constraints:
  - The role host is a *trusted boundary before an agent reads the tree*, unlike base-merge. An untracked file in the worktree is readable by the judge and is prompt-injectable. So copying base-merge's `-uno` is not automatically safe.
  - A Gate-1 decision is needed between two options. One is to exempt the conveyor's own scratch set from a single exported definition (the codex host already does this). The other is `-uno` plus not letting the role read untracked content.
  - The 256 KiB buffer is itself a scale defect. A target worktree with a copied `node_modules` (workaround notes: `cp -cR <main>/node_modules`) overflows it and fails as a different error.
- Tests: unit tests in `claude-role-host.test.cjs` (hermetic). Cover:
  - the two scratch files present → dispatch proceeds;
  - any other untracked file → refuses (or is ignored, per the decision);
  - a status output larger than the buffer → a named refusal, not a crash.

### F6 — verdict carry across base-merges that bring already-judged sibling squashes
- Current: `gate-trailer.cjs carry` (`:466-568` per `40-19-PLAN.md:37`) requires equal head trees and an equal recorded base tree. Its only caller is `base-merge.cjs:213-226`. Backlog entries `a-conform-verdict-does-not-survive…` and `the-carry-window-closes…` are untriaged.
- Files: `gate-trailer.cjs` (owner **T-40-19**, which moves the verdict to a `merge-gate` commit status with a 140-character description limit, D-32), `base-merge.cjs` (owner: none; T-40-19 reads it only), `sentinel.cjs` gate call sites (owners **T-40-19, T-40-22**), `tests/unit/trailer.test.cjs` (T-40-19), `tests/smoke/sentinel-smoke.sh` (T-40-19).
- Ordering: strictly after T-40-19. The carry has to post a `merge-gate` status, not a body trailer. Any new carry fact, such as "the incoming diff equals sibling squashes whose own verdicts were conform", must fit the D-32 description grammar or live in a sealed sidecar.
- Constraints:
  - A carry is a *verdict reuse*, so it has to be provable from object identities: tree SHAs, sibling squash commit SHAs, and their `merge-gate` statuses. It cannot rest on judgement.
  - The carry must still refuse when the merge result differs from `judged-diff ∪ sibling-diffs`. Example: a textual merge that duplicated a block (backlog `a-clean-merge-can-duplicate-a-block…`).
  - Measure before and after: arch-review launches per ticket (PROBLEM.md success criterion; ≈23 for 13 tickets).
- Tests: `trailer.test.cjs` with a stubbed `gh`, and a hermetic git fixture: two siblings squashed into an epic, then a child base-merges. Carry accepts. Mutating one byte → carry refuses. The launch-count number needs a live proving-ground rerun.

### F7 — executor verification environment and merges without receipt or finalization
- Current: the Claude executor runs `--restricted` with cwd = worktree (`claude-runtime-host.cjs:684-694`, cited in `phase40-amendment.diff:63`). `sentinel.mergeOne` (`sentinel.cjs:891-1080`) checks the gate, CI, threads and freshness. **Nothing in the merge path checks for an executor receipt or trusted finalization of the head.**
- Transcript: at 16:19:34 and 16:42:29 the orchestrator ran `git commit --no-verify` in the front-mobile-web and docs-platform worktrees. At 14:06:36 and 14:07:22 executors returned `no-contract` (covered by D-43).
- Files: `sentinel.cjs` (owners **T-40-19, T-40-22**), `tests/unit/sentinel.test.cjs` (T-40-22), `delivery-commit-finalizer.cjs` (owners **T-41-04, T-40-18, T-40-27**), `claude-delivery-host.cjs` (owners **T-40-10, T-40-13, T-40-14, T-40-15**), `codex-delivery-host.cjs` (owners **T-41-04, T-40-12, T-40-14, T-40-15**), `claude-runtime-host.cjs` (owner: none), `workflows/executors.mjs` (owner **T-40-15** via the amendment), and `commands/deliver.md` (owners **T-41-07, T-40-24**). Provenance data comes from T-40-22's sidecar (`dispatch-record.cjs`, D-33).
- Ordering: after T-41-04 (trusted finalization resume), T-40-22 (provenance sidecar, dogfood merge refusal) and T-40-15 (plan delivery). The merge-side check reads those artifacts, so it is the **last** editor of `sentinel.cjs`.
- Constraints:
  - K1 (no widened sandbox; the receipt shape is frozen).
  - A merge refusal must name the command that brings a hand commit under the conveyor (PROBLEM.md success criterion).
  - Fixer commits (`ci-fix`, `review-fix`) must also count as covered, via the fixer receipt.
  - Base-merge commits are mechanical and journalled (`log-event base_merge`, T-24-06), so they need a defined rule. Without one, every cascade child becomes unmergeable.
  - Legacy PRs opened before the change need an explicit migration rule, or they are stranded. The same concern applies to T-40-19's legacy fallback.
- Tests:
  - unit: `mergeOne` with a stubbed `gh` and fixture provenance. A head covered by a receipt merges. A head with an extra hand commit refuses and prints the remedy. A base-merge commit on a covered head merges.
  - fixture: host-side verification on a fixture project, extending T-40-23's `tests/fixtures/live-project`.
  - **live**: docker, php and network verification can only be proven on a target project.

### F8 — ENOBUFS in `run-reachability.cjs:59`; `sentinel.treeBlobs` reads full recursive trees
- Current: `run-reachability.cjs:58-59` calls `spawnSync('git', …, {encoding})` with no `maxBuffer` (default 1 MiB). `sentinel.cjs:202-210` calls `gh api …/git/trees/<ref>?recursive=1` and correctly refuses when the result is `truncated`.
- Transcript: at 15:47:04 and 16:46:47 `epic reachability UNKNOWN: … spawnSync gh ENOBUFS`. At 14:00:55–14:01:18 the plugin cache was patched to `maxBuffer: 64 * 1024 * 1024`.
- Files: `run-reachability.cjs` (owner: none), `sentinel.cjs` (owners **T-40-19, T-40-22**), and their tests.
- Ordering: the `run-reachability` change is independent and can go in wave 1. The `sentinel.cjs` change goes after T-40-22.
- Constraints:
  - Raising `maxBuffer` alone only moves the cliff. The shape-correct fix asks a bounded question: `git diff --name-only`, `ls-tree` of the paths that matter, or a compare API.
  - The truncated-listing refusal (K4) has to survive.
  - A GitHub API rate budget exists; there is no measured number, see §5.
- Tests: unit tests with a stub `git` or `gh` that prints more than 1 MiB. Assert a correct result, or a named refusal instead of ENOBUFS. A 27k-file tree is fixture-reproducible with synthetic stdout, so it needs no live run.

### F9 — stale bot approval blocks merge
- Current: `reviewers.cjs:154-169` `reviewFreshness` requires, when `reviewDecision === APPROVED`, an approval whose `commit_id === headSha`. Per-author reduction happens at `:130-138`. The `bot` flag is computed for CodeRabbit and Copilot only (`:142`). `sentinel.cjs:1052-1053` blocks on `review_fresh === false`.
- Transcript: at 16:46:47 `refused T-02-10 PR #845: the APPROVED review is not bound to the current head commit`.
- Files: `reviewers.cjs` (owner: none), `tests/unit/reviewers*.test.cjs`, and possibly `sentinel.cjs` (after T-40-22).
- Constraints:
  - Branch protection may require a fresh human approval. The fix must not merge anything GitHub would call `BLOCKED` (`sentinel.cjs:1072`).
  - A stale **bot** approval can be ignored only when:
    - a human approval exists that is bound to the head; or
    - `reviewDecision` would stay satisfied without the bot (for example, repository rules do not require reviews).
  - Otherwise the fix should be an explicit remedy, a re-review request, rather than an endless block.
  - The bot identity list is hardcoded (backlog `a-disabled-reviewer-has-no-way-to-say-so.md`). A configurable reviewer list is a related, unowned change.
- Tests: `reviewFreshness` unit tests: stale bot approval plus fresh human approval → fresh; stale human approval → stale; bot only and stale → stale, with a remedy.

### F10 — request builders for research, decompose, arch-review and fix-round
- Current: T-40-15 creates `deliver-dispatch.cjs` for executor and pr-sentinel only (`phase40-amendment.diff:68-86`).
- Files: `deliver-dispatch.cjs` (new, owner **T-40-15**), `tests/unit/deliver-dispatch.test.cjs` (T-40-15), and the hosts' exported validators. Those validators live in:
  - `claude-role-host.cjs` (T-41-01 → T-40-16 → T-40-22)
  - `claude-decompose-host.cjs` (T-40-10)
  - `codex-decompose-host.cjs` (T-40-11)
  - `workflows/investigation-research.mjs` / `claude-delivery-host.cjs` (T-40-13)

  It also touches `commands/{deliver,investigate,decompose}.md` (owners T-40-24, T-41-07, T-40-25).
- Ordering: after T-40-15 and T-40-24/25, which rewrite the prose that currently tells the model to hand-build requests.
- Constraints:
  - K1. Every builder round-trips through the real host validator in tests, with no hand-written request shapes (T-40-15 acceptance, `phase40-amendment.diff:108`).
  - The graph and plan come from the project, not the worktree (D-43).
  - Multi-repo subjects need per-repository roots (D-44).
- Tests: unit tests per role that build → call `validateRequest` / `validateArgs` → accept, plus refusal cases. No live run is needed.

### F11 — state-sync wall time
- Current: `state-sync.cjs:459-473` runs `gh pr list --state all --limit pr_fetch_limit` (default 1000, `pipeline-config.cjs:537`) per repository, plus an open-PR review listing. In a 27k-file monorepo with thousands of PRs the listing is expensive, and already merged tickets from earlier phases are re-synced. Transcript metric: 25 syncs with a 128 s median (findings-report header).
- Files: `state-sync.cjs`. Owners **T-41-08, T-40-03, T-40-19, T-40-27**. T-40-03 adds `pr-ledger.cjs` (D-31, "state-sync reads it and never rebuilds it from GitHub"), which *changes the matching input but not the fetch cost*.
- Ordering: after all four. Phase 42 is the last editor of `state-sync.cjs`.
- Constraints:
  - Skipping merged tickets must not hide a reverted or re-opened PR. The skip must be keyed on a merged state that is recorded and immutable, such as a ledger entry plus a merge SHA.
  - `state-sync.cjs` carries a deliberate NUL byte (backlog `a-nul-key-separator…`), so `grep` assertions on it silently degrade. Tests must use `grep -a` or node.
  - The measured before/after comes from the proving ground (PROBLEM.md). T-41-06 (`usage-report.cjs`, `orchestration-overhead.cjs`) is the natural measurement tool.
- Tests: a unit or fixture test with a stubbed `gh` that counts calls: merged tickets are not re-queried, and a ledger hit skips the bulk list. The wall-time number is **live only**.

### F12 — ci-wait window vs the Claude Bash 600 s cap; CANCELLED routed to ci-fix
- Current: `ci-wait.cjs:123` defaults the window to `15 * 60` s, `:125` caps it at `WINDOW_CEIL_S = 60 * 60`, and `:566` derives a window from estimates. `check-state.cjs:98-100` counts `cancel` as `failing`, which puts the ticket on the ci-fix path.
- Transcript: at 17:41:35 `ci-wait.cjs` ran in the foreground, and at 17:45:07 a manual `gh run rerun … --failed` followed.
- Files: `ci-wait.cjs` (owner: none), `check-state.cjs` (owner: none), `front.cjs` routing (owner: none; imported by `stop-gate.cjs`), `run-waker.cjs` (owner **T-40-15** adds the `dispatch` wait kind), and `tests/unit/ci-wait.test.cjs`, `check-state` tests, `stop-gate.test.cjs` (owner **T-40-14**).
- Ordering: after T-40-15 if ci-wait moves to a detached wait with `run-waker` (the same pattern as T-40-15's `wait`). Otherwise independent.
- Constraints:
  - The ci-wait design depends on staying in the foreground so the turn never ends (backlog `nothing-wakes-a-run…`, closed). A window shorter than 600 s must keep that property: return exit 0 and loop, or use the T-40-15 detached wait with `run-waker`. It must not end the turn with nothing armed to wake it.
  - Codex has its own tool timeout, which is unknown (§5).
  - A CANCELLED check needs its own bucket: a rerun remedy, with a counter against repeated cancellations. It must never count as green (K4), and it must not spend a repair attempt against `max_attempts`.
- Tests: unit tests on `check-state.classify` (cancel ≠ fail bucket) and `ci-wait` window clamping (`window ≤ runtime cap`). The real 600 s cap is a Claude harness fact and is **live only** (not checked by any command here).

### F13 — comment policy vs annotations the target repository requires; ADR-required comment edits
- Current: `comment-policy.cjs:382` hardcodes `allowed_markers: ['@invariant:', '@security:', '@contract:']`. Transcript: at 14:20:17 pdffiller's `.github/agents/*.md` require `@ai-generated model=<model>` on generated methods and tests.
- Files: `comment-policy.cjs` (owner: none), `publish-gate.cjs` (none), `pipeline-config.cjs` (owner **T-40-17** via the amendment), the comment-policy tests, and possibly `references/*.md` executor guidance (owner: none).
- Ordering: after T-40-17 for the `pipeline-config.cjs` key registration.
- Constraints:
  - K5. The allowlist comes from trusted configuration, per repository (a D-45-shaped map by `owner/repo`).
  - Shipyard default unchanged (K3).
  - An ADR-required *edit of an existing comment* must be distinguishable from an added comment line. `comment-policy` scores added lines, so a modified line reads as an add. The fix may exempt only lines whose pre-image was already a comment, and must keep blocking net-new comments.
- Tests: unit tests on hermetic diffs:
  - an `@ai-generated` annotation is allowed only when configured;
  - an edited existing comment passes;
  - a new free comment still blocks;
  - the Shipyard fixture is unchanged.

### F14 — `role-artifact.cjs:1276` rejects a whole arch-review on one unknown finding type
- Current: `role-artifact.cjs:1275-1276` calls `fail('INCOMPLETE_FINDING', … unsupported type …)` for any arch-review finding type other than the listed ones.
- Transcript: at 16:19:52 `T-02-12 arch exit=1`.
- Files: `role-artifact.cjs` and `tests/unit/role-artifact.test.cjs`. Owner **T-40-18** (PR-body hygiene at `:402-410`, `:545`, `:693`).
- Ordering: after T-40-18.
- Constraints:
  - K1/K4. An unknown type must not silently pass. The acceptable shapes are:
    - normalise it to `informational` only when the verdict is `conform` and the finding carries no blocking fields; or
    - return the artifact as a structured bounded refusal so the host can re-prompt once, not discard the whole run.
  - It must not become a verdict upgrade path.
  - The same validator serves integrator findings (`:1278+`), so change arch-review semantics only.
- Tests: unit tests in `role-artifact.test.cjs`: unknown type + conform → accepted as informational (or a re-prompt refusal); unknown type + violation → still blocking; known types unchanged.

### F15 — decompose cannot bind pre-existing Jira issues
- Current: `jira-export.cjs:213-253` always builds a label lookup with `on_no_match: 'create'` for epics and issues. Graph rows already carry a `jira` key (the `tickets.json` row keys include `jira`, checked with C1), and T-40-17/T-40-20 read `delivery.jira`.
- Files: `jira-export.cjs` (owner: none), its tests, `commands/decompose.md` (owner **T-40-25**), and possibly `validate-graph.cjs` (owner **T-40-20**) if `delivery.jira` needs validation.
- Ordering: after T-40-25 for the prose, and after T-40-20 if `validate-graph.cjs` is touched.
- Constraints:
  - ADR-008: "the tracker is a projection". Binding an existing issue must not rewrite its summary or description with Shipyard internals. The current `summary: \`${id}: ${t.title}\`` (`:244`) would leak ticket ids into the target's Jira, which conflicts in spirit with D-07.
  - With a bound key the lookup must be *by key*, with `on_no_match: refuse` (never create a duplicate).
  - Status transitions stay projection-driven (`jira_transitions`, phase 29).
- Tests: unit tests on the export plan (steps are pure data): a row with `jira` → a bind step, no create; an unknown key → refuse. Real Jira behaviour is **live only**.

### F16 — decompose-written ROADMAP blocks gsd-sync; `pipeline.gsd_sync` handling
- Current: `pipeline-config.cjs:927-932` deletes `pipeline.gsd_sync` **and pushes a warning** (`'pipeline.gsd_sync is not supported — use delivery_pipeline.gsd_sync'`). So the setting is not strictly silent; the warning does not reach the operator's board. `state-sync.cjs:385` skips on `gsd_sync === false`.
- Transcript: at 13:56:40 `gsd-sync finalization blocked: … phase 1 is not declared in ROADMAP.md`. At 13:54:46 and 13:56:46 the operator moved the key by hand.
- Files: `pipeline-config.cjs` (owner **T-40-17** via the amendment), `gsd-sync.cjs` (owner **T-41-05**), `state-sync.cjs` (see F11 owners), and `commands/decompose.md` (owner **T-40-25**).
- Ordering: after T-41-05 (projection fingerprints) and T-40-17.
- Constraints:
  - `delivery_pipeline.*` precedence (`pipeline-config.cjs:922-926`) is a documented contract. Either honour the legacy key with a visible deprecation, or surface the warning on the board. Do not change precedence.
  - The ROADMAP fix must not let decompose write GSD-owned files outside what gsd-sync can reconcile (ADR-013 / ADR-019).
- Tests: `pipeline-config.test.cjs` (the warning is emitted and reaches the `state-sync` output) and `gsd-sync` tests with a decompose-shaped ROADMAP fixture.

### F17 — `human_checkpoint` semantics under `auto_merge: epic`
- Current: `sentinel.cjs:131` sets `AUTO_MERGE` only for `auto_merge === 'epic'` with `epic-stacked`. `mergeOne` refuses at `:905` via `needsHuman(t)` (from `front.cjs`) unless `preauthorized === true` (`:911`; ADR-001 D6).
- Transcript: at 19:15:27–19:15:29 `preauthorized: true` was hand-inserted into 02-02, 02-04 and 02-05 PLAN.md.
- Files: `front.cjs` `needsHuman` (owner: none, but `stop-gate.cjs` imports it, and `stop-gate.test.cjs` is owned by **T-40-14**), `sentinel.cjs` (T-40-19, T-40-22), `commands/decompose.md` (T-40-25), `references/pr-sentinel.md` (none).
- Constraints:
  - Pre-authorization is a **human Gate-2 decision** recorded in the plan. `auto_merge: epic` must not imply it. That would turn a config knob into a human's approval.
  - The allowed fix shapes are:
    - a Gate-2 prompt that asks for pre-authorization in bulk for epic-targeted merges; or
    - a semantic in which `human_checkpoint` gates only the epic → default-branch merge.

    Either needs a Gate-1 ADR decision.
  - `pipeline-stats` counts guard merges under pre-authorization separately (backlog `pipeline-stats-says-a-person-merged…`). A new semantic must keep that audit trail.
- Tests: unit tests on `needsHuman` and `mergeOne` for the chosen semantics. The prose contract goes through the deliver/decompose contract tests.

### F18 — premature human escalation when the repository has an automatable remedy
- Current: `escalation-record.cjs mark` is used by guards. Transcript: at 16:15:33 T-02-06 was escalated for a Playwright shard failure; at 18:21:57 the operator found the repository's snapshot-regeneration workflow by hand.
- Files: `references/ci-fix.md` / `references/pr-sentinel.md` (owner: none), possibly `escalation-record.cjs` (none), and a new, configured "repository remedies" map in `pipeline-config.cjs` (T-40-17).
- Constraints:
  - Triggering a repository workflow is a GitHub mutation. It needs a configured allowlist of remedies (workflow name, inputs) from trusted config, never agent discovery, and a journal record (K1).
  - Codex parity: the remedy must be reachable from both runtimes' fixer references.
- Tests: unit tests on the remedy lookup and the escalation refusal ("a remedy is configured → run it first"). Whether the remedy actually fixes the baseline is **live only**.

## 3. File ownership matrix (phase-42 file → open 40/41 editors → required order)

Source: C1 (`tickets.json`/`delivery-state.json`), C2 (plan front matter), C3 (amendment, not yet in `tickets.json`).

| File | Phase-42 findings | Open 40/41 editors (order) | Phase-42 position |
|---|---|---|---|
| `scripts/publish-gate.cjs` | F2, F13 | none | free (wave 1) |
| `scripts/shipyard-pre-push-gate.sh` | F2 (maybe) | T-41-08 | after T-41-08 |
| `scripts/run-reachability.cjs` | F8 | none | free |
| `scripts/claude-role-host.cjs` (+test) | F5, F10 | T-41-01 → T-40-16 → T-40-22 | after T-40-22 |
| `scripts/sentinel.cjs` (+`tests/unit/sentinel.test.cjs`, `tests/smoke/sentinel-smoke.sh`) | F6, F7, F8, F9, F17 | T-40-19, T-40-22 (T-40-22 depends on T-40-19) | after T-40-22 |
| `scripts/gate-trailer.cjs` (+`trailer.test.cjs`) | F6 | T-40-19 | after T-40-19 |
| `scripts/base-merge.cjs` | F6 | none (T-40-19 reads only) | after T-40-19 (semantic dependency) |
| `scripts/reviewers.cjs` | F9 | none | free |
| `scripts/ci-wait.cjs`, `check-state.cjs`, `front.cjs` | F12, F17 | none (`stop-gate.test.cjs`: T-40-14) | free, or after T-40-15 if using `run-waker` |
| `scripts/run-waker.cjs` | F12 (maybe) | T-40-15 | after T-40-15 |
| `scripts/comment-policy.cjs` | F13 | none | free |
| `scripts/role-artifact.cjs` (+test) | F14 | T-40-18 | after T-40-18 |
| `scripts/jira-export.cjs` | F15 | none | free |
| `scripts/validate-graph.cjs` | F15 (maybe) | T-40-20 | after T-40-20 |
| `scripts/pipeline-config.cjs` (+test) | F13, F16, F18 | T-40-17 (amendment only; **absent from `tickets.json` on this branch**) | after T-40-17 |
| `scripts/gsd-sync.cjs` | F16 | T-41-05 | after T-41-05 |
| `scripts/state-sync.cjs` | F11, F16 | T-41-08, T-40-03, T-40-19, T-40-27 | last editor |
| `scripts/delivery-commit-finalizer.cjs` | F5 (shared scratch), F7 | T-41-04 → T-40-18 → T-40-27 | after T-40-27 |
| `scripts/claude-delivery-host.cjs` | F7 | T-40-10, T-40-13, T-40-14, T-40-15 (amendment) | after T-40-15 |
| `scripts/codex-delivery-host.cjs` (+test) | F7 | T-41-04 → T-40-14 → T-40-15; the test's last editor is T-40-09 | after T-40-09 |
| `scripts/claude-runtime-host.cjs` | F7 | none | free, but K1 applies |
| `workflows/executors.mjs` | F7 | T-40-15 (amendment only) | after T-40-15 |
| `scripts/deliver-dispatch.cjs` (new) | F10 | T-40-15 | after T-40-15 |
| `claude-/codex-decompose-host.cjs` | F10 | T-40-10 / T-40-11, T-40-09 (tests) | after T-40-09 |
| `commands/deliver.md` | F7, F10, F12 | T-41-07, T-40-24 | after T-40-24 |
| `commands/decompose.md`, `investigate.md` | F10, F15, F16, F17 | T-40-25 | after T-40-25 |
| `references/*.md` | F12, F17, F18 | none | free |

Consequence. About half of phase 42 (F6, F7, F10, F11, F14, the F5 role-host part, F16) cannot start until specific phase-40 tickets have merged and phase 40's epic has reached `main`. The findings free now are F2 (publish-gate part), F8 (reachability part), F9, F12 (the check-state/ci-wait part), F13 (comment-policy part), F15 (export plan) and F18 (references). A two-wave phase-42 slicing follows from this: wave A for the free files, wave B gated on phase-40 landing. That slicing belongs to the alternatives line; it is recorded here only as a constraint.

## 4. Test strategy summary

| Finding | Unit | Fixture (hermetic git / stub gh) | Live (target project) |
|---|---|---|---|
| F2 | `baseFor` resolution | bare origin with `master` and with `develop` | first push in pdffiller and jsfiller |
| F5 | role-host status handling | worktree with scratch files, other untracked files and an oversized status output | — |
| F6 | carry predicate | sibling-squash cascade | arch-review launches per ticket (before/after) |
| F7 | `mergeOne` receipt coverage | T-40-23 live-project fixture, host-side verification | docker/php verification; hand commit refused |
| F8 | output larger than 1 MiB | stub git/gh | 27k-file tree (optional; the fixture suffices) |
| F9 | `reviewFreshness` matrix | stub gh | CodeRabbit stale approval |
| F10 | builder → real validator | fixture graph | — |
| F11 | gh call count | stub gh | state-sync median (before 128 s) |
| F12 | cancel bucket, window clamp | stub gh | Claude 600 s cap; Codex tool timeout |
| F13 | allowlist, edited comment | hermetic diffs | pdffiller `@ai-generated` |
| F14 | unknown type handling | — | — |
| F15 | export plan steps | — | Jira binding and transitions |
| F16 | warning surfaced; ROADMAP fixture | gsd-sync fixture | — |
| F17 | `needsHuman`/`mergeOne` | — | operator acceptance of the semantic |
| F18 | remedy lookup | — | Playwright snapshot workflow |

All unit and fixture tests must be hermetic: temp repositories in `os.tmpdir()`, `GIT_CONFIG_GLOBAL` set, `commit.gpgsign=false` (T-40-01, T-40-16 pattern). Each must be shown to fail on base before the fix.

## 5. Uncertainties and unknowns (each needs a next check)

- Q1. Where does a host-side verification result live, given that the receipt shape is frozen (PROBLEM.md out of scope)? Next check: read `ADR-014-DATA-MODEL.md` for an extensible evidence or finalization reference. Owner: ADR author at Gate 1.
- Q2. Is `tickets.json` on the delivering branch going to include the D-43..D-45 amendment before phase-42 decomposition? On this branch, C1 shows no owner for `executors.mjs` or `pipeline-config.cjs`. Next check: `git show plan/40-target-project-amendments:.planning/graph/tickets.json` after it merges. Owner: operator.
- Q3. The actual Claude Bash tool timeout (600 s is from the problem statement) and the Codex tool timeout. Unverified by any command here. Next check: the harness documentation or a measured live `sleep` probe. Owner: operator.
- Q4. Whether pdffiller branch protection requires a fresh human approval after a push (this decides the F9 shape). Next check: `gh api repos/pdffiller/<repo>/branches/<base>/protection`. Owner: target-project admin.
- Q5. The GitHub API rate budget consumed by per-merge tree reads and by state-sync at pdffiller scale. Next check: `gh api rate_limit` before and after one sync on the proving ground. Owner: operator.
- Q6. T-41-07 is listed as an editor of `claude-role-host.cjs` (`phase40-amendment.diff:309`), but its `files_modified` (C2) does not list it. Treated as not an editor. Next check: the T-41-07 plan-check. Owner: the phase-41 planner.
- Q7. Whether the role host's clean-tree requirement exists to stop untracked content reaching the judge (this decides the F5 shape). Next check: read `git log -S "untracked-files=all" -- plugins/delivery-pipeline/scripts/claude-role-host.cjs`. Owner: role-host author.
- Q8. Transcript timestamps come from `intake/transcript-timeline.txt` as recorded. Whether they are UTC or EEST was not independently checked (the contract says UTC; findings-report says 15:19–22:31 EEST). Owner: investigation author.
