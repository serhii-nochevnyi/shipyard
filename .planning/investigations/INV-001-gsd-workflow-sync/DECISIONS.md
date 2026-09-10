# Decisions

## Shipyard owns execution state and publishes a native GSD read model

**Why:** The validated PLAN/DAG/delivery records already describe ticket
identity, dependencies, and observed delivery facts. Maintaining a second
hand-authored execution state would recreate the divergence this work is meant
to remove.

**What was rejected:** Manual backfill of GSD files and abandoning native GSD
artifacts in favor of Shipyard-only state.

**Scope fence:** This does not replace GitHub as the live source for PR/check
facts, and it does not change the delivery graph semantics.

## The projection is deterministic, local-only, atomic, and idempotent

**Why:** Lifecycle synchronization must be safe during restarts and must not
need credentials or network access. A check-only mode lets CI and gates detect
drift without mutation.

**What was rejected:** Prompt-only instructions, network-backed synchronization,
and independent writers for each GSD document.

**Scope fence:** The synchronizer does not create commits, PRs, tracker issues,
or worktrees.

## Completion is evidence-based at two levels

**Why:** A merged ticket proves delivery of that plan's change, but a phase also
needs integration and verification evidence. The projection must preserve the
difference so GSD cannot report a false phase pass.

**What was rejected:** Marking all summaries and UAT checks passed solely because
the delivery front says `merged`.

**Scope fence:** Existing human integration findings remain authoritative; the
projection summarizes them and does not remediate them.

## Lifecycle gates run the synchronizer at every state boundary

**Why:** Running only once at ship time leaves long-lived session state stale;
running only after planning misses delivery changes. Plan, delivery, verify,
and ship boundaries provide a closed loop while the check mode makes the
contract observable.

**What was rejected:** A one-time migration script and an advisory-only hook
that can silently fail.

**Scope fence:** The gate is inert for projects without Shipyard delivery plans.
