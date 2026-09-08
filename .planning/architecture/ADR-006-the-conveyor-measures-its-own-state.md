# ADR-006 — The conveyor measures its own state

- **Status**: accepted
- **Date**: 2026-09-08
- **Extends**: ADR-004's principle (positive evidence before a mutation) from the
  work the conveyor JUDGES to the records the conveyor KEEPS ABOUT ITSELF.

## Context

Phases 24, 25 and 26 shipped 32 tickets that made the conveyor stop lying to the
operator: a green measured against a moved base is not a green, an unobserved
compare is not a zero, an unreadable check answer is not an empty one, an
unparseable config permits no mutation. Every one of those is the same sentence
about the WORK.

Delivering them produced 23 backlog notes, and re-reading them together shows
the sentence has a second half nobody wrote down: **the conveyor asserts things
about its own state that it has not measured either.** Not one of the cases below
is a theory. Each was found by running the conveyor, most of them more than once,
and several of them by the conveyor's own reviewers correcting the orchestrator.

The evidence, with how it surfaced:

- **A base is one field with two jobs.** A child's PR base decides both what the
  review diff shows and where the squash lands. Optimising the first
  mis-targeted the second: PR #52 squash-merged T-26-03 onto a branch already
  merged into the epic, so `epic/26` did not contain the work — while the ticket
  read `merged`, its PR read merged, and every board the conveyor prints was
  telling the truth about its own subject. Nothing asserts that a merged
  ticket's work is reachable from its epic.
- **A landed cross-phase parent never reaches the child's tree**, and the local
  refs go stale silently. Measured four times in one session: `epic/25` and
  `epic/26` each 27 then 31 commits behind `main`, containing zero occurrences
  of the predicates their next tickets were written against; and
  `ticket-worktree.sh create` resolving a bare `epic/…` to a LOCAL ref while
  origin was ahead, reporting success each time.
- **A verdict is discarded on a head move that provably adds nothing.**
  `gateConform` binds strictly to a sha, so a `base-merge` whose whole tree is
  byte-identical costs a full re-judgement. Measured on T-25-05: the same tree
  object, the same diff against the new base, and the review re-run anyway — at
  ~150k tokens a round, on 42% of a ticket's cost.
- **A journal writes intent as fact.** T-25-05 was about to record the resolver's
  `effort` for roles whose spawn cannot carry one (46.9% of subagent tokens go
  through the Agent tool, which has no effort parameter). Caught before it
  shipped; the same class then reappeared in `--reason`, whose provenance the
  code cannot supply.
- **`log-event.cjs` does not refuse `dispatch`.** The orchestrator claimed it did
  — in a plan — and `OWNED_BY_SCRIPTS` holds four events, not that one. So the
  audit trail T-25-05 exists to make trustworthy can be written around.
- **Reading the front after a journal write reports pre-write buckets.**
  `dispatch-record` refreshes the overlay; `log-event` only appends. The
  orchestrator applied the first habit to the second and concluded "nothing
  actionable" from a board computed before the push.
- **A wiring line nothing asserts.** Delete `epics: epicInfo` from state-sync's
  `computeFront` call and four suites totalling 309 assertions stay green. The
  same shape as a `grep -q` contract passing against a file a NUL byte had made
  binary to `grep`.
- **A guard that knows about a home and stays quiet.** The gsd-core pin has
  eleven sites across eight files; the assertion shipped for five.
- **A cap that counts the wrong unit.** `max_concurrent_agents` counts dispatch
  RECORDS while the guard files one per guarded ticket and Step 4 spawns one
  agent, so a guard holding four PRs fills the default of four. Reproduced by
  the reviewer. On a capacity-full board the front, `ci-wait` and the stop gate
  then give three mutually incompatible orders.
- **And the ADRs themselves.** D2 of ADR-005 was amended while D1, D6, D10 and
  its Consequences kept asserting what it retired; ADR-003's Consequences was
  amended while D3 six sections above kept the withdrawn default. Both found by
  reviewers, not by us, and the second one after the first had been fixed.

The pattern under all of it: **the conveyor's own facts are derived from the
cheapest available signal rather than from the one that answers the question.**
A branch name instead of a ticket status. A sha instead of a tree. An intent
instead of an application. A count instead of a set. A list of homes instead of
a sweep. Each is correct about something adjacent to what it is used for.

## Decision

Eight decisions, each already measured, each sized as one ticket. They are
ordered so the ones that make the NEXT phase's delivery honest come first.

- **D1 — The cap counts agents, and the three capacity mechanisms agree.**
  Decide the counting unit before a phase runs under the cap: collapse the
  guard's N records to the one agent that holds them, or count agents directly.
  Then reconcile the three readers — on a capacity-full board `front.cjs`,
  `ci-wait.cjs` and `stop-gate.cjs` currently order "do not dispatch", "take
  that work first" and "ending here is a defect" at the same time, because the
  gate's with-an-agent hatch sits behind `count <= 0`. Ship with an assertion
  that every `workflows/*.mjs` effort default equals the resolver's answer for
  that role: `executors.mjs` and `fix-round.mjs` agree today by luck, and
  `drift-gate.mjs` does not agree at all.
- **D2 — A verdict survives a head move it provably covers, and the trailer
  records what it judged.** The test is the PAIR, and the pair is a proof rather
  than a heuristic: the head trees equal AND the diff against each base equal.
  Implement it as the BASE-TREE comparison, not the diff comparison — a diff is
  a rendering that depends on rename detection, context size, whitespace and
  `diff.algorithm`, while two object identities have no such surface. The
  blocker is that the trailer records only `head=`, so it must also record the
  merge-base TREE: the old base branch gets reaped, and a rule that recomputes
  `mergebase(origin/<old-base>, …)` dies with it. A tree sha is immortal. Only
  `arch-review=conform` carries; `checks=green` never does.
- **D3 — A base is chosen for where the merge lands, and the epic is asserted
  to have received it.** A parent's ticket branch is a legal base only while the
  parent's PR is OPEN — the post-merge retarget is what then gives both
  properties. Once the parent has merged the base is the epic, with `base-merge`
  first to keep the diff a single slice. And the invariant that was violated
  silently becomes a check: **after any ticket merge, assert the ticket's own
  declared files are reachable from its epic.**
- **D4 — An epic learns what landed under it, and a worktree is cut from what
  the board named.** `epic-branch.sh` gains a `refresh` verb (fetch, merge
  `origin/<base>`, push, refuse with the conflicting paths rather than resolving)
  and Step 0 calls it for every epic whose base has moved. Whatever performs it
  also fast-forwards the local base and epic refs, because a refresh pushed from
  a detached worktree leaves them behind — measured four times. And
  `ticket-worktree.sh create` measures `origin/<base>`, reports the distance of
  any branch it REUSES, and never resolves a bare `epic/…` to a stale local ref.
- **D5 — A journal records what was applied, and refuses to be written around.**
  `log-event.cjs` adds `dispatch` to `OWNED_BY_SCRIPTS` with the `halfAct`
  message the other four use. `--agent-file` is cross-checked against the role.
  `--reason` is emitted by the RESOLVER rather than composed by the caller, so
  the journal records the route the ladder took rather than the caller's opinion
  of it. And one sha format: the full forty characters, because `gate_status`
  records it that way and a reader cannot lengthen an abbreviation.
- **D6 — The front says when it is behind, and one dispatch carries one base.**
  `front.cjs` reads the journal's tail the way `stop-gate.cjs` does and prints
  one line when a `merge` or `attempt … pushed` is newer than the state it is
  about to render — the gate proves this is computable inside a 75ms budget.
  `deliver.md` states the pairing where the loop meets it. And `drift-gate.mjs`
  takes `baseRef` PER TICKET, from `delivery-state[id].base`, which
  `drift-needed.cjs` already resolves: one baseRef for a mixed-base cascade
  forced a round into two invocations.
- **D7 — A guard asserts a sweep, not a list; and a wiring line is asserted at
  all.** The gsd-core pin: remove the two installer HINT literals (three sibling
  scripts print `@latest` by design) and then assert that every tracked
  `gsd-core@<semver>` equals the `Dockerfile`'s, excluding `.planning/`. Fail on
  more than one match per file — `head -1` reads green while the effective value
  is the later one. Add the `epics: epicInfo` wiring assertion and a
  files-contract case that no script contains byte 0x00. Close the four blind
  classes the reviewer's nine novel mutants exposed.
- **D8 — The remaining ADR-004 D2 gaps, and the records that contradict
  themselves.** `front.cjs`'s standalone CLI, `gsd-tune --global` and
  `gen-codex-shipyard.cjs` still take defaults from a config that does not
  parse; the first offers a paid `finalize` dispatch with no warning, and
  `deliver.md` advertises that CLI as re-runnable on its own. Plus one
  `Math.floor` and a type check in `loadConfig`'s shared numeric rule, which
  today accepts `true` as a cap of one agent and `0.5` as "dispatch nothing"
  while `free !== 0`. Plus the ADR bookkeeping: ADR-003's Context still says the
  Agent tool accepts full model ids, and ADR-005's `Supersedes` names D3 alone.

## What this ADR does NOT cover, and why

Said explicitly, because a decomposition that quietly widens is how a phase
stops ending:

- **`gsd-collapses-claude-fable-5-into-the-alias`** — upstream in gsd-core, not
  ours to fix; it belongs in an issue there.
- **`config-warnings-name-the-namespace-the-value-came-from`** and
  **`orchestrator-facts-reach-fixers-unverified`** — real, but ergonomics and a
  prompt contract respectively, neither about a measured fact.
- **`no-ci-in-the-conveyors-own-repo`**, **`nothing-wakes-a-run-that-is-only-waiting`**
  and **`front-has-no-in-flight-state`** — STALE. CI exists (`test.yml` ran on
  every PR today), `ci-wait.cjs` shipped and returned in 65s on live use, and the
  dispatch overlay shipped. They should be closed with the reason rather than
  carried.
- **`phase-20-followups`**, **`phase-22-followups`**, **`phase-24-followups`** —
  older collections, partly closed by the three phases since. They need a triage
  pass of their own before any of them becomes a ticket.
- **`diamond-child-base-is-materially-incomplete`** — the same family as D3/D4
  but about a NON-primary parent, which the cascade cannot express at all. It is
  a decomposition-time rule (linearize, or slice the contract out) more than a
  script fix, and it deserves its own investigation rather than a ticket here.

## Consequences

Eight tickets, one phase, and the ordering is load-bearing rather than a
preference: **D1 first, because phase 27's own delivery runs under the cap it
fixes**, and a phase whose first wave stalls on its own guard will be diagnosed
as the new code rather than as the counting unit. D2 next, because it is the
largest measured saving and every later ticket in the phase pays the cost it
removes. D3 and D4 are one family and may run in parallel with D5–D7. D8 is a
sweep and goes last, since three of its items are in files the earlier tickets
touch.

Two of these are about this repository's own habit rather than its code, and are
worth stating as such. **A claim about a mechanism must be checked against the
mechanism**: three assertions in one session — `log-event` refusing `dispatch`,
T-24-06 adding the `arch_review` event, GSD clamping `max` on Codex — were all
written from a documented intent and disproved by opening the file. And **an
assertion nobody has seen fail is not a guard**: the mutation check is now
required in the acceptance criteria of every ticket that ships one, because this
phase caught two guards that passed for the wrong reason and one test of the
orchestrator's own that did not reproduce the defect it was written for.
