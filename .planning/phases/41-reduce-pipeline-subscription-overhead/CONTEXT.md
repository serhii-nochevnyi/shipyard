# Phase 41 context — Reduce pipeline subscription overhead

Status: preparation captured; formal Codex research/decomposition blocked by missing host artifact support.
Updated: 2026-09-25.

## Goal and authorization

Reduce avoidable context processing and repeated model work while preserving
independent verification, canonical model policy and trusted host boundaries.
The user requested that the most important findings from the pipeline and
today's Claude-session audits be added to phase 41.

Phase 41 was agreed in the parallel Claude sessions as the efficiency phase
after phase 39 and before phase 40. No phase-41 plans or INV-006/ADR-019 files
were present in the inspected registered worktrees when this context was
created. This records the agreed scope and new evidence without inventing an
accepted ADR, global requirement numbers, ticket IDs or delivery state. The
planner must reconcile any subsequently materialized INV-006/ADR-019 first.

## Required evidence

- [Claude session audit](../../../docs/audits/2026-09-25-claude-session-efficiency.md).
- [Usage aggregates and source identities](../../../docs/audits/2026-09-25-claude-session-usage.json).
- [Static pipeline audit](../../../docs/audits/2026-09-25-pipeline-subscription-efficiency.md).

Snapshot: 2026-09-25, 00:00–12:47 Europe/Kyiv; 861 unique model responses.
Processed input is 252,061,225 tokens, including 245,666,703 cache-read tokens.
These are processing counters, not subscription credits or unique text size.
Roles in the snapshot are inferred from task prefixes, not receipt-attributed.

The strongest measured signals are:

- Main orchestrators: 137,968,609 input tokens (54.74%); individual requests
  carry up to 858,932 input tokens.
- Six false stop-hook replies: 5,097,592 input tokens.
- Every inspected judgment packet selects all 203 backlog sections;
  backlog alone is 497,763 serialized bytes.
- A second executor pass for T-39-16 adds 4,822,956 input tokens after
  host/base recovery; not all of that work is proven unnecessary.

## Scope and acceptance criteria

The P41 labels below are local acceptance references, not global REQ or ticket
IDs. Retain the existing fingerprint and compaction scope; prioritize the
following measured additions during decomposition.

### P41-A — Complete-prompt measurement and installed packet verification

Build on T-39-17, not a second packet-selection implementation. Capture the
assembled prompt size, packet estimate, observed first-response input and
installed host/policy identity for each role. Separate cache reads, cache
creation and output. Compare like-for-like runtime/model/effort and role scope.

Acceptance:

- Installed arch-review, sentinel and integrator paths demonstrably use the
  selected source/backlog behavior and bounds delivered by T-39-17.
- No implicit full-backlog fallback occurs for those targeted role packets;
  selected inventory and source content are not duplicated unnecessarily.
- Packet bytes/4 is labeled as an estimate, not presented as the provider's
  full launch input. Oversized mandatory input produces a named remedy before
  model launch; rules and applicable constraints are never silently omitted.
- Supersession is scoped to the decisions it replaces: source selection must
  retain still-governing constraints and transitive references.
- Fixtures prove selection/admission behavior; installed-runtime observations
  prove that the shipped path uses it. Neither alone proves quota savings.

### P41-B — Bounded orchestrator continuation

Use the existing session-handoff/controller machinery to carry a compact,
durable checkpoint across phase boundaries and long waits. Include task/run
ownership, accepted decisions, artifact digests, unresolved findings, pending
gates and exact next action. Do not transfer the entire conversation by default.

Acceptance:

- A successor resumes the correct scope without repeating completed delivery
  work, losing constraints or resetting attempt history.
- Measure checkpoint collection, successor startup and cache warmup as part of
  the treatment; a smaller parent transcript alone is not proof of savings.
- Missing/stale checkpoints refuse unsafe continuation and name recovery.
- No live dispatch is orphaned or duplicated by the handoff.

### P41-C — No model wakeup for foreign or unchanged waiting work

Treat T-39-03 as the implementation dependency. Phase 41 verifies installation
and caller behavior rather than reimplementing the stop gate. Extend only a
demonstrated residual ownership/wakeup gap.

Acceptance:

- A foreign worktree's actionable board does not wake an unarmed/waiting
  session; unchanged wait observations do not cause repeated model replies.
- The owning run resumes once relevant CI/review/dependency state changes.
- Installed hook identity and behavior are checked, so a merged source fix
  cannot be reported as deployed merely from the package version.
- The six false replies in the baseline are retained as regression scenarios;
  shell polls and model turns are counted separately.

### P41-D — Resume trusted finalization after completed execution

Persist completed execution evidence before commit/finalization. After a host,
signing or base-resolution failure, recover from that candidate instead of
automatically launching the complete executor again.

Acceptance:

- An unchanged authenticated candidate can finish trusted finalization without
  another executor launch; repeated recovery is idempotent.
- The candidate binds repository, ticket, worktree, tree/base, plan/policy and
  verification evidence. A changed identity requires bounded revalidation or
  explicit refusal, never reuse of a stale green result.
- Base movement invalidates affected checks; failed/pending gates remain
  visible and a host error does not become a successful execution receipt.
- A scenario matching T-39-16 distinguishes completed code work from failed
  finalization and measures any necessary revalidation separately.

### P41-E — Local GSD projection fingerprints

Preserve the existing phase-41 commitment: compute projection fingerprints from
the inputs that actually govern each projection, instead of injecting one
repository-wide digest into every generated file.

Acceptance:

- Changing one plan/ticket only rewrites affected projections and legitimately
  dependent aggregates; unrelated phase artifacts remain byte-identical.
- The read-only consistency check still detects stale relevant projections,
  and changed dependency edges invalidate all affected outputs.
- Compare generated file count and diff bytes on a representative plan/state
  change; do not convert reduced diff bytes directly into quota savings.

### P41-F — Comparable end-to-end efficiency evidence

Extend the existing usage-attribution/orchestration-overhead reporting rather
than creating another ledger. Join parent and child usage with verified outcomes
where identities permit, retaining missing attribution as unknown.

Acceptance:

- Deduplicate streamed/replayed messages; do not add iteration/thinking/cache
  subcounts twice. Include failed, interrupted, parked and recovery work.
- Report processed input, cache categories, output, model turns and retries,
  plus median/p90 per verified completion and total cohort consumption.
- Compare one behavioral treatment at a time and track false greens, skipped
  gates, lost constraints, duplicate work, reopens and escaped defects.
- Reuse the existing 20-completion / 95%-attribution readiness criteria for a
  savings claim. Until sufficient live evidence exists, report inconclusive;
  do not block shipping a verified functional fix solely to collect a sample.
- The release report distinguishes implemented, installed, behaviorally
  verified and efficiency-measured results. No fixed subscription percentage
  or financial saving is promised from token counts.

## Dependencies and overlap

- Phase 39 release, especially T-39-03 and T-39-17: verify effective installation.
- Phases 33–34: reuse existing handoff, wait-event, usage and treatment machinery.
- Phase 40 planning already owns work on host provenance (T-40-21), stream
  compatibility (T-40-08/11), request construction (T-40-15), finalizer formatting
  (T-40-18) and judgment hosts (T-40-22 and ADR-018 additions).
- Phase 41 must remain deliverable before phase 40. During decomposition, give
  shared files explicit ordering and update phase-40 dependencies when a
  phase-41 contract changes. Do not introduce a circular dependency or silently
  duplicate the phase-40 features. Schema compatibility work beyond what is
  needed for finalization recovery stays with its existing owner.
- INV-006/ADR-019, if created concurrently, must ingest this measured scope and
  preserve prior decisions; this context is not permission to overwrite them.

## Boundaries

Keep independent planner/checker and integrator judgments: today's runs found
real defects. Preserve canonical model/effort selection and trusted launch,
artifact, verification and merge gates. Global model downgrades, adaptive
investigation fan-out, a new sentinel daemon, broad ticket resizing and a full
instruction-document rewrite are follow-up experiments outside this phase's
priority scope.

## Planning handoff

See [PLANNING-BLOCKERS.md](PLANNING-BLOCKERS.md): CLI capability preflight passes,
but the research write/sealer contract requires existing phase-40 prerequisites.
The phase ordering needs reconciliation before formal callbacks can proceed.

Kickoff is recorded in [INV-006](../../investigations/INV-006-pipeline-subscription-overhead/PROBLEM.md).
Its intake and seed evidence are prepared; six technical research questions
remain open. Codex capability preflight passed with the explicit installed
capabilities file. Formal research callbacks have not yet run.

Before materializing tickets, reconcile the latest phase-39 implementation and
phase-40 file ownership, derive global requirements from the accepted ADR, and
run the normal GSD planning/checking path. Keep this evidence with the plans.
No implementation ticket or delivered status is implied by this scope capture.
