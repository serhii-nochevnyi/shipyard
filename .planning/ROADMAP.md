# Roadmap: shipyard

## Overview

The conveyor reaches green reliably. What it does not yet do is survive a night
unattended: a run either stops for a person or spends its budget repeating the
same wrong fix. This milestone closes that gap, in the order that buys the most
safety first.

The programme behind it is one rule, stated in two places: **a decision that can
differ between runtimes, or that decides whether work continues, belongs in a
script — not in a prompt.** Every requirement below is an instance of it.

## Requirements

- **REQ-01** — A failure is identified by a normalized SIGNATURE (error class +
  test/job id + file), not by an attempt counter, so the policy can tell progress
  from repetition.
- **REQ-02** — A ticket has a third terminal outcome besides green and
  human: `plan_defect`, reached mechanically from K distinct signatures without
  progress. It blocks the ticket and lets the cascade continue.
- **REQ-03** — A job that fails intermittently on an unchanged tree is a FLAKE:
  quarantined, and its attempts are not charged against the budget.
- **REQ-04** — The actionable front is ORDERED by unblocking power (descendants
  in the DAG) and CI length, so an unattended run does not narrow to one item.
- **REQ-05** — A fixer receives the prior attempts for its ticket (signature,
  hypothesis, outcome) as INPUT, so a fresh subagent cannot re-propose a fix that
  already failed, without polluting its context.
- **REQ-06** — Risk classes are pre-authorized at decomposition time, so a
  runtime interruption at 3am becomes a design-time decision. Anything not
  pre-authorized is deferred to the morning front rather than blocking.
- **REQ-07** — Degenerate green is detected on the diff (weakened assertion,
  skip, rewritten snapshot, raised timeout, `any`/`@ts-ignore`, swallowed catch,
  narrowed matcher) and REPORTED as a `gate_status:` trailer. Reporting first,
  blocking only once field data shows the false-positive rate.

- **REQ-08** — A park is described to the human by the STORE that owns it, so a
  new park kind cannot be rendered with another kind's lifting rule.
- **REQ-09** — A guard that rejects an unusable value checks the VALUE, not the
  shape of the argument list around it.
- **REQ-10** — Every script sharing the `--graph` spelling shares its parsing,
  including the refusal to swallow a following flag as the value.
- **REQ-11** — A lock is held from the instant it exists, so a writer still
  announcing itself is never mistaken for a dead one.
- **REQ-12** — A test that cannot fail is a defect: the harness must fail an
  asynchronous test that throws, rather than reporting it green.

- **REQ-13** — A ticket handed to an agent is VISIBLE as dispatched: the front
  reports it as waiting rather than offering it again, and the record expires by
  itself so a killed run cannot hide work from the next one.
- **REQ-14** — The backlog states what is true now. An entry describing a defect
  that has since been fixed is the same class of error the programme exists to
  remove: prose asserting a state the code does not have.

- **REQ-15** — A dispatch or escalation record is lifted only by a fact its
  OWNER moves: a guard's output for a dispatch, a human's fields for a park —
  never by CI tallies.
- **REQ-16** — The stop gate blocks every stop a cascade needs (one per round,
  under a cap), and never blocks a session for a run that has ended or for a
  dispatch that outlived a plausible launch.
- **REQ-17** — Check state has ONE vocabulary, read from gh's own `bucket`;
  anything unclassified is pending, never green.
- **REQ-18** — Every wait the guard imposes is a bucket the front reports and an
  owner the loop can dispatch: `waiting.parent` exists, and a moved base is a
  `base-merge` duty with a workflow flag.
- **REQ-19** — A gate verdict is bound to the head it judged; a trailer for a
  head that is no longer the PR's is absent for duty, merge and front alike.
- **REQ-20** — Merge verifies what the cache cannot know: no reported checks is
  not green, the merged head is pinned, the stack is the phase's own, children
  are retargeted from live PR data.
- **REQ-21** — Review feedback is the CURRENT state (comments since the last
  push, last verdict per reviewer), and `CHANGES_REQUESTED` with nothing to
  resolve belongs to a person, not to a fixer.
- **REQ-22** — `plan_defect` requires K distinct signatures with no green between
  them, `unknown` never counts, and the attempt counter survives the session.
- **REQ-23** — The CI waiter distinguishes a stalled pipeline from an unreachable
  `gh`, clears only the settled ticket's record, and sizes its window from the
  observed CI.
- **REQ-24** — Prose names only what the scripts implement: no instruction
  sanctions a wait, a bucket or an order of operations the code does not have.
- **REQ-25** — Every writer of `delivery-front.json` writes the SAME front: a
  resync must carry the dispatch overlay, so the board and the stop gate never
  read work in flight as actionable between one `mark` and the next.

- **REQ-26** — The image and the smokes pin the runtimes the conveyor is
  tested on: Claude Code with Fable 5.1/Opus 5 aliases, gsd-core 1.13.0.
- **REQ-27** — A Codex agent carries EFFORT, not a model baked from a catalog
  that can be stale; a `model =` line appears only when the user's GSD remap
  names one, resolved through GSD's resolver.
- **REQ-28** — Prose names the runtimes as they are: the Agent tool's accepted
  values, `opus` = Opus 5 and its version floor, `fable` = Fable 5.1 and its
  consent hazard, the conveyor's `gate_status:` PR trailer vs GSD's
  `gate-status:` commit trailer.
- **REQ-29** — One ownership matcher decides Gate 2 overlap, the scope gate and
  base-merge conflict resolution; ambiguous declarations are rejected and an
  uncertain owner never authorizes a mechanical resolution.
- **REQ-30** — A corrupt configuration permits no mutation: merge, duty,
  escalation and retarget refuse on an unparseable config and name the file.
- **REQ-31** — Readiness needs positive evidence: an epic comparison that failed
  is `unknown`, not `landed`; availability and path reachability are checked in
  both integration modes.
- **REQ-32** — Worktree gc removes only a worktree PROVEN landed by delivery
  state; a clean local-only branch is reported and kept.
- **REQ-33** — A lock is released only by its owner and taken over atomically;
  a delivery-state snapshot is never overwritten by an older observation.
- **REQ-34** — The Codex config merge produces valid TOML for every valid input,
  detecting headers by grammar and re-parsing before it replaces the file.
- **REQ-35** — GSD tuning merges the delivery-rules skill into `agent_skills`
  and preserves every foreign entry; a missing `~/.gsd/` is created.
- **REQ-36** — Jira idempotency keys are namespaced by repository so two
  repositories exporting the same ticket id never select one issue.
- **REQ-37** — Workflow scripts validate `args` before dispatching: malformed
  input throws, an empty list returns empty, every ticket yields one result.
- **REQ-38** — "Left behind" is decided by the ticket's own phase having landed
  without it, never by phase-number arithmetic.
- **REQ-39** — An unavailable check reading (gh error, malformed JSON) is a
  state of its own, distinct from an observed empty list, and never green.
- **REQ-40** — No role that writes code or renders a judgement is dispatched
  below `opus`; `pr-sentinel` and `drift-check` stay on `sonnet` because
  neither's answer is the gate, and no built-in path reaches `haiku`. Depth is
  expressed by EFFORT keyed on the role and its signals, not on the tier; a
  configured effort override must not silently disable the signature escalation
  it outranks; and **every signal a row is keyed on is passed by the dispatch,
  with an absent signal never resolving upward.** *(Amended 2026-09-08: the
  universal floor is retired for those two roles, and effort is chosen for the
  work rather than for the price — output is 12–19% of a model line, so an
  effort step moves ~3% of a run against ~2.5× for a tier step. ADR-005 D2.)*
- **REQ-41** — `fable` is a ceiling the conveyor reaches mechanically (window
  pressure, exhausted repair depth, contested judgment) and never by default,
  the integrator included; it is never emitted where the runtime would
  resolve it to Fable 5. *(Amended 2026-09-08: the integrator's standing
  exception is withdrawn — its measured run was 291k tokens against a 1M window
  at 2× the price, so it earns `fable` through the window route like every other
  role.)*
- **REQ-45** — Every dispatch records the model and the effort it ran at, so
  the ladder can be revised on evidence instead of judgement.
- **REQ-42** — A wave is cut to a concurrency the session can afford: the front
  reports capacity, the loop dispatches no more than that, and a front held back
  by the cap is never a fixpoint.
- **REQ-43** — Whether a ticket needs a drift check is COMPUTED against the base
  the ticket is cut from, not judged against the integration branch.
- **REQ-44** — A workflow returns a reference to a document, not the document:
  what the orchestrator forwards but never reads must not enter its context.
- **REQ-46** — The concurrency cap counts AGENTS, and the three mechanisms that
  read capacity give one answer: a capacity-full board must not have the front,
  `ci-wait` and the stop gate ordering three incompatible things at once.
- **REQ-47** — An architecture verdict survives a head move it provably covers —
  equal head trees AND equal base trees — and the trailer records the base it
  judged, as a tree sha rather than a branch name.
- **REQ-48** — A child's PR base is chosen for where the merge LANDS, and after
  any ticket merge the ticket's own declared files are asserted reachable from
  its epic.
- **REQ-49** — An epic learns what landed under it, and a worktree is cut from
  the base the board named: `origin/<base>` is measured, a reused branch reports
  its distance, and a bare epic name never resolves to a stale local ref.
- **REQ-50** — The journal records what was APPLIED, not what was intended: the
  `dispatch` event has one writer, `--reason` comes from the resolver, and one
  sha format throughout.
- **REQ-51** — The front says when it is behind the world, and one dispatch
  carries one base: a mixed-base cascade round is never judged against a single
  `baseRef`.
- **REQ-52** — A guard asserts a SWEEP rather than a list of known homes, fails
  on more than one match per file, and every wiring line the board depends on is
  asserted by something.
- **REQ-53** — No reader takes defaults from a config that does not parse, the
  shared numeric rule rejects a non-integer, and no ADR asserts what a later
  amendment retired.

- **REQ-54** — The concurrency cap counts DISTINCT agents: two live guards are
  two, one guard over many PRs is one, and time of dispatch is not an identity.
- **REQ-55** — A signature's history is a set with adjacency, not a count, so
  `repeat` is reachable whenever the same failure recurs at a moved head; and
  `repeat_exhausted` means the depth was APPLIED, not merely decided.
- **REQ-56** — Judgment follows one procedure — measure, resolve, dispatch,
  record — on the background path and the inline one alike, asserted by a
  contract test over both entry points.
- **REQ-57** — A model floor is measured against what is EFFECTIVE: after the
  last remap, against the agent files actually registered, and including an
  explicit environment pin.
- **REQ-58** — An installer owns what it wrote: an old manifest reconciled
  against the new one, only its own files removed, proven by a two-stage smoke.
- **REQ-59** — Every reader has a writer or a recorded decision, and a mechanism
  shipped with no caller is a finding rather than a surprise.
- **REQ-60** — "Is this worktree dirty" asks about TRACKED content, and a
  declared path that cannot exist is warned about at decomposition time.
- **REQ-61** — A clean exit is not evidence of a coherent result: a merge that
  duplicated a definition is caught, and a metric never credits one actor's act
  to another.

- **REQ-62** — The tracker projection is driven off the OWNED journal, not off
  live state, and a watermark makes each status change reach the tracker exactly
  once and only ever forwards.
- **REQ-63** — The status map names the tracker's TARGET STATUS, never a
  transition name, and it is a declared knob whose empty default means the
  projection is off.
- **REQ-64** — Deciding what to project is a pure function of three local files:
  no network, no credential, no stub.
- **REQ-65** — A transition is performed by ID, and a target the workflow cannot
  reach from the current status is a report naming what WAS offered — never an
  error and never a block.
- **REQ-66** — The watermark advances only on evidence: a record that cannot
  name the transition id it used is refused, and the journal event is owned.
- **REQ-67** — The projection is outside the tick rate and invisible to the stop
  gate: a pending one is neither actionable nor a reason to block.
- **REQ-68** — A mechanism this repository cannot exercise says so: CI proves the
  planner, the refusal, the wiring and the negative pin, and the witnessed
  mutation is owed by the proving ground.
- **REQ-69** — Only the `execute` transition is gated, so "worked on" means by
  someone outside this conveyor and a resumed run can always continue its own
  ticket.
- **REQ-70** — An externally prepared ticket is not deliverable: it enters
  through investigate from a cold start, and the import shortcut that
  manufactured a plan from a tracker description is gone.
- **REQ-71** — "To Do" is a declared knob whose empty default means the gate is
  off, matched on the tracker's own status name.
- **REQ-72** — "Not worked on" is status plus assignee from the default
  response, never the changelog, which cannot be paged and reports a truncated
  history as complete.
- **REQ-73** — The selection gate fails CLOSED: an unreadable tracker parks the
  ticket rather than authorising it, and the park carries the tracker's own
  words.
- **REQ-74** — A direct instruction is the ticket NAMED, never a set, and the
  bypass is journalled so an overridden rule can be told from one that never
  fired.
- **REQ-75** — The read cache is its own store with its own expiry, never merged
  with the projection watermark that expires by a different rule.
- **REQ-76** — A repository is RESOLVED in order: configured, then discovered,
  then asked for — cloning is the last resort, never the first move.
- **REQ-77** — Discovery matches on the remote origin, never on a directory
  name, over declared roots only, and reports ambiguity instead of picking.
- **REQ-78** — A clone happens only when a person answers; an unattended run
  parks the repo rather than writing into somebody's filesystem.
- **REQ-79** — The clone destination obeys the same nesting rule the config
  validator already enforces, checked against the resolved path.
- **REQ-80** — The clone protocol mirrors the PROJECT's origin, not the `gh`
  CLI's configured preference.
- **REQ-81** — The clone is full: no depth, no single-branch, because base
  resolution needs `refs/remotes/origin/<base>` and falls back silently.
- **REQ-82** — Resolution is idempotent and refuses rather than clobbers: a
  path whose origin does not match is a refusal, never an overwrite.
- **REQ-83** — A resolved checkout is written back to config so nobody is asked
  twice, and any failure parks the ticket without stopping the board.
- **REQ-84** — *Cross-cutting, and it belongs to ADR-006's 2026-09-10 amendment
  rather than to ADR-010:* where a claim can be checked, it is checked and the
  command is named — carried into every file an agent reads, into the Workflow
  prompt builders that bypass those files, asserted by a sweep, and refusable by
  arch-review.

- **REQ-85** — Usage is deduplicated by provider, attributed with coverage, and
  separated from observed subscription windows; missing counters are unknown.
- **REQ-86** — Backlog items are discoverable across local notes and GSD 999.x,
  with stable identities and evidence-backed lifecycle transitions.
- **REQ-87** — All eight roles reconcile requested routing with launch and runtime
  evidence, distinguishing unsupported capability from missing proof.
- **REQ-88** — Expected reviewers are explicit; disabling one does not disable
  another or turn unavailable review into completed review.
- **REQ-89** — Advisor usage and effective policy are visible separately, and a
  trial cannot silently alter global host settings.
- **REQ-90** — Unchanged observations do not require repeated model turns;
  deterministic waiting remains bounded, recoverable and subordinate to live gates.
- **REQ-91** — Role boundaries return bounded summaries and complete referenced
  evidence; selected backlog and required policy remain available.
- **REQ-92** — Context rotation transfers durable state with one acknowledged
  owner, only at a safe boundary and on a supported runtime.
- **REQ-93** — Review progress has evidence and signatures; resource budgets do
  not replace the retry backstop or fabricate a plan defect.
- **REQ-94** — Model-axis escalation requires verified capability and a completed
  attempt; unknown effort never becomes applied depth, and role floors persist.
- **REQ-95** — A manual-merge verdict carry proves ancestry, head tree, base tree
  and current PR identity; missing proof requires fresh review.
- **REQ-96** — Participating projects count distinct nested agents through owned
  leases, report coverage, and never interpret store failure as unlimited capacity.
- **REQ-97** — Each optimization has a versioned baseline, quality and recovery
  gates, rollback, and a report that feeds evidence into the next backlog decision.
- **REQ-98** — Shipyard publishes one deterministic native-GSD projection from
  the validated plan and delivery graph; no second execution authority is
  hand-maintained.
- **REQ-99** — The projection materializes the canonical STATE, REQUIREMENTS,
  plan summary, UAT, and verification artifacts with explicit ownership and
  source fingerprints.
- **REQ-100** — A plan or phase is marked complete only from positive delivery,
  integration, and verification evidence; missing evidence remains visible and
  non-green.
- **REQ-101** — Planning, delivery, verification, and ship boundaries run a
  blocking synchronization/check gate for Shipyard projects and remain inert
  for ordinary GSD projects.
- **REQ-102** — Synchronization is local-only, atomic, idempotent, and
  checkable without mutation, with deterministic refusal on conflicting files
  or ambiguous plan/ticket identity.
- **REQ-103** — Claude and Codex consume the same canonical synchronizer through
  generated/bundled installer surfaces, with smoke coverage for both.

*ADR-011 was accepted for implementation on 2026-09-10. T-32-01/02 are the
initial isolated tooling slice; subsequent packages remain subject to decomposition
and rollout gates. Existing model floors remain unchanged.*

## Phases

### Phase 20: Autonomy of the drive-to-green loop
**Requirements**: REQ-01, REQ-02, REQ-03, REQ-04, REQ-05

The night-survival core. REQ-01 and REQ-02 are one unit — a signature without a
verdict is telemetry, a verdict without a signature is unreachable. REQ-03 rides
with them because a flake charged as an attempt is the fastest way to burn a
budget on someone else's instability. REQ-04 and REQ-05 are independent and
cheap.

### Phase 21: Verdicts a human would have made anyway
**Requirements**: REQ-06, REQ-07

Deferred deliberately. REQ-07 is the largest value in the programme and the only
item that can be WRONG about correct work, so it ships as a report and earns its
blocking status with evidence. REQ-06 needs phase 20 first: pre-authorization is
only worth having once the night reliably reaches morning.

### Phase 22: Close what phase 20 left open
**Requirements**: REQ-08, REQ-09, REQ-10, REQ-11, REQ-12

Repair debt surfaced BY delivering phase 20 — five defects the run found in
code phase 20 touched or stood next to, all recorded in
`.planning/backlog/phase-20-followups.md` and re-verified against the merged
epic before being planned. Sequenced BEFORE phase 21 despite the higher number:
21 ships a judgement (REQ-07) that must not be built on a harness which cannot
fail a test, nor on a park message that states its own opposite.

Two of the five are worse than they were reported. The renderer contradiction
(REQ-08) is a rule stated backwards to the one person who has to act on it. And
the harness (REQ-12) does not merely have vacuous tests: `test(name, fn)` calls
`fn()` inside a `try`, so ANY asynchronous body reports green before its
assertions run — proven with two async tests asserting `1 === 2`, both of which
print a tick. Today that hides exactly two cases, and both pass once made to run;
the value is closing the class before the next async test is written.

### Phase 23: The board tells the truth about itself
**Requirements**: REQ-13, REQ-14

Housekeeping with one real defect in it. The conveyor's own board has been
lying in two directions, and both were measured rather than suspected.

The front cannot see "dispatched", so it re-offers work already in flight —
five times in a single session, across BOTH owners, every one verified live
before being reported. That is not an occasional annoyance: the documented
protocol says "post the guard and do NOT wait", so the front is wrong by
construction on every healthy run, and the stop gate's blocks stop meaning
anything. A gate whose blocks are usually false gets switched off, which this
repository has done twice already.

The backlog lies the other way: six of its seven phase-20 entries describe
defects that phases 21 and 22 fixed. A reader trusting it would re-do finished
work — and the entry claiming this repository has no CI is now read by a
repository that gained CI two releases ago.

### Phase 24: The conveyor stops interrupting itself
**Requirements**: REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24, REQ-25

Decomposed from ADR-002. Phases 20–23 added the mechanisms a night needs; a
full read of the result found that the interruptions left are mechanisms
DISAGREEING about one fact, or deciding from the wrong datum. Three stores
expire against a hash of the CI tallies, so every finished check lifts a
guard's dispatch and every retarget lifts a human's park (REQ-15). The stop
gate blocks once per turn where a cascade needs once per round, and reads
journal events of any age (REQ-16). The guard says `wait-parent`, the front
says `finalize`, and the waiter refuses to wait (REQ-18). Three hand-written
check-state lists let `ACTION_REQUIRED` and `STARTUP_FAILURE` read as green
(REQ-17), no checks at all is green (REQ-20), and a conform verdict outlives
the diff it judged (REQ-19). `plan_defect` fires on three sequentially FIXED
failures because the "no green" clause exists only in a comment (REQ-22).

Everything crossing `sentinel.cjs`/`front.cjs` lands as one stacked chain —
those two files are the seam every finding touches; the stores, the stop gate
and the CI waiter land beside it. Every ticket carries a unit test that fails
on the current code.

Found while delivering this phase (REQ-25, T-24-11): `state-sync.cjs` writes
`delivery-front.json` WITHOUT the dispatch overlay that `front.cjs` and
`dispatch-record.cjs` apply, so every resync while agents hold tickets turns
the board back into `execute: …, finalize: …` until the next `mark` rewrites it
— measured on the first wave of this very phase, with four tickets out.

### Phase 25: The conveyor follows the models it runs on
**Requirements**: REQ-26, REQ-27, REQ-28, REQ-40, REQ-41, REQ-42, REQ-45

Decomposed from ADR-003. Three things moved under the conveyor within a
fortnight — Claude Code's aliases (Opus 5 at 2.1.219, Fable 5.1 at 2.1.255, the
Agent tool accepting full ids), Codex's `gpt-6-astra`, gsd-core 1.13.0 — and the
repository records none of them: the image pins Claude Code 2.1.200 and
gsd-core 1.7.0, the Codex generator bakes `gpt-5.6-terra` into all seven agents
over the user's newer default, and four documents state a tool constraint that
no longer exists. The pins ticket runs now; the two prose/generator tickets
wait for phase 24's epic, because they edit files phase 24 owns.

T-25-04 was added on 2026-09-07 from ADR-005, after the releases made the
ladder's own justification stale: `fable` was chosen for the judges because
"the 1M window is what distinguishes their work", and Sonnet 5 now has that
window natively while Anthropic positions Fable 5.1 as the step AFTER Opus 5 at
higher effort falls short. The decision taken was to raise the floor to `opus`,
express depth as effort, and make `fable` something the conveyor earns.

### Phase 26: Positive evidence before a mutation
**Requirements**: REQ-29, REQ-30, REQ-31, REQ-32, REQ-33, REQ-34, REQ-35, REQ-36, REQ-37, REQ-38, REQ-39

Decomposed from ADR-004, the external audit of 2026-09-07. Eleven of its
twenty-eight findings were already phase 24's and were folded into its unstarted
tickets; the seventeen left share one shape — a mutation that proceeds on the
ABSENCE of a signal where it needs the PRESENCE of one: a glob stump owning the
wrong files and base-merge overwriting a ticket's own change on that basis, a
corrupt config defaulting to auto-merge, a failed epic comparison reading as
landed, gc deleting a committed-but-unpushed worktree, a stale lock holder
removing its successor's lock, an installer writing invalid TOML, tuning
deleting a project's skills, Jira labels colliding across repositories,
workflow input errors returning an empty success, and "left behind" decided by
phase arithmetic. Six tickets touch nothing phases 24/25 own and run at once;
five wait for phase 24's epic as one chain.

### Phase 27: The conveyor measures its own state
**Requirements**: REQ-46, REQ-47, REQ-48, REQ-49, REQ-50, REQ-51, REQ-52, REQ-53

Decomposed from ADR-006, which extends ADR-004's principle from the work the
conveyor JUDGES to the records it keeps ABOUT ITSELF. Every item was found by
running the conveyor, most of them more than once and several by its own
reviewers correcting the orchestrator: a branch name read instead of a ticket
status, a sha instead of a tree, an intent instead of an application, a count
instead of a set, a list of homes instead of a sweep. Eight tickets, and the
order is load-bearing rather than a preference — T-27-01 first because this
phase's own delivery runs under the cap it fixes, T-27-02 second because every
later ticket pays the re-review cost it removes, T-27-08 last because it sweeps
files the earlier tickets touch. Six of the eight are one chain, and the reason
is Gate 2's contested-path rule rather than a preference: `deliver.md` is touched
by five of them, `front.cjs` by three and `pipeline-config.cjs` by two, while a
cascade gives a child only its PRIMARY parent's work — the diamond-child gap
ADR-006 parks — so a single-parent spine is what keeps the last ticket's base
complete. T-27-02 and T-27-07 share no file with that chain and run as their own
roots beside T-27-01, which puts the phase's largest saving in the first wave.

### Phase 28: A mechanism nobody connected is not a mechanism
**Requirements**: REQ-54, REQ-55, REQ-56, REQ-57, REQ-58, REQ-59, REQ-60, REQ-61

Decomposed from ADR-007, which extends ADR-006 one layer inward: from facts the
conveyor asserts without measuring, to mechanisms it builds and never wires.
Three families. ADR-006's own closing shape returns twice — `repeat` unreachable
when signatures alternate, and two guards counted as one agent, the second
introduced BY phase 27's fix and turning the cap's error direction from
under-dispatch to over-dispatch. Nine readers with no writers, the headline
being phase 27's own D2, which shipped complete and inert because a deferral
addressed to a phase was nobody's `files_modified` line. And the installed Codex
bundle predating three phases entirely, with `AGENT_CARDINALITY` absent from the
`front.cjs` the Codex skill actually executes. Eight tickets: T-28-01 first
because its error direction is over-dispatch and the phase is dispatched under
it, T-28-02 second because it governs how this phase's own repair rounds
escalate; T-28-04 and T-28-05 are one family and gate the bundle regeneration
that follows the phase. Five run as roots — the contested-path rule forces only
two short chains, not phase 27's spine.

### Phase 29: The tracker is a projection, and a projection is driven
**Requirements**: REQ-62, REQ-63, REQ-64, REQ-65, REQ-66, REQ-67, REQ-68

Decomposed from ADR-008, which turns `delivery-rules` §11 from a rule about
DIRECTION into a rule about MAINTENANCE. §11 settled who wins in a disagreement
between Jira and the plans; it never said whether the projection is kept
current, and measured rather than recalled, it is not: zero tracker calls exist
anywhere in `scripts/` or `workflows/`, and the tracker is touched at exactly
one moment — decompose's Step 5 — after which the conveyor never speaks to it
again. So this phase does not fix an oversight; it REVERSES a default that two
files state deliberately, which is why the empty map that means "off" is the
default and why nothing here may block a merge. Everything hard is already
solved: `state-sync` has journalled an owned, append-only `status_change` with
`from`/`to`/`ts` since long before anyone wanted a consumer, and this project
alone holds 205 of them. What is missing is a consumer, a map, and one honest
account of who is allowed to fail. Seven tickets, two roots, depth six. The
spine is forced by data rather than by preference — the planner needs both the
map and the store, and a diamond child would get only its primary parent's work,
which is the gap ADR-006 parks. The two roots are the ones that genuinely owe
nothing: T-29-01, the negative pin, deliberately FIRST so it is already red for
whoever writes the acting half, and T-29-02, the config knob. Then
T-29-03..T-29-05 build one script in three passes (store, planner, recorder),
sharing a file and therefore ordered; T-29-06 is the only checkpoint in the
phase, because it is the first instruction in this repository that tells an
agent to write to an external system; T-29-07 is last because it pins what the
others built. The uncomfortable fact is stated in the ADR rather than discovered
later: `pipeline.jira.enabled: false` here and all 69 tickets carry a null key,
so this repository ships a mechanism it cannot run, and the witnessed mutation
is owed by the proving ground.

### Phase 30: A ticket you cannot reach is not deliverable
**Requirements**: REQ-76, REQ-77, REQ-78, REQ-79, REQ-80, REQ-81, REQ-82, REQ-83, REQ-84

Decomposed from ADR-010. Today a ticket whose files live in a sibling
repository with no configured checkout is a dead end with a good error message:
`state-sync.cjs:1034` says exactly what is missing and the tickets stay
visible, blocked and nobody's. This makes the checkout something the conveyor
RESOLVES rather than a precondition the operator satisfies by hand — but
cloning is the LAST step, not the first. A repository the operator already has
is one with its own branches and stashes; a second copy beside it is two
checkouts that diverge with the work in only one. So the order is configured →
discovered by ORIGIN (never by directory name, over declared roots only) →
asked, with an unattended run taking the parked branch because silence is not
consent to write into somebody's filesystem. Two decisions come from
measurements taken while writing the ADR: the clone protocol follows the
PROJECT's origin rather than the `gh` CLI's preference, because on this very
host they disagree (gh says https, origin is ssh); and the clone is FULL, no
depth and no single-branch, because `graph-dir.cjs:104` resolves every base
through `refs/remotes/origin/<base>` and falls back to the bare name silently —
the false success this repository has already been bitten by. The destination
obeys the nesting rule `pipeline-config.cjs:575-585` already enforces, checked
against the resolved path, because a checkout inside the project takes GSD's
project resolution with it. Eight tickets, plus one that rides at the HEAD of the
phase and belongs to none of ADR-010's decisions: T-30-01 delivers ADR-006's
2026-09-10 amendment — *where a claim can be checked, check it and name what you
ran; a hypothesis is for what cannot be measured yet* — into
`delivery-rules/SKILL.md` as rule zero on both lists, into all seven
`references/*.md`, into the three Workflow prompt builders (which bypass every
skill document, and which need three DIFFERENT edits because only
`executors.mjs` has a `rulesHint` default at all), behind a `source-contract`
sweep so dropping it from one file names that file, and as one new arch-review
criterion: a claim about an existing mechanism with no command named is a
`violation`. It rides here because it is cross-cutting and blocks nothing, and
it is delivered by the conveyor rather than hand-edited because a rule about
verification that arrived unverified would be its own counter-example. Nine
tickets in all; the phase cannot start until phase 29's epic lands, and it
contests less than phase 31 does.

### Phase 31: Not every ticket is available work
**Requirements**: REQ-69, REQ-70, REQ-71, REQ-72, REQ-73, REQ-74, REQ-75

Decomposed from ADR-009, which answers two operator rules that are one subject
from two sides — what evidence entitles a ticket to be taken into work. One is
about who HOLDS it (only To Do and unassigned; anything else by direct
instruction), the other about who DESIGNED it (an externally prepared ticket
goes through investigate from a cold start). Most of the machinery already
exists and was found rather than invented: `front.cjs:761` is the single line
where a ticket is taken into work, the four durable stores are one debugged
park pattern, `status` and `assignee` both arrive free in `getJiraIssue`'s
default field set, and provenance needs no tracker call at all — a ticket is
ours iff a Gate-2-accepted plan stands behind it. So the second rule is not a
missing feature but a shortcut to delete: `deliver.md:810-816` offers to
manufacture a PLAN.md out of a Jira description, deriving `files_modified` and
`depends_on` "from the content" — the two fields every parallel-safety
guarantee in this system is computed from, and the one path by which unexamined
work reaches a worktree. T-30-01 goes FIRST because it closes that hole and
depends on nothing. The gate's failure direction is deliberately the OPPOSITE
of ADR-008's: a tracker error must never block a merge, but it must block a
start, because an unanswered question is not a yes. The phase cannot begin
until phase 29's epic lands — it edits `pipeline-config.cjs`, `front.cjs` and
`deliver.md`, all of which phase 29 tickets own. It also runs AFTER phase 30
rather than before it, and the reason is an argument rather than a preference:
a ticket that passes this eligibility gate but has no local checkout is parked
either way, so the gate cannot be exercised until reachability is solved.


### Phase 32: Measure usage and make the backlog actionable
**Status**: initial tooling slice in progress (ADR-011)
**Requirements**: REQ-85, REQ-86, REQ-87, REQ-88, REQ-89

Waves 0–1 of [ADR-011-ROLLOUT](architecture/ADR-011-ROLLOUT.md): establish a
prospective baseline and current-source backlog inventory, then reconcile actual
routing and make reviewer/advisor policy observable. Preserve existing model
floors. Read-only baseline collection may precede phase 31; shared source edits
follow existing phase ownership and landing. OPT-01–05 are decomposition inputs,
not executable tickets. The phase exits with coverage and unknowns reported,
not with an invented subscription-savings percentage.

### Phase 33: Reduce orchestration context and transfer sessions safely
**Status**: planned (ADR-011)
**Requirements**: REQ-90, REQ-91, REQ-92

Waves 2–3 of [ADR-011-ROLLOUT](architecture/ADR-011-ROLLOUT.md), after phase 32:
OPT-06–08 move unchanged observations into deterministic waiting, extend bounded
artifact outputs and implement recoverable context handoff. Checkpoint/manual
resume precedes automatic rotation. Each treatment is evaluated separately;
Workflow and mandatory quality gates remain. Unsupported automatic transfer
stays in recommendation mode rather than interrupting a live session.

### Phase 34: Improve convergence and tune from measured outcomes
**Status**: planned (ADR-011)
**Requirements**: REQ-93, REQ-94, REQ-95, REQ-96, REQ-97

Waves 4–5 of [ADR-011-ROLLOUT](architecture/ADR-011-ROLLOUT.md), after phase 33:
OPT-09–13 add review-aware progress, evidenced model-axis escalation, verified
manual-merge carry, shared participating-agent admission and experiment reports.
Apply one behavioral treatment at a time and retain failed/interrupted runs in
accounting. Quality regressions roll back the affected treatment and create a
linked backlog item. Model-floor changes require a separate ADR amendment.

### Phase 35: Close the GSD and Shipyard workflow loop
**Status**: planned (ADR-013)
**Requirements**: REQ-98, REQ-99, REQ-100, REQ-101, REQ-102, REQ-103

Shipyard remains the execution authority while publishing a deterministic native
GSD read model. The phase adds the projection generator, evidence-based phase
artifacts, lifecycle gates, cross-runtime packaging, and a reviewed bootstrap of
this repository's missing GSD state. It must not rewrite historical integration
findings or turn a merged ticket count into a false phase pass.

<!-- shipyard:gsd-sync:begin -->
## Shipyard synchronization (generated)

- Source fingerprint: `b6496b0114e7d2ebd6c35c1942f912cc2729ea62eb479e94307fae64fbc0ca0c`
- Plans merged: 81/82
- Phases verified: 3/16
- Current phase: 20

| Phase | Plans | Merged | Verification |
|---|---:|---:|---|
| 20 — Autonomy of the drive-to-green loop | 6 | 6 | pending |
| 21 — Verdicts a human would have made anyway | 5 | 5 | pending |
| 22 — Close what phase 20 left open | 5 | 5 | pending |
| 23 — The board tells the truth about itself | 3 | 3 | pending |
| 24 — The conveyor stops interrupting itself | 11 | 11 | gaps_found |
| 25 — The conveyor follows the models it runs on | 6 | 6 | passed |
| 26 — Positive evidence before a mutation | 15 | 15 | pending |
| 27 — The conveyor measures its own state | 9 | 9 | gaps_found |
| 28 — A mechanism nobody connected is not a mechanism | 9 | 9 | gaps_found |
| 29 — The tracker is a projection, and a projection is driven | 8 | 8 | passed |
| 30 — A ticket you cannot reach is not deliverable | 0 | 0 | pending |
| 31 — Not every ticket is available work | 0 | 0 | pending |
| 32 — Measure usage and make the backlog actionable | 2 | 2 | passed |
| 33 — Reduce orchestration context and transfer sessions safely | 0 | 0 | pending |
| 34 — Improve convergence and tune from measured outcomes | 0 | 0 | pending |
| 35 — Close the GSD and Shipyard workflow loop | 3 | 2 | pending |

<!-- shipyard:gsd-sync:end -->
