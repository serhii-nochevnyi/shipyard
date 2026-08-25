# A diamond child's worktree is missing its non-primary parents' code

**Found:** 2026-08-25, dispatching T-20-06 in the first `/shipyard:deliver` run
on this repo.
**Scope:** none of phase 20's tickets — T-20-06 was unblocked by hand.

## What happened

T-20-06 declares four parents: `[T-20-01, T-20-02, T-20-03, T-20-05]`.
`validate-graph` resolved `primary_parent: T-20-02` and therefore
`pr_base: ticket/T-20-02-…`, and `ticket-worktree.sh create` cut the checkout
from that branch. T-20-02 is itself stacked on T-20-01, so the worktree
contained two of the four parents. Measured in the checkout, not inferred:

    failure-signature.cjs (T-20-01)          present
    pipeline-config --signature-state (T-20-02)  7 occurrences
    escalation-record `mark-plan-defect` (T-20-03)   0 occurrences
    attempt-history.cjs (T-20-05)            absent

T-20-06's whole job is to document those four APIs in `deliver.md` and
`pr-sentinel.md`, and its own plan says of the T-20-05 contract: *"exact
strings; they are the contract this file's text must match — no mechanical
check exists for the fix-round args contract, so the pinned strings ARE the
control."* An executor in that worktree cannot read half the strings it is
required to pin. Left alone it would transcribe them from the sibling PLAN
files — which is writing documentation from intent instead of from shipped
code, the exact drift this phase exists to remove.

## The gap

The cascade is a CHAIN: a ticket gets one `pr_base`, so its checkout carries
exactly one root-to-parent path through the DAG. For a linear chain that is the
whole ancestry. For a diamond it is a strict subset, and nothing says so:

- `validate-graph` warns on same-phase diamonds and advises "linearize the chain
  where possible" — a planning-time suggestion about graph shape, silent about
  the runtime consequence for the checkout.
- `state-sync` prints `awaiting <parent> (parent has no branch yet)` while any
  parent is unstarted, then moves the ticket to `execute` the moment ALL parents
  have branches — with no signal that only one of those branches is in the base.
- `deliver.md` Step 3 hands the executor `worktreePath` and the plan, and says
  nothing about ancestors outside the base.

So the operator dispatches a normal-looking `execute` item into a checkout that
is missing code the ticket is defined in terms of. It fails silently: the agent
writes something plausible, the scope gate passes (it only measures paths), the
did-work gate passes (there IS a commit), and the defect surfaces later as
documentation that names a flag nobody shipped.

## What was done instead (the manual workaround, so the fix has a target)

The executor's brief was given the sibling worktree paths as READ-ONLY sources,
with the missing symbols named explicitly and an instruction to verify every
pinned name character-for-character against shipped code and quote `file:line`
in its evidence. This works because a diamond child that touches only files no
sibling touches has no conflict risk, and because by merge time the epic will
contain all four parents anyway — the incompleteness is transient, confined to
the authoring moment.

## Shape of the fix

The information is already in the graph; only the plumbing is missing.

1. **`validate-graph` records it.** Alongside `primary_parent`, emit
   `parents_not_in_base: [T-20-03, T-20-05]` — the parents whose branches are
   absent from the `pr_base` ancestry. Pure graph arithmetic, no git needed.
2. **`state-sync`/`front.cjs` say it out loud.** A ticket offered as `execute`
   with a non-empty `parents_not_in_base` prints the list. An operator who sees
   "base carries 2 of 4 parents" will not dispatch blind.
3. **The executor is handed the sources.** `deliver.md` Step 3 and the
   `executors.mjs` args contract gain `siblingWorktrees: {ticket: path}` for
   exactly those parents, described as read-only. The Workflow path bypasses
   command-doc prose, so this has to live in the args contract, not only in
   `deliver.md` — the standing lesson from the fixer rules.

Deliberately NOT the fix: making the child wait for its non-primary parents to
merge. That serializes a diamond into a chain and gives up the parallelism the
cascade exists for — and the epic reconciles the ancestry at merge time anyway.
The problem is that the executor cannot SEE the code, not that the base is
wrong.
