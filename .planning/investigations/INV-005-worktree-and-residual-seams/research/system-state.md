# INV-005 — research line 1: current system state

- Line: `system-state` (→ RESEARCH.md "Current system state")
- Policy signals (DATA, preserved verbatim): `{"type":"facts"}`
- Model selection resolved by caller: `claude-opus-5-5/medium`
- Worktree: `/Volumes/KINGSTON/.wt-claude-shipyard/inv-005`, branch `inv/005-worktree-and-residual-seams`
- Source revision: `133447a7358d49ee5920b3a9c17051394a1e17b2` (`git rev-parse HEAD`)
- Repository: `git@github.com:serhii-nochevnyi/shipyard.git` (`git remote get-url origin`)
- Read-only research: no product code was changed. The only file written is this one.

Every finding below names the command that checked it. Claims that were not
checked by a command are labelled **Inference**, **Assumption**, or **Unknown**, each with
the next check to run.

---

## 0. Deployment and branch state (hypothesis #1: is the code there?)

| # | Finding | Command → evidence |
|---|---------|--------------------|
| S0.1 | HEAD sits on the phase 39 epic line, not on `main`. `origin/epic/39-remove-conveyor-session-friction` (`be16f9b6`) is an ancestor of HEAD. HEAD is 43 commits ahead of `main`, and `main` is **not** an ancestor of HEAD. | `git merge-base --is-ancestor origin/epic/39-… HEAD` → exit 0. `git merge-base --is-ancestor main HEAD` → exit 1. `git log --oneline HEAD ^main \| wc -l` → 43 |
| S0.2 | `main` (`4830411b`, "release shipyard 0.62.0", PR #219) has commits that are not in this worktree (`93006d41 feat: cap Claude Opus 5.5 effort at high`). Any line number cited here comes from the epic 39 tree, not from `main`. | `git log --oneline main -5`, `git rev-parse main origin/main` → both `4830411b…` |
| S0.3 | **The findings file named in the problem statement is not on this branch.** `.planning/backlog/phase-39-delivery-findings.md` exists only in commit `17a25673`, which only `inv/003-conveyor-session-friction` contains. It is not an ancestor of HEAD. Its content was read from the commit. | `ls .planning/backlog/phase-39-delivery-findings.md` → no such file. `git branch -a --contains 17a25673` → `inv/003-conveyor-session-friction`. `git merge-base --is-ancestor 17a25673 HEAD` → exit 1. `git show 17a25673:.planning/backlog/phase-39-delivery-findings.md` |
| S0.4 | No phase 40 code is delivered. Every T-40-01..T-40-27 row in the committed delivery state is `pending`. Branch names contain no `T-40` commits and no `epic/40`. The `40-*-SUMMARY.md` files are gsd-sync projections: their frontmatter reads `# shipyard:gsd-sync generated` and `commits: 0`. They are not execution summaries. | `node -e` over `.planning/graph/delivery-state.json` + `tickets.json` (see §7). `git log --oneline --all \| grep -iE 'T-40\|epic/40'` → empty. `head -15 .planning/phases/40-*/40-16-SUMMARY.md` |
| S0.5 | Therefore `sentinel-preflight.cjs` (T-40-16), `deliver-dispatch.cjs` (T-40-15) and `pr-hygiene.cjs` (T-40-17) **do not exist** yet. Any worktree precondition that ADR-017 assigns to them is unchecked today. | `ls plugins/delivery-pipeline/scripts \| grep -iE 'sentinel-preflight\|deliver-dispatch'` → empty |
| S0.6 | The committed delivery state is stale for T-39-03. It says `pr-open` (PR 207), but HEAD's parent chain contains `be16f9b6 T-39-03: … (#207)`, the squash commit on the epic. | state dump in §7; `git log --oneline -5` (context) |
| S0.7 | No `.planning/codebase/` map exists, so this line was discovered from source. | `ls .planning/codebase` → no such file |
| S0.8 | Live GitHub was **unreachable** from this sandbox. `gh` cannot read its config, and `git fetch` fails over SSH. PR states #204–#219 and the timestamps of origin refs are therefore **Unknown**. `origin/*` refs are local snapshots. | `gh pr list …` → `open /Users/serhii/.config/gh/config.yml: operation not permitted`. `git fetch --dry-run` → `ssh_dispatch_run_fatal … Broken pipe` |

**Consequence for this investigation:** every residual defect below lives in code
that **is** present in the epic 39 tree, which is what phase 39 delivery ran. None
of them is explained by absence. The one exception is the
ADR-017 seams: they are planned but absent, so any defect they would mask is live.

---

## 1. Entry points and data flow (as of HEAD)

- **Role host** `plugins/delivery-pipeline/scripts/claude-role-host.cjs` (1063 lines, `wc -l`) serves `arch-review`, `pr-sentinel` and `integrator`.
  Flow: `parseRequest` (:56) → `prepareInvocation` (:646) → `canonicalWorktree` (:117) → `graphData` (:142) → `prepareArch` (:358), `prepareSentinel` (:485) or `prepareIntegrator` (:391) → `buildPacket` (:598) → runtime launch through `claude-runtime-host.cjs` → `assertEvidenceOnlyChanges` (:796) → `revalidateLiveInputs` (:822) → `sealResult` (:911) → `roleArtifact.sealJudgment`. The error path (:~998-1006) clears the round and fails the controller run. It performs **no worktree cleanup**: `grep -nE "restore|checkout|clean -|reset|unlink|rmSync" claude-role-host.cjs` → no matches.
- **Runtime host** `plugins/delivery-pipeline/scripts/claude-runtime-host.cjs:681-697` launches `claude --print … --restricted --strict-mcp-config --tools … --permission-mode dontAsk` with `cwd: path.resolve(scope.worktree)`. There is no `--add-dir`: `grep -nE 'add-dir|addDir' claude-runtime-host.cjs` finds only `cwd` at :560 and :694.
- **Delivery host** `plugins/delivery-pipeline/scripts/claude-delivery-host.cjs` serves the executor and the repair roles (ci-fix, review-fix).
- **Artifact layer** `plugins/delivery-pipeline/scripts/role-artifact.cjs` names the scratch files. `MANIFEST_NAME = '.shipyard-role-artifact.json'` (:29), `PR_BODY_NAME = '.shipyard-pr-body.md'` (:30), `EVIDENCE_NAME = '.shipyard-evidence.md'` (:31), `ARTIFACT_ARCHIVE_DIR = '.shipyard-role-artifacts'` (:34). The archive path is `.shipyard-role-artifacts/<digest(dispatchId)>/<name>` (:925).
- **Gate verdict carry** `plugins/delivery-pipeline/scripts/gate-trailer.cjs` `runCarry` (:403-560). `base-merge.cjs` calls it from `carryVerdict` (:205-226).
- **Projection check** `plugins/delivery-pipeline/scripts/gsd-sync.cjs --check` (:325, blockers at :595-620).
- **Orchestrator prose** `plugins/delivery-pipeline/commands/deliver.md`.

---

## 2. Residual defects, mapped to code

### (4) arch-review refuses a draft PR; deliver.md undrafts only after conform

- The host refuses `live.isDraft === true` at `claude-role-host.cjs:363` (prepare) and again at `:826` (revalidate after the run). Error: `live PR identity differs from the ticket worktree`. The message does not name draft as the cause. Checked with `Read claude-role-host.cjs` lines 358-366 and 822-830.
- Executors open PRs as drafts: `deliver.md:1983` `gh pr create … --draft`.
- The finalize order is verdict first, then undraft: `deliver.md:56-57` ("the guard splits it into `arch-review` + `undraft`, so a faulted verdict cannot ready the PR"), and `deliver.md:2320-2335` (write `gate_status` → `gh pr ready <pr>`). `sentinel.cjs merge` requires "open and undrafted" (`deliver.md:339`).
- **Verdict:** a direct contradiction. No arch-review can ever launch on a PR in the documented state. Checked with `grep -nE 'undraft|gh pr ready|--draft' commands/deliver.md`.
- Tests: `tests/unit/claude-role-host.test.cjs` has no draft case. `grep -nE 'isDraft: true' tests/unit/claude-role-host.test.cjs` → no match.
- Phase 40 overlap: T-40-16 and T-40-22 edit `claude-role-host.cjs`, and T-40-24 rewrites `deliver.md` (§6). `grep -nE 'draft|undraft' 40-24-PLAN.md 40-22-PLAN.md` → no match, so no phase 40 plan addresses the order.

### (5) scratch files count as local changes and block dispatch

- `canonicalWorktree` runs `git status --porcelain=v1 --untracked-files=all` and rejects **any** output with `worktree has local changes before role dispatch` (`claude-role-host.cjs:123-124`). There is no allowlist and no remedy in the message.
- The same conveyor writes these files as **untracked** scratch into ticket worktrees: `.shipyard-pr-body.md`, `.shipyard-evidence.md`, `.shipyard-role-artifact.json` (role-artifact.cjs:29-31), `.shipyard-arch-review-evidence.md` and `.shipyard-sentinel-evidence.md` (claude-role-host.cjs:26-27), plus `.shipyard-role-artifacts/<digest>/…` (role-artifact.cjs:34, :925).
- `.gitignore` ignores none of them. `grep -nE 'shipyard|planning' .gitignore` finds only the stop-gate ledger, stop-gate-armed, session-observations and `.adr-ingest`.
- **Four different policies for the same scratch set** exist today:
  1. `codex-delivery-host.cjs:20,205,227` uses an exact allowlist, `SCRATCH_STATUS = {'?? .shipyard-pr-body.md','?? .shipyard-evidence.md'}`.
  2. `delivery-commit-finalizer.cjs:8` uses `SCRATCH = {'.shipyard-pr-body.md','.shipyard-evidence.md'}`.
  3. `claude-delivery-host.cjs:606-610` (`hasRepairChanges`) exempts `REPAIR_EVIDENCE_NAME` and the `.shipyard-role-artifacts/` prefix. `withHiddenRepairArtifacts` (:612+) moves them aside temporarily.
  4. `base-merge.cjs:140-160` and `ticket-worktree.sh:394-410` use `--untracked-files=no` ("tracked content only"). Both carry an explicit design note: "Deliberately NOT fixed by exempting the two known filenames … the next scratch file added would silently re-open it."
  5. The role host has no policy and refuses everything.
  Checked with `grep -nE '\.shipyard-role-artifact|\.shipyard-pr-body|\.shipyard-evidence|shipyard-role-artifacts' plugins/delivery-pipeline/scripts/*`, `sed -n 138,160p base-merge.cjs`, `sed -n 390,410p ticket-worktree.sh` and `sed -n 598,625p claude-delivery-host.cjs`.
- **Inference (not run):** a successful arch-review leaves its own `.shipyard-arch-review-evidence.md` and a `.shipyard-role-artifacts/<digest>/` archive untracked in the ticket worktree, because `sealJudgment` archives inside the worktree (role-artifact.cjs:925, :933). A second arch-review in the same worktree, for example after a push, would then be refused by `:123-124`. Next check: a fixture test that runs `createClaudeRoleHost().run()` twice on one worktree.
- The post-run check `assertEvidenceOnlyChanges` (:796-813) allows only `prepared.evidencePath` plus the host-owned `dispatches.json` and `delivery-front.json` digests (:783-794). If a role mutates anything else, the host rejects `WORKTREE_MUTATED` and leaves the mutation in place, with no restore (see §1). The next dispatch is then refused by the pre-check. This is the "reviewer mutation leftovers left uncommitted" condition. Tested: `claude-role-host.test.cjs:490-496` asserts `/changed paths outside its evidence file/`.

### (6) a pr-sentinel round is discarded when any PR opens during it

- `revalidateLiveInputs` for `pr-sentinel` rejects `STALE_CONTEXT` whenever:
  - any phase ticket that was not in the round is now `pr-open` in the current graph (`:841-848`);
  - a round member has a new open PR (`:862-867`);
  - any non-member phase ticket has an open PR on GitHub (`:885-891`).
- The membership change itself is also fatal (`:838-840`). By contrast, changed **members** are tolerated and returned as `expiredTickets` (`:853-882, :892`), and the unit test covers that case (`claude-role-host.test.cjs:345` "pr-sentinel expires a changed member while retaining the rest of the round").
- **Asymmetry:** a changed member expires, and the rest of the round is kept. A newly opened non-member discards the whole round. `grep -nE 'new PRs opened' tests/unit/claude-role-host.test.cjs` finds no test for the non-member case.
- Phase 40 overlap: T-40-16 adds preflight at the top of `prepareSentinel`, and T-40-22 adds provenance to the same file. Neither changes `revalidateLiveInputs`: `grep -nE 'opened|round' 40-16-PLAN.md` matches only the preflight text at :22-29.

### (7) conform never carries across a sibling merge

- `gate-trailer.cjs runCarry` requires both conditions:
  1. **head tree unchanged**, `fromTree === toTree` (:450-454): "the merge brought content";
  2. **base tree unchanged**, where the merge-base tree equals the recorded `base_tree` (:519-524).
- A base merge that brings a sibling's squash always changes the head tree, so condition 1 refuses by construction. Carry succeeds only for the no-content merge described in `.planning/backlog/a-conform-verdict-does-not-survive-a-base-merge-that-changes-nothing.md`. Checked with `Read gate-trailer.cjs:403-552`.
- The sentinel gates merge on `gateConform(s.gate, s.head_sha)`. The backlog note cites sentinel.cjs:426, 472 and 695; those line numbers were not re-verified at HEAD. Next check: `grep -n gateConform plugins/delivery-pipeline/scripts/sentinel.cjs`.
- Related backlog: `.planning/backlog/the-carry-window-closes-on-exactly-the-merge-that-needs-it.md` (`ls .planning/backlog`).
- Phase 40 overlap: **T-40-19** moves gate verdicts from a PR-body trailer to a commit status and edits `gate-trailer.cjs`, `sentinel.cjs`, `state-sync.cjs` and `trailer.test.cjs` (40-19-PLAN.md frontmatter). Any carry rule has to be written against T-40-19's new carrier.

### (8) executor artifact goes `STALE_ARTIFACT` when the epic moves between seal and publication

- `gitIdentity` (role-artifact.cjs:206-232) resolves `base` via `liveBaseRef` (:191-204), which prefers `origin/<base>`. It records `base_commit` and `base_tree` from the **current** ref tip.
- `expectedManifest` (:568-603) requires `manifest.base_commit === identity.base_commit` and `base_tree ===` (:588-596) and fails `STALE_ARTIFACT` otherwise. So any epic advance between seal and read invalidates a fresh executor artifact, even when the ticket head is unchanged.
- A `historical` mode already exists for repair and drift artifacts (:2286-2310). It re-verifies the **recorded** base commit→tree instead of comparing with the live tip. Executors do not get this mode. Checked with `sed -n 570,605p` and `sed -n 2270,2320p role-artifact.cjs`.
- Phase 40 overlap: **T-40-18** edits `role-artifact.cjs`, `role-artifact.test.cjs` and `delivery-commit-finalizer.cjs` (40-18-PLAN.md).

### (12) `gsd-sync --check` fails a planning PR that adds tickets

- `gsd-sync.cjs:603-613` adds the blocker `<T>: delivery-state.json has no observation` for every PLAN whose ticket has no key in `delivery-state.json`. The file is written only by state-sync observation, so a PR that adds PLAN files and `tickets.json` rows, but no fresh state-sync, always fails `--check`. Checked with `sed -n 595,620p gsd-sync.cjs`.
- The source fingerprint deliberately excludes volatile front and heartbeat fields (:1080-1095), but the per-ticket presence check is unconditional.
- Tests: `tests/unit/gsd-sync.test.cjs` and `tests/unit/gsd-sync-gate.test.cjs` exist (`ls tests/unit`). Whether they pin this blocker is not verified. Next check: `grep -n 'has no observation' tests/unit/gsd-sync*.test.cjs`.
- Phase 40 overlap: no phase 40 plan lists `gsd-sync.cjs` (§6). `state-sync.cjs` is touched by T-40-02, T-40-03, T-40-19 and T-40-27.

### (new) the integrator refuses the epic diff: `DIFF_MAX_BYTES` = 1 MiB

- `DIFF_MAX_BYTES = 1024 * 1024` (`claude-role-host.cjs:21`). `diffText` (:341-345) runs `git diff --no-ext-diff --unified=50 base...head` with no pathspec and rejects `role diff exceeds the bounded context packet`. `prepareIntegrator` passes the full epic diff (:451-453). `prepareArch` uses the same function on the ticket diff (:371).
- **Measured** with the same flags, `git diff --no-ext-diff --unified=50 origin/main...origin/epic/39-remove-conveyor-session-friction`:

  | pathspec | bytes (`wc -c`) |
  |---|---|
  | all | **1,935,272** (limit 1,048,576 → 1.85×) |
  | `-- .planning` | **1,465,974** (75.7%) |
  | `-- ':!.planning'` | **469,298** (fits) |

  `git diff --stat <merge-base> <epic> -- .planning` reports 309 files, +14420 and −420. The local `origin/main` equals `main` (`4830411b`). Because fetch was unavailable (S0.8), these numbers hold for the local refs only.
- ADR-017 untracks `.planning/` in **target projects** and exempts the Shipyard repository ("the Shipyard repository is exempt": ADR-017 Decision, PR hygiene bullet). T-40-17 therefore does **not** shrink this repository's epic diff.
- Tests: `grep -nE 'exceeds the bounded|DIFF_MAX' tests/unit/claude-role-host.test.cjs` → no match. There is no size-limit test.

### Findings 9, 10, 11 (not listed as residual in the problem, but they are worktree conditions)

- (9) `--restricted` with `cwd = worktree` and no `--add-dir` (`claude-runtime-host.cjs:684, :694`). **Assumption:** Claude CLI restricted file tools cannot read paths outside cwd. This is taken from findings item 9 and was not checked against the CLI docs. Next check: a `/gsd-spike` or the CLI docs. `SHIPYARD_GRAPH_DIR` is documented only in one line of `deliver.md:534` (logging context), not for executor plan or graph location. Checked with `grep -rnE 'SHIPYARD_GRAPH_DIR' commands/*.md`.
- (10) The role host already fetches `+refs/heads/<b>:refs/remotes/origin/<b>` in `branchOid` (:169-179). It then tries `origin/<b>` before `<b>` (:180-186), and it swallows fetch failure when `expectedOid` is set (:176-178). T-40-16 is planned to fix the swallow (40-16-PLAN.md:33, :51). `graph-dir.cjs resolveBaseRef` (:184-186) falls back to the **local** branch when no origin ref resolves. `ticket-worktree.sh create` cuts from `origin/<base-ref>` when it exists (header line 6). Nothing in the role host fast-forwards the local branch. The only source for which host compares the local epic ref is findings item 10; this was not reproduced here.
- (11) Pre-push gate: covered by ADR-017 and T-40-02 (`scripts/shipyard-pre-push-gate.sh`). Out of scope.

---

## 3. Worktree conditions: what each host checks before launch today

| Condition | Role host (`claude-role-host.cjs`) | Delivery host, Claude | Delivery host, Codex | base-merge / gc | Planned (phase 40) |
|---|---|---|---|---|---|
| worktree is canonical toplevel | yes, :120-122 | — (not audited) | — | — | — |
| no tracked changes | yes, :123-124 (untracked too) | repair: :606-610 | :205, :227 | `--untracked-files=no` | — |
| untracked scratch tolerated | **no** | repair: evidence + archive dir only | exact 2-name allowlist | all untracked ignored | — |
| graph dir location | `options.graphDir` or `<worktree>/.planning/graph` (:134-140) | `graphDirectory(options)` (:309) | `SHIPYARD_GRAPH_DIR` referenced | `--graph` flag | T-40-15 builds requests from graph; T-40-27 says reuse `graph-dir.cjs` and "graph may live outside the worktree in target projects" (40-27-PLAN.md:43) |
| plan readable under `--restricted` | not checked (reads plan host-side via `fileText`, :220) | not checked | n/a | n/a | T-40-15 "plan path from the ticket worktree" (ADR-017) |
| base ref fresh vs origin | fetch + compare to live PR oid (:169-188); swallow on `expectedOid` | `git fetch origin --prune` for repair (:294) | — | `--no-fetch` from host (:310) | T-40-16 preflight (sentinel only) |
| GPG signing usable | not checked | forces `commit.gpgsign=true`, `merge.gpgSign=true` via `GIT_CONFIG_*` for base-merge (:313-317) | `SIGNER_UNAVAILABLE` checks (:111-124) | — | T-40-01 hermetic *tests* only |
| leftover mutations from a prior role | refused on next launch, never cleaned | — | — | gc keeps `dirty` | — |
| tracked `.shipyard-role-artifacts/` in repo | not distinguished | — | — | — | — |
| reaper / gc | — | — | — | `ticket-worktree.sh gc [--prune]` (header :11-13, :25-27); reaper works from `reapable` | — |

The Claude and Codex delivery host rows are partial. They cover only the checks
found by `grep -nE 'porcelain|status --|untracked|refs/remotes|fetch'` and the
signing grep. A full audit of the executor launch path is **Unknown**. Next check:
read `claude-delivery-host.cjs` executor `prepare` and `codex-delivery-host.cjs:190-240`.

**Tracked `.shipyard-role-artifacts/`:** this repository tracks 3 files under
`.shipyard-role-artifacts/1138a7f8…/` (`.shipyard-role-artifact.json`,
`INTEGRATION.md`, `findings.json`), added by `22397b76 docs: finalize phase 38 integration evidence`.
Checked with `git ls-files | grep -E '(^|/)\.shipyard-'` and `git log --oneline --diff-filter=A -- .shipyard-role-artifacts`.
So the archive dir is sometimes committed evidence and sometimes untracked
scratch, and no host distinguishes the two.

**GPG signing is live on the operator machine and breaks non-hermetic tests.**
`git config --get commit.gpgsign` → `true`. Running
`node tests/unit/claude-role-host.test.cjs` in this sandbox gave **exit 1, tests 13 / pass 0 / fail 13**.
The error was `gpg failed to sign the data … pubring.kbx: Permission denied … No secret key`,
raised from `setupRepository` (test :63). The same run with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false` gave **exit 0, 13/13 pass**.
This is the condition T-40-01 targets, and T-40-16's verification depends on
T-40-01 for this reason (40-16-PLAN.md:40). Output files: `$TMPDIR/rh.out` and `$TMPDIR/rh2.out`.

---

## 4. Existing tests relevant to the residual defects

`tests/unit/claude-role-host.test.cjs` (500 lines) has 13 tests (`grep -nE "^test\("`):

- request contract (:269)
- arch-review happy path (:283)
- sentinel round (:311)
- sentinel member expiry (:345)
- read-only smoke (:363)
- caller ticket-set refusal (:380)
- integrator happy path (:392)
- marker-matched merged PR (:413)
- moved merged PR (:436)
- missing application evidence (:456)
- integrator missing PR (:466)
- stale local base with fetch failure (:478)
- out-of-scope filename (:490)

**None of them covers** a draft PR (4), untracked scratch before dispatch (5), a
non-member PR opening mid-round (6), or the diff size limit (new).

Other suites present (`ls tests/unit | grep -iE 'role-host|role-artifact|gsd-sync|base-merge|gate-trailer'`):
`role-artifact.test.cjs`, `gsd-sync.test.cjs` and `gsd-sync-gate.test.cjs`. There is no
`gate-trailer.test.cjs`; `trailer.test.cjs` is the file T-40-19 names. Their coverage of (7), (8)
and (12) was not inspected. **Unknown**; the next check is to grep for `carry`, `STALE_ARTIFACT`
and `has no observation` in them.

---

## 5. Known warts, as the code states them

- Scratch-file policy is duplicated in five places with four semantics (§2 (5)). base-merge and ticket-worktree explicitly reject name allowlists. codex-delivery-host and the finalizer use one anyway.
- Role host refusal messages carry no remedy: "local changes", "live PR identity differs", "exceeds the bounded context packet". This contradicts the problem statement's "refuse with a named remedy" goal. Compare `refusal-hints.cjs`, which `codex-delivery-host.cjs:15` uses (`formatHint`). Whether the role host imports it: `grep -n refusal-hints claude-role-host.cjs` was not run. **Unknown**.
- `WORKTREE_MUTATED` leaves the mutation in place (§1).
- Committed delivery state lags behind merges (S0.6).

---

## 6. Shared-file map: residual fixes vs phase 40 tickets

Command:
```
for f in <file>; do grep -l -E "^\s+- .*$f" .planning/phases/40-*/40-*-PLAN.md; done
```
This matches list lines anywhere in the plan, not only `files_modified`. T-40-27's
hits on `claude-delivery-host.cjs`, `codex-delivery-host.cjs`, `base-merge.cjs` and `graph-dir.cjs`
are **read-only context** (40-27-PLAN.md:42-44).

| Residual fix likely touches | Phase 40 tickets that modify it |
|---|---|
| `scripts/claude-role-host.cjs` (4, 5, 6, new) | **T-40-16**, **T-40-22** |
| `tests/unit/claude-role-host.test.cjs` | T-40-16, T-40-22 |
| `commands/deliver.md` (4) | **T-40-24** |
| `scripts/role-artifact.cjs` (5, 8) | **T-40-18** |
| `scripts/gate-trailer.cjs` (7) | **T-40-19** |
| `scripts/sentinel.cjs` (7) | T-40-19, T-40-22 |
| `scripts/state-sync.cjs` (12, if fixed there) | T-40-02, T-40-03, T-40-19, T-40-27 |
| `scripts/gsd-sync.cjs` (12) | none |
| `scripts/base-merge.cjs` (7) | none modifies (T-40-27 reads) |
| `scripts/claude-delivery-host.cjs` (5, 8) | T-40-10, T-40-13, T-40-14 |
| `scripts/codex-delivery-host.cjs` (5) | T-40-12, T-40-14 |
| `scripts/delivery-commit-finalizer.cjs` (5) | T-40-18, T-40-27 |
| `scripts/ticket-worktree.sh` (conditions) | T-40-27 |
| `scripts/claude-runtime-host.cjs` (9) | none |

---

## 7. Delivery-state snapshot (committed, not live)

Command:
```
node -e '<print status, pr, pr_base for T-39-*/T-40-* from .planning/graph/delivery-state.json; flag rows whose tickets.json files include claude-role-host.cjs>'
```
The last commit touching the file is `e6f2b079 2026-09-24 22:40:58 +0300` (`git log -1 -- .planning/graph/delivery-state.json`).

- T-39-01, 02, 04–12 are `merged`, with PRs 206, 205, 208, 210, 211, 209, 217, 212, 213, 216, 204. T-39-12 (PR 204) lists `claude-role-host.cjs`.
- T-39-03 is `pr-open` (PR 207, base `epic/39-…`); this is stale, see S0.6.
- T-40-01..27 are all `pending`. T-40-16 and T-40-22 list `claude-role-host.cjs`.

---

## 8. Unknowns (each needs an OPEN-QUESTIONS.md mirror)

- [ ] Live PR states for #204–#219, and whether the epic 39 → main PR exists or is open. Blocked by sandbox `gh`/SSH. Owner: operator (`gh pr list --state all --limit 30`).
- [ ] Whether `.planning/backlog/phase-39-delivery-findings.md` (only on `inv/003-…`) should be merged into this line of history. Owner: operator.
- [ ] Whether Claude CLI `--restricted` really denies reads outside cwd (finding 9). Owner: `/gsd-spike "restricted Claude child reads a plan outside its worktree"`.
- [ ] Whether a second arch-review in one worktree is refused by the host's own leftover evidence and archive (§2 (5) inference). Owner: a fixture test or `/gsd-spike`.
- [ ] Current `sentinel.cjs` line numbers of `gateConform`, and the coverage of (7), (8) and (12) in `role-artifact.test.cjs`, `gsd-sync*.test.cjs` and `trailer.test.cjs`. Owner: next research pass (grep).
- [ ] The full pre-launch checks of the executor path in `claude-delivery-host.cjs` and `codex-delivery-host.cjs`. Owner: next research pass.
- [ ] Whether the diff measurement holds against the live `origin/main`, since the local refs were not refreshed. Owner: operator (`git fetch && git diff --unified=50 origin/main...origin/epic/39-… | wc -c`).
- [ ] Whether `claude-role-host.cjs` uses `refusal-hints.cjs`. Owner: `grep -n refusal-hints plugins/delivery-pipeline/scripts/claude-role-host.cjs`.

## 9. Sources

- `plugins/delivery-pipeline/scripts/`: `claude-role-host.cjs`, `claude-runtime-host.cjs`, `claude-delivery-host.cjs`, `codex-delivery-host.cjs`, `role-artifact.cjs`, `gate-trailer.cjs`, `base-merge.cjs`, `gsd-sync.cjs`, `graph-dir.cjs`, `ticket-worktree.sh`, `delivery-commit-finalizer.cjs`
- `plugins/delivery-pipeline/commands/deliver.md`
- `.planning/architecture/ADR-017-delivery-seams-and-pr-hygiene.md`
- `.planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-01..27-PLAN.md`, `40-16-SUMMARY.md`
- `.planning/phases/39-remove-conveyor-session-friction/` (listing only)
- `git show 17a25673:.planning/backlog/phase-39-delivery-findings.md`
- `.planning/backlog/a-conform-verdict-does-not-survive-a-base-merge-that-changes-nothing.md`
- `.planning/graph/delivery-state.json`, `.planning/graph/tickets.json`
- `tests/unit/claude-role-host.test.cjs` (run output in `$TMPDIR/rh.out`, `$TMPDIR/rh2.out`)
- `.gitignore`
