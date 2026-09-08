# Autonomy and quality audit — 2026-09-07

## Scope and evidence

Reviewed the current delivery scripts, commands, workflow prompt builders, agent references, gates, configuration/generation/install paths, container/CI configuration, tests, and existing architecture/planning records. The audit targets failures that interrupt unattended execution or weaken the resulting implementation.

Production source was unchanged between starting commit `b4091f7` and completion snapshot `501864f3916573ca08cc0a1514fbbf72734d2a24`. Concurrent changes during the audit affected planning and delivery records; they are not implementation fixes. Existing `.planning/graph` changes were preserved. This audit makes no production changes, commits, pushes, Jira edits, or real PR merges.

Validation:

- `make test-fast` completed with exit 0: unit, graph, worktree, worktree-gates, sentinel, documentation, and SSH smoke suites. Its output contained 676 successful assertion lines. This is the suite's existing success signal, not a count of independent regression scenarios.
- Isolated Node fixtures with a fake `gh` exercised merge decisions and state synchronization. All merge reproductions used `--dry-run`.
- Isolated local Git repositories reproduced ownership/glob and worktree-GC defects.
- Temporary configuration files reproduced invalid TOML generation, dropped agent skills, and unsafe fallback defaults.
- Workflow files were evaluated in an async wrapper with a stub `agent()` to inspect the actual generated prompts.
- GitHub CLI contracts were checked against the installed CLI and official documentation via Context7. `gh pr checks` exposes a normalized `bucket`; `gh pr merge` supports `--match-head-commit`; `gh api` uses repository-qualified endpoints and does not accept `--repo`. See the [checks manual](https://cli.github.com/manual/gh_pr_checks), [merge manual](https://cli.github.com/manual/gh_pr_merge), and [API manual](https://cli.github.com/manual/gh_api).

Docker builds, Kubernetes deployment, actual agent execution under both CLI runtimes, and live GitHub/Jira write operations were not run. Findings below distinguish executed reproductions from source/protocol analysis. This is a broad source audit, not a proof that no additional bugs exist.

## Overall assessment

The dominant problem is disagreement between components about the same facts: who owns a ticket, what counts as green, whether a phase landed, what a file pattern owns, and which code a review approved. Adding stronger wording to the orchestration prompts will not repair these inconsistencies.

The existing suite passes while concrete counterexamples violate the advertised guarantees. The strongest missing tests are lifecycle and adapter tests across module boundaries, especially `state-sync → dispatch/park → state-sync`, failed GitHub reads, and the full `declaration → scope gate → conflict resolution` path.

There are **28 findings** below: **11 P1** and **17 P2**. P1 denotes a high-priority correctness or operational blocker under the stated trigger; it does not imply that the failure happened in production. P2 denotes a repeatable interruption, quality regression, or important reliability defect. Deliberate human authorization boundaries are not classified as bugs merely because they require a person.

## Findings

### F01 — P1: File-pattern ownership can silently discard ticket implementation

**Sources:** `plugins/delivery-pipeline/scripts/validate-graph.cjs:313`, `scope-gate.cjs:78`, `base-merge.cjs:71`, `base-merge.cjs:110`.

Patterns are truncated before their first wildcard and then treated as complete path segments. Thus `src/foo*.ts` becomes `src/foo`, which does not cover `src/fooBar.ts`. A pattern such as `src/*.ts` instead owns every path under `src`, including non-TypeScript files. This is neither normal glob matching nor an explicitly constrained directory-only contract.

**Executed reproduction:** Gate 2 accepted two unordered tickets declaring `src/foo*.ts` and `src/fooBar.ts`. The scope gate rejected the first ticket's legitimate edit to `src/fooBar.ts`. With conflicting edits on the base, `base-merge` classified that file as undeclared, replaced the ticket's implementation with the base edition, committed, and exited 0 with `result: resolved mechanically`.

**Consequence:** both false escalations and silent removal of intended behavior. The concurrency guarantee also fails for intersecting wildcard declarations.

**Remedy:** one rigorously specified matcher for scope and conflict ownership; conservatively reject ambiguous overlapping declarations. Until implemented, restrict accepted declarations to exact paths and explicit directory patterns. An uncertain ownership result must never authorize automatic conflict resolution.

### F02 — P1: Missing or unreadable CI is accepted as green

**Sources:** `scripts/state-sync.cjs:119`, `state-sync.cjs:281`, `front.cjs:216`, `sentinel.cjs:128`, `sentinel.cjs:535` under `plugins/delivery-pipeline/`.

Failed commands, malformed JSON, an empty check list, and successful execution all collapse into counters. Missing entries in the hand-maintained state lists also produce zero failing/pending checks. The front explicitly treats `none_reported` as green, and the live merge check merely adds a note when no checks ran.

**Executed reproduction:** a fake `gh pr checks` returning HTTP 503 produced `failing:0, pending:0, total:0` and `would_merge:true`. A reported `STARTUP_FAILURE` likewise produced `would_merge:true`. The remaining merge conditions were satisfied in both fixtures.

**Consequence:** an unverified PR may land unless GitHub's own protection independently stops it. The live recheck repeats the same defect and therefore is not an independent safeguard.

**Remedy:** share a normalized check classifier, distinguish unavailable data from an observed empty list, make unknown states non-green, and require an explicit policy for a repository with no CI. Do not turn outages into successful verification. Partly covered by phase 24's check-state and merge plans.

### F03 — P1: Malformed configuration enables automatic merging

**Sources:** `plugins/delivery-pipeline/scripts/pipeline-config.cjs:110`, `pipeline-config.cjs:154`, `sentinel.cjs:86`.

`loadConfig()` catches malformed project JSON and returns defaults, including `auto_merge: epic`. The sentinel discards the accompanying warnings and proceeds with that policy.

**Executed reproduction:** a truncated configuration containing the user's `auto_merge: off` resolved to `auto_merge: epic` with only a warning.

**Consequence:** corruption or an interrupted non-atomic config edit changes an authorization-sensitive policy in the permissive direction.

**Remedy:** invalid existing configuration must prevent mutations. Return a typed configuration error or validity flag that every mutating caller checks. Defaults are appropriate for an intentionally absent configuration, not a corrupt one.

### F04 — P1: Architecture approval is not bound to the code that merges

**Sources:** `plugins/delivery-pipeline/scripts/sentinel.cjs:169`, `sentinel.cjs:467`, `sentinel.cjs:529`, `sentinel.cjs:598`; `references/pr-sentinel.md:157`.

The merge predicate accepts the string `arch-review=conform` without an approved head SHA. A later fix push preserves the body and therefore preserves the approval. The live PR query does not request `headRefOid`, and the merge call does not pin the checked commit with `--match-head-commit`.

**Evidence:** source inspection and merge fixture with a new head plus an old, unbound conform trailer. This was accepted by the dry-run gate.

**Consequence:** architecture review can apply to a different diff, and a push between the checks and merge can move the head being merged.

**Remedy:** bind the verdict to the head and relevant base/contract identity; invalidate it on change; pin the verified head in the merge operation. Covered substantially by T-24-04/T-24-05.

### F05 — P1: The allowed merge target includes unrelated tickets

**Sources:** `plugins/delivery-pipeline/scripts/state-sync.cjs:391`, `sentinel.cjs:481`.

Both the cached `merge_scope` and the live gate allow every ticket branch in the repository. They do not require the target to belong to the ticket's phase or dependency ancestry.

**Trigger:** a PR is accidentally retargeted to a ticket in another phase, or to an unrelated sibling. Its target still passes the membership check.

**Consequence:** automatic squash can put implementation into the wrong branch while the guard reports it landed inside its intended stack.

**Remedy:** validate the exact resolved base or an explicit permitted ancestor relation, with phase and repository identity. Refresh relevant parent state before mutating. Covered in part by T-24-05.

### F06 — P1: Cross-repository stale-base checking is broken and fails permissively

**Sources:** `plugins/delivery-pipeline/scripts/sentinel.cjs:120`, `sentinel.cjs:576`.

`behindBy()` appends `--repo` to `gh api`, which does not support it, while leaving repository placeholders in the endpoint. The error becomes `null`; the merge gate only rejects positive numeric lag or GitHub's explicit `BEHIND` state.

**Executed reproduction:** the fake CLI rejected `--repo` exactly as the real API command does; the dry-run still returned `would_merge:true`. This matters especially when branch protection does not require up-to-date branches and GitHub reports `CLEAN`.

**Remedy:** use `repos/<owner>/<repo>/compare/...`, distinguish failure from zero lag, and refuse or retry an unproven base freshness check.

### F07 — P1: Failed epic comparison marks an unfinished phase as landed

**Sources:** `plugins/delivery-pipeline/scripts/state-sync.cjs:311` and `state-sync.cjs:319`.

A missing/failed comparison maps to `ahead=0`; `landed` then becomes true.

**Executed reproduction:** parent P was merged into its epic, which still existed. An API rate-limit error on the epic-to-base comparison made a phase-2 child of P become `ready:true`, even though P had not been proven present on the integration branch.

**Consequence:** the child starts from a base missing its declared dependency, causing avoidable failures or an implementation built around an incomplete system.

**Remedy:** model integration as `landed | not-landed | unknown`. Park only affected dependent work on unknown and retry the observation; do not map unknown to zero.

### F08 — P1: GC removes clean worktrees whose branches were never pushed

**Sources:** `plugins/delivery-pipeline/scripts/ticket-worktree.sh:244`, `ticket-worktree.sh:248`, `ticket-worktree.sh:315`.

GC assumes that a graph-known ticket with no remote branch has already landed. The normal executor protocol creates and commits a local branch before publishing it, so the same condition holds for active work.

**Executed reproduction:** create ticket worktree, commit one implementation change without pushing, run `gc --prune`. GC classified it as `landed` and removed the directory. The committed work remained reachable through the local branch; this reproduction does not establish permanent loss of that commit.

**Consequence:** interrupted executor/test environment, deleted ignored build/dependency state, and possible loss of new working changes in the classification-to-removal race because removal uses `--force`.

**Remedy:** require positive evidence of landing and absence of active ownership, then recheck cleanliness under the relevant lock immediately before removal. A missing remote ref is not landing evidence. Remove the unsafe fallback deletion path for an unproven worktree.

### F09 — P1: Main synchronization drops active dispatch ownership

**Sources:** `plugins/delivery-pipeline/scripts/state-sync.cjs:502`; compare `front.cjs` and `dispatch-record.cjs` callers of `computeFront`.

The main sync does not pass active dispatch records when building the persisted front.

**Executed reproduction:** `state-sync → dispatch-record mark T executor` produced `waiting.dispatched=[T]`; the next `state-sync` produced `execute=[T], dispatched=[]`; immediately running `front.cjs --json` restored `dispatched=[T]`.

**Consequence:** the main loop and other readers receive contradictory ownership decisions and may dispatch duplicate work. A correctly refreshed standalone front can compensate, but the normal sync output itself is wrong.

**Remedy:** a single front-input builder, used by every caller, plus an integration regression that executes the whole sequence. T-24-11 was added to the concurrent planning work during this audit; production source remains unfixed in the reviewed snapshot.

### F10 — P2: Parent waits are not represented consistently

**Sources:** `plugins/delivery-pipeline/scripts/sentinel.cjs:286`, `sentinel.cjs:403`, `front.cjs:216`, `ci-wait.cjs:163`.

The sentinel defers a child to `wait-parent`, while the front can classify the same green child as `finalize` or `merge`. The documented general `waiting.parent` bucket is not implemented in this front. `dutySummary()` also omits `wait-parent` from its moving counts.

**Trigger:** a parent is still on CI while its child already has an apparently green PR.

**Consequence:** the front says work is actionable, the guard declines it, and the CI waiter refuses because actionable work remains. This is a protocol deadlock or repeated manual reconciliation, not useful progress.

**Remedy:** share the dependency-wait predicate and ownership classification between front, duty, and waiter. Distinguish waiting on an active parent from waiting on a human. Covered by T-24-03.

### F11 — P2: Dispatch and human parks expire on the wrong facts

**Sources:** `plugins/delivery-pipeline/scripts/escalation-record.cjs:135`, `dispatch-record.cjs:194`.

The shared fingerprint includes CI tallies but omits head identity. A routine check finishing can release an agent's dispatch or a human park. Conversely, a real fix push with the same resulting tallies need not release the park at all. A TTL also cannot distinguish a dead agent from a long-running one.

**Evidence:** equal fingerprints after changing only head identity; direct inspection of the shared expiry predicate.

**Consequence:** duplicate work during healthy progress, or an unjustified fixpoint after a human has supplied new code.

**Remedy:** owner-specific identities: dispatch lease/agent identity and heartbeat, review/head identity for human parks, CI run identity for CI waits. Include head SHA in the source snapshot. Covered in part by T-24-08.

### F12 — P2: An expired lock holder can delete its successor's lock

**Sources:** `plugins/delivery-pipeline/scripts/lock.cjs:102`, `lock.cjs:116`.

Takeover depends only on age, and release unconditionally removes the directory without proving ownership.

**Executed reproduction:** acquire A, let its short fixture TTL expire, acquire B, release A, then acquire C while B is still holding its handle. All operations succeeded.

**Consequence:** concurrent owners can enter protected sections after a slow process or scheduler pause. The default TTL changes how often this occurs, not the correctness of the protocol.

**Remedy:** unique owner tokens checked on release, live-owner/heartbeat checks, and atomic takeover. Prefer a proven OS locking mechanism where portable.

### F13 — P2: Atomic writes do not prevent stale snapshots replacing newer ones

**Sources:** `plugins/delivery-pipeline/scripts/state-sync.cjs:149`, `state-sync.cjs:490`, `state-sync.cjs:510`.

Previous state, timestamps, and GitHub observations are collected before the write lock. Two normal callers, main loop and sentinel, can finish in reverse order. The slower older snapshot can overwrite the newer one. The state/front/YAML are separate files, and readers do not all take the writer's lock.

**Evidence:** source-level concurrency analysis; no claim that an actual production race was observed.

**Consequence:** apparent rollback of delivery state, duplicated transitions, stale ownership and recovery decisions. Valid JSON is insufficient evidence of a coherent current snapshot.

**Remedy:** serialized sync or generation-based compare-and-swap with a fresh previous-state read; publish a coherent snapshot generation and make readers validate it.

### F14 — P2: Flakes and old failures incorrectly produce durable plan defects

**Sources:** `plugins/delivery-pipeline/scripts/failure-signature.cjs:264`, `failure-signature.cjs:275`, `failure-signature.cjs:292`.

Every historical attempt signature contributes to the distinct count, regardless of `outcome=flake`. Green boundaries do not reset the interval, and unknown signatures can enter the set.

**Executed reproduction:** two sanctioned, uncharged flaky signatures followed by the first real failure returned `plan_defect` with `distinct:3`.

**Consequence:** correct plans are parked until replanning; successful prior repair work does not reset the supposed “no green” window.

**Remedy:** count only eligible failures in the current unresolved interval, exclude quarantined/unknown observations, and record explicit green boundaries. Covered in part by T-24-01.

### F15 — P2: The attempt limit does not have a reliable resume protocol

**Sources:** `plugins/delivery-pipeline/commands/deliver.md:972`, `deliver.md:1107`; `scripts/attempt-history.cjs`.

The command initializes attempts at 1 and leaves accounting to the session. The journal stores events but the documented cold-start path does not reconstruct a canonical next attempt counter. The workflow increments only on a confirmed push; repeated no-op repair rounds can remain outside that backstop.

**Consequence:** interrupted runs can reset their retry budget, while non-progress work can continue without exhausting it.

**Remedy:** durable, per-ticket/head repair accounting with explicit categories for real fixes, no-op rounds, infrastructure retries, and flakes. Restore the counter at dispatch time instead of trusting conversation memory. Covered in part by T-24-01.

### F16 — P2: CI timeout accounting can both escalate too soon and wait indefinitely

**Sources:** `plugins/delivery-pipeline/scripts/ci-wait.cjs:204`, `ci-wait.cjs:257`, `ci-wait.cjs:274`.

The fixed empty-window budget does not distinguish an observation outage from a stalled CI run. When any watched PR settles, the implementation clears every watched ticket's budget.

**Trigger:** a GitHub outage or normally slow CI consumes windows; alternatively, stuck A shares watches with B/C that periodically finish.

**Consequence:** false human escalation in the first case, and an unbounded wait for A in the second.

**Remedy:** keep per-ticket/run budgets, reset only the item that progressed, separate API retry state from CI progress, and use observed CI duration with an explicit ceiling. Covered by T-24-10.

### F17 — P2: Background sentinel bypasses the bounded multi-PR waiter

**Sources:** `plugins/delivery-pipeline/references/pr-sentinel.md:44`, `commands/deliver.md:1035`.

The background sentinel is instructed to run `gh pr checks <one PR> --watch`. That command can monopolize the only guard while other guarded PRs finish or acquire review feedback. It bypasses `ci-wait`'s escalation bookkeeping.

**Trigger:** A remains pending for hours; B becomes green shortly after the guard starts watching A. B is not serviced until that watch returns, even if the main loop has finished its own work.

**Consequence:** starvation of independent PRs and a session that cannot finish despite actionable progress elsewhere.

**Remedy:** one bounded watch scheduler for the guarded set, returning on any meaningful change and refreshing duties. Background execution changes who waits, not the fairness requirement. Protocol analysis; no actual infinite watch was launched during this audit.

### F18 — P2: The stop hook both permits premature stops and interrupts stale runs

**Sources:** `plugins/delivery-pipeline/scripts/stop-gate.cjs:168`, `stop-gate.cjs:228`, `stop-gate.cjs:306`, `stop-gate.cjs:327`.

`stop_hook_active` bypasses every later stop check after one refusal, while a cascade needs several rounds. Conversely, journal movement is checked before the maximum-age exit and is not bounded to the current session or a recent time window.

**Consequence:** an unfinished cascade may stop after one continuation; a much later unrelated session can be interrupted by movement belonging to an old delivery run.

**Remedy:** a bounded session/generation ledger that rechecks genuinely advanced rounds, with recent-event filtering. This describes the Claude hook; the Codex installer has no equivalent installed stop hook, so cross-runtime enforcement is already asymmetric. Covered in part by T-24-09.

### F19 — P2: Review servicing can miss live findings or endlessly revisit old ones

**Sources:** `plugins/delivery-pipeline/scripts/reviewers.cjs:318`, `reviewers.cjs:343`, `sentinel.cjs:339`; `workflows/fix-round.mjs:123`; `commands/deliver.md:1148`.

Feedback aggregates historical bot comments and marks changes requested when any retained historical review requested changes, even if that reviewer later approved. The workflow prompt explicitly fetches only `unresolved`, omitting the PR-level feedback surface. The duty classifier sends `CHANGES_REQUESTED` with zero unresolved threads back to review-fix.

**Executed prompt inspection:** `usesFullFeedback:false`, `usesUnresolvedOnly:true`. Historical aggregation and zero-thread routing were confirmed in source.

**Consequence:** repeated obsolete fixes, no-op loops, or skipped PR-level findings. Zero unresolved threads is also not evidence that configured reviewers have reviewed the current head.

**Remedy:** current-head/current-reviewer state with stable finding IDs and an explicit consumed-feedback record. Fetch the same complete surface on every runtime. Route a standing reviewer veto with no actionable findings to the correct review/human state. Avoid solving history filtering merely by deleting all comments before a push: unresolved earlier findings must remain actionable. Covered partly by T-24-06.

### F20 — P2: Stale-base repair has no executable duty action

**Sources:** `plugins/delivery-pipeline/scripts/sentinel.cjs:401`, `sentinel.cjs:559`; `workflows/fix-round.mjs:116`.

Merge can refuse a DIRTY/BEHIND base, but the duty vocabulary has no `base-merge`, and the workflow input/prompt has no implemented base-repair branch.

**Executed prompt inspection:** passing `needsBaseMerge:true` did not emit any `base-merge.cjs` instruction.

**Consequence:** the guard can repeatedly offer `merge`, receive the same refusal, and depend on an agent improvising the missing transition.

**Remedy:** explicit base-repair action with a stable owner and verification before another merge attempt. Covered by T-24-06.

### F21 — P1: A valid Codex configuration can become invalid TOML

**Sources:** `scripts/merge-codex-config.cjs:33`, `merge-codex-config.cjs:87`, `merge-codex-config.cjs:105`.

The regex recognizes only a bare `[agents]` line. A valid header with a trailing comment is missed, so the installer appends a duplicate table.

**Executed reproduction:** input `[agents] # my limits` produced two `[agents]` declarations and exit 0. A TOML parser rejects the duplicate declaration.

**Consequence:** installation can break Codex startup and require manual configuration repair.

**Remedy:** parse and validate TOML before replacement, preserve unrelated values, and write atomically with recovery. Add fixtures for comments, quoted headers, and valid existing parent/subtable arrangements.

### F22 — P2: GSD tuning removes existing quality skills

**Sources:** `plugins/delivery-pipeline/scripts/gsd-tune.cjs:217`, `gsd-tune.cjs:315`.

The desired planner/executor `agent_skills` values are singleton arrays. Applying tuning replaces existing arrays wholesale.

**Executed reproduction:** executor skills `[custom-test-contract, custom-quality]` became only `[global:shipyard-delivery-rules]` after a successful apply.

**Consequence:** installing the delivery contract can remove project-specific testing, security, and quality requirements without identifying them as removed requirements.

**Remedy:** merge the owned skill into the array, remove only obsolete Shipyard aliases, and preserve other entries. Offer required-only configuration repair separately from optional model tuning.

### F23 — P2: Codex routing ignores declared model remaps and loses per-run escalation

**Sources:** `scripts/gen-codex-shipyard.cjs:103`, `gen-codex-shipyard.cjs:113`, `gen-codex-shipyard.cjs:258`; `plugins/delivery-pipeline/commands/deliver.md:344`.

The generator reads the catalog's default Codex tier directly instead of applying the user's runtime-tier remaps. Resolution happens from the installer's cwd with empty risk/signature arguments, and the resulting model/effort is baked into global agent files. The command simultaneously claims those files deliberately contain no model key, contrary to the generator.

**Executed agent-side fixture:** a custom sonnet remap did not change generated ci-fix/pr-sentinel models. A repeat failure resolved to deeper effort in the policy CLI while the generated role remained at its baseline effort.

**Consequence:** the actual agent can differ from the user's configuration and the logged/resolved repair policy. High-risk/repeat work does not automatically receive the promised per-ticket treatment through this static path.

**Remedy:** use the full GSD resolver and pass supported per-dispatch options where the runtime allows them; otherwise provide explicit role variants and document the limitation. Test generated behavior, not merely the presence of a model line. Do not assume a model parameter is absent without checking the active tool schema.

### F24 — P1: Jira idempotency keys collide across repositories

**Sources:** `plugins/delivery-pipeline/commands/decompose.md:345`.

The find-or-update key is only Jira project plus `shipyard-T-<phase>-<plan>`; epic labels likewise contain only a phase number. Ticket IDs restart in each repository.

**Trigger:** repositories A and B both export `T-01-01` to the same Jira project. They generate the same JQL lookup, and B is instructed to update A's issue. No external mutation was performed to demonstrate this deterministic collision.

**Consequence:** unrelated ticket/epic descriptions and dependency links can be overwritten, destroying the external traceability the export is intended to provide.

**Remedy:** a stable project/repository namespace plus ticket identity, stored as a label/property. Validate source identity before update and migrate old labels with explicit disambiguation.

### F25 — P2: Invalid executor workflow input silently succeeds with no work

**Sources:** `plugins/delivery-pipeline/workflows/executors.mjs:65`.

JSON parsing errors become `{}`, and a missing ticket array returns `[]` as success.

**Executed reproduction:** invoking the wrapped executor workflow with the string `{invalid` returned `[]`; no agent was launched and no input error was reported.

**Consequence:** an adapter/input failure looks like a legitimately empty wave, potentially leaving a front unserved or a dispatch awaiting results that will never exist.

**Remedy:** validate arguments before dispatch; malformed input and an explicitly empty wave must be different outcomes. Assert a result for every dispatched ticket.

### F26 — P2: Phase numbering is used as evidence that work was abandoned

**Sources:** `plugins/delivery-pipeline/scripts/front.cjs:357`; the left-behind exclusions in `stop-gate.cjs` and `ci-wait.cjs`.

A lower phase number than any merged ticket's phase becomes `left_behind`, even if the roadmap intentionally executes phases out of numerical order. This repository records exactly that ordering for phases 21 and 22.

**Consequence:** live work is deprioritized and the all-left-behind escape can allow a stop/wait despite remaining executable work.

**Remedy:** explicit scope/abandonment state and dependency order. A phase ID is an identifier, not evidence of temporal completion. This is an existing backlog issue, not a newly invented concern.

### F27 — P2: Direct-to-main skips access and unreachable-path blockers

**Sources:** `plugins/delivery-pipeline/scripts/state-sync.cjs:368`, `state-sync.cjs:397`.

The general repository availability and `unreachable_paths` checks exist only inside the epic-stacked branch.

**Trigger:** direct-to-main mode, including legacy fallback, with an unavailable foreign repository or an escaping declared path. A dependency-free ticket can still become ready.

**Consequence:** repeated impossible executor dispatches and misleading board state.

**Remedy:** perform common preconditions before mode-specific dependency/base logic, with the same recoverable blocked state in both modes.

### F28 — P2: Main sync gives the wrong recovery advice for a plan defect

**Sources:** `plugins/delivery-pipeline/scripts/state-sync.cjs:488`; kind-aware `activeParks` consumers in `front.cjs` and `dispatch-record.cjs`.

The main sync calls `activeEscalations`, flattening the record to a string. The front then describes the normal PR-movement lifetime, even when the actual park is bound to the plan hash.

**Consequence:** users are told a push/review change will release a plan defect, but the store will not do so. Subsequent runs continue to stop on the same ticket.

**Remedy:** preserve record kind in the shared front-input builder and test emitted recovery instructions against actual expiry behavior. This is distinct from F09 but can be fixed in the same integration work; T-24-11 now addresses the sync wiring.

## Problematic design choices and instruction conflicts

These are additional architectural observations, not included in the 28 defect count.

1. **Control flow remains distributed across long prompts.** `deliver.md`, `pr-sentinel.md`, workflow prompt builders, generated skills, and runtime adapters duplicate state transitions. The repeated contradictions about parent waits, model keys, base repair, and CI watching demonstrate drift in behavior despite one canonical source tree. Move transition selection and progress accounting into a deterministic step planner; prompts should implement named actions and return typed results.

2. **Autonomy has several separate authorization boundaries without a durable run contract.** Router confirmation, decomposition mode choice, scope selection, risk preauthorization, and integrator `needs-fix → next decompose/deliver` can each stop the lifecycle. Some approvals are legitimate. The defect-prone choice is failing to carry already-granted scope and policy through them. `route.md:85` requires confirmation even when the request may already authorize the action; `deliver.md:1313` sends integration fixes into another invocation. Record authorized scope, allowed side effects, and human checkpoints once; continue all permitted work up to concrete reviewable results.

3. **Strict file fences lack a routine contract-repair path.** The executor is told both to stay inside `files_modified` and to fix a broken plan's verification commands. Legitimate adjacent-file changes tend to become human escalations. Do not simply relax the gate: support a bounded plan amendment, rerun overlap/dependency validation, and escalate only changes outside the user's authorized scope or risk policy.

4. **Verification is optimized for speed without guaranteeing the displaced coverage exists.** Rules forbid full suites/local service checks and assume CI owns them, while no-checks currently permits merge. The architecture judge explicitly excludes bugs, and the degenerate-green detector is intentionally advisory. The combination leaves no reliable functional check when CI is absent or narrower than assumed. Retain proportional testing, but validate actual required coverage before claiming verification. An advisory detector is not itself a bug; describing it as a safety net would be.

5. **Runtime installation is not isolated enough.** Both installers apply a single shared `~/.gsd/defaults.json` runtime, so installing one can change defaults used by the other. They swallow tuning failures; a fresh missing `.gsd` directory can fail at `gsd-tune.cjs:321`. The generated drift judge is `read-only` (`gen-codex-shipyard.cjs:243`) while its prompt requires persisting `drift-record`; its documented orchestrator fallback must therefore carry that responsibility. Use runtime-specific effective config, explicit degraded-install status, and ownership consistent with the actual sandbox.

6. **Cross-runtime parity is not continuously exercised.** The fast CI runs deterministic tests but excludes the Codex generation/install and actual runtime contract checks. Host GSD installation defaults to a moving latest version, while the image uses a pin. That is a conscious compatibility tradeoff, but generated adapters can change independently of Shipyard's source tests. Add a separate compatibility job for the supported pinned/current combinations; avoid upgrading the whole runtime as an incidental step when only repairing Shipyard registration.

7. **“Already tried” is treated as “disproven.”** Repair prompts exclude every recorded hypothesis. A hypothesis can be correct but only partially implemented, or masked by another failure. Keep the anti-loop mechanism, but record evidence and distinguish disproven explanation, incomplete fix, unchanged observation, and newly exposed failure. Otherwise the agent is forced toward a novel but less plausible explanation merely to satisfy the prompt.

## Existing phase 24 coverage

ADR-002 already identifies a substantial subset of these failures. Its accepted status and PLAN files are evidence of intended remediation, not of shipped behavior. During the audit, new planning commits added T-24-11 and expanded test declarations; the audited scripts were unchanged.

| Planned work | Findings substantially related to it |
|---|---|
| T-24-01: failure interval and attempt history | F14, F15 |
| T-24-02: common check vocabulary | F02, but explicitly test command errors and successful empty responses too |
| T-24-03: shared parent waits | F10 |
| T-24-04: verdict identity | F04 |
| T-24-05: live merge boundary | F04, F05, part of F02; also add F06 |
| T-24-06: actionable remedies and review state | F19, F20 |
| T-24-07: consistent instructions | F17 and the documented/runtime conflicts |
| T-24-08: owner-specific records | F11 |
| T-24-09: stop lifecycle | F18 |
| T-24-10: CI wait accounting | F16 |
| T-24-11: canonical resync front | F09, F28 |

Additional scope is needed for glob ownership, worktree GC, malformed configuration, failed epic comparisons, lock/snapshot concurrency, TOML parsing, skill preservation, actual Codex remaps, Jira namespacing, invalid workflow input, numerical left-behind classification, and common direct-mode preconditions. The presence of phase 24 should not hide these gaps.

## Recommended execution order

1. **Protect implementation and mutation decisions:** F01–F08. Require positive evidence for ownership, configuration, checks, approval identity, base identity, integration status, and GC eligibility.
2. **Make ownership and progress coherent:** F09–F18, F26, F28. One snapshot generation and transition vocabulary; durable leases and retry intervals; fair bounded waiting.
3. **Make repairs and runtime adapters trustworthy:** F19–F23, F25, F27. Test actual prompts and generated config with the same fixtures as the deterministic path.
4. **Repair external identity before further multi-repository exports:** F24.
5. **Then simplify prompts and measure autonomy:** completed accepted scope per run, user interruptions by reason, duplicate dispatches, no-op repair rounds, invalidated reviews, and incorrect park/merge decisions. Measure useful progress, not only the absence of pauses.

## Required regression scenarios

- `mark dispatch → state-sync` retains ownership; a real result releases it exactly once.
- CI outage, unknown state, no configured checks, and pending checks have distinct results.
- Old conform + new head cannot merge; head movement between check and merge is rejected.
- Unknown epic comparison never releases a cross-phase dependency.
- Every accepted file pattern has consistent overlap, scope, and conflict-resolution semantics.
- A clean local-only branch and an actively held worktree survive GC.
- Reverse-order sync completion does not regress the published generation.
- A stale owner cannot remove a successor's lock.
- Green boundaries and quarantined failures do not accumulate plan-defect signatures.
- One stuck PR retains its timeout budget when a neighbor progresses.
- Both agent paths receive complete current feedback and an explicit base-repair action.
- Existing commented TOML and custom skill arrays survive installation/tuning.
- Two repositories exporting the same ticket ID never select the same Jira issue.

Passing these checks would substantiate the autonomous guarantees much more directly than additional keyword assertions in command documentation.
