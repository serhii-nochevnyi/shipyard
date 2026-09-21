# Phase 33 treatment evaluation protocol

Status: collecting measurement plumbing; no treatment is promoted by this
document.

Related work: ADR-011, OPT-06 / REQ-90 and OPT-07 / REQ-91. The purpose of
this protocol is to measure deterministic waiting and bounded context as two
separate treatments before a combined trial. It does not change the ADR-014
runtime model policy, dispatch boundary, or any live quality gate.

## Frozen experiment identity

Before collecting a cohort, record the repository revision, runtime versions,
effective policy hash, treatment collector version, provider and opaque account
scope, collection dates and subscription reset/window identifiers. A row is
joinable only when it carries the run, dispatch, role, runtime, backend, policy
hash and treatment dimensions. Missing dimensions remain coverage findings.

The graph-local stream is `.planning/graph/orchestration-overhead.jsonl`. It is
append-only and revisioned by `observation_id`. A retry with identical metadata
is ignored; a changed observation appends a higher revision; a reused identity
with different run, dispatch, runtime, policy or treatment fails closed. The
stream contains metadata, source paths, source digests, byte counts, estimates,
counter values and coverage states. It never contains prompts, transcripts,
credentials, source bodies or synthetic provider-token totals.

The collector uses `utf8-bytes-div4-v1` for its explicit estimated-token
counter. Estimated tokens, measured provider tokens and ordinary orchestration
bytes are separate fields. A missing provider observation is `unknown`, not
zero.

## Treatment arms

Each run carries both dimensions, even when one is the baseline:

| Arm | `wait_events` | `bounded_context` | Purpose |
|---|---|---|---|
| Baseline | `baseline` | `baseline` | Existing behavior and complete comparison control |
| OPT-06 | `opt-06` | `baseline` | Deterministic unchanged-observation waiting |
| OPT-07 | `baseline` | `opt-07` | Targeted bounded launch packets and referenced evidence |
| Combined | `opt-06` | `opt-07` | Allowed only after both individual arms have usable evidence |

The default is baseline for both dimensions. A wait record persists the
selection in `wait-events.json`; a context packet measurement carries the same
selection. Turning a treatment off does not delete pending actions, reset a
semantic baseline, or remove mandatory gates. Drain and reconcile an existing
pending action before changing a run's treatment.

## Measurements

The collector records these stages independently:

- `startup`: packet bytes and estimated tokens at child launch;
- `ordinary_input`: bounded ordinary input where a caller has a supported
  measurement;
- `parent_reingestion`: bytes actually returned by a validated role-artifact
  read, including a selected evidence range rather than the full file size;
- `checkpoint_collection` and `cache_warmup`: setup costs when observed;
- `wait_poll`: poll count and timing metadata, with no model response inferred;
- `model_turn` and `tool_call`: counts only when usage or transcript evidence
  supports them.

One thousand unchanged `wait_poll` rows therefore remain one thousand polls and
zero inferred model turns. If no supported response evidence exists, the report
shows model turns and tool calls as `unknown`, never as zero. Usage attribution
is joined read-only from its own ledger; it is not copied into or replaced by
the overhead stream.

## Handoff, recommendation and capability verdicts

Handoff evidence is reported in separate dimensions. Offline correctness of the
owner fence, generated-runtime smoke, real clean-boundary manual resume,
economic pilot and automatic capability are distinct verdicts and must not be
collapsed into one phase result. A successful fixture can therefore be
`verified-offline` while the real manual, economic or automatic rows remain
`unexecuted`, `inconclusive` or `unsupported`.

The rotation recommendation is an advisory observation. It is `recommend` at a
completed phase boundary or when the last five comparable ordinary passes each
exceed twice the prospective startup median for the same role, runtime and
backend. It is `not-recommended` when that comparison is complete but false,
and `unknown` when startup evidence is missing, dimensions are mixed or only
advisor measurements exist. The report retains sample IDs, metric/unit and the
comparison. It never starts a successor or interrupts a live session.

Automatic transfer remains `unsupported`/`unproven` until a strict active
runtime context and host-version-bound proving-ground evidence cover fresh
bounded context, supported launch API, active-child enumeration, durable owner
acknowledgement, dispatch application-evidence continuity and crash recovery.
CLI help, a resume/fork flag, an installed version, a synthetic acknowledgement
or caller-supplied booleans are not evidence. Missing or stale evidence cannot
bypass a live gate or the ADR-014 dispatch boundary.

Checkpoint collection, successor startup and cache warm-up are recorded as
separate metadata-only cost stages. A real cache measurement must be supplied
by the host; the collector never invents a zero for an unobserved cost.

## Cohort and accounting rules

Freeze comparable strata before assignment: implementation, repair or review;
risk; size band; repository; runtime and backend. Include every started
failure, park and interruption, plus advisor, cache and shared planning costs
when they are attributable. Unattributed work is reported as shared overhead.
Do not rerun production mutations to manufacture paired data, and do not drop a
failed treatment run from a savings denominator.

The initial pilot target is at least 20 completed tickets per arm. A smaller
cohort is a pilot and remains inconclusive. Keep a seven-day post-merge defect
window before default promotion. Report sample count, median, p90, spread and
uncertainty where supported, with provider and runtime dimensions separate.

The initial acceptance targets are:

- at least 20% lower ordinary input for an overhead treatment, with cache and
  advisor categories shown separately;
- at least 25% fewer observed orchestrator turns for OPT-06;
- no autonomy deterioration above five percentage points;
- no latency p90 deterioration above 15% without explicit acceptance;
- zero false green, invalid carry, skipped mandatory gate, lost recovery or
  lost constraints;
- at least 95% dispatch-to-usage attribution for routing comparisons.

These are gates for a decision, not results supplied by the offline fixture.
No subscription/quota saving claim is valid without an observed account/window
measurement and complete enough provider coverage.

## Verdict and rollback

Generate a report only at an experiment boundary with
`orchestration-overhead.cjs` and preserve its JSON output with the experiment
revision. The deterministic verdict rules are:

| Condition | Verdict |
|---|---|
| false green, invalid carry, skipped gate, duplicate dispatch, orphaned work, lost recovery or lost constraints | `rollback` |
| missing response/provider/attribution evidence, fewer than 20 completions, or less than seven days of defect observation | `inconclusive` |
| complete evidence and all frozen quality/latency/coverage gates satisfied | `promote` or `continue_trial` according to the declared trial decision |

Rollback changes only the affected treatment selection and preserves the audit
stream. It never revives a superseded session owner, bypasses a live sentinel or
creates a model receipt. A regression records its failure signature, affected
policy and reproduction as a linked backlog candidate; it does not launch a
repair automatically.

For handoff specifically, rollback turns off recommendation/context treatment
for the affected cohort while retaining acknowledged owner fencing, pending
work, dispatch receipts, live gates and ADR-014 selection. Automatic capability
is never promoted by an incomplete savings report; provider/account-window
coverage and the seven-day defect window remain required for an economic
decision.

Offline fixtures verify measurement plumbing and refusal behavior. They do not
prove economic benefit, provider quota savings, runtime-specific transfer, or
promotion readiness. An absent live observation remains explicitly unmeasured.
