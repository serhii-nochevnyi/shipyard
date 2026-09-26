# INV-007 — research line: alternatives (→ OPTIONS.md draft)

- Line: `alternatives` · policy signals (verbatim DATA): `{"type":"alternatives"}`
- Source revision: `d8a7146e2150dde25a456532a075d0012718df8d` · policy hash `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968`
- Runtime selection (resolved by caller): `claude-opus-5-5` / `medium`
- Scope: 2–3 options with trade-offs for each **decision finding** (F6, F7, F13, F15, F17, F18); the
  cheapest correct shape for each **point fix** (F2, F5, F8, F9, F10, F11, F12, F14, F16); a proposed
  ticket slicing for phase 42. **No recommendation** — the choice belongs to the human at Gate 1
  (`DECISIONS.md`). Where a column says "cheapest" it is a cost statement, not a preference.

## How evidence was gathered (rule zero)

All codebase evidence below came from read-only tool calls in this worktree at the revision above.
"Read X:a-b" means the `Read` tool on that file and line range; "Grep '<p>' X" means the `Grep` tool
(ripgrep) with that pattern on that path; "awk NR" means
`awk 'NR==…' intake/transcript-timeline.txt | cut -c1-700` (the one Bash call that ran; a compound
`cd && sed …` Bash call was **denied** by the session's permission layer and was not retried — every
fact it was meant to fetch was re-fetched with Read/Grep). Transcript timestamps are the UTC prefix of
`intake/transcript-timeline.txt`. Metrics quoted from `intake/findings-report.md` (444 orchestrator
calls, 25 state-syncs / 128 s median, ≈23 arch-review launches, 8/13 hand-committed) were **not
re-measured** by this line — they are source-reported and labelled so.

### Code facts this line relies on (each checked)

| # | Fact | Evidence |
|---|---|---|
| C1 | `publish-gate.cjs` base candidates are `--base`, `COMMENT_POLICY_BASE`, `SHIPYARD_COMMENT_BASE`, `origin/$GITHUB_BASE_REF`, then literally `origin/main`, `main`; otherwise throws `cannot resolve a base ref` | Read `plugins/delivery-pipeline/scripts/publish-gate.cjs:24-40` |
| C2 | `claude-role-host.cjs` refuses on ANY porcelain line incl. untracked (`--untracked-files=all`) with `worktree has local changes before role dispatch` | Read `claude-role-host.cjs:131-132` |
| C3 | `run-reachability.cjs` `git()` calls `spawnSync('git', …, { encoding: 'utf8' })` with no `maxBuffer` (Node default 1 MiB) | Read `run-reachability.cjs:58-59` |
| C4 | `sentinel.cjs` `treeBlobs()` reads `git/trees/<ref>?recursive=1` through `gh api` for BOTH the merged head and the epic, and returns `{error}` on truncation; the caller `epicReceived` turns any error into `ok:null` (unknown, not refusal) | Read `sentinel.cjs:202-229` |
| C5 | `reviewFreshness()` is required whenever `reviewDecision === 'APPROVED'`; fresh only if some current APPROVED review has `commit_id === headRefOid`; it does not distinguish bot vs human, nor required vs optional reviewer | Read `reviewers.cjs:154-170` |
| C6 | `mergeOne` blocks on `review_fresh === false` with `review approval must cover the current head` | Read `sentinel.cjs:1052-1054` |
| C7 | `check-state.cjs` counts bucket `cancel` as `failing` ("a red round to be re-driven") | Read `check-state.cjs:95-100` |
| C8 | `ci-wait.cjs` default window `TIMEOUT_S = 15*60` (`--timeout` / `SHIPYARD_CI_WAIT_TIMEOUT_S` override; resized from the front's estimates) | Grep `CANCELLED\|timeout\|…` on `ci-wait.cjs` → lines 6, 119-123 |
| C9 | `role-artifact.cjs` arch-review finding validator `fail('INCOMPLETE_FINDING', … unsupported type …)` for any type outside the known set — a single finding fails the whole artifact | Read `role-artifact.cjs:1260-1277` |
| C10 | `pipeline-config.cjs` deletes `pipeline.gsd_sync` when `delivery_pipeline.gsd_sync` is absent and pushes the warning `pipeline.gsd_sync is not supported — use delivery_pipeline.gsd_sync` (so it is warned, not strictly silent; the transcript shows the warning was filtered/lost — see T3) | Read `pipeline-config.cjs:927-933` |
| C11 | `jira-export.cjs` plan steps find issues by shipyard labels only (`project = X AND labels = "<label>"`) and every issue/epic step carries `on_no_match: 'create'`; `recordKey` exists (`jira-export.cjs record <T> <KEY>`) but `planExport` never reads a recorded key (Grep `jira_key\|jiraKey\|key:` → only lines 147, 154, both in the label-hit path) | Read `jira-export.cjs:102-124, 226-254, 328-347`; Grep above |
| C12 | `sentinel.cjs` classifies an unanswered `human_checkpoint` as `action: 'human'` and `mergeOne` blocks `human_checkpoint ticket — the merge is the human's by contract` regardless of whether the target is an epic; `preauthorized: true` is the only relaxation | Read `sentinel.cjs:690-701`; Grep `human_checkpoint` → 701, 905, 911 |
| C13 | `AUTO_MERGE` is true only for `auto_merge === 'epic' && integration_mode === 'epic-stacked'` | Grep `auto_merge` → `sentinel.cjs:131` |
| C14 | `sentinel.cjs` contains no executor-receipt or trusted-finalization check before merge (the only `receipt\|finaliz` hits are comments at 673 and 795) | Grep `receipt\|finaliz` on `sentinel.cjs` → 2 hits, both comments |
| C15 | The Claude executor launch is `--restricted`, sandbox `enabled`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, write-allow only the worktree, `blockReadsOutsideWorkingDirectories: true`; no network allow-list and no excluded commands are configured | Read `claude-runtime-host.cjs:649-690` |
| C16 | `comment-policy.cjs` allowed markers are hard-coded `@invariant:`, `@security:`, `@contract:`; no config input | Grep `MARKER_PATTERN\|allowed_markers\|config` on `comment-policy.cjs` → 9, 62, 382 (no config hit) |
| C17 | `gate-trailer.cjs carry` exists (ADR-006 D2), its only caller is `base-merge.cjs`, and it refuses when the live head is not the judged head (`gate-trailer.cjs:473-538`) | Grep `carry` on `gate-trailer.cjs` → 10, 49, 79-82, 382-538 |
| C18 | T-40-19 moves verdicts to a `merge-gate` commit status and keeps `carry` (posts status on the new head) | Grep `carry\|base-merge\|commit status` on `40-19-PLAN.md` → 4, 24-26, 42, 51, 56 |
| C19 | T-41-04 is a Codex-side resume of an authenticated completed candidate through trusted finalization (`codex-*-host`, `delivery-commit-finalizer.cjs`, `command-runner.cjs`) | Grep `## Goal` -A8 on `41-04-PLAN.md` |
| C20 | `state-sync.cjs:459` lists `gh pr list --state all --limit <pr_fetch_limit>` per repository; default `pr_fetch_limit: 1000` | Grep `pr_fetch_limit` → `pipeline-config.cjs:537`, `state-sync.cjs:459,466` |
| C21 | The phase-40 amendment gives T-40-15 host request building for executor (D-43 plan path + sha256) and pr-sentinel preflight per repository (D-44); D-45 title format per repo | Grep `^\+.*(D-43\|D-44\|D-45)` on `intake/phase40-amendment.diff` → 54-94, 132, 192 |

### Transcript facts this line relies on (each checked)

| # | UTC | Fact | Evidence |
|---|---|---|---|
| T1 | 13:32:40 | Orchestrator asks to bind the 12 tickets to existing MYD keys "through `jira-export record`; no new Jira issues" | awk NR==320 |
| T2 | 13:44:57 / 13:45:11 | Loop of `jira-export.cjs record T-02-NN MYD-…` for 12 tickets; then a memory note: "decompose Jira export duplicates pre-existing Jira tickets … disable export instead" | awk NR==325, 329 |
| T3 | 13:54:46 → 13:56:46 | `c['pipeline']['gsd_sync']=False` then re-done as `delivery_pipeline.gsd_sync=False`; second run pipes through `grep -v "not declared in ROADMAP"` | awk NR==347, 349 |
| T4 | 14:20:11–14:20:17 | Operator inspects `comment-policy.cjs` allowed markers; pdffiller's `.github/agents/*.agent.md` require `@ai-generated model=<model>` on generated tests | awk NR==527-528 |
| T5 | 14:20:32 → 15:00:23 | `AskUserQuestion` on the conflict; answer "follow shipyard"; ~40 min of wall time waiting on a human | awk NR==529-530 |
| T6 | 15:00:49, 15:41:28 | Orchestrator strips `@ai-generated` with python and `git commit -q -S --amend --no-edit` by hand in the executor's worktree | awk NR==533, 676 |
| T7 | 15:47:04 | `merged T-02-01 PR #37730 → epic/…` then `epic reachability UNKNOWN: … spawnSync gh ENOBUFS` | awk NR==711 |
| T8 | 16:15:33–16:15:34 | `escalation-record.cjs mark T-02-06 "…baseline screenshot must be regenerated…"` → parked for a human | awk NR==740-741 |
| T9 | 18:21:57–18:22:06 | After the user asked what is left (18:19:23) the orchestrator finds `pw-debug-tests.yml` `workflow_dispatch` input "regenerate screenshot" in jsfiller; run 36173005465 read at 18:26 | Grep `regenerat\|…` → 898-919 |
| T10 | 19:14:50–19:15:23 | User: "you will merge into the epic branch, right?" → "then pre-authorize"; orchestrator writes `delivery.preauthorized: true` into three plans and re-runs Gate 2; T-02-13 kept as a real checkpoint (external dependency MYD-17877) | awk NR==966-969 |

---

## Part 1 — Decision findings (options, no recommendation)

### F6 — conform verdict does not survive a base-merge that brings already-judged sibling squashes

**Today:** `carry` accepts a head move only when the head tree is unchanged AND the recorded base tree
equals the new merge-base tree (C17; backlog `a-conform-verdict-does-not-survive…`,
`the-carry-window-closes-on-exactly-the-merge-that-needs-it`). A base-merge that brings a sibling's
squash changes the head tree (the sibling's files now appear) — so carry refuses, and a full
arch-review is re-owed although the ticket's own diff against the new base is unchanged.
Source-reported cost: ≈23 arch-review launches for 13 tickets.

| | **A. Diff-identity carry** | **B. Composition carry (judged-set)** | **C. Keep re-judging, make it cheap** |
|---|---|---|---|
| Sketch | Extend `gate-trailer.cjs carry` with a second proof: the ticket's own patch is identical — `git diff <old-base> <judged-head>` ≡ `git diff <new-base> <new-head>` (compare `git patch-id --stable`, or compare the per-path blob sets for the ticket's `files_modified` plus "no other path differs from the new base"). The base moved; the ticket's diff did not. | Carry when every commit the base-merge brought in is a squash of a ticket that itself holds a `conform` verdict on the same epic (look up via the `merge` journal events + commit status), and the merge produced no conflict in a file the ticket declares. The union of judged diffs is treated as judged. | Leave the carry rule as is. Add a "delta" arch-review mode: the judge receives only `git range-diff old-base..judged new-base..new-head` and the prior verdict, at the `base` rung, with a small budget; a `conform` still has to be rendered but costs ~1/10 of a full review. |
| Cost / complexity | Low–medium: one predicate in `gate-trailer.cjs` + `base-merge.cjs` call site; also the "after push" window (backlog `the-carry-window-closes…`): re-derive the proof from the merge commit's own parents so a hand-resolved merge can still carry. | Medium–high: needs a reliable map commit→ticket→verdict across repos (T-40-03's PR-number ledger helps), and must reason about interactions between siblings — which is precisely what arch-review exists for. | Medium: new request shape for arch-review, prompt/reference change, role-artifact accepts a `delta` verdict kind. Touches ADR-014 launch surface (a new judgement mode, not new authority). |
| Risks | Patch identity is necessary but not sufficient: a sibling can change code the ticket CALLS (semantic conflict with an identical patch). Mitigated only by the integrator/epic review later. Fail direction: a missed semantic conflict is merged into the epic (not into the default branch). | Same semantic-conflict hole, larger: the carry is taken on the claim that two independently judged diffs compose. Complex lookups fail-open if a ledger lookup is wrong. | Keeps a judge on every head (fail-closed). Still one launch per base move; saves tokens, not launches — the "launches per ticket" success metric does not move. |
| Forecloses | Nothing structural; can be tightened later. Sets a precedent that "judged" means "judged diff" rather than "judged tree". | Commits the design to "verdicts compose", which is hard to walk back once merges rely on it. | Leaves the ≈23→13 launch reduction unachieved; the metric in PROBLEM.md "arch-review launches per ticket" needs A or B. |
| Receipts / ADR-014 | No new launch; carry is a deterministic writer (already exists). | No new launch; deterministic, but more state read. | New judgement mode; rung selection unchanged (grid out of scope). |
| Codex parity | Pure script; identical. | Pure script; identical. | Both hosts need the new request shape. |

### F7 — executor verification environment + merges of commits without executor receipt / trusted finalization

Two coupled halves. (a) The Claude executor runs `--restricted` with a write-only-worktree sandbox and
no network/docker (C15), so PHP tickets could edit but not verify and returned `blocked`; (b) the
orchestrator then verified, committed (`-S`, twice `--no-verify`, T6) and published by hand, and
`sentinel merge` merged them because merge checks no receipt (C14). Half (b) is required by
PROBLEM.md success criteria regardless of which (a) is chosen; it is listed as the common part.

**Common part (every option):** `sentinel.cjs mergeOne` (and the Codex equivalent path) refuses a PR
whose head is not covered by a verified executor/fixer receipt + trusted finalization record for that
head (or a verified `carry`/base-merge record descending from one), with a message naming the command
that brings the commit under the conveyor. Receipt shape unchanged (out of scope); this reads existing
receipts.

| | **A. Host-side verification step** | **B. Declared verification environment inside the sandbox** | **C. Verification delegated to repository CI** |
|---|---|---|---|
| Sketch | The executor edits and returns a candidate (T-41-04's candidate concept, extended to Claude). The trusted host — outside the agent sandbox — runs the plan's declared `verification` commands (e.g. `docker run … php -l`, codecept) via `command-runner.cjs`, records exit codes as evidence, then finalizes (commit+sign) only on pass; on fail returns the output to a new executor/fixer round. | Project config declares an executor environment: extra `sandbox.network.allowedDomains`, `excludedCommands` (e.g. `docker`), read paths (dependency caches), and a pre-launch "prepare" hook (e.g. APFS `cp -c` of `node_modules`, the workaround in `intake/target-project-workarounds.md`). The agent verifies itself, as on Shipyard. | The executor may return `verified: deferred-to-ci` when the plan says checks need infra; the host finalizes and publishes a draft; the ticket stays un-mergeable until repository CI is green (already enforced) and the receipt carries the deferral. ci-fix handles red. |
| Cost / complexity | Medium: a host-run command path with timeouts and log capture; plan schema already has verification commands (to be confirmed by constraints line). One more host step per ticket. | Medium–high: per-runtime sandbox configuration (Claude settings vs Codex sandbox), per-project config keys, doctor checks. Correctness depends on the operator's machine. | Low: a receipt field + host policy; relies on existing CI gate. |
| Risks | Host executes plan-declared commands with the operator's authority — a plan (agent-authored at decompose time) becomes a command source: needs an allow-list / Gate-2 approval of the verification commands. Wall time moves from agent to host. | Widens the executor's sandbox (network, docker socket = host root equivalent). Directly in tension with ADR-014 "no widened launch authority". Docker inside the sandbox is effectively an escape. | Slow feedback (CI minutes per round), more ci-fix launches; repositories with thin CI (or none) get unverified merges — must be combined with `merge_without_ci` rules. Local-only checks (php -l) not run at all. |
| Forecloses | Keeps the sandbox narrow; makes "host verifies" a trusted-boundary responsibility that later roles (ci-fix, review-fix) can reuse. | Future tightening of the sandbox becomes a breaking change for projects that opted in. | Forecloses local TDD evidence (RED-on-base) for infra-bound repos; evidence quality drops. |
| Receipts / ADR-014 | Host adds a verification record to the existing receipt flow (shape unchanged → must fit an existing evidence slot; constraints line to confirm). No agent authority widened. | Widens agent authority — likely needs an ADR-014 amendment, which is out of scope per PROBLEM.md. | No widening; receipt semantics gain a "deferred" meaning — may touch receipt shape (out of scope) unless carried as evidence text. |
| Codex parity | Shared host code; Codex already has the candidate/finalize seam (C19) — natural fit. | Separate config per runtime; parity is manual. | Identical. |

### F13 — comment-policy vs annotations the target repository requires (and ADR-required comment edits)

Today markers are hard-coded (C16); pdffiller requires `@ai-generated model=<model>` (T4); the conflict
cost ~40 min of human wait (T5) and hand amend commits (T6).

| | **A. Repository-declared allowed markers** | **B. Repository instructions win by default (policy off for declared paths)** | **C. Keep policy strict; executor told to omit, decision recorded once** |
|---|---|---|---|
| Sketch | `delivery_pipeline.comment_policy.allowed_markers` (per repo in `pipeline.repos.<name>`) extends the three built-ins with patterns like `^@ai-generated\b`. ADR-required comment edits: a plan-level `comment_policy.allow_paths` / `allow_edits_of_existing` so modifying an existing comment the ADR names is not counted as "added". | Config switch `comment_policy: repo` makes the publish gate defer to the repo (only forbid Shipyard internals, like D-45 does for titles). | No code change; `deliver`/executor reference gains: "the target repo's comment conventions do not override comment-policy"; the one-time decision is stored in project config so nobody is asked again. |
| Cost | Low: config key + marker compile + fixture test. | Low. | Very low. |
| Risks | Pattern is regex from config — must be anchored/length-bounded (existing `MAX_MARKER_LENGTH` idiom). Over-broad pattern re-admits narrative comments. | Loses the policy's purpose (no narrative comments) on target repos entirely. | Violates the target repo's own rules (their agents/tooling expect the tag); repeated friction per project; PRs may be rejected by humans there. |
| Forecloses | Nothing; built-ins stay. | A later strict mode needs a migration. | Keeps a known conflict alive; "no user decisions needed" success goal not met. |
| Codex parity | Shared script. | Shared. | Prose only. |

### F15 — decompose cannot bind pre-existing Jira issues

Today lookup is by shipyard label and `on_no_match: create` (C11); keys recorded with
`jira-export record` are not read back by `plan`; the operator disabled export and moved statuses by
hand (T1, T2).

| | **A. Recorded key is authoritative** | **B. Match-by-query binding at decompose** | **C. Bind-only mode (no create ever)** |
|---|---|---|---|
| Sketch | `planExport` first checks the plan's recorded key (the frontmatter field `upsertJiraKey` writes): if present, emit `lookup: [{kind:'key', key, on_match:'update'}]` and `on_no_match: 'refuse'` (never create when a key was recorded). Decompose gains a documented step to `record` keys for tickets derived from existing issues (e.g. from the investigate input's Jira children). Status transitions then flow through the existing `jira_transitions` projection. | Decompose's input (the epic's child issues, fetched at investigate) is matched to tickets by the decomposer, which writes `delivery.jira_key` into each plan at Gate 2 — the human approves the mapping with the ticket set. | `delivery_pipeline.jira.on_no_match: create|skip|refuse` config; `skip` projects only to issues found by key/label and never creates. |
| Cost | Low: one lookup branch + test; `record` already exists. | Medium: decompose prompt + schema + Gate-2 check; depends on the Jira MCP being available to the decomposer. | Low. |
| Risks | A wrong recorded key updates someone else's issue (description overwrite). Needs `on_foreign`-style guard: only update summary/description if the issue carries the shipyard label, else only transition + comment. | Model-authored mapping can be wrong; the human must check it at Gate 2 (the current approval already reviews the set). | Without A, `skip` still cannot find unlabelled pre-existing issues — solves duplication, not binding. |
| Forecloses | Nothing. | Couples decompose to Jira availability. | Nothing; composes with A. |
| Codex parity | Shared script. | Prose in both decompose commands. | Shared. |

### F17 — `human_checkpoint` semantics under `auto_merge: epic`

Today an unanswered checkpoint blocks the guard's merge even into the epic (C12, C13); the user's
reaction at 19:14:50 ("you will merge into the epic branch, right? → then pre-authorize", T10) shows the
operator's mental model was "checkpoint = merge into the integration/default branch".

| | **A. Checkpoint applies at the epic→default merge only (when `auto_merge: epic`)** | **B. Keep per-ticket semantics; pre-authorize at Gate 2 by default prompt** | **C. Split the flag: `human_checkpoint: review` vs `merge`** |
|---|---|---|---|
| Sketch | Under `integration_mode: epic-stacked` + `auto_merge: epic`, a checkpoint ticket merges into the epic after green+conform, and the checkpoint is transferred to the epic PR (listed in its body/status; the epic PR is already human-merged). | No semantic change. Decompose's Gate 2 asks per checkpoint ticket "pre-authorize for epic merge?" (it already asked, 13:32:40 T1 area, and user answered "without pre-authorization" at 13:44:51); improve the wording to state the consequence (the guard will NOT merge into the epic). | Plans declare what needs the human: `review` (human must approve the PR, then the guard may merge into the epic) or `merge` (human merges, today's meaning). Default stays `merge` for backward compatibility. |
| Cost | Low–medium: `needsHuman` condition + epic PR listing + pipeline-stats predicate (backlog `pipeline-stats-says-a-person-merged…`). | Very low (prose). | Medium: schema, validate-graph, sentinel, front, stats. |
| Risks | Weakens a contract: work a human wanted to see before it lands anywhere now lands in the epic (still reversible — epic is not default). Cases like T-02-13 (external dependency) would merge into the epic prematurely unless a separate "blocked on external" mechanism exists. | Operators keep misreading it; the epic stalls exactly as observed. | More vocabulary; still needs human action for `review`. |
| Forecloses | Per-ticket "do not even land in the epic" — needs C's `merge` value to recover. | Nothing. | Nothing; A is expressible as `review`. |
| Codex parity | Shared scripts. | Prose. | Shared. |

### F18 — premature human escalation when the repository has an automatable remedy

Today the orchestrator parked T-02-06 for a human (T8, 16:15:33) although jsfiller has a
`workflow_dispatch` screenshot-regeneration workflow, found only after the user asked two hours later
(T9, 18:21:57).

| | **A. Declared repository remedies** | **B. "Look for a remedy" step before escalation** | **C. Do nothing / human stays the remedy** |
|---|---|---|---|
| Sketch | Project config `pipeline.repos.<name>.remedies: [{ match: <signature/regex on failing check or log>, workflow: pw-debug-tests.yml, inputs: {...}, then: 'rerun-ci' }]`. ci-fix/escalation consult it: a matching failure dispatches the workflow (`gh workflow run`) instead of `escalation-record mark`, bounded by the attempt budget. | `references/ci-fix.md` + escalation prose: before `escalation-record mark` for a "needs regeneration/update" class, list `.github/workflows` for `workflow_dispatch` inputs and repo docs (`CLAUDE.md`, agents) that name a remedy; escalate with the candidate remedy in the reason. | Keep escalation; improve the escalation reason format so the human sees it quickly. |
| Cost | Medium: config schema + matcher + dispatcher + run-wait; `gh workflow run` is an outward-facing action on the target repo. | Low (prose), unverifiable except live. | Zero. |
| Risks | Triggering target-repo workflows is a new outward action — needs to be operator-declared (not discovered) to stay within authority; workflow may push commits to the PR branch (unreceipted commits → collides with F7 common part; must be modelled as a known non-executor writer or verified by a subsequent fixer round). | Agent discovers and runs arbitrary workflows → widened authority unless it only *proposes*. Soft; may be ignored. | Wall time, as observed (~2 h). |
| Forecloses | Nothing. | Nothing. | The "no human escalation where an automatable remedy exists" goal. |
| Codex parity | Shared scripts. | Both reference files. | — |

---

## Part 2 — Point fixes: cheapest correct shape

| F | Cheapest correct shape | Why not narrower | Test |
|---|---|---|---|
| F2 publish-gate base | In `baseFor` (C1), before the literal `origin/main|main`, resolve: (1) the ticket's recorded base (`delivery-state[id].base`) when `--ticket` is given, (2) the branch's upstream PR base via `graph-dir.cjs resolveBaseRef`-style lookup, (3) `refs/remotes/origin/HEAD` (the repo's default branch). Keep `main` last for back-compat. Pre-push hook passes `--ticket` when the branch is a ticket branch. | Adding `origin/master`/`develop` literals is a list of known homes (backlog `base-merge-refuses…` warns about lists); `origin/HEAD` is the repo's own answer. | Unit fixture: repo whose default is `master`, epic branch `epic/02-…`; gate resolves epic base; Shipyard repo still resolves `origin/main`. |
| F5 scratch files in role host | `claude-role-host.cjs:131` → `--untracked-files=no` **plus** an explicit refusal only if an untracked path would collide with a tracked path in the target (the backlog's caveat); do the same fix in `base-merge.cjs:122` and `ticket-worktree.sh gc` in one ticket so all three share one helper ("worktree dirty ignoring untracked"). | Filename allow-list of `.shipyard-*` rejected for the same reason the backlog gives. Alternative within this fix: move scratch files out of the worktree into the host state dir (bigger; touches T-26-14's contract). | Unit: worktree with `.shipyard-pr-body.md` untracked → host proceeds; with a modified tracked file → refuses. |
| F8a reachability ENOBUFS | `run-reachability.cjs:59` add a `maxBuffer` (e.g. 64 MiB, the target project's patch) AND stop needing big output: use `git rev-list --count`/`merge-base --is-ancestor`/`cat-file -e` forms whose output is O(1). | Buffer alone moves the cliff; command shape removes it. | Unit: fake repo with a git shim emitting > 1 MiB — no ENOBUFS. |
| F8b `treeBlobs` | Replace the two recursive tree reads with a local git comparison when the repo is checked out (`git ls-tree -r <head> -- <declared paths>` vs same on `origin/<epic>` after fetch) — only declared paths, not the whole tree; keep `gh api` fallback restricted by path (`contents` or non-recursive per-dir) only when no checkout exists. Also give `gh()` a large `maxBuffer`. | Current code reads 27k-file trees twice through `gh api`; result is `unknown` anyway on truncation (C4). | Unit with a stub repo: 2 declared files, reachability computed from `ls-tree`; stub `gh` not called. |
| F9 stale bot approval | In `reviewFreshness` (C5): freshness is required only when the APPROVED decision is load-bearing — i.e. compute it from reviews by **required/human** reviewers; an approval from a bot login (`[bot]` suffix, or a configured `delivery_pipeline.reviewers` list — backlog `a-disabled-reviewer-has-no-way-to-say-so`) that is stale does not block when a current non-bot approval or no approval requirement exists. Alternative cheap remedy: the block message names the command (`reviewers.cjs reinit` / re-request review) and the guard re-requests the bot once. | Removing the check fail-opens human approvals on moved heads. | Unit: reviews = [bot APPROVED on old head] with `reviewDecision=APPROVED`, no branch-protection requirement → fresh; human stale → still blocked. |
| F10 request builders | Extend T-40-15's `deliver-dispatch.cjs` (after it lands) with builders for `research`, `decomposition`, `arch-review`, `review-fix`/`ci-fix` rounds — same pattern: read the graph/INV dir, compute paths + digests, emit the exact host request; no new host. | Separate scripts per role duplicate the builder. Ordering: strictly after T-40-15 merges (file owner). | Unit per role: builder output validates against the host's exported request validator (T-40-14 exports them). |
| F11 state-sync wall time | (1) `gh pr list` per repo with `--search "head:ticket/T-<phase>"` / `--state open` + targeted `gh pr view` for tickets whose state is `pr-open` — never `--state all --limit 1000` on a 30k-PR repo (C20); (2) skip re-deriving tickets already `merged` in `delivery-state.json` (terminal state; re-check only on explicit `--full`). | Raising/lowering `pr_fetch_limit` alone either truncates or stays slow. | Unit with stub `gh` counting calls: merged tickets cause 0 calls; before/after wall time from the proving ground (live, per PROBLEM.md). |
| F12a ci-wait vs Bash 600 s | Cap a single `ci-wait.cjs` invocation at < 600 s by default when `CLAUDECODE`/runtime=claude (e.g. 540 s) and keep the window budget across invocations in the existing wait record (C8, lines 62-63 already persist empty windows). The loop re-invokes; the stop gate already keeps the turn alive. | Background Bash loses the foreground property that closed `nothing-wakes-a-run…`. | Unit: runtime=claude → effective timeout ≤ 540 unless `--timeout` explicit; empty-window count accumulates across two short calls. |
| F12b CANCELLED → ci-fix | Split bucket `cancel` from `fail` in `check-state.cjs:100` (C7): a cancelled check with a newer run for the same head/name is ignored; a cancelled latest run is `rerun` (dispatch `gh run rerun` once — deterministic, no agent) before it can become `ci-fix`. | Treating cancel as pass is fail-open. | Unit: `CANCELLED` superseded by `SUCCESS` → green; lone `CANCELLED` → action `rerun`, not `ci-fix`. |
| F14 one unknown finding type | `role-artifact.cjs:1276` (C9): map an unknown type to `note` with `original_type` preserved when the finding carries `summary`, and fail only if the **verdict** is unsupported or a blocking type is incomplete. Alternatively normalise known synonyms first. Keep `conform/violation` verdict validation strict. | Accepting any shape unchecked hides a violation; mapping to `note` cannot turn a violation verdict into conform because the verdict is separate. | Unit: artifact with verdict `violation` + one `type:"unknown"` finding → accepted, finding downgraded, verdict preserved. |
| F16 ROADMAP + gsd_sync | (1) Make the `pipeline.gsd_sync` warning (C10) reach the operator — surface config warnings on the state-sync summary line rather than below filtered noise (T3 shows `grep -v`); or honour `pipeline.gsd_sync` as a deprecated alias (warn, but apply). (2) decompose writes its phase into ROADMAP in the shape gsd-sync reads, or gsd-sync treats "phase not declared in ROADMAP" as a single summarised warning, not a per-ticket block. | Deleting the key while the operator believes it applied is the silent-failure class; applying it as an alias is the backward-compatible shape. | Unit on `loadConfig`: `pipeline.gsd_sync:false` alone → effective false + one warning. Fixture for decompose→gsd-sync ROADMAP shape. |

---

## Part 3 — Proposed ticket slicing for phase 42 (a draft, not a decision)

Slicing assumes Part-1 choices are made at Gate 1; tickets marked *(option-dependent)* change shape
with the choice. File ownership and ordering against phase 40/41 plans are the constraints line's
job; the overlaps noticed here are listed so that line can check them.

| # | Ticket | Findings | Main files (noticed overlaps) | Dependent on |
|---|---|---|---|---|
| 42-01 | Resolve the publish-gate base from the ticket's recorded base and the repo's default branch | F2 | `publish-gate.cjs`, `scripts/shipyard-pre-push-gate.sh` (**T-41-08** owns the hook) | after T-41-08 |
| 42-02 | One "dirty ignoring conveyor scratch" helper for role host, base-merge and gc | F5 | `claude-role-host.cjs` (**T-40-16, T-40-22, T-41-01** also touch it), `base-merge.cjs`, `ticket-worktree.sh` (**T-40-27**) | after those |
| 42-03 | Bounded git/gh output in reachability and epic-received checks | F8 | `run-reachability.cjs`, `sentinel.cjs` (**T-40-19, T-40-22**) | after T-40-19/22 |
| 42-04 | Stale bot approval does not block; re-request once | F9 | `reviewers.cjs`, `sentinel.cjs` | after 42-03 (same file) |
| 42-05 | Request builders for research, decomposition, arch-review and fix rounds | F10 | `deliver-dispatch.cjs` (**T-40-15**) | after T-40-15 (+ amendment D-43) |
| 42-06 | state-sync: targeted PR listing and no re-sync of merged tickets | F11 | `state-sync.cjs` (**T-40-03, T-40-19, T-40-27, T-41-08**) | after all four; measure before/after live |
| 42-07 | ci-wait under the Bash cap; cancelled checks re-run, not ci-fix | F12 | `ci-wait.cjs`, `check-state.cjs` | — |
| 42-08 | arch-review tolerates an unknown finding type | F14 | `role-artifact.cjs` (**T-40-18**) | after T-40-18 |
| 42-09 | gsd_sync legacy key honoured with warning; decompose ROADMAP readable by gsd-sync | F16 | `pipeline-config.cjs`, `gsd-sync.cjs` (**T-41-05**), `commands/decompose.md` (**T-40-25**) | after T-41-05, T-40-25 |
| 42-10 *(option-dependent)* | Verdict carry across sibling base-merges (+ post-push carry) | F6 | `gate-trailer.cjs`, `base-merge.cjs` (**T-40-19**) | after T-40-19 |
| 42-11 | Merge refuses heads not covered by a verified receipt + trusted finalization | F7 common | `sentinel.cjs`, Codex merge path | after 42-03/04 (same file) |
| 42-12 *(option-dependent)* | Executor verification environment (A host-verify / B sandbox env / C CI-deferred) | F7 | A: `claude-delivery-host.cjs`, `command-runner.cjs`, `delivery-commit-finalizer.cjs` (**T-41-04**, **T-40-18**, **T-40-27**) | after T-41-04 |
| 42-13 *(option-dependent)* | Repository-declared comment markers / edits | F13 | `comment-policy.cjs`, `pipeline-config.cjs` | after 42-09 (same config file) |
| 42-14 *(option-dependent)* | Bind pre-existing Jira issues | F15 | `jira-export.cjs`, `commands/decompose.md` | after T-40-25 |
| 42-15 *(option-dependent)* | Checkpoint semantics under `auto_merge: epic` | F17 | `sentinel.cjs`, `front.cjs`, `pipeline-stats.cjs` (**T-40-03**) | after 42-11 (same file) |
| 42-16 *(option-dependent)* | Repository remedies before escalation | F18 | config + `references/ci-fix.md` / escalation path | after 42-07, 42-11 |
| 42-17 | Proving-ground rerun: before/after state-sync time and arch-review launches per ticket | success metrics | none (evidence only; live) | last |

Alternative slicings the human may prefer:
- **By file owner** (fewer, larger tickets): one `sentinel.cjs` ticket (F8b, F9, F7-common, F17) and
  one config ticket (F13, F16, F15-config) — fewer serial merges on a hot file, larger review each.
- **Two waves**: wave 1 = point fixes that unblock the proving ground without any decision
  (42-01..42-09); wave 2 = decision tickets after Gate 1. Wave 1 can start alongside phase 40's tail
  only where no file is shared.

---

## Spikes recommended (not performed — throwaway code is out of scope)

- `/gsd-spike "F6-A: on a real stacked cascade, does patch-id equality of the ticket diff before/after a sibling-bringing base-merge hold, and how often does it hold when arch-review would still have found something?"`
- `/gsd-spike "F7-A: host-run verification commands from a plan inside a Docker container for a PHP ticket; measure wall time and what the executor needs back on failure"`
- `/gsd-spike "F8b: git ls-tree on declared paths vs gh api recursive tree on pdffiller — equality of the reachability answer and wall time"`
- `/gsd-spike "F11: state-sync with --search head:ticket/ vs --state all --limit 1000 on a 30k-PR repository"`

## Uncertainties / unknowns (for the risks line's OPEN-QUESTIONS)

- Whether the plan schema already carries machine-runnable verification commands usable by F7-A — not checked by this line; next check: Grep `verification` in `validate-graph.cjs` and a 40-* plan's frontmatter.
- Whether the receipt/evidence slot can carry a host-verification record without changing the receipt shape (out of scope to change) — owner: constraints line / ADR-014 owner.
- Whether pdffiller branch protection requires CodeRabbit's approval (F9: if the bot is a required reviewer, option "ignore stale bot approval" is wrong) — unknown; needs `gh api repos/pdffiller/pdffiller/branches/<epic>/protection` in the live project.
- Whether `pw-debug-tests.yml` commits the regenerated screenshot to the PR branch itself (T9, 18:22:06 the orchestrator was checking) — unknown from the truncated timeline; decides whether F18-A must model a non-executor writer.
- Metrics (≈23 launches, 128 s median, 8/13) are source-reported, not re-measured here.
- F16 "silently dropped": code emits a warning (C10); whether the state-sync output surfaced it before the orchestrator's `grep -v` filter is not visible in the truncated tool result at 13:54:46.
