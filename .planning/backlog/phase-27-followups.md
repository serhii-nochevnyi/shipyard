# Phase 27 follow-ups

## The cap returns to 4 when the EPIC lands, not when T-27-01 did

`delivery_pipeline.max_concurrent_agents` was raised to 8 for this phase (user's
decision, 2026-09-08) because the cap counted dispatch RECORDS and a guard
holding four PRs filled a cap of 4. T-27-01's acceptance criteria said the value
returns to 4 "once this ticket has merged". Measured while delivering, that
sentence is wrong by one step:

```
main: AGENT_CARDINALITY occurrences = 0
epic: AGENT_CARDINALITY occurrences = 5
```

T-27-01 merged into `epic/27`, and the running conveyor executes
`plugins/delivery-pipeline/scripts/front.cjs` out of the PROJECT checkout, which
is on `main`. So the agent-shaped count is not in force for any session until the
epic's integration PR (#67) lands on the default branch. Until then a cap of 4
would still be a record count against a guard.

**Operator's first action after #67 merges:** set
`delivery_pipeline.max_concurrent_agents` back to `4` in `.planning/config.json`.

The general shape is worth keeping beyond this knob: **a conveyor change is in
force when it reaches the branch the conveyor RUNS from, not when its ticket
merges.**

**It bit, rather than being predicted, on 2026-09-09.** Cutting T-27-09's
worktree, `ticket-worktree.sh create T-27-09 <branch> epic/27-…` resolved the
bare epic name to the LOCAL ref at `8a0edc3` — the epic at two commits — while
origin was at `868e9c7` with all eight. The executor would have worked against a
tree missing six of its own phase's tickets, and `create` reported success.

That is precisely the defect T-27-04 shipped a fix for ("`ticket-worktree.sh
create` measures `origin/<base>` … and never resolves a bare `epic/…` to a stale
local ref"), and the fix could not help: it lives in the epic, and the conveyor
runs `ticket-worktree.sh` out of the project checkout, which is on `main`.
Caught by reading the `HEAD is now at` line rather than by any gate — nothing in
the delivery loop compares the cut point against origin, which is what T-27-04
adds once it lands. Every ticket in this phase changes the conveyor itself, so the same gap
applies to all of them — T-27-02's trailer carry, T-27-07's pin sweep and
T-27-03's merge gate are all merged into the epic and none of them governs this
session's own delivery.

## Two plan defects of my own, found by the executors

1. **T-27-01's plan listed `node --check plugins/delivery-pipeline/workflows/drift-gate.mjs`
   as a verification command.** It cannot pass: the Workflow runtime wraps the
   script body in an async function, so top-level `return` is legal there and
   `node --check` reports `Illegal return statement` by design — the file's own
   header says so. The executor narrowed the check to the wrapped form. Any future
   plan touching a `workflows/*.mjs` must not use a bare `node --check` on it.
2. **T-27-01's PR body claimed the test evidence "lives in `.shipyard-evidence.md`
   in this branch".** It does not: T-26-14 writes that file into the worktree as
   UNTRACKED scratch, so it is in no branch and no reader can follow the pointer.
   Caught by arch-review, wording fixed before the merge. The `prBodyGuide` this
   run passed did not say where the evidence must be QUOTED rather than
   referenced; it should.

## Copilot proposed a regression, and the guard proved it was one

Recorded because it is the counter-example to "bot review is advisory but usually
right". On T-27-03 Copilot flagged twice that `treeBlobs()` interpolates a
slash-containing ref into `git/trees/<ref>` without encoding. The guard checked
instead of complying: encoded and unencoded requests return byte-identical
responses live, and applying `encodeURIComponent(ref)` produces a live 404 and
5 smoke failures against the ticket's own suite, which passes 160/160 unencoded.
Answered on both threads with the evidence and resolved them, no code change.
`deliver.md`'s rule held exactly as written — "disagreement with justification is
a legal review-fix result, blind execution is not."

## CodeRabbit did not engage on any phase-27 PR

Across two guard rounds and five PRs (#63, #64, #65, #66, plus reinit retries),
CodeRabbit answered nothing; `reviewers.cjs reinit` reported "the previous one is
still unanswered — is it installed?" every time. Every review round in this phase
therefore rested on Copilot alone. That is a real narrowing of review coverage
and it is invisible unless someone reads the reinit output — worth a state-sync
`⚠` line of its own, so a phase does not silently ship with half its reviewers.

## The board offers a fix at a child whose failure is its parent's

Measured 2026-09-08, **three times** in one cascade — the count matters, because
one instance reads as bad luck and three reads as the cascade's normal shape. T-27-03's CI went red on one
assertion; T-27-04 base-merged that branch and inherited the identical failure
(`✗ a landed parent releases the child on both sides at once`, same single
assertion, runs 34268518770 and 34269493892). `front.cjs` then listed
`fix: T-27-04` as actionable, because failing checks outrank the
parent-still-open bucket.

Taking it would have been wrong twice over: it is the same failure a fixer is
already out on, and the remedy needs `front.cjs` and
`tests/unit/parent-moving.test.cjs`, which are in NEITHER child's
`files_modified` — so the second fixer would hit the exact wall the guard hit on
the first and burn an attempt to reach the same plan-defect verdict.

`parentIsMoving` does not cover this: the parent's base had not moved, so the
child was not deferred. What the board is missing is not a moving base but an
INHERITED failure — the child's red arrived through the merge base rather than
from its own diff. That is computable: the failing check's signature is
identical on both PRs, and `failure-signature.cjs compute` already produces the
hash that would say so.

The third instance, added after the first draft of this note: T-27-05 (#69) was
cut from T-27-04's branch and inherited the identical assertion again — run
34272251452, `✗ a landed parent releases the child on both sides at once`,
11 passed / 1 failed, byte-identical to runs 34268518770 and 34269493892. Its
tree shows exactly why: `limbBaseOf` occurs 5 times in `sentinel.cjs` and
`limbBase` 0 times in `front.cjs` — the divergent mid-fix state of the parent,
frozen into the child at the moment its worktree was cut.

So the shape is: **one divergence in a parent propagates to every descendant
already cut, and each one arrives on the board as its own actionable `fix`.**
Three PRs, three offers, one cause, and no child can fix it — the remedy is in
files none of them declare.

Parked with `state-sync --parked T-27-04,T-27-05` for the session, which is the
honest channel (it holds only until the parent's fix lands, and it is nobody's
escalation), but a fresh session would re-offer all of them and dispatch
blindly at each.

Worth its own ticket, and it belongs with T-27-06's family — the front saying
what it knows about itself. Shape: when a child's failing signature equals its
primary parent's, the child is `waiting: parent`, not `fix`, with a why that
names the parent's PR.

## `--parked` on `front.cjs` renders; only `state-sync.cjs` makes it stick

My own error, 2026-09-08, and the stop gate is what caught it — which is the
best possible evidence that the gate earns its place.

Both commands accept `--parked`:

```
front.cjs      [--json] [--parked <T,T>]     # renders a board
state-sync.cjs [--parked <T,T>]              # rebuilds AND WRITES delivery-front.json
```

I parked T-27-04 with the first one. The terminal showed exactly what I wanted —
`front: 0 actionable now` — so the park looked done. It was not: `front.cjs`
computes and prints, and the DURABLE board is written by `state-sync`. The stop
gate reads only `delivery-front.json`, so it still saw `fix: T-27-04` and
refused the stop, correctly, with the run's own rule quoted back at me:
"a parked item leaves the front; an ignored one does not."

The flag is identical, the printed answer is identical, and one of the two is a
no-op for everything that ENFORCES. `deliver.md` does say the front is
"re-runnable on its own" and that state-sync writes the file — but it never says
that parking through the renderer persists nothing, and the two invocations are
listed one line apart in the script list.

Cheap fix, and it is the same shape as this phase's other findings: have
`front.cjs` say what it did. When `--parked` is passed to the renderer, print
one line — `parked: T-27-04 (this render only — `state-sync --parked` writes the
board the stop gate reads)`. No behaviour change, and the trap stops being
invisible.

## scope-gate run from inside the worktree answers from the BRANCH's frozen graph

Found by T-27-03's fix round, 2026-09-08, and it is the stale-graph-in-a-worktree
class `CLAUDE.md` already documents for `graph-dir.cjs` — arriving through the
one door that entry does not close.

`scope-gate.cjs` resolves its graph dir through `graph-dir.cjs`, whose order is
flag/env → **cwd** → the worktree's own repository. This repo TRACKS
`.planning/`, so a ticket worktree contains a full `.planning/graph/tickets.json`
— the branch's copy, frozen at whatever the declaration said when the branch was
cut. The cwd step finds it and stops looking.

Measured: with T-27-03's plan amended (files_modified widened from 5 paths to 8),
`scope-gate.cjs T-27-03` run from inside `/Volumes/KINGSTON/.wt-claude-shipyard/T-27-03`
reported `front.cjs`, `parent-moving.cjs` and `parent-moving.test.cjs` as
`outside` and exited 1. Run from the project it reported `outside: []` and
exited 0. Same command, same branch, same commit — two answers, and the wrong
one is the one an agent standing in its worktree gets.

Why it bites harder than the `base-merge` case: a false `outside` tells an agent
its correct work breaches the scope contract. The plausible reactions are all
damaging — revert the edit, widen nothing and escalate, or conclude the plan is
wrong. And it is silent: exit 1 with a specific file list reads exactly like a
real violation.

The proving ground keeps `.planning/` untracked, which is why the documented
`graph-dir.cjs` story is about the OPPOSITE failure (no `.planning/` at all in
the worktree). Both directions are the same root: **cwd is not evidence about
which graph an invocation belongs to.** For an amendable declaration the project's
copy is the only one that can be current, so the ordering should prefer the
worktree's own REPOSITORY over its cwd when the two disagree and the cwd copy is
a tracked checkout of that same repo — or, cheaper and honest: have scope-gate
print the graph dir it resolved and how, the way `base-merge`/`scope-gate`
already print the base ref they measured.

Until then: the main loop must run scope-gate from the PROJECT, never from the
worktree, and any prompt that asks an agent to self-verify scope has to pass
`--graph <project>/.planning/graph` explicitly.

Related: [[a-childs-pr-base-is-its-merge-target-not-just-its-review-diff]].

## A guard that backgrounds `make test-fast` never sees its own verification

Measured three times in a row on one PR, 2026-09-08 — same guard, same cause,
zero commits made across all three stops.

`make test-fast` takes over two minutes on this machine (145 assertions across
the whole deterministic layer; timed at cold start when it exceeded a 120s tool
timeout). A background agent that launches it and then waits ends its TURN
before the completion notification arrives. The harness then wakes the PARENT,
not the agent, so:

- the guard never sees the result it was waiting for;
- its finished work sits uncommitted in the worktree;
- the orchestrator gets a notification whose entire content is "standing by".

Each wake needed a `SendMessage` to make progress, and the guard did progress
each time — so this is not a confused agent, it is a structural mismatch between
a >2-minute foreground wait and a turn that ends when the agent stops acting.

**The rule that prevents it already exists and applies here too.** `deliver.md`
tells an EXECUTOR to run the plan's Verification commands and never to widen
them to `make test` or the full suite, because "the executor runs these on every
attempt and the fix roles on every round, so an unscoped command sets the tick
rate of the entire conveyor." That reasoning was about wall-clock cost; this run
shows a second consequence — an unscoped command is also too slow to survive one
agent turn. `references/pr-sentinel.md` does not carry the same instruction, and
it should: the guard runs verification on every round, exactly like a fixer.

Fix shape: state in `references/pr-sentinel.md` that verification is the
ticket's own scoped commands, run in the foreground, and that the whole suite
belongs to CI — which has already run it on the pushed head anyway, so a local
`make test-fast` re-proves what GitHub just proved.

## Gate 2 validates a declaration no edit can satisfy

Measured 2026-09-08 on T-27-08, and it is the same sentence ADR-006's Context
ends on: a declaration correct about something adjacent to what it is used for.

T-27-08's `files_modified` named
`plugins/delivery-pipeline/scripts/gen-codex-shipyard.cjs`. That file does not
exist; the script is at `scripts/gen-codex-shipyard.cjs` in the repository root
(`find` shows exactly one copy). Gate 2 passed the plan anyway, twice — at
decomposition and again after two amendments — and the executor then hit a
contract no edit could fulfil: the real file was outside its declaration, so
touching it would breach the parallel-safety guarantee, and the declared path
had nothing to touch.

The executor handled it correctly: refused, and NAMED the gap in its report
rather than guessing that the adjacent real file was what the plan meant. That
guess is the tempting one and it is a scope breach.

**What `validate-graph.cjs` actually checks about a path**: that it parses as a
declaration, that it does not escape the repository root (`unreachable_paths`, a
warning plus a flag), and that two dependency-unordered tickets do not contest
it. It never asks whether the file exists. Nothing else does either — the scope
gate compares what a branch CHANGED against the declaration, so a declared path
nobody edited is invisible to it by construction.

So the failure mode is: a plan passes every mechanical check, an executor is
dispatched against it, and the gap surfaces only if the agent is honest enough
to report a refusal instead of improvising. This run got the honest report. The
same typo in a ticket whose executor guessed would have shipped a scope breach
with a green gate behind it.

Fix shape, and it is cheap: `validate-graph.cjs` already resolves each
`files_modified` entry against the repo root to compute `unreachable_paths`. In
the same pass, for an entry with no wildcard, check existence — and report it as
a WARNING plus a flag rather than a gate failure, exactly as `unreachable_paths`
is handled, because a plan may legitimately declare a file it is about to
CREATE. A warning naming "declared, does not exist, and contains no wildcard" is
enough: it would have been read at decomposition time, before an executor spent
a round discovering it.

## I hand-typed a branch name for the third time, having adopted the rule not to

2026-09-08/09. `state-sync` printed:

```
⚠ branch drift: T-27-08 matched by title marker
   (PR head ticket/T-27-08-…-and-the-r ≠ canonical ticket/T-27-08-…-and-the-re)
```

One character. I typed the branch into `ticket-worktree.sh create` instead of
reading it from `tickets.json`, which is the third time this exact defect has
happened in this repository and the second time AFTER I recorded the lesson and
adopted the rule ("now read only from `tickets.json`"). Four other branches this
phase I typed correctly, which is worse rather than better: a rule that holds
four times out of five is a habit, not a rule.

Two things worth separating.

**The safety net worked, and it is worth knowing why.** `state-sync` matches a
ticket to its PR by TWO anchors — the canonical branch name and the
`Ticket: <T>` marker plus the `<T>: ` title prefix — so the board stayed correct
and the drift surfaced as a warning rather than as a ticket that reads `pending`
forever while its PR is green. That second anchor exists precisely because this
happened before. It is doing its job.

**Relying on the net is not the same as following the rule.** The fix here was a
declaration, not git surgery: the branch already carried a pushed PR (#71), so
T-27-08's plan now sets `delivery.branch` to the name that actually exists —
`validate-graph` VALIDATES an explicit branch rather than generating one, so the
graph agrees with git instead of with a name nothing uses. Gate 2 exit 0, drift
warning gone.

The mechanical fix for the class, since three occurrences say prose will not
hold it: `ticket-worktree.sh create` takes the branch as an argument and has the
graph available. It could refuse a branch name that is neither the canonical one
nor an existing branch, naming the canonical in the message. That turns a
one-character typo into a refusal at the moment of the typo, instead of a
warning several PRs later.

## A plan amended on the ticket branch is inert for every gate

Measured 2026-09-08 on T-27-05, and it is the mirror image of the scope-gate
finding above — same root, opposite direction.

The guard hit a real arch-review violation at T-27-05's fourth head: the ticket
makes `dispatch-record mark` refuse `--reason`, and `references/pr-sentinel.md`
— the file the guard itself reads — still told the guard to pass it, plus a bare
`head=<sha>` the ticket's forty-character rule rejects. Correct fix, correctly
scoped: change the reference file and declare it. The guard amended
`files_modified` and pushed.

But it amended the plan **on the ticket branch**, and that is inert:

```
$ git show main:….../27-05-PLAN.md | sed -n '/files_modified/,/requirements/p'   # 7 paths
$ git show origin/epic/27-…:….../27-05-PLAN.md | …                               # 8 paths
```

`validate-graph.cjs` and `scope-gate.cjs` read the PROJECT checkout's
`tickets.json`. So at the moment of the push the eighth path was declared
nowhere any gate could see, and a project-side `scope-gate` run would have
called that file `outside`. Nothing refused only because nobody ran it from
there on that head.

**Same root as the earlier finding, read from the other end.** This repo tracks
`.planning/`, so a live phase has TWO copies of every declaration — the
project's and each branch's — and which one answers a gate depends purely on
cwd. From a worktree the gate reads a FROZEN declaration and reports correct
work as out of scope; from the project it reads the CURRENT one and cannot see
an amendment a branch made. Neither direction is a bug in either script; both
are the consequence of a mutable contract living inside the tree it governs.

Two fixes, and they are independent:

1. **Cheap and immediate**: whoever amends a declaration mid-delivery must mirror
   it on the planning branch, not only on the ticket branch, and the guard should
   say so when it does one — T-27-03's precedent (`4ec4868`) is the shape. Done
   here for T-27-05.
2. **The real one**: gates should resolve the declaration from a single named
   place and PRINT which one they used, the way `base-merge`/`scope-gate` already
   print the base ref they measured. A silently-substituted declaration is a new
   invisible behaviour, and this phase now has one instance in each direction.
