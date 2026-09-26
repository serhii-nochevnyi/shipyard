# INV-007 — Research line 1: current system state

Line: `system-state`. Source revision `d8a7146e2150dde25a456532a075d0012718df8d`, policy hash
`30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968`. Policy signals passed by the
caller: `{}` (recorded as given). This line only reads. It changes no code and no plan.

Abbreviations used below:

- `T` = `.planning/investigations/INV-007-target-project-scale/intake/transcript-timeline.txt`.
  Timestamps are UTC `HH:MM:SS` as printed in that file (the session was 15:19–22:31 EEST).
- `S` = `plugins/delivery-pipeline/scripts/`.
- Every transcript claim was read with `grep -n '<pattern>' T` or `sed -n <n>p T`. The pattern or
  line is named with each claim.

## 0. Deployment check (hypothesis #1): is the code the pdffiller session ran the code on this revision?

Yes. The runtime code on this branch is the code the session ran, byte for byte, apart from one
local patch the operator made in the plugin cache.

| Claim | Command | Result |
|---|---|---|
| The session ran Shipyard 0.63.0 from the plugin cache | `grep -n 'shipyard/0.63.0' T` | every host/script call uses `S=/Users/serhii/.claude/plugins/cache/shipyard/shipyard/0.63.0` (e.g. 13:52:31) |
| `v0.63.0` is the newest tag | `git tag --list 'v0.6*' --sort=-v:refname` | `v0.63.0` first |
| `v0.63.0` is 5 commits behind HEAD | `git rev-list --count v0.63.0..HEAD` | `5` |
| No runtime code changed since `v0.63.0` | `git diff --stat v0.63.0 HEAD -- plugins scripts tests Makefile` | empty output (292 changed files, all under `docs/` and `.planning/`) |
| One local cache patch existed during the run | `sed -n 371,372p T` | 14:01:08–14:01:18: `sed -i` on the cache copy of `run-reachability.cjs` adding `maxBuffer: 64 * 1024 * 1024` |
| No phase-40 or phase-41 ticket has shipped | `node -e '…delivery-state.json… /^T-4[01]-/'` | all 34 T-40-*/T-41-* rows are `pending` |
| The `4x-*-SUMMARY.md` files are projections, not delivery evidence | `head -c 400 .planning/phases/40-*/40-15-SUMMARY.md` | header `# shipyard:gsd-sync generated`, `tokens: 0` |
| The phase-40 amendment (D-43..D-45) is not on this branch | `grep -n 'D-43' .planning/phases/40-*/40-CONTEXT.md` returns nothing; the diff is only in `intake/phase40-amendment.diff` | as stated in RESEARCH-CONTRACT |
| No `.planning/codebase/` maps exist | `ls .planning/codebase` | `No such file or directory` |

So every file:line below describes the behaviour the pdffiller run hit, apart from the patched
`run-reachability.cjs` buffer. The only planned changes are the pending phase-40/41 plans, which
are checked per finding.

Blocked reads (sandbox, not a finding): reading `/Users/serhii/.claude/plugins/cache/...` and one
compound `cd … && sed …` were refused by the session permission layer. The cache contents were
therefore not diffed directly. Equality rests on the tag diff above, plus the assumption that the
cache holds the released `v0.63.0` tree. Next check: `diff -r <cache>/scripts plugins/delivery-pipeline/scripts`
on the operator's machine.

## 1. How the affected part of the system works today (overview)

Delivery pipeline as exercised by the session (all paths in this repository):

1. **Decompose** (`commands/decompose.md`): the orchestrator hand-writes request files for
   `S/claude-decompose-host.cjs` (researcher/planner/checker) and `S/claude-investigation-host.cjs`.
   `S/adr-bootstrap.cjs:104-108` writes `.planning/{config.json,ROADMAP.md,REQUIREMENTS.md,PROJECT.md}` only when a file is missing (`writeIfMissing`, `:81-89`).
   `S/jira-export.cjs` plans Jira steps.
2. **State**: `S/state-sync.cjs` reads GitHub (`gh pr list` per repository, branches, checks) and
   writes `delivery-state.json`, the YAML and the front. It then runs the GSD projection
   `S/gsd-sync.cjs` (`publishGsdProjection`, `state-sync.cjs:384-406`).
3. **Execute**: `S/claude-delivery-host.cjs` runs `workflows/executors.mjs` through
   `S/claude-runtime-host.cjs`, which launches `claude --restricted` in the ticket worktree
   (`claude-runtime-host.cjs:681-697`). The trusted finalizer commits only on
   `result.status === 'committed'` (`claude-delivery-host.cjs:764-768` → `S/delivery-commit-finalizer.cjs`).
4. **Publish/push**: the Claude `PreToolUse` hook `scripts/shipyard-pre-push-gate.sh` runs
   `S/publish-gate.cjs` (comment policy, `S/comment-policy.cjs`) before any `git push` typed into Bash.
5. **Guard**: `S/claude-role-host.cjs` runs `arch-review` / `integrator` / `pr-sentinel`.
   `S/gate-trailer.cjs` records and carries verdicts. `S/base-merge.cjs` merges a moved base.
   `S/ci-wait.cjs` waits on CI. `S/reviewers.cjs` reads review state.
   `S/sentinel.cjs merge` (`mergeOne`, `sentinel.cjs:891-…`) squash-merges into the epic.
6. **Epic**: `S/epic-branch.sh ensure` cuts the epic and proves reachability with `S/run-reachability.cjs prove` (`epic-branch.sh:233`).

Existing tests near the affected code (command: `ls tests/unit | grep -E …` and
`grep -rl <symbol> tests`):

- present: `tests/unit/{claude-role-host,reviewers,role-artifact,trailer,ci-wait,check-state,comment-policy,pipeline-config,gsd-sync,gsd-sync-gate,run-reachability,jira-export}.test.cjs`, and `tests/smoke/{sentinel-smoke,reachability-smoke}.sh`;
- absent: no `publish-gate` unit test (`grep -rl baseFor tests` → none); no test names the
  arch-review `unsupported type` refusal (`grep -rl 'unsupported type' tests` → none); no test for
  the `pipeline.gsd_sync is not supported` warning; no test asserts the `head tree MOVED` carry refusal text.

Phase-40/41 file ownership was checked from each plan's frontmatter `files_modified` (command: an
`awk` over `.planning/phases/4[01]-*/4[01]-*-PLAN.md` that prints `files_modified`). The result for
every finding file is in the table in §3.

## 2. Findings

### F2 — publish-gate base resolution

**Current behaviour.** `S/publish-gate.cjs:24-40` `baseFor` tries, in order: `--base`,
`COMMENT_POLICY_BASE`, `SHIPYARD_COMMENT_BASE`, `origin/$GITHUB_BASE_REF`, `origin/main`, `main`.
When none resolves it throws `cannot resolve a base ref in <worktree>` (exit 2, `:66-71`). The
hook `scripts/shipyard-pre-push-gate.sh:35` calls it with no `--base`
(`--worktree "$WORKTREE" --working-tree --ticket publish`). So a push is gated against
`origin/main` whatever the ticket's `pr_base` or the repository's default branch. There is one
more wart. In a repository whose default is `main` (the four frontend repositories), a ticket
worktree is compared against `origin/main` instead of its epic or parent branch. The comment
scan then covers every change already on the epic. This is an inference from the code, not
observed.

**Transcript evidence.**
- 14:00:48 `git -C …/pdffiller push … epic/02-…` → hook: `publish-gate: cannot resolve a base ref in /Volumes/KINGSTON/PhpstormProjects/pdffiller` (`sed -n 365p T`). pdffiller's default is `master` (`sed -n 354p T`, `pdffiller:master jsfiller:develop …`).
- 14:10:42 same refusal for `.wt-jsfiller/T-02-07` (jsfiller default `develop`) (`sed -n 459p T`).
- 14:11:06 the orchestrator wrote `gated-push.sh` to run `publish-gate.cjs --base <ref>` before pushing (`sed -n 464p T`). This is the "wrapper around the push hook" that PROBLEM.md lists under success criteria.
- Separate defect in the same hook, seen at 13:12:02 (`…/pdffiller/$K`), 14:00:41 (`…/pdffiller;`) and 16:42:34 (`…/$W`): `not a git worktree`.

**Coverage by 40/41/backlog.**
- **T-41-08** (`41-08-PLAN.md:8-13, 56`) fixes only the worktree resolution in `shipyard-pre-push-gate.sh` (`$VAR`, trailing `;`, git toplevel). It does not touch `publish-gate.cjs`, and its own verification still runs `publish-gate.cjs --base origin/main` (`41-08-PLAN.md:103`). The `master`/`develop` refusal is **not covered**.
- No phase-40 plan lists `publish-gate.cjs` or `comment-policy.cjs` in `files_modified`. They appear in plan text only as verification commands (grep of `files_modified` blocks in §3).
- Backlog `generated-state-yaml-header-blocks-push-from-the-project.md` is the YAML header, which T-41-08 closes. It is a different defect.

### F5 — conveyor scratch files make `claude-role-host.cjs:131` refuse

**Current behaviour.** `S/claude-role-host.cjs:131-132`: `git status --porcelain=v1 --untracked-files=all`,
and any output rejects with `worktree has local changes before role dispatch`. The conveyor
itself leaves these untracked files in every ticket worktree:
`.shipyard-pr-body.md` and `.shipyard-evidence.md` (`workflows/executors.mjs:113-114`), and
`.shipyard-role-artifact.json` plus `.shipyard-role-artifacts/` (`S/role-artifact.cjs:29-34, 548, 933`).
Other readers of the same state already use their own exemption lists, and the lists differ:
- `S/base-merge.cjs:167` uses `--untracked-files=no`. The backlog fix is already shipped (`:142-166` comment).
- `S/ticket-worktree.sh:394, 519` (gc) uses `--untracked-files=no`.
- `S/codex-delivery-host.cjs:20, 204-206` exempts exactly `?? .shipyard-pr-body.md` and `?? .shipyard-evidence.md`.
- `S/delivery-commit-finalizer.cjs:8` has a `SCRATCH` set of the same two names.
- `S/claude-delivery-host.cjs:606-610` (`hasRepairChanges`) exempts `REPAIR_EVIDENCE_NAME` and `.shipyard-role-artifacts/`.
- `S/claude-role-host.cjs:131` has **no** exemption.

**Transcript evidence.**
- 15:07:49 `sentinel exit=1 ⏎ claude-role-host: worktree has local changes before role dispatch` (pr-sentinel on the pdffiller checkout; `sed -n 559p T`).
- 15:12:43 `?? .shipyard-role-artifact.json … T-02-07 arch exit=1 ⏎ claude-role-host: worktree has local changes before role dispatch` (`sed -n 574p T`).
- 14:07:02 and 15:12:51: the orchestrator appended `.shipyard-*` (and `.planning/`) to `.git/info/exclude` in all six repositories (`sed -n 412p T`, `sed -n 575p T`). This is the "`.git/info/exclude` edits" named in PROBLEM.md.

**Coverage.** Backlog `base-merge-refuses-on-the-scratch-files-the-conveyor-itself-writes.md`
covers `base-merge.cjs` and `ticket-worktree.sh gc`, both already fixed in code (lines above).
It does not name `claude-role-host.cjs`. T-40-16, T-40-22, T-41-01 and T-41-07 all list
`claude-role-host.cjs` in `files_modified`, but none of them mentions `porcelain`, `untracked` or
`canonicalWorktree` (`Grep 'porcelain|local changes|untracked|scratch|canonicalWorktree'` over the
40/41 plans and the amendment diff: only unrelated hits in 40-10/40-16/40-17). **Not covered.**

### F6 — verdict carry across base-merges that bring already-judged sibling squashes

**Current behaviour.** `S/base-merge.cjs:205-230` (`carryVerdict`) calls `gate-trailer.cjs carry`
after a mechanical merge. `S/gate-trailer.cjs:433-454` refuses first when the head **tree**
moved: `the head tree MOVED … the merge brought content`. Only after that does it check the
trailer, the head binding (`:476-491`) and base-tree equality (`:503-524`). A base-merge that
brings a sibling's squash always changes the head tree, so the verdict is dropped. This is true
even though the sibling diff was itself judged `conform` on its own PR. The sentinel then gates
on `gateConform(gate, pr.headRefOid)` (`S/sentinel.cjs:1003-1008`; also `:672, :718`) and a new
arch-review is owed. For the declared-conflict path, `base-merge.cjs` hands over to an agent and
never carries (`:275-277`, `carry: null`).

**Transcript evidence** (`grep -n 'tree MOVED\|CARRIED' T`):
- 15:28:54 T-02-08, 16:14:53 (T-02-03), 16:49:44 T-02-02, 16:50:34, 18:35:08 (T-02-06 after the bot snapshot commit), 19:20:21 T-02-04: `No verdict carried — the head tree MOVED`.
- 19:20:21 T-02-05: `The architecture verdict CARRIED` (the one success, where the tree did not move).
- Arch-review launches: `grep -c 'arch-review' T` = 41 lines. `grep -n 'arch exit=' T` shows repeated
  launches for the same tickets (T-02-07 ×3, T-02-08 ×3, T-02-12 ×4, T-02-02 ×3, T-02-05 ×3,
  T-02-03 ×3, T-02-04 ×3 between 15:12 and 19:24). This matches the intake figure of ≈23 launches
  for 13 tickets. Exact count: unknown; next check is `grep -c '"role":"arch-review"'` on the raw jsonl.

**Coverage.**
- Backlog `a-conform-verdict-does-not-survive-a-base-merge-that-changes-nothing.md` covers only the
  equal-tree case. It is implemented as `carry` (ADR-006 D2).
- Backlog `the-carry-window-closes-on-exactly-the-merge-that-needs-it.md` covers the declared-conflict
  path pushed by hand. Its shapes are "base-merge owns the push" or `carry --after-push`.
- Neither covers a base-merge whose incoming content is a sibling squash that was already judged
  (`grep -n -i 'sibling\|already judged'` over both notes: no match).
- **T-40-19** (`40-19-PLAN.md:26, 37, 42, 51`) moves the verdict from a PR-body trailer to a commit
  status, and `carry` posts it on the new sha. Its carry conditions are unchanged. **Not covered.**

### F7 — executor verification environment; merges without executor receipt / trusted finalization

**Current behaviour.**
- Sandbox: `S/claude-runtime-host.cjs:649-661` sets `sandbox.enabled`, `failIfUnavailable`,
  `allowUnsandboxedCommands:false`, `filesystem.allowWrite:[worktree]`, and
  `permissions.blockReadsOutsideWorkingDirectories:true`. `:684` passes `--restricted` and `:694`
  sets `cwd = worktree`. The settings grant no network allow-list and no docker socket (none are
  set in `:649-661`). Whether the Claude sandbox's default network is off: assumption, consistent
  with the executor reports below.
- Finalization: `S/claude-delivery-host.cjs:764-768` finalizes (host-signed commit) only when
  `result.status === 'committed'`. A `blocked` result leaves the edit uncommitted and unreceipted.
- Merge: `S/sentinel.cjs:891-1090` (`mergeOne`) checks config, status, checkpoint, PR state/draft,
  stack boundary, checkpoint parent, limb base, CHANGES_REQUESTED, gate trailer, checks, threads,
  review freshness, DIRTY/BLOCKED/BEHIND. It reads **no executor receipt, dispatch record or
  finalization record**. A commit made by the orchestrator by hand, then gated and reviewed, merges
  exactly like a host-finalized one (`grep -n 'receipt\|finaliz' S/sentinel.cjs`: only comments at `:673, :795`).

**Transcript evidence.**
- Executor results with `blocked` (`grep -n 'T-02-\d\d (blocked|committed) ' T`): 14:13:58 T-02-01
  (`Blocked: sandbox denies docker/podman exec ("operation not permitted: docker…`), 14:18:40 T-02-03,
  14:18:55 T-02-06, 15:19:13 T-02-06, 15:39:46 T-02-02, 16:09:44 T-02-04 and T-02-05, 18:31:37 T-02-13.
  Committed: T-02-08 (14:13:58), T-02-07 (`sed -n 448p T`), T-02-09 (15:06:27), T-02-10 (15:19:13).
  At 13:17:02 the researcher itself reports `Docker and node_modules aren't available here`.
- Orchestrator verification outside the sandbox: 15:00:52 `OK (3 tests, 3 assertions)` and
  `T-02-06 yarn exit=1 … T-02-10 yarn exit=0` (`sed -n 534p T`); the target-project notes say
  `php -l`/codecept via `docker run` and `cp -cR node_modules` into worktrees.
- Hand commits/publication: 14:20:02 `manual-publish.sh` created, with the comment "For executor
  results blocked only by missing tooling: orchestrator verified, commits, gates, publishes"
  (`sed -n 524p T`). It is used 5 times (`grep -c manual-publish.sh T`). `--no-verify` appears in
  orchestrator commands at 16:19:34 (T-02-11) and 16:42:29 (T-02-12) (`grep -n no-verify T`).
- Merge of such a commit: 15:47:04 `merged T-02-01 PR #37730 → epic/02-… (squash)` (`sed -n 711p T`).
  T-02-01 was `blocked` at 14:13:58.
- A bot commit also became a merge candidate. 18:31:16 `6e5bdc5865 GHA CI: Update Playwright Snapshots`
  landed on T-02-06's branch from a repository workflow (`sed -n 935p T`). No executor or fixer
  produced it.

**Coverage.**
- **T-40-15 / D-43** (amendment diff lines 54-55, 87-90) fixes plan *delivery* to the sandbox
  (`no-contract`). It explicitly does not widen permissions (line 90). It does not provide
  docker, php, network or dependencies, and does not touch the merge side.
- **T-41-04** (`41-04-PLAN.md:40-59`) adds a host-owned `collectVerificationEvidence` with an OS
  sandbox that **denies network** (`:54`), for **Codex only** (`codex-delivery-host.cjs`,
  `command-runner.cjs`). It keeps "downstream CI/review … gates merge" pending but adds no
  sentinel-side receipt check (`sentinel.cjs` is not in its `files_modified`). It would still not
  run docker-based PHP suites.
- **T-40-22** (`40-22-PLAN.md:27, 45, 51`) adds a provenance sidecar per dispatch and a
  sentinel refusal for dogfood merges into a default branch. It checks host provenance, not whether
  a commit is covered by a receipt.
- Backlog `nothing-forbids-no-verify-in-a-fixer-prompt.md` covers fixer prompts, not the
  orchestrator. **The merge-without-receipt case is not covered by any plan.**

### F8 — `run-reachability.cjs` ENOBUFS; `sentinel.cjs` `treeBlobs` full recursive trees

**Current behaviour.**
- `S/run-reachability.cjs:58-69` `git()` calls `spawnSync('git', …, { encoding: 'utf8' })` with no
  `maxBuffer`. Node's default is 1 MiB (Node.js `child_process.spawnSync` docs, external source).
  `declaredFiles` runs `git ls-tree -r --name-only <baseSha>` (`:147-150`) over the whole tree. An
  overflow sets `result.error`, `status` is null → `1` (`:60`), and it throws `GIT_FAILED`.
  `S/epic-branch.sh:233-238` calls `prove` and exits with its status, so `ensure` never pushes the epic.
- `S/sentinel.cjs:202-217` `treeBlobs` runs `gh api repos/<r>/git/trees/<ref>?recursive=1` through
  `gh()` → `runBounded` (`:141-147`). The buffer is `DEFAULT_MAX_BUFFER_BYTES = 8 MiB`
  (`S/command-runner.cjs:6, 37`). It runs twice per merge (head and epic, `:226-229`). Failure is
  an honest `ok: null` "UNKNOWN" (`:218-230`), so the merge still happens, but the reachability
  assertion is lost.

**Transcript evidence.**
- 14:00:16–14:00:33: `epic-branch.sh ensure epic/02-… master` → `"code": "GIT_FAILED", "message": "run-reachability: git ls-tree -r --name-only c8f2804… failed"`, output persisted as 1.1 MB (`sed -n 356-357p T`).
- 14:01:08–14:01:18: cache patched with `maxBuffer: 64 * 1024 * 1024`, then the epic pushed (`sed -n 371-372p T`).
- 15:47:04 and 16:46:47: `epic reachability UNKNOWN: the merged head tree could not be read: spawnSync gh ENOBUFS` (`grep -n ENOBUFS T`).
- Tree size of 27k files is from `target-project-workarounds.md`. The exact count was truncated
  in `T` (14:00:28 `wc -lc`). Unknown; next check is `git ls-tree -r --name-only <sha> | wc -lc` in pdffiller.

**Coverage.** `run-reachability.cjs` and `treeBlobs` appear in no 40/41 `files_modified`
(`grep -l run-reachability.cjs` over the plans: none). `sentinel.cjs` is edited by T-40-16, T-40-19,
T-40-22 and T-40-27 for other reasons. **Not covered.**

### F9 — stale bot approval blocks merge

**Current behaviour.** `S/reviewers.cjs:154-178` `reviewFreshness`: when GitHub's
`reviewDecision === 'APPROVED'`, freshness requires at least one *current* `APPROVED` review whose
`commit_id` equals the head sha. Otherwise `review_fresh:false`, with the reason
`the APPROVED review is not bound to the current head commit`. `S/sentinel.cjs:1052-1054` refuses
the merge on `review_fresh === false`. Nothing distinguishes a bot approver from a human one.
Nothing asks the approver again, dismisses the stale approval, or accepts a newer non-approving
bot pass. A bot that approved an old head and does not re-approve therefore holds the PR
indefinitely, even though GitHub's own `reviewDecision` is `APPROVED`.

**Transcript evidence.**
- 16:22:11, 16:40:08, 16:46:47, 17:24:19, 17:36:48: `refused T-02-10 PR #845: the APPROVED review is not bound to the current head commit` (`grep -n 'not bound to the current head' T`).
- 16:24:53 `coderabbitai APPROVED cdc12c06b` (an old head) (`sed -n 771p T`).
- 17:39:30–17:41:29: escalated to a human: "the only APPROVED review is CodeRabbit's on old head cdc12c06 … Needs a human approval on the current head (or dismiss the stale bot approval)" (`sed -n 862-863p T`).
- Side wart: 17:39:24 `escalation-record: no T-02-10 in delivery-state.json — run state-sync.cjs first` right after a sync (`sed -n 861p T`). Cause unknown; next check is which graph dir `escalation-record.cjs` resolved from that cwd.

**Coverage.** No 40/41 plan, ADR or backlog note mentions `reviewFreshness`, `review_fresh` or the
refusal text. `grep -rln` over `.planning/backlog`, the phase 40/41 dirs and `.planning/architecture`
returns nothing. `git log -S reviewFreshness` shows it came in with `9b1af4d5`. Backlog
`a-disabled-reviewer-has-no-way-to-say-so.md` is related (hard-coded reviewers) but does not cover
freshness. **Not covered.**

### F10 — request builders missing for research, decompose, arch-review and fix-round

**Current behaviour.** Host request schemas: `claude-delivery-request.v1` (`S/claude-delivery-host.cjs:19`;
workflows `executors`, `fix-round`, `drift-gate`, `investigation-research`, `:18`) and
`claude-role-request.v1` (`S/claude-role-host.cjs:19, 29`, roles `arch-review|integrator|pr-sentinel`).
`S/claude-decompose-host.cjs:18` takes `{role, phase, worktree, prompt, signals}`
(transcript 13:04:14). No script in `S/` builds any of these requests. The role host
cross-checks caller `signals` against authenticated evidence and rejects mismatches
(`claude-role-host.cjs:360-372`, `SIGNAL_MISMATCH`), so a hand-built request can be refused.

**Transcript evidence.**
- 12:28:25 investigation host with hand-written `$SP/investigation-request.json` (`sed -n 97p T`).
- 13:05:14 decompose host with hand-written `req-researcher.json` (`sed -n 279p T`).
- 15:07:22 `printf '{"schema":"shipyard.claude-role-request.v1","role":"pr-sentinel",…}'` (`sed -n 556p T`).
- 15:18:24 hand-built arch-review request with `signals:{risk:"low",contested:…}` → 15:18:45 `caller signal contested differs from authenticated project evidence` (`sed -n 594-595p T`).
- 15:37:49–15:38:31: the orchestrator reads the `fix-round.mjs` args contract ("built by /shipyard:deliver each babysit round") and assembles a ci-fix round by hand (`sed -n 656-659p T`).

**Coverage.** **T-40-15** (`40-15-PLAN.md:22-30, 49-62`) adds `deliver-dispatch.cjs launch --role <role>`.
Its scope spells out building only executor requests and running preflight for `pr-sentinel`
(`:56-58`). The amendment (D-43/D-44) keeps that scope. Research, decompose, arch-review and
fix-round requests are **not specified** (`Grep 'research|decompos|arch-review|fix-round|repair'` on
40-15-PLAN.md: only the pr-sentinel line). **Not covered.**

### F11 — state-sync wall time

**Current behaviour.** `S/state-sync.cjs:454-494` `loadRepo` makes, per repository the graph
touches:
1. `gh pr list --state all --limit pr_fetch_limit` (default 1000, `S/pipeline-config.cjs:537`);
2. a second open-only `gh pr list`;
3. `gh api …/branches --paginate` (every branch);
4. `gh repo view` for foreign repositories.
When the listing hits the limit, *every* unmatched ticket gets its own `gh pr list --head <branch>`
(`:531-553`). Every open PR also gets `gh pr checks` (`:296, :621`). There is no terminal-state
cache. A ticket already `merged` in `delivery-state.json` is re-derived from GitHub on every sync
(`grep -n -i 'terminal\|cache' S/state-sync.cjs`: only comments at `:5, :60, :500, :1009`). Old
merged tickets whose PRs fall outside the last 1000 (here phase 01) are exactly the "unmatched"
ones that trigger the per-ticket fallback. Then `publishGsdProjection` runs `gsd-sync.cjs` in the
same call (`:384-406, :1189`).

**Transcript evidence.**
- 13:58:38 `⚠ the bulk PR listing for this repo hit its limit (1000) — falling back to per-ticket lookups … pdffiller/jsfiller … pdffiller/front-mobile-web …` (`sed -n 350p T`).
- Durations: an `awk` over `T` pairing each `->` Bash call containing `state-sync.cjs` with its next `<-`
  result gives 27 calls, median 136 s, most 112–153 s, two at 601 s (17:45:07, 18:49:34,
  both hitting the 600 s Bash cap because `ci-wait` was chained in the same command). The intake
  says 25 syncs with a median of 128 s. This heuristic also counts combined commands, so treat it as
  an approximation of the same figure.

**Coverage.** **T-41-05** fingerprints the GSD projection (`gsd-sync.cjs`), which would shorten
the projection step. `gsd_sync` was disabled in this run (F16), so it would not have helped here.
**T-40-03** (`40-03-PLAN.md`) changes ticket↔PR *matching* in `state-sync.cjs` to "PR number
recorded at creation, then exact head branch". That could reduce unmatched fallbacks. Whether it
avoids the bulk listing or the per-merged-ticket re-reads is unknown; next check is a read of
40-03 Scope against `state-sync.cjs:544-553`. No plan adds a terminal-state skip.
**Not covered as observed.**

### F12 — `ci-wait.cjs` window vs Claude Bash 600 s cap; CANCELLED routed to ci-fix

**Current behaviour.**
- `S/ci-wait.cjs:123-125`: default window `15*60` s, floor 15 min, ceiling 60 min. `:542-570`
  sizes the window from `ci_estimates` (max/3, clamped to [15 m, 60 m]). The minimum window is
  900 s, above the 600 s ceiling of a foreground Claude Bash call. `deliver.md:2565-2586` tells the
  loop to run `ci-wait.cjs` in the foreground and "stay in the turn". The same block uses repo-relative
  `node plugins/delivery-pipeline/scripts/ci-wait.cjs`, which does not exist in a target project
  (observed wart, `deliver.md:2586-2587`).
- `S/check-state.cjs:98-100`: `case 'fail': case 'cancel': out.failing += 1`. A cancelled run
  counts as failing. The sentinel duty then files it as `ci-fix` (`sentinel.cjs:1026`, and the duty
  text at 19:26:21).

**Transcript evidence.**
- 17:45:07 `ci-wait.cjs …` → 17:55:08 `Command did not complete within its 600s timeout and was moved to the background` (`sed -n 869-870p T`). The orchestrator then polled the output with hand-written `until … SECONDS+580` loops at 17:55:14, 18:59:40 and 19:26:43 (`grep -n 'SECONDS+5' T`).
- 17:25:54 `publish cancelled` (concurrency), and "not failed, but cancelled … just re-run" (`sed -n 850-851p T`).
- 19:26:21 `ci-fix T-02-05 PR #37734 — 1 failing check(s)`, and at 19:26:30 the job is `publish cancelled` again; the orchestrator re-ran it by hand (`sed -n 987-990p T`).

**Coverage.** No 40/41 plan lists `ci-wait.cjs` or `check-state.cjs` (`grep -l`: none). T-40-15
adds a `dispatch` wait kind with `wait --timeout-ms` (`40-15-PLAN.md:62-63`) for host dispatches,
not for CI. Backlog `nothing-wakes-a-run-that-is-only-waiting.md` is CLOSED by `ci-wait`'s
foreground design, and that design is what collides with the cap. **Not covered.**

### F13 — comment-policy vs annotations the target repository requires; ADR-required comment edits

**Current behaviour.** `S/comment-policy.cjs:53-57` `protectedComment` has a fixed allow-list
(SPDX, copyright, `@ts-*`, `@generated`, lint pragmas, `shipyard…`, `managed by`, `do not edit`, …).
Markers are only `@invariant:`, `@security:` and `@contract:` (`:9` MARKER_PATTERN per 14:20:11, and `:382`).
There is no project configuration key: `policy.mode: 'strict'` is hard-coded (`:379-385`). Every
*added* line counts, and editing an existing comment line is a delete plus an add, so any comment
edit is an "added comment". `publish-gate.cjs` and `base-merge.cjs` (15:49:41, `publish-gate: BLOCKED`)
share this rule.

**Transcript evidence.**
- 14:20:03 `comment-policy: T-02-03 BLOCKED` on a PHPDoc test block (`sed -n 525p T`); 14:20:17 pdffiller requires `@ai-generated model=<model>` in `.github/agents/*.agent.md` and `unit_test.instructions.md` (`sed -n 529p T`); 14:20:32–15:00:23 the user was asked and chose the Shipyard rule; the annotations were stripped by hand (15:00:43, 15:41:41–15:41:52).
- 16:52:21–17:13:44: arch-review requires removing a stale phrase from a comment that ADR-002 demands, and comment-policy blocks any comment-line edit; the user decided (`sed -n 826-827p T`).
- 15:49:41 base-merge: `publish-gate: BLOCKED — 1 file(s) contain non-allowed added comments` (`sed -n 716p T`).

**Coverage.** No 40/41 plan lists `comment-policy.cjs` in `files_modified`. `40-CONTEXT.md:79`
restates the strict policy for Shipyard's own code. ADR-017 has no comment decision
(`Grep comment` on ADR-017: none). T-41-08 removes only the YAML header comment. **Not covered.**

### F14 — `role-artifact.cjs:1276` rejects a whole arch-review on one unknown finding type

**Current behaviour.** `S/role-artifact.cjs:1257-1277`: for `arch-review`, types `violation`,
`adr-outdated`, `note` and `informational` are accepted. Anything else raises
`fail('INCOMPLETE_FINDING', … unsupported type …)`, which rejects the whole artifact. The model is
not constrained at the source: `S/claude-role-host.cjs:783-791` `roleOutputSchema('arch-review')`
declares `findings.items` with only a `ticket` property and **no `type` enum**. The integrator
schema has one (`:797-807`, `type: { enum: [...] }`). `references/arch-review.md:39, 83` lists
only verdict values.

**Transcript evidence.** 16:19:52 `T-02-12 arch exit=1 … T-02-12 no result ⏎ arch-review finding 1 has unsupported type "unknown"` (`sed -n 765p T`). T-02-12 was then relaunched (16:40:08, 16:44:15).

**Coverage.** T-40-18 lists `role-artifact.cjs` but only for PR bodies and commits
(`Grep 'finding|unsupported type'` on 40-18-PLAN.md: none). T-41-04 and T-41-07 reference
`role-artifact.cjs` as reading material only. **Not covered.**

### F15 — decompose cannot bind pre-existing Jira issues

**Current behaviour.** `S/jira-export.cjs:86-99` derives labels
(`shipyard-<owner>-<repo>-<t-id>`, adr-004 and legacy forms). `:103` looks up with
`project = X AND labels = "<label>"`. `:228-253` gives every ticket `on_no_match: 'create'` (epics at `:223`).
The plan ignores a recorded `delivery.jira` key. `jira-export.cjs` never reads `t.jira`
(`grep -n '\.jira\b' S/jira-export.cjs`: none). The `record` verb (`:327-…`) writes the key into
the plan frontmatter, which `validate-graph.cjs:177` carries into `tickets.json`. Status projection
`S/jira-project.cjs:508-511` is off when `pipeline.jira.enabled === false`, and `:513-517` is off
when `jira_transitions` is empty. It then projects only tickets with `t.jira` (`:520-535`). Turning
export off to avoid duplicates therefore also turns the status projection off, because both share
`pipeline.jira.enabled`.

**Transcript evidence.**
- 12:46:35 DECISIONS.md: "`jira-export.cjs plan` looks issues up only by shipyard labels and has `on_no_match: create`; MYD-17836…17899 carry no such labels, so a normal export would create ~28 duplicates" (`sed -n 222p T`).
- 13:44:57 `jira-export.cjs record T-02-01 MYD-17864 …` for 12 tickets (`sed -n 325p T`); 13:45:03 `pipeline.jira = {enabled:false, project:'MYD'}` (`sed -n 327-328p T`).
- 19:31:09–19:31:27: Jira transitions listed and statuses moved by hand through the Atlassian MCP (`sed -n 1007-1014p T`).

**Coverage.** No 40/41 plan lists `jira-export.cjs` or `jira-project.cjs`. `40-25-PLAN.md`
updates decompose prose for untracked planning only. **Not covered.**

### F16 — decompose-written ROADMAP blocks gsd-sync; `pipeline.gsd_sync` silently dropped

**Current behaviour.**
- `S/gsd-sync.cjs:614-617` adds a blocker for every `*-PLAN.md` whose phase is not a `### Phase`
  in ROADMAP.md. `S/state-sync.cjs:398-404` turns any blocker into `fail('gsd-sync finalization blocked: …')`.
  The sync exits and prints no board.
- `S/adr-bootstrap.cjs:104-108` writes ROADMAP.md (only when it is missing) with exactly one phase
  (`roadmapContent(args.phase, …)`). Older phase plans already on disk are not declared.
- `S/pipeline-config.cjs:927-933` deletes `pipeline.gsd_sync` when `delivery_pipeline.gsd_sync` is
  absent, and pushes a warning. The warning is printed only by `state-sync.cjs:1194`
  (`for (const w of cfgWarnings) console.log(…)`), which runs **after** `publishGsdProjection()` at
  `:1189`. When the projection fails, the process exits first, and the operator sees only the
  gsd-sync blocker, never the warning. So the drop is silent in the one situation where the key
  was set on purpose.

**Transcript evidence.**
- 13:02:45 `.planning` holds `architecture config.json graph investigations phases`. There is no ROADMAP.md, and `phases/01-legacy-chat-backend-removal/01-01…01-10-PLAN.md` exist (`sed -n 252p T`).
- 13:03:51–13:03:52 ROADMAP.md now contains only `### Phase 2: power-experiment-cleanup` (`sed -n 261-262p T`). The writer is not visible because the 13:03:42 command is truncated (`node $S/s…`). That `adr-bootstrap.cjs` wrote it is an **assumption** from `decompose.md:70` and `adr-bootstrap.cjs:106`. Next check: `grep adr-bootstrap` in the raw jsonl.
- 13:54:46 `c['pipeline']['gsd_sync']=False` → 13:56:40 `state-sync: gsd-sync finalization blocked: …01-01-PLAN.md: phase 1 is not declared in ROADMAP.md …` (`sed -n 347-348p T`).
- 13:56:46 moved to `delivery_pipeline.gsd_sync=False`, and sync then succeeded (13:58:38) (`sed -n 349-350p T`).

**Coverage.** T-41-05 changes gsd-sync fingerprints, not the ROADMAP blocker (its `files_modified`
is `gsd-sync.cjs` plus tests). No plan lists `pipeline-config.cjs` except the **phase-40 amendment**
to T-40-17, which adds `pipeline-config.cjs` only to register `pr_title_format` (amendment diff
lines 183-184, 200). It does not touch `:927-933` or the order of warnings in `state-sync.cjs`.
T-40-03, T-40-16, T-40-19, T-40-27 and T-41-08 edit `state-sync.cjs`, but none of them moves
`:1189`/`:1194`. **Not covered.**

### F17 — `human_checkpoint` semantics under `auto_merge: epic`

**Current behaviour.** `S/front.cjs:144-148` `needsHuman`: `human_checkpoint && preauthorized !== true`.
`S/sentinel.cjs:905` refuses the ticket's own merge ("the merge is the human's by contract").
`:966-983` refuses merges *into* an open checkpoint parent. Under `auto_merge: epic` the ticket's
merge target is the phase epic, and the epic → default-branch merge is always refused to the
sentinel (`:943-945`). So a checkpoint ticket needs a human twice (into the epic and again at the
epic PR), while `preauthorized: true` in the plan frontmatter is the only lift (`:911`).

**Transcript evidence.**
- 16:42:20 `T-02-05 awaiting-human (checkpoint)`; 17:16:23 T-02-04; 17:24:19 T-02-02; 18:49:28 T-02-13 (`grep -n checkpoint T`).
- 19:11:21 `fixpoint: YES`, board waiting only on `checkpoint (human)` (`sed -n 964-965p T`).
- 19:14:50 user: "you will merge into the epic branch, right?"; 19:15:17 "then preauthorize"; 19:15:27 the orchestrator edits three plans with `preauthorized: true`, re-runs Gate 2, and merges (`sed -n 966-973p T`). T-02-04 had waited since about 17:16.

**Coverage.** Backlog `pipeline-stats-says-a-person-merged-what-the-guard-merged.md` and
`phase-24-followups.md` touch checkpoint accounting and prose, not the semantics. No 40/41 plan
changes `needsHuman` or `mergeOne:905`. **Not covered.**

### F18 — premature human escalation when the repository has an automatable remedy

**Current behaviour.** The conveyor has no notion of repository-provided remediation workflows.
`grep -n 'workflow_dispatch\|regenerat\|gh workflow run'` over `plugins/delivery-pipeline`
finds no match in any reference, command or script that describes a repair path. An expected
visual-baseline failure is escalated with `escalation-record.cjs mark`. The opposite policy
exists: `S/degenerate-green.cjs:271-272` treats snapshot updates (`--update-snapshots`, …) in a diff
as a degenerate-green signal. A regenerated baseline also arrives as a bot commit on the ticket
branch, which moves the head without an executor receipt (see F7) and drops the verdict (F6,
18:35:08).

**Transcript evidence.**
- 16:15:33 `escalation-record.cjs mark T-02-06 "Playwright shard 5 fails … the baseline screenshot must be regenerated …"` → parked for a human (`sed -n 740-741p T`).
- 18:21:44 user: "open cascaded and continue"; 18:21:57–18:22:08 the orchestrator finds `.github/workflows/pw-debug-tests.yml` with a `regenerateScreenshot` input (`sed -n 898-904p T`).
- 18:22:26 and 18:27:07 `gh workflow run pw-debug-tests.yml … -f regenerateScreenshot=true` (the first had a wrong path); 18:31:16 bot commit `6e5bdc5865 GHA CI: Update Playwright Snapshots` (`sed -n 907, 930, 935p T`). The ticket was parked for about 2 h 07 m.
- 18:22:20 and 18:27:31: the plan's `files_modified` was amended to declare the screenshot path (`sed -n 905, 932p T`).

**Coverage.** None in 40/41 or the backlog (`grep -rln 'regenerat\|workflow_dispatch'` over
`.planning/backlog` and the 40/41 plans: none found in delivery context). **Not covered.**

## 3. Ownership cross-reference (files each finding lives in × phase-40/41 `files_modified`)

Source: frontmatter `files_modified` of every `.planning/phases/4[01]-*/4[01]-*-PLAN.md` (awk dump
in §1), plus `intake/phase40-amendment.diff` for T-40-15/16/17.

| Finding | Current-behaviour file(s) | 40/41 plans that also list the file | Do they change the observed behaviour? |
|---|---|---|---|
| F2 | `S/publish-gate.cjs`, `scripts/shipyard-pre-push-gate.sh` | T-41-08 (hook only) | No (base untouched) |
| F5 | `S/claude-role-host.cjs:131` | T-40-16, T-40-22, T-41-01, T-41-07 | No |
| F6 | `S/gate-trailer.cjs`, `S/base-merge.cjs`, `S/sentinel.cjs` | T-40-19 (gate-trailer, sentinel), T-40-16/22/27 (sentinel) | No (storage only) |
| F7 | `S/claude-runtime-host.cjs`, `S/claude-delivery-host.cjs`, `S/sentinel.cjs` | T-40-15 amendment (delivery hosts, executors.mjs), T-40-14/10/13 (claude-delivery-host), T-40-22 (sentinel), T-41-04 (Codex hosts) | Partly (plan delivery; Codex verification without network); merge side no |
| F8 | `S/run-reachability.cjs`, `S/sentinel.cjs:202`, `S/command-runner.cjs` | T-41-04 (command-runner), sentinel as above | No |
| F9 | `S/reviewers.cjs`, `S/sentinel.cjs:1052` | none for reviewers.cjs | No |
| F10 | new builder(s); `S/claude-role-host.cjs`, `S/claude-decompose-host.cjs`, `S/claude-delivery-host.cjs` | T-40-15 (`deliver-dispatch.cjs`, executor + pr-sentinel) | No for research/decompose/arch-review/fix-round |
| F11 | `S/state-sync.cjs` | T-40-03, T-40-16, T-40-19, T-40-27, T-41-08; T-41-05 (gsd-sync) | Unknown for T-40-03; others no |
| F12 | `S/ci-wait.cjs`, `S/check-state.cjs`, `commands/deliver.md` | T-40-24, T-41-07 (deliver.md) | No |
| F13 | `S/comment-policy.cjs`, `S/publish-gate.cjs` | none | No |
| F14 | `S/role-artifact.cjs:1276`, `S/claude-role-host.cjs:783` | T-40-18 (role-artifact); claude-role-host as F5 | No |
| F15 | `S/jira-export.cjs`, `S/jira-project.cjs` | none | No |
| F16 | `S/gsd-sync.cjs`, `S/adr-bootstrap.cjs`, `S/pipeline-config.cjs:927`, `S/state-sync.cjs:1189/1194` | T-41-05 (gsd-sync), T-40-17 amendment (pipeline-config), state-sync as F11 | No |
| F17 | `S/front.cjs:144`, `S/sentinel.cjs:905/966` | none for front.cjs; sentinel as above | No |
| F18 | `references/ci-fix.md`, `S/escalation-record.cjs`, `S/degenerate-green.cjs` | none | No |

The constraints line decides ordering. This line only records that `sentinel.cjs`
(T-40-16/19/22/27), `state-sync.cjs` (T-40-03/16/19/27, T-41-08), `claude-role-host.cjs`
(T-40-16/22, T-41-01/07), `claude-delivery-host.cjs` (T-40-10/13/14/15-amended) and
`deliver.md` (T-40-24, T-41-07) are heavily shared.

## 4. Uncertainties and next checks

- [ ] Whether the plugin cache equals `v0.63.0` apart from the `run-reachability.cjs` patch: the
  cache was unreadable here. Next: `diff -r` on the operator's host.
- [ ] Exact arch-review launch count per ticket: timeline lines are truncated. Next: count
  `claude-role-host` arch-review invocations in the raw jsonl.
- [ ] Who wrote the phase-2-only ROADMAP.md at 13:03:42–13:03:51 (assumed `adr-bootstrap.cjs`).
- [ ] Whether T-40-03's number-first matching removes the per-ticket fallback cost for old merged
  tickets. Next: read `40-03-PLAN.md` Scope against `state-sync.cjs:544-553`.
- [ ] Whether the Claude sandbox's default network policy is "deny" or whether only the dependency
  and docker absence caused the blocks (executors reported `operation not permitted: docker`).
  Next: `/gsd-spike` a restricted executor running `curl` and `docker version`. Not done here
  (read-only line).
- [ ] The pdffiller tree size (27k files) is taken from the target-project notes, not measured here.
- [ ] Why `escalation-record.cjs` reported `no T-02-10 in delivery-state.json` at 17:39:24 right after a sync.
- Inference, not observed: in `main`-default repositories the pre-push gate compares a ticket
  branch against `origin/main`, not its epic (F2).

## 5. Commands run for this line (all from the worktree root unless an absolute path is shown)

`git rev-parse HEAD`; `git tag --list 'v0.6*' --sort=-v:refname`; `git log -1 v0.63.0`;
`git rev-list --count v0.63.0..HEAD`; `git diff --stat v0.63.0 HEAD -- plugins scripts tests Makefile`;
`git log --oneline -S reviewFreshness -- S/reviewers.cjs`; the `node -e` status dump of
`.planning/graph/delivery-state.json`; the `awk` `files_modified` dump of all 40/41 plans;
`grep -l` over the plans per finding file; `Read`/`sed -n` of `S/publish-gate.cjs:1-73`,
`scripts/shipyard-pre-push-gate.sh`, `41-08-PLAN.md`, `S/claude-role-host.cjs:115-145, 355-372, 780-830`,
`S/gate-trailer.cjs:432-535`, `S/sentinel.cjs:141-147, 190-235, 272-330, 891-1090`,
`S/claude-runtime-host.cjs:630-704`, `S/run-reachability.cjs:40-80, 140-160`,
`S/epic-branch.sh:225-250`, `S/pipeline-config.cjs:905-940`, `S/state-sync.cjs:375-420, 440-559, 1190-1215`,
`S/gsd-sync.cjs:595-625`, `S/adr-bootstrap.cjs:60-130`, `S/reviewers.cjs:154-200`,
`S/ci-wait.cjs:123-125, 542-590`, `S/check-state.cjs:85-110`, `S/comment-policy.cjs:40-75, 370-390`,
`S/role-artifact.cjs:1220-1300`, `S/jira-export.cjs:60-100, 228-260, 320-350`, `S/jira-project.cjs:500-535`,
`S/degenerate-green.cjs:255-300`, `S/claude-delivery-host.cjs:600-615, 755-775`, `S/codex-delivery-host.cjs:195-215`,
`commands/deliver.md:2560-2599`, `40-15-PLAN.md:20-79`, `41-04-PLAN.md:1-70`, and the `Grep` checks named per finding;
`grep`/`sed -n` over `T` as cited per claim.
