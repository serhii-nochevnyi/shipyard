# Requirements: shipyard

<!-- shipyard:gsd-sync generated; sync-version: 1; source fingerprint: a90991e8483ab3ab2ab26f88bd2644d1e8379f29333e27291f6a1b42bf987780 -->

**Defined:** 2026-09-10
**Core Value:** Keep delivery decisions truthful, resumable, and synchronized between the Shipyard conveyor and native GSD workflows.

## v1 Requirements

### Delivery and workflow integrity
- [ ] **REQ-01**: A failure is identified by a normalized SIGNATURE (error class + test/job id + file), not by an attempt counter, so the policy can tell progress from repetition.
- [ ] **REQ-02**: A ticket has a third terminal outcome besides green and human: `plan_defect`, reached mechanically from K distinct signatures without progress. It blocks the ticket and lets the cascade continue.
- [ ] **REQ-03**: A job that fails intermittently on an unchanged tree is a FLAKE: quarantined, and its attempts are not charged against the budget.
- [ ] **REQ-04**: The actionable front is ORDERED by unblocking power (descendants in the DAG) and CI length, so an unattended run does not narrow to one item.
- [ ] **REQ-05**: A fixer receives the prior attempts for its ticket (signature, hypothesis, outcome) as INPUT, so a fresh subagent cannot re-propose a fix that already failed, without polluting its context.
- [ ] **REQ-06**: Risk classes are pre-authorized at decomposition time, so a runtime interruption at 3am becomes a design-time decision. Anything not pre-authorized is deferred to the morning front rather than blocking.
- [ ] **REQ-07**: Degenerate green is detected on the diff (weakened assertion, skip, rewritten snapshot, raised timeout, `any`/`@ts-ignore`, swallowed catch, narrowed matcher) and REPORTED as a `gate_status:` trailer. Reporting first, blocking only once field data shows the false-positive rate.
- [ ] **REQ-08**: A park is described to the human by the STORE that owns it, so a new park kind cannot be rendered with another kind's lifting rule.
- [ ] **REQ-09**: A guard that rejects an unusable value checks the VALUE, not the shape of the argument list around it.
- [ ] **REQ-10**: Every script sharing the `--graph` spelling shares its parsing, including the refusal to swallow a following flag as the value.
- [ ] **REQ-11**: A lock is held from the instant it exists, so a writer still announcing itself is never mistaken for a dead one.
- [ ] **REQ-12**: A test that cannot fail is a defect: the harness must fail an asynchronous test that throws, rather than reporting it green.
- [ ] **REQ-13**: A ticket handed to an agent is VISIBLE as dispatched: the front reports it as waiting rather than offering it again, and the record expires by itself so a killed run cannot hide work from the next one.
- [ ] **REQ-14**: The backlog states what is true now. An entry describing a defect that has since been fixed is the same class of error the programme exists to remove: prose asserting a state the code does not have.
- [ ] **REQ-15**: A dispatch or escalation record is lifted only by a fact its OWNER moves: a guard's output for a dispatch, a human's fields for a park — never by CI tallies.
- [ ] **REQ-16**: The stop gate blocks every stop a cascade needs (one per round, under a cap), and never blocks a session for a run that has ended or for a dispatch that outlived a plausible launch.
- [ ] **REQ-17**: Check state has ONE vocabulary, read from gh's own `bucket`; anything unclassified is pending, never green.
- [ ] **REQ-18**: Every wait the guard imposes is a bucket the front reports and an owner the loop can dispatch: `waiting.parent` exists, and a moved base is a `base-merge` duty with a workflow flag.
- [ ] **REQ-19**: A gate verdict is bound to the head it judged; a trailer for a head that is no longer the PR's is absent for duty, merge and front alike.
- [ ] **REQ-20**: Merge verifies what the cache cannot know: no reported checks is not green, the merged head is pinned, the stack is the phase's own, children are retargeted from live PR data.
- [ ] **REQ-21**: Review feedback is the CURRENT state (comments since the last push, last verdict per reviewer), and `CHANGES_REQUESTED` with nothing to resolve belongs to a person, not to a fixer.
- [ ] **REQ-22**: `plan_defect` requires K distinct signatures with no green between them, `unknown` never counts, and the attempt counter survives the session.
- [ ] **REQ-23**: The CI waiter distinguishes a stalled pipeline from an unreachable `gh`, clears only the settled ticket's record, and sizes its window from the observed CI.
- [ ] **REQ-24**: Prose names only what the scripts implement: no instruction sanctions a wait, a bucket or an order of operations the code does not have.
- [ ] **REQ-25**: Every writer of `delivery-front.json` writes the SAME front: a resync must carry the dispatch overlay, so the board and the stop gate never read work in flight as actionable between one `mark` and the next.
- [x] **REQ-26**: The image and the smokes pin the runtimes the conveyor is tested on: Claude Code with Fable 5.1/Opus 5 aliases, gsd-core 1.13.0.
- [x] **REQ-27**: A Codex agent carries EFFORT, not a model baked from a catalog that can be stale; a `model =` line appears only when the user's GSD remap names one, resolved through GSD's resolver.
- [x] **REQ-28**: Prose names the runtimes as they are: the Agent tool's accepted values, `opus` = Opus 5 and its version floor, `fable` = Fable 5.1 and its consent hazard, the conveyor's `gate_status:` PR trailer vs GSD's `gate-status:` commit trailer.
- [ ] **REQ-29**: One ownership matcher decides Gate 2 overlap, the scope gate and base-merge conflict resolution; ambiguous declarations are rejected and an uncertain owner never authorizes a mechanical resolution.
- [ ] **REQ-30**: A corrupt configuration permits no mutation: merge, duty, escalation and retarget refuse on an unparseable config and name the file.
- [ ] **REQ-31**: Readiness needs positive evidence: an epic comparison that failed is `unknown`, not `landed`; availability and path reachability are checked in both integration modes.
- [ ] **REQ-32**: Worktree gc removes only a worktree PROVEN landed by delivery state; a clean local-only branch is reported and kept.
- [ ] **REQ-33**: A lock is released only by its owner and taken over atomically; a delivery-state snapshot is never overwritten by an older observation.
- [ ] **REQ-34**: The Codex config merge produces valid TOML for every valid input, detecting headers by grammar and re-parsing before it replaces the file.
- [ ] **REQ-35**: GSD tuning merges the delivery-rules skill into `agent_skills` and preserves every foreign entry; a missing `~/.gsd/` is created.
- [ ] **REQ-36**: Jira idempotency keys are namespaced by repository so two repositories exporting the same ticket id never select one issue.
- [ ] **REQ-37**: Workflow scripts validate `args` before dispatching: malformed input throws, an empty list returns empty, every ticket yields one result.
- [ ] **REQ-38**: "Left behind" is decided by the ticket's own phase having landed without it, never by phase-number arithmetic.
- [ ] **REQ-39**: An unavailable check reading (gh error, malformed JSON) is a state of its own, distinct from an observed empty list, and never green.
- [x] **REQ-40**: No role that writes code or renders a judgement is dispatched below `opus`; `pr-sentinel` and `drift-check` stay on `sonnet` because neither's answer is the gate, and no built-in path reaches `haiku`. Depth is expressed by EFFORT keyed on the role and its signals, not on the tier; a configured effort override must not silently disable the signature escalation it outranks; and **every signal a row is keyed on is passed by the dispatch, with an absent signal never resolving upward.** *(Amended 2026-09-08: the universal floor is retired for those two roles, and effort is chosen for the work rather than for the price — output is 12–19% of a model line, so an effort step moves ~3% of a run against ~2.5× for a tier step. ADR-005 D2.)*
- [x] **REQ-41**: `fable` is a ceiling the conveyor reaches mechanically (window pressure, exhausted repair depth, contested judgment) and never by default, the integrator included; it is never emitted where the runtime would resolve it to Fable 5. *(Amended 2026-09-08: the integrator's standing exception is withdrawn — its measured run was 291k tokens against a 1M window at 2× the price, so it earns `fable` through the window route like every other role.)*
- [x] **REQ-45**: Every dispatch records the model and the effort it ran at, so the ladder can be revised on evidence instead of judgement.
- [x] **REQ-42**: A wave is cut to a concurrency the session can afford: the front reports capacity, the loop dispatches no more than that, and a front held back by the cap is never a fixpoint.
- [ ] **REQ-43**: Whether a ticket needs a drift check is COMPUTED against the base the ticket is cut from, not judged against the integration branch.
- [ ] **REQ-44**: A workflow returns a reference to a document, not the document: what the orchestrator forwards but never reads must not enter its context.
- [ ] **REQ-46**: The concurrency cap counts AGENTS, and the three mechanisms that read capacity give one answer: a capacity-full board must not have the front, `ci-wait` and the stop gate ordering three incompatible things at once.
- [ ] **REQ-47**: An architecture verdict survives a head move it provably covers — equal head trees AND equal base trees — and the trailer records the base it judged, as a tree sha rather than a branch name.
- [ ] **REQ-48**: A child's PR base is chosen for where the merge LANDS, and after any ticket merge the ticket's own declared files are asserted reachable from its epic.
- [ ] **REQ-49**: An epic learns what landed under it, and a worktree is cut from the base the board named: `origin/<base>` is measured, a reused branch reports its distance, and a bare epic name never resolves to a stale local ref.
- [ ] **REQ-50**: The journal records what was APPLIED, not what was intended: the `dispatch` event has one writer, `--reason` comes from the resolver, and one sha format throughout.
- [ ] **REQ-51**: The front says when it is behind the world, and one dispatch carries one base: a mixed-base cascade round is never judged against a single `baseRef`.
- [ ] **REQ-52**: A guard asserts a SWEEP rather than a list of known homes, fails on more than one match per file, and every wiring line the board depends on is asserted by something.
- [ ] **REQ-53**: No reader takes defaults from a config that does not parse, the shared numeric rule rejects a non-integer, and no ADR asserts what a later amendment retired.
- [ ] **REQ-54**: The concurrency cap counts DISTINCT agents: two live guards are two, one guard over many PRs is one, and time of dispatch is not an identity.
- [ ] **REQ-55**: A signature's history is a set with adjacency, not a count, so `repeat` is reachable whenever the same failure recurs at a moved head; and `repeat_exhausted` means the depth was APPLIED, not merely decided.
- [ ] **REQ-56**: Judgment follows one procedure — measure, resolve, dispatch, record — on the background path and the inline one alike, asserted by a contract test over both entry points.
- [ ] **REQ-57**: A model floor is measured against what is EFFECTIVE: after the last remap, against the agent files actually registered, and including an explicit environment pin.
- [ ] **REQ-58**: An installer owns what it wrote: an old manifest reconciled against the new one, only its own files removed, proven by a two-stage smoke.
- [ ] **REQ-59**: Every reader has a writer or a recorded decision, and a mechanism shipped with no caller is a finding rather than a surprise.
- [ ] **REQ-60**: "Is this worktree dirty" asks about TRACKED content, and a declared path that cannot exist is warned about at decomposition time.
- [ ] **REQ-61**: A clean exit is not evidence of a coherent result: a merge that duplicated a definition is caught, and a metric never credits one actor's act to another.
- [x] **REQ-62**: The tracker projection is driven off the OWNED journal, not off live state, and a watermark makes each status change reach the tracker exactly once and only ever forwards.
- [x] **REQ-63**: The status map names the tracker's TARGET STATUS, never a transition name, and it is a declared knob whose empty default means the projection is off.
- [x] **REQ-64**: Deciding what to project is a pure function of three local files: no network, no credential, no stub.
- [x] **REQ-65**: A transition is performed by ID, and a target the workflow cannot reach from the current status is a report naming what WAS offered — never an error and never a block.
- [x] **REQ-66**: The watermark advances only on evidence: a record that cannot name the transition id it used is refused, and the journal event is owned.
- [x] **REQ-67**: The projection is outside the tick rate and invisible to the stop gate: a pending one is neither actionable nor a reason to block.
- [x] **REQ-68**: A mechanism this repository cannot exercise says so: CI proves the planner, the refusal, the wiring and the negative pin, and the witnessed mutation is owed by the proving ground.
- [ ] **REQ-69**: Only the `execute` transition is gated, so "worked on" means by someone outside this conveyor and a resumed run can always continue its own ticket.
- [ ] **REQ-70**: An externally prepared ticket is not deliverable: it enters through investigate from a cold start, and the import shortcut that manufactured a plan from a tracker description is gone.
- [ ] **REQ-71**: "To Do" is a declared knob whose empty default means the gate is off, matched on the tracker's own status name.
- [ ] **REQ-72**: "Not worked on" is status plus assignee from the default response, never the changelog, which cannot be paged and reports a truncated history as complete.
- [ ] **REQ-73**: The selection gate fails CLOSED: an unreadable tracker parks the ticket rather than authorising it, and the park carries the tracker's own words.
- [ ] **REQ-74**: A direct instruction is the ticket NAMED, never a set, and the bypass is journalled so an overridden rule can be told from one that never fired.
- [ ] **REQ-75**: The read cache is its own store with its own expiry, never merged with the projection watermark that expires by a different rule.
- [ ] **REQ-76**: A repository is RESOLVED in order: configured, then discovered, then asked for — cloning is the last resort, never the first move.
- [ ] **REQ-77**: Discovery matches on the remote origin, never on a directory name, over declared roots only, and reports ambiguity instead of picking.
- [ ] **REQ-78**: A clone happens only when a person answers; an unattended run parks the repo rather than writing into somebody's filesystem.
- [ ] **REQ-79**: The clone destination obeys the same nesting rule the config validator already enforces, checked against the resolved path.
- [ ] **REQ-80**: The clone protocol mirrors the PROJECT's origin, not the `gh` CLI's configured preference.
- [ ] **REQ-81**: The clone is full: no depth, no single-branch, because base resolution needs `refs/remotes/origin/<base>` and falls back silently.
- [ ] **REQ-82**: Resolution is idempotent and refuses rather than clobbers: a path whose origin does not match is a refusal, never an overwrite.
- [ ] **REQ-83**: A resolved checkout is written back to config so nobody is asked twice, and any failure parks the ticket without stopping the board.
- [ ] **REQ-84**: *Cross-cutting, and it belongs to ADR-006's 2026-09-10 amendment rather than to ADR-010:* where a claim can be checked, it is checked and the command is named — carried into every file an agent reads, into the Workflow prompt builders that bypass those files, asserted by a sweep, and refusable by arch-review.
- [x] **REQ-85**: Usage is deduplicated by provider, attributed with coverage, and separated from observed subscription windows; missing counters are unknown.
- [x] **REQ-86**: Backlog items are discoverable across local notes and GSD 999.x, with stable identities and evidence-backed lifecycle transitions.
- [x] **REQ-87**: All eight roles reconcile requested routing with launch and runtime evidence, distinguishing unsupported capability from missing proof.
- [x] **REQ-88**: Expected reviewers are explicit; disabling one does not disable another or turn unavailable review into completed review.
- [x] **REQ-89**: Advisor usage and effective policy are visible separately, and a trial cannot silently alter global host settings.
- [ ] **REQ-90**: Unchanged observations do not require repeated model turns; deterministic waiting remains bounded, recoverable and subordinate to live gates.
- [ ] **REQ-91**: Role boundaries return bounded summaries and complete referenced evidence; selected backlog and required policy remain available.
- [ ] **REQ-92**: Context rotation transfers durable state with one acknowledged owner, only at a safe boundary and on a supported runtime.
- [ ] **REQ-93**: Review progress has evidence and signatures; resource budgets do not replace the retry backstop or fabricate a plan defect.
- [ ] **REQ-94**: Model-axis escalation requires verified capability and a completed attempt; unknown effort never becomes applied depth, and role floors persist.
- [ ] **REQ-95**: A manual-merge verdict carry proves ancestry, head tree, base tree and current PR identity; missing proof requires fresh review.
- [ ] **REQ-96**: Participating projects count distinct nested agents through owned leases, report coverage, and never interpret store failure as unlimited capacity.
- [ ] **REQ-97**: Each optimization has a versioned baseline, quality and recovery gates, rollback, and a report that feeds evidence into the next backlog decision.
- [x] **REQ-98**: Shipyard publishes one deterministic native-GSD projection from the validated plan and delivery graph; no second execution authority is hand-maintained.
- [x] **REQ-99**: The projection materializes the canonical STATE, REQUIREMENTS, plan summary, UAT, and verification artifacts with explicit ownership and source fingerprints.
- [x] **REQ-100**: A plan or phase is marked complete only from positive delivery, integration, and verification evidence; missing evidence remains visible and non-green.
- [x] **REQ-101**: Planning, delivery, verification, and ship boundaries run a blocking synchronization/check gate for Shipyard projects and remain inert for ordinary GSD projects.
- [x] **REQ-102**: Synchronization is local-only, atomic, idempotent, and checkable without mutation, with deterministic refusal on conflicting files or ambiguous plan/ticket identity.
- [x] **REQ-103**: Claude and Codex consume the same canonical synchronizer through generated/bundled installer surfaces, with smoke coverage for both. *ADR-011 was accepted for implementation on 2026-09-10. T-32-01/02 are the initial isolated tooling slice; subsequent packages remain subject to decomposition and rollout gates. Existing model floors remain unchanged.*

## Out of Scope

| Feature | Reason |
|---|---|
| External tracker or GitHub mutation | The projection is local-only. |
| Historical evidence fabrication | Missing or failed integration remains visible. |

## Traceability

| Requirement | Phase | Status |
|---|---|---|
| REQ-01 | Phase 20 | In Progress |
| REQ-02 | Phase 20 | In Progress |
| REQ-03 | Phase 20 | In Progress |
| REQ-04 | Phase 20 | In Progress |
| REQ-05 | Phase 20 | In Progress |
| REQ-06 | Phase 21 | In Progress |
| REQ-07 | Phase 21 | In Progress |
| REQ-08 | Phase 22 | In Progress |
| REQ-09 | Phase 22 | In Progress |
| REQ-10 | Phase 22 | In Progress |
| REQ-11 | Phase 22 | In Progress |
| REQ-12 | Phase 22 | In Progress |
| REQ-13 | Phase 23 | In Progress |
| REQ-14 | Phase 23 | In Progress |
| REQ-15 | Phase 24 | Blocked |
| REQ-16 | Phase 24 | Blocked |
| REQ-17 | Phase 24 | Blocked |
| REQ-18 | Phase 24 | Blocked |
| REQ-19 | Phase 24 | Blocked |
| REQ-20 | Phase 24 | Blocked |
| REQ-21 | Phase 24 | Blocked |
| REQ-22 | Phase 24 | Blocked |
| REQ-23 | Phase 24 | Blocked |
| REQ-24 | Phase 24 | Blocked |
| REQ-25 | Phase 24 | Blocked |
| REQ-26 | Phase 25 | Complete |
| REQ-27 | Phase 25 | Complete |
| REQ-28 | Phase 25 | Complete |
| REQ-29 | Phase 26 | Blocked |
| REQ-30 | Phase 26 | Blocked |
| REQ-31 | Phase 26 | Blocked |
| REQ-32 | Phase 26 | Blocked |
| REQ-33 | Phase 26 | Blocked |
| REQ-34 | Phase 26 | Blocked |
| REQ-35 | Phase 26 | Blocked |
| REQ-36 | Phase 26 | Blocked |
| REQ-37 | Phase 26 | Blocked |
| REQ-38 | Phase 26 | Blocked |
| REQ-39 | Phase 26 | Blocked |
| REQ-40 | Phase 25 | Complete |
| REQ-41 | Phase 25 | Complete |
| REQ-45 | Phase 25 | Complete |
| REQ-42 | Phase 25 | Complete |
| REQ-43 | Unmapped | Pending |
| REQ-44 | Unmapped | Pending |
| REQ-46 | Phase 27 | Blocked |
| REQ-47 | Phase 27 | Blocked |
| REQ-48 | Phase 27 | Blocked |
| REQ-49 | Phase 27 | Blocked |
| REQ-50 | Phase 27 | Blocked |
| REQ-51 | Phase 27 | Blocked |
| REQ-52 | Phase 27 | Blocked |
| REQ-53 | Phase 27 | Blocked |
| REQ-54 | Phase 28 | Blocked |
| REQ-55 | Phase 28 | Blocked |
| REQ-56 | Phase 28 | Blocked |
| REQ-57 | Phase 28 | Blocked |
| REQ-58 | Phase 28 | Blocked |
| REQ-59 | Phase 28 | Blocked |
| REQ-60 | Phase 28 | Blocked |
| REQ-61 | Phase 28 | Blocked |
| REQ-62 | Phase 29 | Complete |
| REQ-63 | Phase 29 | Complete |
| REQ-64 | Phase 29 | Complete |
| REQ-65 | Phase 29 | Complete |
| REQ-66 | Phase 29 | Complete |
| REQ-67 | Phase 29 | Complete |
| REQ-68 | Phase 29 | Complete |
| REQ-69 | Phase 31 | In Progress |
| REQ-70 | Phase 31 | In Progress |
| REQ-71 | Phase 31 | In Progress |
| REQ-72 | Phase 31 | In Progress |
| REQ-73 | Phase 31 | In Progress |
| REQ-74 | Phase 31 | In Progress |
| REQ-75 | Phase 31 | In Progress |
| REQ-76 | Phase 30 | In Progress |
| REQ-77 | Phase 30 | In Progress |
| REQ-78 | Phase 30 | In Progress |
| REQ-79 | Phase 30 | In Progress |
| REQ-80 | Phase 30 | In Progress |
| REQ-81 | Phase 30 | In Progress |
| REQ-82 | Phase 30 | In Progress |
| REQ-83 | Phase 30 | In Progress |
| REQ-84 | Phase 30 | In Progress |
| REQ-85 | Phase 32 | Complete |
| REQ-86 | Phase 32 | Complete |
| REQ-87 | Phase 32 | Complete |
| REQ-88 | Phase 32 | Complete |
| REQ-89 | Phase 32 | Complete |
| REQ-90 | Phase 33 | In Progress |
| REQ-91 | Phase 33 | In Progress |
| REQ-92 | Phase 33 | In Progress |
| REQ-93 | Phase 34 | In Progress |
| REQ-94 | Phase 34 | In Progress |
| REQ-95 | Phase 34 | In Progress |
| REQ-96 | Phase 34 | In Progress |
| REQ-97 | Phase 34 | In Progress |
| REQ-98 | Phase 35 | Complete |
| REQ-99 | Phase 35 | Complete |
| REQ-100 | Phase 35 | Complete |
| REQ-101 | Phase 35 | Complete |
| REQ-102 | Phase 35 | Complete |
| REQ-103 | Phase 35 | Complete |

**Coverage:**
- v1 requirements: 103 total
- Mapped to phases: 101
- Unmapped: 2 ⚠️

---
*Requirements generated by Shipyard GSD synchronization.*
