# Decisions

<!-- Every accepted position is recorded IMMEDIATELY at the moment of the decision, not at the end. -->
<!-- Record format: -->
<!-- ## <decision, as an affirmative statement> -->
<!-- **Why:** ... -->
<!-- **What was rejected:** ... -->
<!-- **Scope fence:** what this decision explicitly does NOT cover -->
<!-- These sections become the locked decisions in the ADR when Gate 1 is closed. -->

## Executor work is verified host-side, outside the agent sandbox
**Why:** User decision 2026-09-26 (F7). The Claude executor sandbox has no docker, php, network or dependencies (`claude-runtime-host.cjs:649-690`), so 8 of 13 tickets could edit but not verify. Running the plan's declared verification commands in the trusted host keeps the agent's authority unchanged (ADR-014 §4) and makes the evidence host-produced, not agent-claimed.
**What was rejected:** A declared verification environment inside the sandbox (widens agent authority; docker is host-root-equivalent; needs an ADR-014 amendment). Verification deferred to repository CI (slow feedback, no local RED/GREEN evidence, weak for thin-CI repositories).
**Scope fence:** Only commands declared in the approved plan and matching a project allow-list run, as argument arrays with timeouts and bounded output, never taken from agent output. The result is finalization evidence (or a sealed artifact referenced by digest); the receipt shape does not change. The host finalizes only on pass and returns failures to a bounded executor/fixer round. Codex reuses the same host path (T-42-01's candidate seam (split from T-41-04)). No sandbox widening.

## The merge gate refuses heads not covered by the conveyor, for PRs opened after rollout
**Why:** User decision 2026-09-26 (F7). `sentinel.cjs mergeOne` checks no receipt or finalization today (`grep receipt\|finaliz sentinel.cjs` → comments only), so eight orchestrator-authored commits merged into epics.
**What was rejected:** Applying the gate to every open PR at once (strands PRs opened before the release); a warning-only mode (keeps the fail-open).
**Scope fence:** A head is covered when each commit since the ticket's base is a link of the chain: a verified executor or fixer receipt with trusted finalization, a journalled base-merge, or another link kind named in the ADR (a declared remedy only if that decision is taken). Anything else refuses with the command that brings the commit under the conveyor. PRs opened before the release keep today's rule and are marked as legacy in the journal. Both runtimes' merge paths. Reads existing receipts; no new receipt fields.

## A conform verdict carries across a base-merge when the ticket's own diff is unchanged
**Why:** User decision 2026-09-26 (F6). Base-merges that bring already-judged sibling squashes discarded the verdict seven times (≈23 arch-review launches for 13 tickets). The ticket's own patch is what the judge certified; it is provable from object identities.
**What was rejected:** Composition carry over sibling verdicts (larger fail-open, cross-repository commit→ticket→verdict lookups); a cheap delta re-review (still one launch per base move, the launches-per-ticket target does not move).
**Scope fence:** Carry only when the own patch is identical (`git patch-id --stable`, or identical blobs for every `files_modified` path) and every other path equals the new base; any other difference, including a merge that duplicated a block, re-owes arch-review. CI and the epic PR remain the interaction checks. Built after T-40-19 (verdict as `merge-gate` commit status) and posts the carried status there. Before/after launches per ticket measured on the proving-ground rerun.

## `human_checkpoint` distinguishes `review` from `merge`
**Why:** User decision 2026-09-26 (F17). Under `auto_merge: epic` a checkpoint blocked merges even into the epic; three tickets waited ~2.5 h and the user expected epic merges to be automatic ("you will merge into the epic branch, right?").
**What was rejected:** Moving every checkpoint to the epic→default merge (loses "do not land even in the epic", needed for external dependencies such as T-02-13); keeping the semantics with only a clearer Gate-2 prompt (the stall recurs).
**Scope fence:** `review`: a human approval of the PR is required, then the guard merges into the epic. `merge`: the human merges (today's meaning), also the value for external-dependency holds. `true` keeps meaning `merge` for existing plans; `preauthorized: true` keeps working. Gate 2 states the consequence of each value. `pipeline-stats` keeps attributing guard merges separately. Both runtimes.

## Target repositories declare extra allowed comment markers, and edits of existing comments are not additions
**Why:** User decision 2026-09-26 (F13). pdffiller's own agents require `@ai-generated model=<model>` on generated tests; the hard-coded markers (`comment-policy.cjs:9,382`) blocked it and cost a 40-minute user decision, and an ADR-required edit of a stale comment was blocked because a modified comment line scores as added.
**What was rejected:** Letting the repository win entirely on target projects (loses the policy's purpose); keeping it strict with a one-time recorded decision (violates the target repository's rules on every ticket).
**Scope fence:** Per-repository exact marker tokens in the project's `.planning/config.json`, keyed by `owner/repo` like D-45, read through `loadConfig` from trusted configuration, never from the ticket worktree; anchored and length-bounded. A changed line whose pre-image was already a comment is not an addition; net-new free comments still block. The three built-in markers stay; Shipyard defaults unchanged.

## Pre-existing Jira issues are bound by key, proposed by decompose and approved at Gate 2
**Why:** User decision 2026-09-26 (F15). The export looks up by shipyard label and creates on no match (`jira-export.cjs:102-124,213-254`), so an epic with existing issues would get ~28 duplicates; the operator disabled Jira and moved statuses by hand.
**What was rejected:** Recorded keys only, bound by hand (keeps the manual step); a `skip` mode (no duplicates, but no binding either).
**Scope fence:** Decompose proposes a ticket → existing-issue mapping from the investigation's Jira input and writes the key into each plan; the human approves it with the ticket set at Gate 2. A recorded key is authoritative: export looks it up by key, never creates when a key is recorded, and refuses an unknown key. Issues that do not carry the shipyard label are only transitioned and commented, never have summary or description rewritten. Status transitions stay the phase-29 projection.

## Only operator-declared repository remedy workflows may run before a human escalation
**Why:** User decision 2026-09-26 (F18). T-02-06 was parked for a screenshot baseline although jsfiller's `pw-debug-tests.yml` (`regenerateScreenshot`) fixed it; it took two hours and a user nudge.
**What was rejected:** Proposing remedies only (the human still runs them); no change.
**Scope fence:** The project config declares, per repository, a failure signature, the workflow and its inputs; a match dispatches it (bounded by the attempt budget, journalled) instead of `escalation-record mark`. A commit the workflow pushes is a declared link kind in the merge gate's receipt chain, and the head still goes through arch-review and CI. Nothing is discovered or run that is not declared; otherwise escalation names the candidate remedy.

## One shared definition of the conveyor's scratch files; any other untracked file still blocks the role host
**Why:** User decision 2026-09-26 (F5). `claude-role-host.cjs:131` refused on the conveyor's own `.shipyard-*` files, and the operator had to edit `info/exclude` in six repositories. The judge certifies `HEAD^{tree}` (`:140`), so arbitrary untracked content must not reach it.
**What was rejected:** Ignoring untracked files in the role host as base-merge does (untracked content becomes readable by the judge).
**Scope fence:** One exported scratch set used by the role host, the finalizer (`delivery-commit-finalizer.cjs:8`), the Codex host (`codex-delivery-host.cjs:20`) and base-merge/gc; the role host's status read also stops failing on large output (256 KiB buffer). No `.gitignore` or `info/exclude` writes.

## A stale approval from a declared bot does not block a merge the target branch does not require it for
**Why:** User decision 2026-09-26 (F9). `reviewers.cjs:154-170` demands an approval on the current head whenever `reviewDecision` is APPROVED; CodeRabbit re-reviewed without re-approving, and T-02-10 was parked for a human although none of the six repositories' epic branches has any rule (`gh api …/rules/branches/epic%2F…` → `[]`).
**What was rejected:** Keeping the block and only re-requesting the bot.
**Scope fence:** Ignored only when the stale approval's author is a declared bot and either the target branch requires no review or a human approval on the current head exists; a stale human approval still blocks; otherwise the guard re-requests the review once and escalates with the command. Bot identities become configurable (backlog `a-disabled-reviewer-has-no-way-to-say-so`). GitHub's own `BLOCKED` merge state still refuses.

## Cancelled checks are re-run, not repaired, and one ci-wait call fits the runtime's tool cap
**Why:** User decision 2026-09-26 (F12). `check-state.cjs:95-100` sends CANCELLED to ci-fix (three concurrency-cancelled `publish` jobs were hand re-run), and `ci-wait.cjs:123-125` waits 15–60 minutes while one Claude Bash call is capped at 600 s, so the wait went to the background and was polled with `sleep`.
**What was rejected:** Fixing only the CANCELLED routing.
**Scope fence:** A CANCELLED check superseded by a newer run for the same head and name is ignored; a lone CANCELLED latest run gets one deterministic `gh run rerun` (journalled, not counted against `max_attempts`, never green). On Claude one `ci-wait.cjs` call returns within 540 s unless `--timeout` is explicit, and the window budget accumulates across calls in the existing wait record; the stop gate keeps the turn alive between calls.

## `pipeline.gsd_sync` is honoured as a deprecated alias with a visible warning, and a decomposed phase does not block gsd-sync
**Why:** User decision 2026-09-26 (F16). `pipeline-config.cjs:927-933` drops the legacy key with a warning the state-sync output buries; `gsd-sync.cjs:616` blocked finalization once per phase-01 plan because decompose wrote a ROADMAP declaring only its own phase; projections stayed off for the run.
**What was rejected:** Refusing the legacy key loudly.
**Scope fence:** `delivery_pipeline.*` precedence is unchanged; the deprecation shows on the state-sync summary line. Decompose writes its phase into ROADMAP in the shape gsd-sync reads, and plans of a phase absent from ROADMAP produce one summarised warning, not a per-plan block. Built after T-41-05 and T-40-17.

## Point fixes take their cheapest correct shape
**Why:** Scoped by the user on 2026-09-25 as fixes that need no decision; shapes from `research/alternatives.md` Part 2 and `research/constraints.md` §2.
**What was rejected:** Raising buffers or limits alone (moves the cliff); lists of known branch names.
**Scope fence:**
- F2: `publish-gate.cjs baseFor` resolves the ticket's recorded base, then the repository's `origin/HEAD`, before the `origin/main`/`main` fallback; the pre-push hook passes the ticket when the branch is a ticket branch; an unresolved base still exits 2.
- F8: `run-reachability.cjs` asks bounded questions (`merge-base --is-ancestor`, `cat-file -e`, path-scoped `ls-tree`) and gains a large `maxBuffer`; `sentinel.cjs` epic reachability compares only declared paths through local git when the repository is checked out, keeps a path-scoped API fallback, and still refuses a truncated listing.
- F10: `deliver-dispatch.cjs` (T-40-15) gains builders for research, decomposition, arch-review, ci-fix and review-fix requests; each round-trips through the host's exported validator; Codex parity or a named reason.
- F11: `state-sync.cjs` lists PRs by ticket head and open state instead of `--state all --limit <pr_fetch_limit>`, and does not re-derive tickets whose merge into a landed epic is recorded immutably (ledger entry plus merge SHA); `--full` re-derives everything.
- F14: an arch-review finding of unknown type is kept as an informational note with its original type; it never changes the verdict, and a `violation` or incomplete blocking finding still fails.

## Phase 43 is one wave after phase 40 is released; the proving-ground rerun is outside the phase
**Why:** User decision 2026-09-26. Most fixes touch files phase 40 still owns (`sentinel.cjs`, `claude-role-host.cjs`, `state-sync.cjs`, the delivery hosts, `pipeline-config.cjs`); waiting for phase 40's release avoids cross-phase parents that cannot cascade through an epic.
**What was rejected:** Two waves (free files first); a rerun ticket inside the phase.
**Scope fence:** Phase 43 depends on the released phases 40, 41 and 42 (T-42-01, the Codex trusted-finalization resume that host-side verification builds on), so its tickets depend only on each other. Every fix carries unit or fixture tests that fail on base. The before/after numbers (state-sync time, arch-review launches per ticket, no orchestrator commits) come from a later proving-ground rerun by the operator, not from a phase-43 ticket.


## The new phase is numbered 43
**Why:** While INV-007 was open, main gained phase 42 (T-42-01, trusted finalization resume split from T-41-04, delivered after phase 41 and before phase 40). This investigation's phase therefore takes number 43.
**What was rejected:** Renumbering the existing phase 42.
**Scope fence:** Only the number changes; research artifacts under `research/` keep their original wording as sealed evidence.
