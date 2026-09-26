# INV-007 — Line 4: risks and unknowns (draft for RISKS.md + OPEN-QUESTIONS.md)

- Subject: `INV-007-target-project-scale:risks`
- Source revision: `d8a7146e2150dde25a456532a075d0012718df8d` (checked: `git rev-parse HEAD`)
- Policy hash: `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968` (ADR-014 `adr-014.v6`); policy signals passed to this launch: `{}`
- Runtime: Claude, `claude-opus-5-5` / `medium`, as the caller selected.
- Scope: read-only. The only file written is this one.

## Method and evidence rules

Every code claim below names the command that checked it. I used these:

- `sed -n <range>p <file>` to read cited lines.
- `grep -n` over `plugins/delivery-pipeline/scripts/*.cjs`.
- A frontmatter extraction over `.planning/phases/{40,41}-*/*-PLAN.md`: `awk` between the `---` fences, then `grep -oE "scripts/[a-z0-9-]+\.cjs"`.
- The Grep tool and `sed -n` over `intake/transcript-timeline.txt`.

Transcript timestamps are the UTC prefixes of `intake/transcript-timeline.txt` lines. The contract says that file is UTC; I did not check this independently.

Two things were not done:

- I did not run a live target-project run. I did not run tests.
- A `grep` over the `intake/` directory whose path was built with `cd … &&` was denied by the session permission layer ("path computed at run time"). The same data was then read with the Grep tool and a `sed -n` from the worktree root. As a result, `intake/phase40-amendment.diff` (309 lines, from `wc -l`) was **not** read line by line for this artifact. The D-43..D-45 overlap is taken from PROBLEM.md and the findings report, not from the diff. See OQ-01.

## Cross-cutting facts that decide failure direction

1. **`sentinel.cjs merge` checks no receipt or finalization.**
   - Command: `grep -n "receipt\|finaliz" plugins/delivery-pipeline/scripts/sentinel.cjs`
   - Output: only line 673 (a comment about certify/ready) and line 795 (a comment). There is no receipt check on the merge path.
   - The merge preconditions read at `sentinel.cjs:895-915` (`sed -n 895,915p`) are: config valid, ticket known, `AUTO_MERGE`, `status === 'pr-open'`, `s.pr`, not `needsHuman`, then a live `gh pr view`.
   - Consequence: today, any commit on a ticket branch is mergeable once the gates are green. That includes the orchestrator's hand commits. This is the fail-open that F7 must close, and every F7 option inherits it until it is closed.
2. **Phase 40 moves the gate verdict carrier.**
   - 40-19 is titled "Record gate verdicts as a commit status instead of a PR-body trailer". Its frontmatter lists `scripts/gate-trailer.cjs scripts/sentinel.cjs scripts/state-sync.cjs`.
   - Consequence: any F6 carry design written against today's `gate-trailer.cjs` trailer (the `carry` entry at `gate-trailer.cjs:289`, the live-head refusal at `:488`) will be rewritten under it. If F6 is built before 40-19 lands, one of the two is wasted or they conflict.
3. **Plan overlap on files phase 42 will touch.** From the frontmatter extraction:

   | File | Phase 40/41 plans that list it |
   |---|---|
   | `claude-role-host.cjs` | 40-16, 40-22, 41-01 |
   | `sentinel.cjs` | 40-19, 40-22 |
   | `role-artifact.cjs` | 40-18 |
   | `state-sync.cjs` | 40-03, 40-19, 40-27, 41-08 |
   | `gate-trailer.cjs` | 40-19 |
   | `claude-decompose-host.cjs` | 40-10 |
   | `codex-decompose-host.cjs` | 40-11 |
   | `deliver-dispatch.cjs` | 40-15 |

   None of the extracted frontmatters list any of these, so phase 42 would be their first owner: `publish-gate.cjs`, `run-reachability.cjs`, `reviewers.cjs`, `ci-wait.cjs`, `check-state.cjs`, `pipeline-config.cjs`, `jira-export.cjs`.

   Caveat: 41-08's goal text covers the pre-push hook worktree resolution. Its frontmatter regex match did not list `publish-gate.cjs`, and I did not read its body fully. See OQ-02.

## Risk register, per finding

Severity: **H** = can merge unverified code or lose a receipt. **M** = false refusal or stall that sends the operator back to hand work. **L** = cost only.

### F2 — publish-gate base resolution

- **Current state.** `publish-gate.cjs:24-38` (`sed -n 15,45p`) tries these in order: `--base`, `COMMENT_POLICY_BASE`, `SHIPYARD_COMMENT_BASE`, `origin/$GITHUB_BASE_REF`, `origin/main`, `main`. Otherwise it throws `cannot resolve a base ref`.
- **Transcript.** 14:00:48 and 14:10:42: the hook refused in pdffiller and in `.wt-jsfiller/T-02-07` with `publish-gate: cannot resolve a base ref`. At 14:10:46 the orchestrator read the gate source to work around it.
- **R-F2-1 (H) — the wrong base passes a violation.** Suppose the fix resolves the repository default branch, or `origin/HEAD`, while the ticket's real base is the epic or a parent ticket branch. Then the comment-policy diff is measured against the wrong tree. Because the epic is ahead of `master`, a diff against `master` includes sibling tickets' lines. That gives false refusals. A diff against a *later* ref would hide the ticket's own added comments, which fails open.
  - Mitigation: resolve from `delivery-state[id].base` / the PR base first, and use the default branch only as a fallback, named in the output.
- **R-F2-2 (M) — an untracked `.planning/` has no delivery-state.** In a worktree with no `.planning/`, a state-based resolution finds no state. It must fall through to the git-derived default branch, and it must not refuse.
- **R-F2-3 (M) — collision with T-41-08.** T-41-08 already owns the hook's worktree resolution, so F2 must land after it or be folded into it. See OQ-02.
- **Cannot verify without a live run:** a non-`main` default branch combined with an untracked `.planning/` and a PreToolUse hook installed by copy. A fixture can simulate a `master`/`develop` remote. The copy-installed hook's staleness (see backlog `the-stop-gate-enforcing-this-session-predates-the-fix…`) can only be seen on the operator's machine.

### F5 — scratch files make the role host refuse

- **Current state.** `claude-role-host.cjs:131` runs `git status --porcelain=v1 --untracked-files=all` with a 256 KiB buffer and rejects on any output (`sed -n 115,145p`). `base-merge.cjs:167` already uses `--untracked-files=no` (from `grep -n porcelain`), so the base-merge backlog note is fixed there and the role host is the remaining site.
- **Transcript.** 15:07:49 `sentinel exit=1 … worktree has local changes before role dispatch`. 15:12:43 `?? .shipyard-role-artifact.json … T-02-07 arch exit=1`, the same refusal.
- **R-F5-1 (H) — ignoring all untracked files changes the input the judge sees.** An executor or fixer can leave an untracked source file the judge would then read. Today the refusal protects the judge from judging a tree that differs from HEAD. `--untracked-files=no` removes that protection wholesale.
  - Mitigation: allow-list the conveyor's own scratch names by one shared prefix (`.shipyard-*`), and keep refusing other untracked paths. The backlog note warns against lists of *names*; a *prefix* owned by the conveyor avoids that.
- **R-F5-2 (M) — the 256 KiB buffer is itself a scale hazard.** In a 27k-file monorepo with build artifacts, `--untracked-files=all` can exceed 256 KiB. That turns into a preflight failure (a false refusal), not a pass. So it fails closed, but it looks like F8.
- **R-F5-3 (M) — ordering with other plans.** 40-16, 40-22 and 41-01 all edit `claude-role-host.cjs`. F5 must be sequenced after them or folded into one of them.

### F6 — verdict carry across base-merges bringing judged siblings

- **Current state.** Carry exists only through `base-merge.cjs` → `gate-trailer.cjs carry` (`:289`). It refuses if the live head moved (`:488`). The backlog notes `a-conform-verdict-does-not-survive…` and `the-carry-window-closes…` cover identical-tree and declared-conflict pushes. They do not cover a base-merge whose incoming content is *other tickets' already-judged squashes*.
- **Measured cost.** About 23 arch-review launches for 13 tickets (findings-report metrics). This is not re-derived here.
- **R-F6-1 (H) — false carry, the central risk.** "Already-judged sibling squash" is established by matching incoming commits against sibling verdicts. A sibling squash is judged against *its* base, not against this ticket's diff. The interaction between the two diffs is judged by nobody.
  - Example: sibling A removes a function that ticket B still calls. Each is conform alone. After B merges the epic in, B's tree calls a deleted symbol.
  - A carry that treats "incoming = judged elsewhere" as "covered" merges a broken combination with a conform stamp.
  - The backlog note already shows the tree-equality test was once wrong in the fail-open direction (a retarget moves the base under an identical tree).
  - Mitigation: carry only when the ticket's own diff (merge-base..head, restricted to its declared files) is byte-identical before and after. Leave CI as the interaction check. Journal every carry via `log-event base_merge` so it can be audited.
- **R-F6-2 (H) — the carrier changes under the fix.** 40-19 replaces the trailer with a `merge-gate` commit status. A carry built on the trailer is obsolete on landing, or keeps two verdict stores that can disagree. F6 must be ordered after 40-19.
- **R-F6-3 (M) — no before/after number yet.** Without a proving-ground rerun there is only the "~23/13" launch count, from one session.
- **Cannot verify without a live run:** the launch count per ticket, and whether real sibling squashes ever produce an interaction the carry would hide. A fixture can build the A/B deleted-symbol case, and should be the mandatory negative test.

### F7 — executor verification environment and receipt-less merges

- **Current state.**
  - The Claude host passes `--restricted` (`claude-runtime-host.cjs:20,684`, from `grep -rn -- "--restricted"`).
  - The sandbox has no docker, php, network or `node_modules`. The executor's own research report at 13:17:02 says: "nothing was run, since Docker and `node_modules` aren't available here".
  - The orchestrator committed by hand and signed: 14:15:15 `git commit -q -S` in `.wt-pdffiller/T-02-01`; 16:19:34 `git commit -q -S --no-verify` in `.wt-front-mobile-web/T-02-11`.
  - The sentinel merged these commits: 15:46:30 `sentinel.cjs merge T-02-01`, then at 15:47:04 `merged T-02-01 PR #37730`.
  - The merge path has no receipt check (cross-cutting fact 1).
- **R-F7-1 (H) — fail-open until a receipt gate exists.** Every day without a merge-time receipt check is a day hand commits merge silently. This is the highest-severity item in the investigation.
- **R-F7-2 (H) — a receipt gate that is too strict stops fixers and base-merges.** Head moves happen legitimately without an executor: base-merge commits (`base-merge.cjs`), ci-fix/review-fix commits, and host finalizer commits. A gate that demands "an executor receipt covers HEAD" refuses all of them.
  - The gate must accept a chain: an executor receipt at commit X, then each later commit covered by a fixer receipt, a base-merge journal event, or a trusted finalizer.
  - If it is wrong in the permissive direction, one uncovered link lets a hand commit ride on top of a covered commit.
- **R-F7-3 (H) — widening the sandbox widens launch authority (ADR-014 boundary).** Options that give the executor docker, network or deps change what a launched model can reach. That could require a policy/ADR change, which PROBLEM.md puts out of scope for the receipt shape and grid.
  - Adding network also exposes artifactory credentials. The workarounds note records `yarn install can 401 on artifactory`, which means credentials are involved.
- **R-F7-4 (M) — delegated verification can lie about provenance.** If verification moves to a host-side "trusted verifier" (the orchestrator or a host script running declared commands outside the sandbox), its result must be bound to the exact tree/HEAD it ran on. Otherwise a green from a previous tree certifies a new one. It must also be a host receipt, not a model claim.
- **R-F7-5 (M) — lost receipts on the refusal path.** When a hand commit is refused, the message must name the command that brings it under the conveyor (PROBLEM success criterion). Otherwise the operator's recovery is, again, a hand re-commit.
- **R-F7-6 (M) — Codex parity.** The Codex executor sandbox has its own limits, which I have not measured here. The receipt-chain gate must read both runtimes' receipts. See OQ-05.
- **Cannot verify without a live run:** whether PHP (codecept, `php -l` via docker) and FE (`node_modules` via APFS clone) verification can run inside any allowed executor environment, and the cost/latency of a host-side verifier on a 27k-file repository.

### F8 — ENOBUFS (`run-reachability.cjs`) and full recursive trees (`sentinel.cjs`)

- **Current state.**
  - `run-reachability.cjs:58-68` calls `spawnSync('git', …, { encoding: 'utf8' })` with no `maxBuffer` (Node's default is 1 MiB).
  - `declaredFiles` at `:150` runs `ls-tree -r --name-only <base>` *without* `allowFailure`. On ENOBUFS, `result.status` is `null`, which becomes 1, which throws `GIT_FAILED`. So it fails closed (a false refusal).
  - The `allowFailure: true` sites (`:88,100,107,165,186,194,235-236`) treat a non-zero status as a soft answer. For small outputs this is fine. `worktree list --porcelain` at `:165` could exceed 1 MiB only with an extreme worktree count.
  - `sentinel.cjs:202-216` `treeBlobs` runs `gh api …/git/trees/<ref>?recursive=1`. It treats any error or truncation as an honest UNKNOWN (`ok: null`) *after* the squash, and never refuses.
- **Transcript.**
  - 14:01:18: the plugin cache was patched to `maxBuffer: 64 * 1024 * 1024`.
  - 15:47:04 and 16:46:47: `epic reachability UNKNOWN: … spawnSync gh ENOBUFS` after `merged T-02-01`.
  - 19:15:36: the orchestrator filters `grep -v "^  epic reachability UNKNOWN"`. The operator is now hiding the alarm channel, which is the "cried-wolf" failure the `sentinel.cjs:195-200` comment warns about.
- **R-F8-1 (M) — raising `maxBuffer` only moves the cliff.** 64 MiB holds 27k paths easily. A larger repository or `git/trees` JSON (with SHAs and modes, roughly 150 bytes/entry) fails again. Prefer streaming, or a path-scoped query (`ls-tree -r <base> -- <declared prefixes>`, `git/trees` per declared directory).
- **R-F8-2 (H) — scoped queries can fail open.** If `treeBlobs` is replaced by per-path queries, a path that is *absent* must still read as absent, and not be skipped. A glob declaration (`owns(decl, p)`) cannot be answered by a path query without listing the directory. A wrong narrowing turns "absent from the epic" into "nothing asserted" (`ok: null`), or worse into `ok: true`.
- **R-F8-3 (L) — GitHub truncation.** GitHub truncates recursive trees above 100k entries / 7 MB (documented GitHub API behaviour, from general knowledge, not checked in this session). The code already maps this to UNKNOWN (`:209`). A local `git ls-tree` on the project checkout avoids both the API and the truncation, but needs the ref fetched locally. This is a multi-repository question: the sentinel runs from the pdffiller checkout for jsfiller PRs.
- **Cannot verify without a live run:** real buffer sizes per repository. A fixture can generate a synthetic 30k-file repository cheaply. This is a `/gsd-spike` candidate (spike S-1).

### F9 — a stale bot approval blocks merge forever

- **Current state.**
  - `reviewers.cjs:154-178`: if `reviewDecision === 'APPROVED'`, the review is fresh only if some *current* APPROVED review has `commit_id === headRefOid`. The check does not look at the author.
  - `sentinel.cjs:1053-1055` blocks when `review_fresh === false`.
  - A bot (CodeRabbit) that approved an older head and never re-reviews keeps `reviewDecision` at APPROVED, so no approval ever matches the head.
- **Transcript.** 16:46:47: `refused T-02-10 PR #845: the APPROVED review is not bound to the current head commit`.
- **R-F9-1 (H) — too broad a fix bypasses a human's intent.** If the fix ignores stale approvals from any author, or treats "approved once" as enough, then a human who approved v1 is counted as approving v2. That is the fail-open the freshness check exists to prevent.
  - Mitigation: exempt only reviewers the project declares as advisory bots (compare backlog `a-disabled-reviewer-has-no-way-to-say-so`, which proposes `delivery_pipeline.reviewers`). Keep the check for humans and required reviewers.
- **R-F9-2 (M) — branch protection is invisible to the script.** If the repository requires N approvals via branch protection, a stale-approval exemption lets `sentinel` attempt a merge that GitHub rejects. That fails safe, but it is a new refusal message the operator must understand.
- **R-F9-3 (M) — bot identity by login.** `isCodeRabbit` / `isCopilot` match logins. A renamed or forked bot app login slips through, in one direction or the other.
- **Cannot verify without a live run:** the behaviour of a real CodeRabbit re-review on a force-free push, and the branch-protection settings of pdffiller repositories. See OQ-08.

### F10 — request builders for research, decompose, arch-review and fix-round

- **Current state.** The research contract says T-40-15 (`deliver-dispatch.cjs`) covers the executor and pr-sentinel only. The orchestrator hand-built the other requests (PROBLEM.md).
- **R-F10-1 (H) — a builder that fills defaults silently can widen scope.** A builder that derives `files_modified`, context refs or model/effort from defaults rather than the graph repeats the "missing signal resolves to the dearer tier" shape (backlog note of that name). A permissive default for `immutable_scope` would let a fixer edit files outside its ticket.
  - Mitigation: refuse on a missing input and never default. Reuse the ADR-014 resolver; do not re-implement it.
- **R-F10-2 (M) — coupling to 40-15's schema.** If phase 42 builders are written before 40-15 lands, they fork the request shape. They must extend `deliver-dispatch.cjs` after it lands.
- **R-F10-3 (M) — Codex parity.** One builder must serve both hosts, as 40-15 does.

### F11 — state-sync wall time

- **Measured.** 25 syncs, median 128 s, about 58 min in total (findings-report). The `--timeout 600000` on state-sync calls, for example at 13:54:46, shows the operator budgeting close to the Bash cap.
- **R-F11-1 (H) — skipping merged tickets can hide a reopened or reverted PR.** If merged tickets are no longer re-synced, a revert, a reopened PR, or a squash landing on the wrong base (see backlog `a-childs-pr-base-is-its-merge-target…`) stops being seen.
  - Mitigation: a cheap per-phase batch query (`gh pr list --state merged --search`), or skip only tickets whose epic has itself landed.
- **R-F11-2 (M) — a lower `pr_fetch_limit` drops PRs.** In a busy repository (pdffiller has PR numbers at 37k), a smaller limit misses a ticket's PR. `state-sync` then reports `execute` for work already published, which is a duplicate dispatch. 40-03 moves matching to the PR number recorded at creation, which removes most dependence on list size. So F11 must build on 40-03.
- **R-F11-3 (M) — file contention.** `state-sync.cjs` is touched by 40-03, 40-19, 40-27 and 41-08. This is the most contended file in the set.
- **Cannot verify without a live run:** the before/after wall time. It needs the proving ground (PROBLEM success criterion). A fixture with a stubbed `gh` gives only call counts. See spike S-2.

### F12 — the ci-wait window versus the Claude Bash 600 s cap, and CANCELLED sent to ci-fix

- **Current state.**
  - `ci-wait.cjs:123` defaults `--timeout` to 15 min and resizes it from estimates (`:116-122`). The Claude Bash tool caps at 600 s.
  - `check-state.cjs:100` counts the `cancel` bucket as failing (`grep -n CANCELLED`).
- **Transcript.** 17:41:35 `ci-wait.cjs … timeout 600000`, then at 17:55:14 a hand polling loop (`until grep -q "^fixpoint" …; sleep 15`) was needed to wait for the background output.
- **R-F12-1 (M) — capping the window below 600 s increases rounds.** Each empty window advances the empty-window counter (`ci-wait.cjs:502`) toward escalation. Shorter windows reach "three consecutive timeouts" (`:62-63`) in wall time too short for slow pipelines, so a slow cypress run is wrongly escalated to a human.
  - Mitigation: count escalation in elapsed time, not windows, or scale the threshold with the window.
- **R-F12-2 (H) — treating CANCELLED as non-failing can fail open.** If CANCELLED becomes "pending" or "skip", then a required check cancelled by a concurrency group (superseded run) or by a human looks green or never settles.
  - Mitigation: CANCELLED where a newer run of the same check exists → pending. CANCELLED as the latest run → a distinct `cancelled` state that is neither sent to ci-fix nor merged, and goes to a retry-the-run action.
- **R-F12-3 (M) — Codex has no 600 s cap.** A Claude-specific window must not shorten Codex waits. See OQ-10.

### F13 — comment policy versus annotations the repository requires, and ADR-required comment edits

- **Current state.** `comment-policy.cjs` and `publish-gate.cjs` enforce the policy (`grep -rln comment-policy`). 40-17 (`pr-hygiene.cjs`, `planning-untrack.cjs`) and 41-08 are adjacent.
- **R-F13-1 (H) — a per-repository allow-list becomes a bypass.** If the target repository can declare "comments matching X are allowed", a broad pattern (`@.*`) disables the gate. Allow-lists must be exact tokens (e.g. `@ai-generated`) and printed in the gate output.
- **R-F13-2 (M) — ADR-required comment edits.** Letting an ADR authorise comment changes means the gate must read the ADR and bind the permission to the ticket. A stale or wrong binding permits comment churn in other tickets.
- **R-F13-3 (M) — where the config lives.** If the config sits in the untracked `.planning/`, it is invisible in the ticket worktree (the same root as D-43). If it sits in the target repository, it is a target-project code change, which is out of scope.

### F14 — `role-artifact.cjs` rejects a whole arch-review on one unknown finding type

- **Current state.** `role-artifact.cjs:1274-1276` calls `fail('INCOMPLETE_FINDING', … unsupported type …)` for any type outside the known set (`sed -n 1260,1290p`).
- **Transcript.** 16:19:52 `T-02-12 no result ⏎ arch-review finding 1 has unsupported type "unknown"`. The whole review was lost and relaunched.
- **R-F14-1 (H) — accepting unknown types can turn a violation into a pass.** If unknown findings are dropped, or downgraded to informational, a judge that reports a real violation under a novel type label produces `conform`.
  - Mitigation: treat an unknown type as blocking (verdict at least `needs-human` or `violation`), keep the finding verbatim, and still seal the artifact so the launch is not wasted.
- **R-F14-2 (M) — the receipt shape is out of scope.** PROBLEM.md excludes the receipt shape. Changing the finding schema must not change the sealed envelope (`shipyard.role-artifact.v1`).
- **R-F14-3 (M) — file ownership.** 40-18 (and 41-04/41-07 by body mention) touch `role-artifact.cjs`, so this must be ordered after 40-18.

### F15 — decompose cannot bind pre-existing Jira issues

- **Current state.** `jira-export.cjs:103` looks up by JQL `labels = "<label>"`, and `:223,252` sets `on_no_match: 'create'`. Pre-existing MYD-178xx issues carry no Shipyard label, so export would create duplicates. The operator disabled export and moved statuses by hand.
- **R-F15-1 (H) — duplicate or wrong issues in a shared tracker.** This is an outward-facing side effect that is hard to reverse. A binding by summary similarity or by key parsed from the plan can bind to the wrong issue and then transition it. Binding must be explicit: the key recorded in the graph at decompose time, verified that it exists and is a child of the epic.
- **R-F15-2 (M) — permissions.** Label or status writes can fail on a project with a restricted workflow. Transitions differ per project (`jira_transitions` exists, per backlog `the-carry-window…` measurement text).
- **Cannot verify without a live run:** Jira workflow transitions of the MYD project, and whether a label may be added to existing issues. See OQ-13.

### F16 — the decompose-written ROADMAP blocks gsd-sync, and `pipeline.gsd_sync` is dropped silently

- **Current state.**
  - `pipeline-config.cjs:926-931` deletes `merged.gsd_sync` when only `pipeline.gsd_sync` is set, and pushes a warning (`sed -n 915,940p`). So it is not fully silent: it goes to `warnings`.
  - Transcript 13:54:46: the operator set `c['pipeline']['gsd_sync']=False`, which is the dropped namespace. The effective value stayed the default.
- **R-F16-1 (M) — warnings are not seen.** The warning goes to the config reader's warning channel. If state-sync output is piped through `tail`/`grep` (as at 13:54:46 `| tail -40`), it is lost. Fix: refuse, or echo the effective value.
- **R-F16-2 (M) — honouring `pipeline.gsd_sync` reverses a deliberate decision.** The comment at `:924-925` says the legacy namespace is ignored on purpose. Accepting it may re-open the ambiguity. 41-05 (`gsd-sync.cjs`) is adjacent. See OQ-15.
- **R-F16-3 (M) — ROADMAP ownership.** Letting decompose write a ROADMAP that gsd-sync accepts without its format means two writers for one file.

### F17 — `human_checkpoint` semantics under `auto_merge: epic`

- **Current state.** `sentinel.cjs:905` blocks: `human_checkpoint ticket — the merge is the human's by contract`. Only `preauthorized === true` (`:911`) passes. Children whose base is an open checkpoint PR are also held (`:954-981`).
- **Transcript.** 19:11:06 `waiting: checkpoint (human): T-02-02, T-02-04, T-02-05, T-02-13 … fixpoint: YES`. At 19:15:36 the orchestrator then ran `sentinel.cjs merge T-02-02` itself.
- **R-F17-1 (H) — the checkpoint loses its meaning.** If "merge into the epic" is exempted from checkpoints, the human's check moves to the epic → default-branch PR. That is fine only if the epic PR itself is held for a human, and if the reviewer can still see which ticket was the checkpoint. Otherwise, risky work flows to `master` inside a large epic squash without a targeted human look.
- **R-F17-2 (M) — how the orchestrator got the merge.** It is unclear whether the 19:15:36 merge was preauthorized or not. The 19:17:57 output shows `merged T-02-02`. If the ticket was not preauthorized, a checkpoint was bypassed by a path I have not identified. See OQ-16.

### F18 — premature human escalation when an automatable remedy exists

- **Transcript.** 18:21:57–18:31:04: the orchestrator found jsfiller `pw-debug-tests.yml` with a `regenerateScreenshot` input and ran it (run 36173511048 at 18:27:21).
- **R-F18-1 (H) — the conveyor runs repository workflows that write to branches.** Dispatching a workflow that commits screenshots creates commits with no executor receipt. That is the F7 hole again, by design.
  - Mitigation: remedy workflows must be declared per repository, and their commits must enter through the same receipt-chain rule (a "trusted remedy" link).
- **R-F18-2 (M) — auto-regenerating a baseline hides a real visual regression.** Regeneration should be allowed only when the ticket's plan or ADR states that the visual change is expected (at 18:31:04 the plan text named the expected change).

## What cannot be verified without a live target-project run

1. The PHP, docker and FE dependency verification path for executors (F7).
2. The real buffer sizes and API truncation on 27k-file repositories (F8). This can be partially covered by a synthetic spike.
3. The state-sync wall-time before/after (F11) and the arch-review launches per ticket (F6). Both are success criteria in PROBLEM.md.
4. The CodeRabbit re-review behaviour and branch protection (F9).
5. Jira MYD workflow transitions and binding (F15).
6. The interaction of a copy-installed pre-push hook with the fixed `publish-gate.cjs` (F2), because the hook is installed by copy under `~/.claude/hooks/`.
7. The end-to-end "no orchestrator-authored commits" success criterion, which by definition needs a rerun.

## Spikes recommended (not run)

- **S-1** `/gsd-spike "synthetic 30k-file repo: measure ls-tree and git/trees output bytes and prove path-scoped reachability agrees with the full listing, including a glob declaration"` (F8).
- **S-2** `/gsd-spike "stubbed-gh state-sync over 13 tickets / 2 phases: count gh calls with and without merged-ticket skip"` (F11).
- **S-3** `/gsd-spike "receipt-chain walker: executor receipt → base-merge event → fixer receipt → hand commit; prove the hand commit is refused and the rest pass"` (F7).
- **S-4** `/gsd-spike "sibling A deletes symbol, B calls it: prove carry refuses and CI is the catch"` (F6).

## RISKS.md draft (condensed)

| ID | Finding | Risk | Sev | Direction | Guard |
|---|---|---|---|---|---|
| R-F7-1 | F7 | Merge path has no receipt check | H | fail-open (live today) | receipt-chain gate in `sentinel.cjs merge` |
| R-F7-2 | F7 | Gate refuses base-merge/fixer/finalizer commits | H | false refusal | chain accepts journalled link types |
| R-F7-3 | F7 | Sandbox widening exceeds ADR-014 launch authority | H | authority widening | host-side bound verifier instead |
| R-F6-1 | F6 | Carry hides sibling interaction | H | fail-open | carry only on an unchanged own-diff; fixture S-4 |
| R-F6-2 | F6 | 40-19 replaces the carrier | H | rework/conflict | order after 40-19 |
| R-F9-1 | F9 | Stale-approval exemption covers humans | H | fail-open | exempt declared bots only |
| R-F12-2 | F12 | CANCELLED treated as pass | H | fail-open | distinct `cancelled` state |
| R-F14-1 | F14 | Unknown finding dropped → conform | H | fail-open | unknown = blocking, still sealed |
| R-F8-2 | F8 | Scoped tree query skips absent paths | H | fail-open | agreement test vs full listing |
| R-F2-1 | F2 | Wrong base measured | H/M | both | state base first, name the fallback |
| R-F5-1 | F5 | Untracked source reaches the judge | H | fail-open | `.shipyard-*` prefix only |
| R-F11-1 | F11 | Merged-skip hides reverts/reopens | H | stale board | skip only landed epics |
| R-F13-1 | F13 | Allow-list becomes bypass | H | fail-open | exact tokens |
| R-F15-1 | F15 | Wrong or duplicate Jira issues | H | outward side effect | explicit key binding |
| R-F17-1 | F17 | Checkpoint diluted into epic squash | H | fail-open | hold epic PR + name checkpoints |
| R-F18-1 | F18 | Remedy workflow commits without receipt | H | fail-open | declared remedies as chain links |
| R-F12-1 | F12 | Short windows escalate slow CI | M | false escalation | time-based threshold |
| R-F5-2 / R-F8-1 | F5, F8 | Buffers move the cliff | M | false refusal | streaming/scoped |
| R-X-1 | all | `state-sync.cjs` / `claude-role-host.cjs` / `sentinel.cjs` contention with 40-03/16/19/22/27, 41-01/08 | M | merge conflicts, rework | phase 42 after those plans land |

## OPEN-QUESTIONS.md draft

- [ ] OQ-01: Does `intake/phase40-amendment.diff` (D-43..D-45) touch any file or behaviour listed above, especially `claude-role-host.cjs`, `sentinel.cjs` or the per-repository config that F9/F13/F18 would also need? — owner: phase-40 planner / constraints research line
- [ ] OQ-02: Does T-41-08 also change `publish-gate.cjs` `baseFor`, or only the hook's worktree resolution? Should F2 be folded into it? — owner: phase-41 plan author
- [ ] OQ-03: What is the authoritative base for the comment policy of a stacked child: `delivery-state[id].base`, the live PR base, or the merge-base with the epic? — owner: operator / ADR author
- [ ] OQ-04: Is a host-side verifier (running declared checks outside the `--restricted` sandbox and sealing a receipt) inside ADR-014's launch authority, or does it need a new ADR decision? — owner: ADR-014 owner (operator)
- [ ] OQ-05: What can the Codex executor sandbox run (docker, network, deps), and does it produce the same receipt type the merge gate would check? — owner: Codex runtime maintainer
- [ ] OQ-06: Which commit kinds are legitimate links in a receipt chain (executor, fixer, base-merge, host finalizer, declared remedy workflow), and which journal event proves each one? — owner: ADR author
- [ ] OQ-07: For F6, is "the ticket's own declared-file diff is unchanged" an acceptable carry criterion, with CI as the only interaction check? — owner: operator
- [ ] OQ-08: Do pdffiller repositories enforce required approvals or code-owner reviews in branch protection, and is CodeRabbit's approval advisory or required? — owner: pdffiller repository admins
- [ ] OQ-09: Where do per-repository settings live when `.planning/` is untracked: the Shipyard project config (`pipeline.repos.*`) or the target repository? — owner: operator
- [ ] OQ-10: Should the ci-wait window be capped per runtime (Claude 600 s only), and should the escalation threshold be time-based rather than counted in windows? — owner: delivery-pipeline maintainer
- [ ] OQ-11: How should a CANCELLED check with no newer run be handled: retry the run, send to a human, or send to ci-fix? — owner: operator
- [ ] OQ-12: What does a judge's `unknown` finding type mean in practice (schema drift or genuine novelty), and should it block? — owner: arch-review role maintainer
- [ ] OQ-13: May Shipyard add labels to or transition existing MYD issues, and which transitions does the MYD workflow allow? — owner: pdffiller Jira admin / operator
- [ ] OQ-14: Should a binding to an existing Jira issue be declared in the plan by decompose, or discovered at export? — owner: operator
- [ ] OQ-15: Should `pipeline.gsd_sync` be refused loudly or honoured? The code comment says it is ignored deliberately. — owner: delivery-pipeline maintainer
- [ ] OQ-16: How was T-02-02 (a human_checkpoint) merged by `sentinel.cjs merge` at 19:15:36 / 19:17:57: preauthorized, flag changed, or another path? — owner: next check is `grep '"T-02-02"' pdffiller/.planning/graph/delivery-log.jsonl` for `preauthorized` (not reachable from this worktree)
- [ ] OQ-17: Under `auto_merge: epic`, is the human check meant for the ticket PR or for the epic PR into the default branch? — owner: operator
- [ ] OQ-18: Which repository remedy workflows (e.g. jsfiller `pw-debug-tests.yml` `regenerateScreenshot`) may the conveyor dispatch without a human, and under what plan or ADR statement? — owner: operator / target-repository owners
- [ ] OQ-19: Is a before/after proving-ground rerun on pdffiller scheduled, and who runs it? It is required for the F6/F11 numbers and the "no orchestrator commits" criterion. — owner: operator
