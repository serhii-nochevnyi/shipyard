# ADR-010 — A ticket you cannot reach is not deliverable

- **Status**: accepted
- **Date**: 2026-09-10
- **Amends**: the conveyor's standing rule that *"Tracking is free, EXECUTING
  needs a local checkout"* (`deliver.md`, multi-repo section). The rule stays
  true; what changes is that the checkout stops being a precondition the
  operator must satisfy by hand and becomes something the conveyor RESOLVES.
- **Sibling of ADR-009, and it goes first.** ADR-009 decides what a ticket is
  ENTITLED to. This decides whether it is REACHABLE. A ticket that passes
  ADR-009's gate and has no checkout is still parked, so the gate proves nothing
  until the checkout exists.

## Context

The operator stated the requirement in two parts, and the second reverses the
obvious reading of the first:

> Tickets taken into work may concern repositories that do not yet exist
> locally. Their remotes have to be resolved and the repositories cloned
> locally.

> Or the repository may already exist locally — then it has to be pointed at, if
> it is not known where it is.

So cloning is the LAST resort, not the first move. A repository the operator
already has is a repository with its own branches, stashes and remotes; cloning
a second copy of it beside the first is not a convenience, it is two checkouts
of one repo that will diverge, and only one of them will have the work.

What is true today, read out of the code:

- **Nothing in the conveyor clones anything.** `git clone` appears twice in this
  repository and both are the image build (`sync-karpathy-skills.sh`,
  `dev.sh`). The delivery layer has no such call.
- **An unconfigured repo is a dead end with a good error message.**
  `state-sync.cjs:1034` prints *"repo `<slug>` holds N ticket(s) but has no
  local checkout configured — add `pipeline.repos["<slug>"]`… without it the
  conveyor can only TRACK them"*. It is accurate and it is the end of the line:
  the tickets are visible, blocked and nobody's.
- **The destination is already constrained, and the constraint is documented in
  the validator itself.** `pipeline-config.cjs:575-585` refuses a checkout
  NESTED inside the project, because since gsd-core 1.9.1 (#2843)
  `findProjectRoot` stopped crossing a git-repo boundary — GSD tooling run there
  silently binds to the child repo instead of this project. GSD's own escape
  hatch is `sub_repos`, honoured before the boundary guard. Any clone this ADR
  performs lands under the same rule; it does not get a private exemption.
- **Worktrees already compose.** `ticket-worktree.sh:41` puts them in
  `$(dirname <repo root>)/.wt-<repo name>`, so a newly resolved checkout gets
  its own worktree root with no extra design. That also settles where a clone
  may reasonably go: beside the project, which is where `.wt-*` already writes.

Two measurements taken while writing this, both of which change a decision:

- **`gh`'s configured protocol and this project's origin DISAGREE on this very
  host.** `gh auth status` reports *"Git operations protocol: https"* while
  `git remote get-url origin` is `git@github.com:serhii-nochevnyi/shipyard.git`.
  So `gh repo clone` would produce a sibling checkout on a different protocol
  from the project it is a sibling of — and on a host that clones over SSH,
  HTTPS may have no usable credential at all. The protocol must be taken from
  the PROJECT's origin, not from `gh`'s preference.
- **A shallow or single-branch clone would break base resolution.**
  `graph-dir.cjs:104` resolves a base by `git rev-parse --verify -q
  refs/remotes/origin/<base>` and silently falls back to the bare name when that
  ref is absent — which is the exact silent-false-success this repository
  already paid for once (a stale local ref answering for origin). A
  `--single-branch` clone has one such ref, so every epic and every parent
  branch in that repo would resolve to a bare name instead.

## Decision

Eight decisions, each one ticket.

- **D1 — Resolution has an ORDER, and cloning is last.** For each repo slug an
  in-scope ticket names: (1) `pipeline.repos[slug]` already configured and valid
  → use it; (2) not configured → DISCOVER an existing checkout (D2); (3) not
  found → ASK the operator, offering both a path and a clone (D3); (4) declined
  or unanswered → the ticket stays trackable-only and is parked with the reason.
  Cloning what the operator already has is the failure this order exists to
  prevent: two checkouts of one repository, diverging, with the work in exactly
  one of them.
- **D2 — Discovery matches on the ORIGIN, never on the directory name.** A
  directory called `jsfiller` is not evidence of anything; `git -C <dir> remote
  get-url origin` resolving to that slug is. The search is over DECLARED roots
  only — `pipeline.repos_root` and the project's own parent directory, one level
  deep — never a filesystem walk. A scan that ranges freely is slow, reaches
  into places nobody offered, and would happily adopt a fork or a colleague's
  unrelated clone. Ambiguity (two directories, same origin) is not resolved by
  picking one: it is reported and handed to D3.
- **D3 — When discovery fails, ASK; do not clone on your own initiative.** One
  question naming the slug, with the choices: clone it to the default
  destination, give a path to an existing checkout, or skip this repo for now.
  A clone writes outside the project and reaches the network, and the operator's
  own phrasing puts pointing at an existing one ahead of making a new one. An
  unattended run that cannot ask takes the skip branch and parks — never the
  clone branch, because silence is not consent to write into somebody's
  filesystem.
- **D4 — The destination obeys the nesting rule the validator already
  enforces.** `pipeline.repos_root`, absolute, defaulting to the project's
  parent — the directory `.wt-<name>` roots already live in.
  `pipeline-config.cjs`'s nesting check runs against the RESOLVED destination
  before anything is written, and refuses a path inside the project unless its
  top segment is in GSD's `sub_repos`. One rule, one implementation, checked in
  both places.
- **D5 — The clone protocol mirrors the PROJECT's origin, not `gh`'s
  preference.** Read `git remote get-url origin` in the project, classify it as
  SSH or HTTPS, and take the matching URL from `gh repo view <slug> --json
  sshUrl,url`. Measured on this host: `gh` says https, the project is ssh. A
  host that clones over SSH has keys; it may hold no HTTPS credential at all,
  and the failure would arrive as an auth prompt in a background run.
- **D6 — A full clone, and the reason is a ref that must exist.** No `--depth`,
  no `--single-branch`, no `--filter`. `graph-dir.cjs:104` resolves every base
  through `refs/remotes/origin/<base>` and falls back to the bare name when it
  is missing — silently. In a single-branch clone that fallback fires for every
  epic and every parent branch in that repo, and a bare name resolving to a
  stale local ref is precisely the false success this repository has already
  been bitten by. Cheap clones are a saving on the one thing that must not be
  cheap here.
- **D7 — Idempotent, and it refuses rather than clobbers.** The destination
  exists and its origin matches → adopt it, clone nothing. It exists and the
  origin does NOT match, or it is not a git repository at all → refuse loudly
  naming the path, park the ticket, and touch nothing. There is no path in this
  ADR that deletes or overwrites a directory it did not create.
- **D8 — A resolved checkout is WRITTEN BACK, and a failure parks.** On success,
  merge `{slug: path}` into `.planning/config.json`'s `pipeline.repos` — the
  same write-back pattern `decompose.md` Step 5 uses to cache a resolved Jira
  project — so the next run resolves it in step (1) and nobody is asked twice.
  On failure — no such repo, no access, network down, D7's refusal — the ticket
  is trackable-only with the reason attached, and the run continues. This is
  ADR-008 D4's direction and NOT ADR-009's: nothing here authorises the START of
  work, it only decides whether work is REACHABLE, so a failure must not stop
  the rest of the board.
  Say `404` honestly: with a token scoped to some organisations and not others,
  a private repo in an unreachable org returns *not found* rather than
  *forbidden*, so the message must name both readings instead of asserting the
  repo does not exist.

## What this ADR does NOT cover, and why

- **Keeping a resolved checkout up to date.** `epic-branch.sh refresh` and
  `ticket-worktree.sh create` already fetch what they need; a background sync of
  every configured repo is a different subject with its own cost.
- **Removing a checkout the conveyor created.** The reaper deletes worktrees and
  branches, never repositories. A clone is the operator's from the moment it
  exists, and nothing here will delete a directory holding a git history.
- **Credentials.** If `gh` cannot see the repo or `git` cannot authenticate, the
  answer is the operator's `gh auth` / SSH setup, not a conveyor feature. D8
  reports; it does not repair.
- **Monorepo sub-paths.** `delivery.repo` names a repository, not a directory
  inside one; a phase that needs part of a repo declares repo-relative
  `files_modified`, which is already the rule.

## Consequences

Eight tickets, one phase. **Phase 30 becomes THIS**, and ADR-009's phase moves
to 31 — the ordering carries an argument rather than a preference: a ticket that
passes ADR-009's eligibility gate but has no checkout is parked either way, so
the gate cannot be exercised until reachability is solved. Materialization
first, entitlement second.

Neither can start until phase 29's epic lands, and this one contests less: it
touches `state-sync.cjs`, a new resolver script and `pipeline-config.cjs`, while
ADR-009's phase touches `front.cjs` and `deliver.md`, which phase 29's last two
tickets own.

Two consequences worth stating.

**The conveyor gains the ability to write outside its own project, and D3 is the
whole of the containment.** Every other write it performs today is inside the
project, its worktree root, or a GitHub repository it was pointed at. A clone is
new territory, so it happens only for a slug the validated graph names, only to
a declared destination, only after discovery has failed, and only when a person
answers — with an unattended run taking the parked branch by construction.

**And a repository the operator already has must never be cloned again.** That
is the requirement's own second half and it is the part an implementation would
be most tempted to skip, because cloning is one command and discovery is a
search with an ambiguous case. The cost of skipping it is not disk: it is a
second checkout that accumulates its own branches while the operator works in
the first, and a conveyor confidently driving the copy nobody is looking at.
