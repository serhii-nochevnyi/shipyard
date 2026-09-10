# ADR-009 — Not every ticket is available work

- **Status**: accepted
- **Date**: 2026-09-10
- **Reverses two things.** `decompose.md:296` — *"deliver never reads Jira, and
  Gate 2 never depends on it"* — survives as a statement about the SOURCE OF
  TRUTH (plans stay canonical, Gate 2 still asks a tracker nothing) and is
  reversed as a statement about SELECTION. And `deliver.md:810-816`, the import
  shortcut, is deleted outright.
- **Sibling of, not part of, ADR-008.** ADR-008 makes the conveyor WRITE to the
  tracker; this decides what it may PICK UP. Their failure directions are
  OPPOSITE (D5), which is the clearest reason not to fold them together.

## Context

The operator stated two rules about how work is chosen, and the conveyor can
express neither.

> Take only tickets that are in To Do and that nobody has worked on; anything
> else only on a direct instruction.

> There are two kinds of ticket — the ones our pipeline prepared and the ones
> prepared outside it. An externally prepared one has to go through the pipeline
> with an investigate, from a cold start.

They are one subject seen from two sides: **what evidence entitles a ticket to
be taken into work.** One rule is about who HOLDS it, the other about who
DESIGNED it.

What is actually true today, read out of the code rather than recalled:

- **`front.cjs:761` is the whole of "take into work":** a ticket enters the
  `execute` bucket on exactly `status === 'pending' && s.ready`, and `pending`
  means no branch exists. `branched` and `pr-open` are already ours. So there is
  one narrow line where the holding rule belongs.
- **Nothing anywhere reads a tracker's status** — zero occurrences of
  `getJiraIssue`, `searchJiraIssuesUsingJql` or `mcp__` across `scripts/` and
  `workflows/`. The Jira key sits in `tickets.json` as `jira`, written once at
  decomposition and never read again.
- **The park mechanism this needs exists four times over.** `front.cjs:499`
  parks a drifted ticket before it reaches any actionable bucket, with a reason
  and a lift condition, off a durable store written by a refusing recorder.
  `drift.json`, `escalations.json`, `dispatches.json` and `ci-waits.json` are
  one debugged pattern: the lock beside the store, `--graph` in any position,
  fail-closed when the graph has no `tickets.json`.
- **The fields the holding rule turns on are already in the cheapest call.**
  `getJiraIssue`'s documented default field set is *"summary, description,
  status, issuetype, priority, labels, components, assignee, reporter, created,
  updated, resolution, project"* — `status` and `assignee` arrive with no
  `fields` argument and no second request.
- **And the provenance rule needs no tracker call at all.** A ticket is this
  pipeline's if and only if a `*-PLAN.md` stands behind it and Gate 2 accepted
  it — which is precisely what `tickets.json` IS. `decompose.md:355` writes the
  matching outbound marker on the issue
  (`shipyard-<owner>-<repo>-T-<phase>-<plan>`, repo-namespaced since two
  repositories restart ticket ids at `T-01-01`), so the two witnesses agree by
  construction. The predicate is local, free, and already computed.

**So the second rule is not a missing feature — it is a shortcut that has to
go.** `deliver.md:810-816` currently says that when there are no PLAN files but
tickets exist in an external tracker, the loop should *offer an IMPORT*: read
each external ticket, materialize it as a PLAN.md, derive what Jira does not
carry (`depends_on`, `files_modified`) *"from the content or interrogate the
user"*, then run Gate 2 and deliver. That manufactures a contract out of a
description and hands it straight to an executor, skipping loop 1 entirely —
no research, no Gate 1, no ADR. Gate 2 cannot catch it, because Gate 2 checks
the SHAPE of a plan and this produces a well-shaped one. It is the one path in
the conveyor by which unexamined work reaches a worktree.

**The trap in the holding rule, and it is ADR-008's class exactly.** The obvious
way to ask "has anyone worked on this?" is the issue's changelog — has its
status ever moved. The MCP's own schema forbids it in as many words: `expand:
"changelog"` *"returns only the newest page, sorted newest-first, and it accepts
startAt/maxResults then ignores them — so it cannot be paged and **reports a
longer history as complete**."* A predicate built on that answers "never
touched" most confidently about the issues with the longest history, which are
the ones most likely to be somebody's in-flight work. Like `transitionName`, it
works on the case it was written against and fails silently on the real one.

The two connected MCP variants also disagree again — one takes a `fields` array,
the other a `view` preset — so nothing here may depend on which is attached.

## Decision

Seven decisions, each one ticket.

- **D1 — Only the `execute` transition is gated, and that is what makes "nobody
  worked on it" definable.** The gate sits where `front.cjs` turns `pending +
  ready` into `execute` — the single moment a ticket is TAKEN INTO WORK.
  `branched` and `pr-open` are never gated: they are this conveyor's own work,
  and gating them would mean a resumed run could not continue its own ticket,
  turning a restart into a deadlock. It also settles the definitional fight the
  rule would otherwise start: **"worked on" means by someone OUTSIDE this
  conveyor**, and our own progress is visible as a branch, not as a tracker
  fact.
- **D2 — Two kinds of ticket, and the import shortcut is deleted.** A ticket is
  **pipeline-prepared** iff a Gate-2-accepted `*-PLAN.md` stands behind it —
  i.e. it is in `tickets.json`. Everything else is **externally prepared**, and
  an externally prepared ticket is not deliverable: it routes to
  `/shipyard:investigate` **from a cold start** — the intake interview, the
  research fan-out, Gate 1, an ADR — and then through `/shipyard:decompose`.
  `deliver.md`'s step 1b is REMOVED, not softened, and what replaces it says why
  in one line: a Jira description is not a contract, and the fields it cannot
  supply (`depends_on`, `files_modified`) are exactly the ones that make a plan
  executable and parallel-safe. Deriving them "from the content" is the
  conveyor's own three-loop doctrine being skipped by its own documentation.
  The one thing that stays from the old step: **tell the user honestly what was
  found instead of plans** — that half was right.
- **D3 — "To Do" is a declared knob, because the vocabulary is theirs.**
  `delivery_pipeline.jira_todo_statuses`, a comma-separated string
  (`To Do, Backlog, Selected for Development`), declared in `capability.json`
  for the reason `codex_models` and `jira_transitions` are: GSD's capability
  config vocabulary is `boolean|string|number|enum`, so a list is a string or it
  is not settable at all. **Empty is the default and means the gate is OFF** —
  the rule is conditioned on working through tickets, so a project that has not
  said so behaves exactly as today.
  Match on the status NAME. Jira's `statusCategory` (`new` / `indeterminate` /
  `done`) is tempting because it is uniform across projects and may well arrive
  nested inside `status`, but the schema names only `status` as a field, so its
  presence is an assumption and no gate is built on one. A ticket that MEASURES
  the category coming back may promote it to a fallback when no name matches;
  that measurement belongs in the ticket, not here.
- **D4 — "Not worked on" is two fields from the default response, and
  deliberately NOT the changelog.** Eligible means the status name is in the
  configured set AND the issue is unassigned. Both are free in the call D3
  already makes. The changelog is excluded on the schema's own evidence above.
  Worklogs are excluded as a second request for a weaker signal.
  The honest consequence, stated rather than discovered later: **an issue that
  was worked on and then genuinely returned to To Do with its assignee cleared
  reads as eligible.** That is the right answer — someone put it back — and
  saying so is cheaper than a changelog that lies.
- **D5 — Fail CLOSED, and that is the opposite of ADR-008 D4.** There a tracker
  error must never block a merge, because the work was already done and the
  tracker is only being told. Here the tracker is being ASKED whether work may
  start, and an unanswered question is not a yes. Gate on and tracker unreadable
  → the ticket is PARKED with `verdict: unknown`, in the words
  `drift-needed.cjs` already uses: *unknown is not clean*. Nobody who has not
  opted in is affected, because D3's default is off.
  The park is a durable store, `tracker.json`, with the four-store discipline.
  It records what the tracker SAID — status, assignee, when it was read — so the
  reason is the tracker's own words rather than a paraphrase: *"MYD-12 is In
  Progress, assigned to someone — name it explicitly to take it anyway."* It
  lifts on a re-read that finds an eligible pair, and on nothing else.
- **D6 — "A direct instruction" is the ticket NAMED, and the naming is
  journalled.** `/shipyard:deliver T-29-05` names a ticket and bypasses the
  holding gate for that ticket alone. `/shipyard:deliver 29`, `all ready` and
  *everything reachable* name a SET and bypass nothing — the distinction the
  rule turns on, mechanical rather than a judgement about intent. A bypass
  writes a `tracker_override` journal event carrying the ticket and what the
  tracker said at the time, so a later reader can tell a rule that was
  overridden from a rule that never fired. The event is owned by the recorder
  and refused from `log-event.cjs` by hand, like the other five.
  **This is also what keeps `/shipyard:bench` legal.** Bench takes a Jira key as
  scope and implements against it off-conveyor; that is a person naming one
  ticket, which is this exception by construction. D2 governs the CONVEYOR's
  entry, not a human's deliberate escape hatch — and bench still creates no
  ticket, no branch and no PR.
- **D7 — The main loop reads, a script records, the front consumes.** A script
  cannot reach an MCP — the constraint that shapes ADR-008 D4 — so the read is
  one call per `pending` ticket at Step 1, made by the loop, and
  `tracker-record.cjs mark <T> <KEY> --status <name> --assignee <id|none>`
  writes it. The recorder REFUSES a mark naming no status: a verdict with no
  tracker fact behind it is the un-evidenced record ADR-004 forbids, and here it
  would silently authorise work.
  **This store stays separate from ADR-008's `jira-projection.json`.** They look
  alike and are not: that one is a WRITE watermark that advances when we mutate
  the tracker and never expires backwards; this is a READ cache whose whole
  value is expiring. One store with two expiry rules is how a lift condition
  ends up applied to the wrong subject.

## What this ADR does NOT cover, and why

- **Assigning the ticket to ourselves when we take it.** The natural next move
  and a real one — it is how a second conveyor, or a person, would see this one
  has started. It is a WRITE, so it belongs on ADR-008's projection path, and it
  needs a decision about identity (whose account) this ADR has no basis for.
- **Any tracker but Jira.** D3's knob and D4's predicate are two field names, so
  a second tracker is a small change — but nothing is generalised on
  speculation, and there is no second tracker to prove the shape against.
- **Reading the tracker for anything else** — priority as a wave hint, labels as
  scope, sprint membership. Each is a separate argument about a separate field,
  and none was asked for.
- **`statusCategory` as the primary match** — parked in D3 rather than omitted:
  likely the better key, currently unverified, so it is a measurement a ticket
  may promote and not a design this ADR asserts.
- **Whether an externally prepared ticket's investigation may be abbreviated**
  when it is genuinely small. Real, and a judgement about sizing rather than
  about entitlement — `/shipyard:route` already owns sizing, and D2 only says
  the conveyor's entry is loop 1.

## Consequences

Seven tickets, one phase. Two orderings are load-bearing rather than
preferences. **D2 goes FIRST**, because it is the only one that closes an open
hole rather than adding a capability — every day the import shortcut stands is a
day unexamined work can reach a worktree, and it depends on nothing else. Then
**D3 → D4 → D5** (a predicate needs its vocabulary; a park needs its predicate),
with D1 landing beside D5 since the `front.cjs` change and the store it reads
are one mechanism. D6 and D7 follow.

**This phase cannot start until phase 29's epic lands.** Not a preference: D3
edits `pipeline-config.cjs` and `capability.json`, which T-29-02 just changed;
D1 edits `front.cjs`; D2/D6/D7 edit `deliver.md`, which T-29-06 and T-29-07 own.
Decomposing now would rewrite `tickets.json` under agents that are reading it —
the exact collision the conveyor's worktree discipline exists to prevent.

Three consequences worth stating plainly.

**Delivery gains a dependency on an external service, contained by being
opt-in.** Everything the conveyor does today is answerable from git, `gh` and
its own files; after this, a project that sets `jira_todo_statuses` cannot start
new work while its tracker is down. That is the right trade for a team whose
tracker IS the assignment mechanism and the wrong one for everybody else — which
is why the default is off rather than a sensible-looking set of status names. An
empty knob here is not an unconfigured feature; it is the statement that this
project does not take its work from a tracker.

**The holding gate can only ever REMOVE work from the front, never add any.**
That bounds the blast radius: its worst failure is a run that does nothing and
says why, not a run that takes what it should not. The expensive failure — a
ticket someone else is holding, executed in parallel, two people's commits over
one contract — is the one it exists to prevent, and it is why an unknown verdict
parks instead of proceeding.

**And D2 makes the conveyor slower to start on external work, on purpose.**
Someone who hands it a Jira board today can be delivering within a round; after
this they run an investigation first. That cost is the point. The shortcut's
appeal was always that it looked like the fast path, and what it actually bought
was `files_modified` guessed from prose — the field every parallel-safety
guarantee in this system is computed from.
