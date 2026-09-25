# Phase 41 context — Reduce pipeline subscription overhead

Status: ADR-019 records the accepted scope; phase research has a fresh verified typed receipt; final plan checker pending.
Planning baseline: main release 0.63.0, d0c2804e517dda9e1924312362749f04f429caff.
Requirements: REQ-151 through REQ-156 map respectively to P41-A through P41-F.
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

The original host blocker is superseded by the private local bootstrap and the
native research recovery recorded on 2026-09-25. Four investigation reports,
ADR-019 and phase research are complete. The original phase-research dispatch
failed its literal wait-result check and has no compliant receipt; it was not
relabelled. A fresh typed research dispatch later revalidated the scope at the
current planning revision and produced a verified durable receipt. The typed
planner completed with an authenticated durable receipt for the initial plan
set.

The first checker described T-41-07 as self-dependent, but there is no literal
`depends_on: T-41-07` self-edge: the original plan depended on T-41-01–06 and
T-41-08. Its actual defect was overlapping ownership and sequencing: it would
write the same `INTEGRATION.md` owned by the standard phase-level integrator,
then seal a second time under a different ticket-set identity. That original
artifact-generation and phase-verdict scope remains retired. The subsequent
checker exposed a separate gap: the merged-parent proof required before
integration had no executable plan owner. T-41-07 is restored with the narrow
prelaunch-check scope below; it does not create or seal `INTEGRATION.md`.

User amendment (merged-parent proof at the final gate, preserved and now
assigned): the Claude integrator host's `phaseSelection` derives phase tickets
from the canonical graph, requires exactly one live merged PR per ticket and
runs `git merge-base --is-ancestor <merge commit> <epic head>` before launch.
The Codex path accepts an orchestrator `--ticket-set-file` and
`role-artifact.cjs` checks its internal consistency and digest, but does not
enforce the complete merged-parent proof. Before any phase-41 integrator launch
on either runtime, the T-41-07 executable preflight derives every ticket from
the canonical graph, confirms one matching live merged PR per ticket and
proves ancestry of each merge commit against the exact pinned epic head/tree
the integrator will read. An incomplete or changed set parks the phase before
dispatch. The human release gate records all eight current graph-ticket merge
proofs and the proof digest next to the standard integrator receipt.

User amendment: include the timeout-only parent wait / asynchronous child
completion fix in T-41-04. It preserves mandatory native child identity,
completion, role/model/effort/instruction, handback and containment checks.
The permanent source fix and regression coverage belong to phase 41; the local
runtime patch remains bootstrap only. No product code is changed by planning.

## Planning and ownership

Phase 41 is independently deliverable on merged phase-39 release 0.63.0 before phase 40. T-39-17 packet selection/bounds and T-39-03 arming are integrated prerequisites; their installed behavior remains a separate acceptance gate. The local host patch used for research/planning is bootstrap, not delivered source. Cross-phase dependents below wait for merged phase-41 source on main; their PRs do not stack across epics. Requirement scope is unchanged. Phase 40 retains its listed producer/consumer, request, provenance and formatting work; T-40-24 additionally waits for T-41-07 because it later edits the same `deliver.md` file and must preserve the preflight contract.

Source audit: implementation tickets are T-41-01–08. The phase goal maps to the standard phase-level integrator after all eight ticket PRs land on the epic; it is not a ticket or PR of its own. REQ-151/P41-A maps to T-41-01; REQ-152/P41-B to T-41-02; REQ-153/P41-C to T-41-03; REQ-154/P41-D to T-41-04; REQ-155/P41-E to T-41-05; REQ-156/P41-F to T-41-06; REQ-157 (moved from REQ-149a/b, formerly T-40-02) to T-41-08. T-41-07 supplies the cross-cutting prelaunch proof and does not replace those requirement owners or the phase integrator. The standard final phase integration gate inspects the complete merged epic and all eight ticket outcomes, maps REQ-151–157 to evidence, records installed/behaviorally verified/efficiency-measured status, retains failed, interrupted, parked and recovery work, and reports savings as inconclusive until the existing 20-completion / 95%-attribution readiness threshold is met. Research constraints for packet admission, safe handoff, one-shot wake, authenticated candidate, dependency-edge fingerprints, and verified-outcome joins are in those same tickets. Deferred global model downgrades, adaptive investigation fan-out, new sentinel daemon, broad ticket resizing, automatic handoff thresholds and instruction rewrite are excluded. A reproduced stop/wake source residual requires a scoped ticket amendment before changing phase-40-owned files; T-41-03's regression and installed acceptance cannot pass while that defect remains.

| Source | Item | Plan | Status |
| --- | --- | --- | --- |
| GOAL | Reduce avoidable context processing and repeated model work with verified outcomes | T-41-01–08, then phase-level integration gate | COVERED |
| REQ | REQ-151; REQ-152; REQ-153 | T-41-01; 02; 03 | COVERED |
| REQ | REQ-154; REQ-155; REQ-156 | T-41-04; 05; 06 | COVERED |
| RESEARCH | Packet admission and governing references; safe handoff; installed one-shot wake | T-41-01; 02; 03 | COVERED |
| RESEARCH | Authenticated candidate; projection dependency edges; deduplicated outcome join | T-41-04; 05; 06 | COVERED |
| CONTEXT | P41-A; P41-B; P41-C | T-41-01; 02; 03 | COVERED |
| CONTEXT | P41-D; P41-E; P41-F | T-41-04; 05; 06 | COVERED |
| CONTEXT | Complete merged ticket set and pinned-epic ancestry proof | T-41-07 | COVERED |

## Phase 40 prerequisite amendments

```json
{
  "phase40_dependency_amendments": [
    {
      "ticket": "T-40-01",
      "add_depends_on": [
        "T-41-04"
      ],
      "shared_files": [
        "tests/unit/codex-delivery-host.test.cjs"
      ],
      "reason": "The signing-host fixture must consume phase-41 authenticated candidate and finalization evidence."
    },
    {
      "ticket": "T-40-09",
      "add_depends_on": [
        "T-41-04"
      ],
      "shared_files": [
        "tests/unit/codex-delivery-host.test.cjs",
        "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
        "tests/unit/codex-runtime-host.test.cjs"
      ],
      "reason": "The captured-stream consumer fixture must preserve phase-41 candidate and recovery contract assertions. The digest task relay must preserve timeout-independent native child completion verification and its negative cases."
    },
    {
      "ticket": "T-40-12",
      "add_depends_on": [
        "T-41-04"
      ],
      "shared_files": [
        "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
        "tests/unit/codex-delivery-host.test.cjs"
      ],
      "reason": "The research consumer extends the Codex host after its trusted finalization candidate API exists."
    },
    {
      "ticket": "T-40-14",
      "add_depends_on": [
        "T-41-04"
      ],
      "shared_files": [
        "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
        "tests/unit/codex-delivery-host.test.cjs"
      ],
      "reason": "The in-flight host input path must retain the phase-41 original-dispatch and candidate recovery fence."
    },
    {
      "ticket": "T-40-16",
      "add_depends_on": [
        "T-41-01"
      ],
      "shared_files": [
        "plugins/delivery-pipeline/scripts/claude-role-host.cjs",
        "tests/unit/claude-role-host.test.cjs"
      ],
      "reason": "Sentinel preflight must consume the phase-41 measured, bounded role prompt path."
    },
    {
      "ticket": "T-40-18",
      "add_depends_on": [
        "T-41-04"
      ],
      "shared_files": [
        "plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs",
        "tests/unit/delivery-commit-finalizer.test.cjs"
      ],
      "reason": "Commit formatting must preserve the phase-41 exact-tree and idempotent finalization contract."
    },
    {
      "ticket": "T-40-22",
      "add_depends_on": [
        "T-41-01"
      ],
      "shared_files": [
        "plugins/delivery-pipeline/scripts/claude-role-host.cjs",
        "tests/unit/claude-role-host.test.cjs"
      ],
      "reason": "Dispatch provenance must consume the phase-41 prompt measurement and selected reference identity."
    },
    {
      "ticket": "T-40-27",
      "add_depends_on": [
        "T-41-04"
      ],
      "shared_files": [
        "plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs"
      ],
      "reason": "Diamond readiness must retain the phase-41 expected-tree and repeated-finalization safeguards."
    },
    {
      "ticket": "T-40-03",
      "replace_depends_on": {"T-40-02": "T-41-08"},
      "shared_files": [
        "plugins/delivery-pipeline/scripts/state-sync.cjs"
      ],
      "reason": "T-40-02 moved into phase 41 as T-41-08 at the user's request; T-40-03 remains the next state-sync.cjs writer and waits for merged phase-41 source."
    },
    {
      "ticket": "T-40-24",
      "add_depends_on": [
        "T-41-07"
      ],
      "shared_files": [
        "plugins/delivery-pipeline/commands/deliver.md"
      ],
      "reason": "Phase 41 inserts the executable merged-parent preflight before phase 40 rewrites deliver.md; T-40-24 must preserve the preflight call and proof handoff."
    }
  ]
}
```

## Planning defaults within the accepted scope

Source: ADR-019; mode standard, granularity standard; TDD descriptions for
eligible implementation tasks. No code/tests are implemented during planning.
Safe explicit handoff boundaries first; automatic thresholds remain deferred.
Changed-base candidate reuse refuses unless a plan preserves complete bounded
revalidation. Use existing matched-cohort/readiness/quality rules. Assign exact
contracts, dependency input sets and later phase40 file ownership in plans.
