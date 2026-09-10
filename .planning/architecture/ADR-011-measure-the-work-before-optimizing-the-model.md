# ADR-011 — Measure the work before optimizing the model

- **Status**: accepted for implementation by the operator on 2026-09-10.
  Runtime behavior changes remain gated by the rollout and evidence requirements.
- **Date**: 2026-09-10
- **Source snapshot**: `7559ef0d673bee3bd9bd8e9c8403edf9d486c375`, local checkout.
- **Scope**: Claude and Codex subscription usage, autonomous delivery, and backlog
  reuse. This document does not execute a rollout or change host settings.
- **Related**: ADR-005 (model floors), ADR-006 (measured state and carry), ADR-007
  (applied evidence), ADR-008–010 (already scheduled phases 29–31).
- **Plan**: [waves and evaluation protocol](ADR-011-ROLLOUT.md).
- **Traceability**: [backlog coverage](ADR-011-BACKLOG.md).

## Context

The [2026-09-10 audit](../../docs/audits/2026-09-10-claude-usage.md)
identified 1,978 unique Claude responses across three projects. Ordinary model
input, including cache reads, was 322,675,834 tokens; advisor input was a separate
3,710,168 tokens. Main sessions produced 21.7% of responses but 43.7% of ordinary
input. Shipyard's main session averaged 441,821 input tokens per model pass.
These are local processing measurements, not subscription billing units.

Streaming records inflated naive accounting by about 2.14 times. Output usage is
incomplete for many subagent responses, and historical subscription attribution
is unavailable. The old backlog's 15x restart and 17x delegation estimates are
hypotheses, not validated quota savings. Session age alone is not active context:
compaction, cache reuse, repeated passes and advisor usage must be distinguished.

The implementation already has useful controls: `scripts/pipeline-config.cjs`
under `plugins/delivery-pipeline/` resolves role and signal policy;
`dispatch-record.cjs` separates requested effort from applied effort;
`failure-signature.cjs` distinguishes repair strategies; `gate-trailer.cjs`
can carry a verdict with evidence; and Workflow executors return artifact paths.
We extend those owners rather than creating another routing policy in prose.

Backlog notes describe recurring costs outside model selection: stale facts in
briefs, reviews repeated after an unchanged merge, missing review progress
signatures, and notes that GSD's standard 999.x backlog reader cannot discover.
Some historical defects are already closed. A note is a lead, not proof that a
current source defect exists.

## Decision

### D1 — Optimize completed, verified work with three separate accounts

Record (a) raw usage by provider/model/cache category, (b) observed subscription
windows when the provider exposes them, and (c) delivery outcomes. Never convert
API price estimates into subscription percentages. Missing output, unknown
account identity and unavailable quota are explicit unknowns, never zero.

A normalized usage observation contains schema version, source/cursor, timestamp
UTC, project/run/session/request/pass identifiers, parent agent and dispatch IDs,
role, backend, requested and observed model, requested/applied effort, cache-read,
cache-write (TTL when available), uncached input, output and completion status.
Advisor passes have their own model and parent and are counted once, separately
from ordinary passes. Preserve provenance and coverage rather than inventing
identities. Do not persist prompt bodies or credentials in aggregate reports.

Use provider-specific deduplication and iteration adapters. The Claude audit is
an initial fixture source, not proof that Codex uses its schema. Test terminal
updates, partial streaming rows, resumed sessions, multi-pass responses and
missing IDs. An idempotent cursor must also consume updates to an earlier partial
record; a byte offset alone cannot finalize an incomplete response.

Subscription samples are keyed by declared opaque account scope, provider,
window identifier/reset time and observation time. A reset, missing sample or
concurrent unobserved activity prevents attribution of a delta to one ticket.
Do not scrape secrets to establish account identity or automatically buy credits.

### D2 — A backlog item has identity, evidence and one lifecycle

Keep original notes. Add a versioned item manifest with stable IDs and source
section anchors: a multi-topic note can yield multiple items. The lifecycle is
`untriaged -> verified_open -> planned -> in_progress -> verified_closed`, with
`deferred` and `superseded` outcomes carrying a reason. Closure requires a landed
commit, relevant verification and the source revision checked, not an agent's
claim or an open PR. Reopen explicitly when evidence changes.

Generate a compact index from that manifest. At cold start, select relevant
open items by role, touched paths and ADR; load the index and selected notes,
not the full backlog corpus. Support both local notes and GSD 999.x through a
Shipyard-owned adapter with source-qualified IDs. Do not edit installed GSD
files, duplicate item ownership or export/promote to Jira implicitly. Promotion
is idempotent and links the original item to its eventual PLAN.

### D3 — Keep orchestration mechanics out of model turns

Retain Workflow as an execution backend. Extend the existing deterministic
front/sentinel/wait machinery so unchanged CI/review observations do not wake an
LLM. Polling is bounded, uses backoff and emits a compact event only for an
observable change, an actionable failure or a timeout. Network errors remain
unknown, not green. An exhausted observation budget parks with a durable reason
and next wake condition; it does not silently abandon owned work.

Before mutation, existing live merge, head, base, ownership and review gates
still run. A cached observation may suppress a redundant explanation; it cannot
authorize a merge. Every new controller has a real caller and a wiring test.
Batch independent reads. Model judgment and code fixes remain agent work.

### D4 — Rotate context through a durable, acknowledged handoff

Use actual per-pass context and redundant-turn measurements to recommend a
rotation; session age is informational. First ship recommendation and checkpoint
support, then automate only on backends with a verified new-session/resume
contract. A prompt saying "forget history" is not rotation.

The checkpoint includes repository and worktree identities, current branch/head
and base, ADR/policy version, ticket/PR state, outstanding review findings,
attempt history references, active agent leases, unresolved decisions, artifact
hashes and the exact next action. Keep large logs outside it. Start with a 12k
estimated-token soft ceiling for the packet; overflow becomes explicit artifact
references, never silent loss of constraints. Calibrate the estimate per backend.

Rotation waits for a safe boundary: no uncommitted owned mutation, merge in
progress or unacknowledged agent ownership transfer. Persist an atomic handoff
ID and successor acknowledgment. Only one owner may dispatch after transfer.
The successor revalidates live state before acting. A failed launch keeps the
previous owner/checkpoint recoverable; unsupported unattended launch is reported,
not emulated with an unsafe shell restart. Do not restart the user's live session
as part of installing this feature.

### D5 — Bound context at every role boundary, preserve evidence

Extend the existing artifact-reference contract to researcher, planner,
arch-review, sentinel and integrator outputs. Return outcome, actionable delta,
evidence paths/hashes and concise summary. A summary cap must not truncate a
blocking finding: store all findings in a structured artifact and surface its
blocking count. Readers verify existence and revision before using the artifact.

Measure startup context separately from growing history. Keep required policy,
quality gates and task scope; reduce duplicate instructions and irrelevant skill
loading only through a runtime-specific experiment. Do not remove Workflow or
required review just to lower the number of tool definitions or agents.

### D6 — Make reviewer and advisor policy explicit and scoped

Declare expected external reviewers in the existing capability/config system.
Disabled, enabled-but-pending, unavailable and completed are distinct states.
Disabling CodeRabbit never disables Copilot. Existing defaults remain until a
project explicitly changes them; do not post new reviewer requests during
migration. The effective reviewer set is carried into briefs and gate evidence.

Record effective advisor policy separately from executor model. First observe
inherited advisor behavior. A trial may disable or selectively enable advisor
only through a supported run-scoped interface after capability verification.
Never silently edit global `settings.json`, lower host effort for all roles or
change the orchestrator model. If no scoped interface exists, mark the experiment
unsupported and defer it; do not pretend a prompt guarantees enforcement.

### D7 — Progress and resource budgets are separate

Add review finding signatures alongside CI signatures. Preserve reviewer thread
IDs as provenance, but use a normalized issue identity (rule/class, file and
stable code location) to detect the same finding reposted under a new comment
ID. A changed head or a newly generated comment is not proof of progress.
Progress requires evidence that a finding was resolved or a relevant check moved
forward. Preserve ambiguity as unknown and retain a total attempt backstop.

Track repeated failures, total attempts, elapsed time and measured token usage
separately. A resource threshold schedules a safe checkpoint; it never declares
`plan_defect`, accepts a weak fix or exempts review-fix from all bounds. Infra
failures keep their existing strategy semantics and still appear in usage.

### D8 — Adapt only within the accepted model policy, on applied evidence

Keep ADR-005's floors: Claude code/judgment roles use at least Opus; sentinel
and drift-check use Sonnet; no Haiku experiment. Preserve the configured Codex
palette and compatibility checks. Do not add Sol/Luna or replace the orchestrator
model. Model and effort are separate axes; effort is not a fixed savings factor.

Use existing role signals and failure strategy as input to one resolver. Add
measured task size/risk, prior outcomes and resource pressure only with versioned
reason codes and field provenance. Low remaining quota reduces admissions or
requests a handoff; it does not justify a weaker model below a role floor.

For all eight roles (research, executor, ci-fix, review-fix, arch-review,
drift-check, pr-sentinel, integrator), record requested policy, actual launch
arguments and observed runtime model when available. A mismatch is a diagnostic
and invalidates a savings comparison; do not write requested values as observed.

Refine ADR-007's applied-evidence rule without making unknown into proof:
capability state is `supported`, `unsupported` or `unknown`, independent of the
observed applied value. On a verified backend with no stronger effort operation,
a repeated unresolved failure after a verified completed attempt at the current
eligible model/effort may select the next permitted model tier. Record that as
`model_axis_exhausted`, not as invented applied depth. A runtime capability
snapshot, launch identity and completed attempt are required. Missing evidence
retains the existing bounded fallback and an explicit diagnostic. A caller that
could apply depth but failed to pass it must not earn an expensive escalation.

### D9 — Capacity covers participating agent identities and all nested launches

Extend the existing distinct-agent accounting, not a new independent counter.
Use atomic leases keyed by provider and declared account scope, shared by
participating projects on the host. Every nested Workflow agent reserves its own
slot. A lease has an owner, heartbeat/expiry, release and recovery semantics;
reserve capacity for completing/reviewing in-flight work before admitting more.
A controller waiting for child capacity must not consume the last child slot.

Do not claim this controls unrelated clients or other devices. Report coverage.
If the shared store fails, use the established conservative local cap and report
the degraded scope; never read an error as unlimited capacity. Unknown quota is
not exhaustion and not permission for unlimited fan-out. Do not switch accounts
or providers to evade a limit.

### D10 — Reuse verification only with a complete proof

Extend `gate-trailer.cjs` through its existing owner for an agent-completed base
merge. Prefer a durable pre-push transaction; allow post-push recovery only when
the judged ancestor, merge parents, unchanged head tree, recorded base tree and
current live PR head all prove equivalence. Changed base, missing objects,
ambiguous ancestry or races require fresh review. Retain original judge,
revision and carry provenance. There is no blanket "same files" review cache.

### D11 — Every optimization is reversible and evaluated

Separate instrumentation from behavior. Each behavior has an independently
selectable treatment, recorded policy version and previous-policy rollback.
Roll back routing/scheduling changes without deleting telemetry or checkpoints.
Do not rollback an acknowledged handoff by reviving its old owner.

Use the [rollout protocol](ADR-011-ROLLOUT.md) before enabling a treatment by
default. Failed, parked and interrupted runs stay in the denominator. A cheaper
but unfinished ticket is not a successful optimization. Unknown measurements
produce an inconclusive result, not a win. A regression creates or reopens a
backlog item linked to the treatment and evidence; policy amendments use that
record rather than session memory.

## Alternatives considered

- Remove Workflow: rejected without a matched experiment; current scripts already
  keep artifacts and control flow out of the parent context. Replacement must
  retain explicit routing, isolation, validation and evidence parity.
- Make Sonnet the executor/orchestrator default: outside the accepted floor and
  outside this rollout. A separate ADR amendment and quality experiment is needed.
- Restart on a fixed age or lower host effort globally: cannot establish actual
  savings and affects unrelated work or judgment quality.
- Raise max_attempts or exempt new reviews: hides loops and has no progress proof.
- Use reconstructed API dollars as a subscription budget: units are not equivalent.

## Consequences and scope fence

The first deliverable is reliable measurement, not a claimed percentage saving.
The program adds schemas, adapters and recovery paths that themselves require
maintenance. Bounded reports and incremental collection limit their overhead;
collector failure must be visible without blocking an otherwise valid merge.

Phases 32–34 are reserved for this program after the existing roadmap.
The operator requested execution on 2026-09-10: isolated read-only tooling in
T-32-01/02 may advance before phases 30/31; their shared source owners remain
reserved, and cold-start integration waits for them. They can
be decomposed into real GSD plans only after file ownership and current source
are rechecked against phases 29–31. This ADR supplies work packages and wave
acceptance, not fabricated Gate-2-approved tickets. No Jira changes, delivery
launch, global model changes or runtime implementation occur in this document.
