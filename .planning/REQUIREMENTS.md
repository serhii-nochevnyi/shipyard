# Requirements: shipyard

<!-- shipyard:gsd-sync generated; sync-version: 1; source fingerprint: cc55f13c005382f4df7a840edfb39cf413e43136be8fa460879a71b3e2812bec -->

**Defined:** 2026-09-10
**Core Value:** Keep delivery decisions truthful, resumable, and synchronized between the

## v1 Requirements

### Delivery and workflow integrity
- [ ] **REQ-01**: A failure is identified by a normalized SIGNATURE (error class +
- [ ] **REQ-02**: A ticket has a third terminal outcome besides green and
- [ ] **REQ-03**: A job that fails intermittently on an unchanged tree is a FLAKE:
- [ ] **REQ-04**: The actionable front is ORDERED by unblocking power (descendants
- [ ] **REQ-05**: A fixer receives the prior attempts for its ticket (signature,
- [ ] **REQ-06**: Risk classes are pre-authorized at decomposition time, so a
- [ ] **REQ-07**: Degenerate green is detected on the diff (weakened assertion,
- [ ] **REQ-08**: A park is described to the human by the STORE that owns it, so a
- [ ] **REQ-09**: A guard that rejects an unusable value checks the VALUE, not the
- [ ] **REQ-10**: Every script sharing the `--graph` spelling shares its parsing,
- [ ] **REQ-11**: A lock is held from the instant it exists, so a writer still
- [ ] **REQ-12**: A test that cannot fail is a defect: the harness must fail an
- [ ] **REQ-13**: A ticket handed to an agent is VISIBLE as dispatched: the front
- [ ] **REQ-14**: The backlog states what is true now. An entry describing a defect
- [ ] **REQ-15**: A dispatch or escalation record is lifted only by a fact its
- [ ] **REQ-16**: The stop gate blocks every stop a cascade needs (one per round,
- [ ] **REQ-17**: Check state has ONE vocabulary, read from gh's own `bucket`;
- [ ] **REQ-18**: Every wait the guard imposes is a bucket the front reports and an
- [ ] **REQ-19**: A gate verdict is bound to the head it judged; a trailer for a
- [ ] **REQ-20**: Merge verifies what the cache cannot know: no reported checks is
- [ ] **REQ-21**: Review feedback is the CURRENT state (comments since the last
- [ ] **REQ-22**: `plan_defect` requires K distinct signatures with no green between
- [ ] **REQ-23**: The CI waiter distinguishes a stalled pipeline from an unreachable
- [ ] **REQ-24**: Prose names only what the scripts implement: no instruction
- [ ] **REQ-25**: Every writer of `delivery-front.json` writes the SAME front: a
- [ ] **REQ-26**: The image and the smokes pin the runtimes the conveyor is
- [ ] **REQ-27**: A Codex agent carries EFFORT, not a model baked from a catalog
- [ ] **REQ-28**: Prose names the runtimes as they are: the Agent tool's accepted
- [x] **REQ-29**: One ownership matcher decides Gate 2 overlap, the scope gate and
- [x] **REQ-30**: A corrupt configuration permits no mutation: merge, duty,
- [x] **REQ-31**: Readiness needs positive evidence: an epic comparison that failed
- [x] **REQ-32**: Worktree gc removes only a worktree PROVEN landed by delivery
- [x] **REQ-33**: A lock is released only by its owner and taken over atomically;
- [x] **REQ-34**: The Codex config merge produces valid TOML for every valid input,
- [x] **REQ-35**: GSD tuning merges the delivery-rules skill into `agent_skills`
- [x] **REQ-36**: Jira idempotency keys are namespaced by repository so two
- [x] **REQ-37**: Workflow scripts validate `args` before dispatching: malformed
- [x] **REQ-38**: "Left behind" is decided by the ticket's own phase having landed
- [x] **REQ-39**: An unavailable check reading (gh error, malformed JSON) is a
- [ ] **REQ-40**: No role that writes code or renders a judgement is dispatched
- [ ] **REQ-41**: `fable` is a ceiling the conveyor reaches mechanically (window
- [ ] **REQ-45**: Every dispatch records the model and the effort it ran at, so
- [ ] **REQ-42**: A wave is cut to a concurrency the session can afford: the front
- [ ] **REQ-43**: Whether a ticket needs a drift check is COMPUTED against the base
- [ ] **REQ-44**: A workflow returns a reference to a document, not the document:
- [ ] **REQ-46**: The concurrency cap counts AGENTS, and the three mechanisms that
- [ ] **REQ-47**: An architecture verdict survives a head move it provably covers —
- [ ] **REQ-48**: A child's PR base is chosen for where the merge LANDS, and after
- [ ] **REQ-49**: An epic learns what landed under it, and a worktree is cut from
- [ ] **REQ-50**: The journal records what was APPLIED, not what was intended: the
- [ ] **REQ-51**: The front says when it is behind the world, and one dispatch
- [ ] **REQ-52**: A guard asserts a SWEEP rather than a list of known homes, fails
- [ ] **REQ-53**: No reader takes defaults from a config that does not parse, the
- [ ] **REQ-54**: The concurrency cap counts DISTINCT agents: two live guards are
- [ ] **REQ-55**: A signature's history is a set with adjacency, not a count, so
- [ ] **REQ-56**: Judgment follows one procedure — measure, resolve, dispatch,
- [ ] **REQ-57**: A model floor is measured against what is EFFECTIVE: after the
- [ ] **REQ-58**: An installer owns what it wrote: an old manifest reconciled
- [ ] **REQ-59**: Every reader has a writer or a recorded decision, and a mechanism
- [ ] **REQ-60**: "Is this worktree dirty" asks about TRACKED content, and a
- [ ] **REQ-61**: A clean exit is not evidence of a coherent result: a merge that
- [ ] **REQ-62**: The tracker projection is driven off the OWNED journal, not off
- [ ] **REQ-63**: The status map names the tracker's TARGET STATUS, never a
- [ ] **REQ-64**: Deciding what to project is a pure function of three local files:
- [ ] **REQ-65**: A transition is performed by ID, and a target the workflow cannot
- [ ] **REQ-66**: The watermark advances only on evidence: a record that cannot
- [ ] **REQ-67**: The projection is outside the tick rate and invisible to the stop
- [ ] **REQ-68**: A mechanism this repository cannot exercise says so: CI proves the
- [ ] **REQ-69**: Only the `execute` transition is gated, so "worked on" means by
- [ ] **REQ-70**: An externally prepared ticket is not deliverable: it enters
- [ ] **REQ-71**: "To Do" is a declared knob whose empty default means the gate is
- [ ] **REQ-72**: "Not worked on" is status plus assignee from the default
- [ ] **REQ-73**: The selection gate fails CLOSED: an unreadable tracker parks the
- [ ] **REQ-74**: A direct instruction is the ticket NAMED, never a set, and the
- [ ] **REQ-75**: The read cache is its own store with its own expiry, never merged
- [ ] **REQ-76**: A repository is RESOLVED in order: configured, then discovered,
- [ ] **REQ-77**: Discovery matches on the remote origin, never on a directory
- [ ] **REQ-78**: A clone happens only when a person answers; an unattended run
- [ ] **REQ-79**: The clone destination obeys the same nesting rule the config
- [ ] **REQ-80**: The clone protocol mirrors the PROJECT's origin, not the `gh`
- [ ] **REQ-81**: The clone is full: no depth, no single-branch, because base
- [ ] **REQ-82**: Resolution is idempotent and refuses rather than clobbers: a
- [ ] **REQ-83**: A resolved checkout is written back to config so nobody is asked
- [ ] **REQ-84**: *Cross-cutting, and it belongs to ADR-006's 2026-09-10 amendment
- [ ] **REQ-85**: Usage is deduplicated by provider, attributed with coverage, and
- [ ] **REQ-86**: Backlog items are discoverable across local notes and GSD 999.x,
- [ ] **REQ-87**: All eight roles reconcile requested routing with launch and runtime
- [ ] **REQ-88**: Expected reviewers are explicit; disabling one does not disable
- [ ] **REQ-89**: Advisor usage and effective policy are visible separately, and a
- [ ] **REQ-90**: Unchanged observations do not require repeated model turns;
- [ ] **REQ-91**: Role boundaries return bounded summaries and complete referenced
- [ ] **REQ-92**: Context rotation transfers durable state with one acknowledged
- [ ] **REQ-93**: Review progress has evidence and signatures; resource budgets do
- [ ] **REQ-94**: Model-axis escalation requires verified capability and a completed
- [ ] **REQ-95**: A manual-merge verdict carry proves ancestry, head tree, base tree
- [ ] **REQ-96**: Participating projects count distinct nested agents through owned
- [ ] **REQ-97**: Each optimization has a versioned baseline, quality and recovery
- [ ] **REQ-98**: Shipyard publishes one deterministic native-GSD projection from
- [ ] **REQ-99**: The projection materializes the canonical STATE, REQUIREMENTS,
- [ ] **REQ-100**: A plan or phase is marked complete only from positive delivery,
- [ ] **REQ-101**: Planning, delivery, verification, and ship boundaries run a
- [ ] **REQ-102**: Synchronization is local-only, atomic, idempotent, and
- [ ] **REQ-103**: Claude and Codex consume the same canonical synchronizer through

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
| REQ-26 | Phase 25 | Blocked |
| REQ-27 | Phase 25 | Blocked |
| REQ-28 | Phase 25 | Blocked |
| REQ-29 | Phase 26 | Complete |
| REQ-30 | Phase 26 | Complete |
| REQ-31 | Phase 26 | Complete |
| REQ-32 | Phase 26 | Complete |
| REQ-33 | Phase 26 | Complete |
| REQ-34 | Phase 26 | Complete |
| REQ-35 | Phase 26 | Complete |
| REQ-36 | Phase 26 | Complete |
| REQ-37 | Phase 26 | Complete |
| REQ-38 | Phase 26 | Complete |
| REQ-39 | Phase 26 | Complete |
| REQ-40 | Phase 25 | Blocked |
| REQ-41 | Phase 25 | Blocked |
| REQ-45 | Phase 25 | Blocked |
| REQ-42 | Phase 25 | Blocked |
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
| REQ-62 | Phase 29 | In Progress |
| REQ-63 | Phase 29 | In Progress |
| REQ-64 | Phase 29 | In Progress |
| REQ-65 | Phase 29 | In Progress |
| REQ-66 | Phase 29 | In Progress |
| REQ-67 | Phase 29 | In Progress |
| REQ-68 | Phase 29 | In Progress |
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
| REQ-85 | Phase 32 | In Progress |
| REQ-86 | Phase 32 | In Progress |
| REQ-87 | Phase 32 | In Progress |
| REQ-88 | Phase 32 | In Progress |
| REQ-89 | Phase 32 | In Progress |
| REQ-90 | Phase 33 | In Progress |
| REQ-91 | Phase 33 | In Progress |
| REQ-92 | Phase 33 | In Progress |
| REQ-93 | Phase 34 | In Progress |
| REQ-94 | Phase 34 | In Progress |
| REQ-95 | Phase 34 | In Progress |
| REQ-96 | Phase 34 | In Progress |
| REQ-97 | Phase 34 | In Progress |
| REQ-98 | Phase 35 | In Progress |
| REQ-99 | Phase 35 | In Progress |
| REQ-100 | Phase 35 | In Progress |
| REQ-101 | Phase 35 | In Progress |
| REQ-102 | Phase 35 | In Progress |
| REQ-103 | Phase 35 | In Progress |

**Coverage:**
- v1 requirements: 103 total
- Mapped to phases: 101
- Unmapped: 2 ⚠️

---
*Requirements generated by Shipyard GSD synchronization.*
