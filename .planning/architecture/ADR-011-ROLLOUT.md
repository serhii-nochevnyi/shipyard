# ADR-011 rollout — token efficiency with a feedback loop

- **Status**: accepted execution program; initial T-32-01/02 tooling slice started on 2026-09-10.
- **Date**: 2026-09-10
- **Owner decision**: [ADR-011](ADR-011-measure-the-work-before-optimizing-the-model.md).
- **Backlog inputs**: [coverage register](ADR-011-BACKLOG.md).
- **Scheduling**: phases 32–34 follow the existing 29–31 work. Read-only baseline
  capture can happen earlier. Shared script edits must wait for their existing
  owners to land. The operator authorized taking the program into work: isolated
  read-only T-32-01/02 tooling advances first; cold-start and stats integration
  stay behind the existing owners. Phases 30/31 are not renumbered.

## ADR-012 amendment and canary boundary

[ADR-012](ADR-012-task-level-model-ladder.md) is an accepted, separate
task-level routing amendment. The current Shipyard project enables its
`delivery_pipeline.model_ladder: adaptive` setting so dispatch selection and
telemetry can be exercised on a narrow canary lane. That setting does not close
OPT-03, does not establish a savings result, and does not authorize an online
policy rewrite. Keep baseline collection, quality/recovery gates and one
treatment at a time from this rollout in force. Rollback is setting the project
back to `conservative` and regenerating the Codex bundle.

## Execution contract

`OPT-*` below are design work-package IDs, not dispatchable GSD ticket IDs.
At decomposition, split into `T-32-*`, `T-33-*`, `T-34-*` PLANs with exact
`files_modified`, requirements, dependencies, pre-authorized risks and delivery
blocks. Run the real graph gate before dispatch. Subsystem names below identify
likely ownership; they do not authorize wildcard edits. Packages touching the
same config, journal or command file run serially unless explicitly split.

Each package includes research against the landed source, implementation,
meaningful negative tests, caller/install validation and independent review.
Prompts and generated Codex artifacts are verified through their generator;
never hand-edit installed agents. Merge through the existing conveyor. A
measured threshold below is a proposed rollout criterion, not an observed gain.

## Wave 0 — Phase 32: establish the baseline and inventory

**OPT-01 / REQ-85 — Versioned usage collector and baseline.**
Owner area: existing audit parser, `pipeline-stats.cjs`, new provider adapters.
Implement D1; separate provider/account/project/run/role/backend, ordinary and
advisor usage, stream duplicates and incomplete output. Import the Sept 10 data
as an observational baseline; collect a prospective ticket-attributed baseline.
Acceptance: duplicate replay changes no totals; partial updates reconcile; nested
and advisor passes are counted once; schema gaps produce coverage warnings;
unknown quota stays unknown. Verify a Claude fixture and a distinct Codex fixture.

**OPT-02 / REQ-86 — Backlog inventory and provenance.**
Owner area: new backlog manifest/index tooling and Shipyard cold-start reader.
Split multi-topic notes into stable items; classify current source evidence before
promoting anything. Cover all 39 notes in the initial snapshot, including already
fixed candidates. Bridge GSD 999.x without patching installed GSD.
Acceptance: every source note is represented, duplicate promotion yields the same
item, a source edit makes its verification stale, and the real cold-start caller
retrieves a relevant item. A historical close marker alone does not prove closure.

Dependencies: neither package depends on the other. File-disjoint work can run
in parallel after decomposition. Exit: baseline schema validated, collection
coverage visible, backlog inventory complete. No routing changes in this wave.

## Wave 1 — Phase 32: make effective policy observable

**OPT-03 / REQ-87 — Requested/applied routing reconciliation.**
Depends on OPT-01. Owner area: dispatch-record, attempt-history, Workflow launch
builders, generated Codex dispatch and stats. Join all eight roles to launch and
runtime evidence. Include backend/version capability snapshots; distinguish
unsupported effort from unknown evidence. Do not change escalation yet.
Acceptance: omitted model, inherited model and requested/observed mismatch are
visible; reused agent IDs do not cross-attribute runs; unavailable observations
remain unknown; tests exercise actual caller payloads, not only a parser fixture.

**OPT-04 / REQ-88 — Explicit reviewers.**
Depends on OPT-02. Owner area: reviewers, capability/config, sentinel briefs.
Implement D6 reviewer set with backwards-compatible defaults.
Acceptance: disabling CodeRabbit preserves Copilot requests/evidence; an enabled
unavailable reviewer never appears completed; duplicate status reads post no
comments; migration posts nothing. Review live repository configuration before
selecting its explicit set. Avoid the historical "all reviewers disabled" error.

**OPT-05 / REQ-89 — Advisor visibility and scoped experiment adapter.**
Depends on OPT-01 and OPT-03. Owner area: runtime preflight/adapter and collector.
Report inherited/effective advisor policy, overhead and enforceability. Add a
supported scoped trial switch only after consulting the installed runtime's
current contract. Acceptance: no global settings write; advisor usage is neither
lost nor double-counted; unsupported scope means no behavioral trial.

Exit: every observed dispatch is either reconciled or explicitly unknown; all
roles have coverage status. Baseline does not silently mix policy changes.
OPT-03/04/05 share config/launch surfaces: serialize conflicting PLANs.

## Wave 2 — Phase 33: remove redundant orchestration work

**OPT-06 / REQ-90 — Event-driven deterministic waiting.**
Depends on OPT-01 and OPT-04. Owner area: existing sentinel/front/ci-wait and
`commands/deliver.md`. Move unchanged observation loops into the existing script
layer; bounded backoff, durable wake condition, compact action events.
Acceptance: a replay of unchanged CI/review observations causes no repeated LLM
work request; each meaningful transition is delivered idempotently; network
failure stays unknown; restart recovers outstanding work; merge still reads live
state. Measure actual model turns and tool calls separately.

**OPT-07 / REQ-91 — Bounded role artifacts and targeted context.**
Depends on OPT-02 and OPT-03. Owner area: role references, Workflow result
contracts, Codex generator. Extend rather than rewrite current executor outputs.
Acceptance: all blocking findings remain accessible despite summary caps; stale
or missing artifacts are rejected; child context includes required ADR/scope and
selected backlog items; startup context and parent re-ingestion are measured.

Exit: evaluate OPT-06 and OPT-07 separately against baseline before combining.
No quality gates removed. No claimed quota gain if provider attribution is absent.

## Wave 3 — Phase 33: make short sessions safe

**OPT-08 / REQ-92 — Durable handoff and supported rotation.**
Depends on OPT-03, OPT-06 and OPT-07. Owner area: checkpoint ownership and the
runtime adapter, cold-start and deliver entry points. Ship checkpoint/manual
resume first, recommendation second, supported automatic transfer last.
Acceptance: crash before checkpoint, crash before acknowledgment, double resume,
failed successor launch, changed PR head, dirty owned work and active child all
have tested recovery. Exactly one owner can dispatch. Unsupported backends report
that limit. A clean phase boundary exercises the real handoff on the proving ground.

Initial recommendation policy: at a completed phase boundary, or when the last
five ordinary passes exceed twice that role's prospective startup median. These
are tuning seeds, not restart mandates; the safety boundary always wins. Record
cache warm-up and handoff collection work as treatment cost.

Exit: manual and automated-supported paths resume without missing constraints,
duplicate dispatch or an orphaned PR. Evaluate rotation alone and then with wave 2.
If safe transfer is unproven, keep recommendation/checkpoint mode only.

## Wave 4 — Phase 34: improve convergence and avoid duplicate judgments

**OPT-09 / REQ-93 — Review-aware progress and independent budgets.**
Depends on OPT-03 and OPT-04. Owner area: failure-signature, attempt-history,
reviewers and sentinel. Implement D7 without removing the backstop.
Acceptance: same issue reposted, new real finding, oscillating failures, missing
identity and infra flake are distinguished; a changed head alone cannot reset
progress; resource exhaustion checkpoints rather than fabricating plan_defect.

**OPT-10 / REQ-94 — Capability-aware model-axis escalation.**
Depends on OPT-03 and OPT-09. Owner area: pipeline-config, signature verdict and
launch adapters. Implement D8 only after ADR adoption. Record the distinct reason
for model-axis exhaustion; honor existing ceiling consent and version checks.
Acceptance: unsupported effort plus a verified completed repeated attempt can
advance within the palette; missing evidence cannot; a supported but omitted
argument cannot; exhausted ceiling still terminates under bounded policy.
Cover Workflow, Agent fallback, Codex and in-process guard repair.

**OPT-11 / REQ-95 — Proven verdict carry after a completed manual merge.**
Depends on OPT-03. Owner area: gate-trailer, base-merge and its caller.
Acceptance: unchanged merge can reuse judgment with full provenance; changed base
tree, changed content, missing parent, rewritten ancestry and concurrent head
movement all refuse carry. Verify with real temporary git repositories.

Exit: compare repair attempts and review calls per completed ticket, while tracking
false progress, unjustified escalation and invalid carry. Any invalid carry or
false green disables the affected treatment immediately. Shared sentinel/signature
writers run serially; OPT-11 can be independent with disjoint files.

## Wave 5 — Phase 34: account-scoped admission and continuous tuning

**OPT-12 / REQ-96 — Shared participation-aware agent admission.**
Depends on OPT-01, OPT-03 and OPT-08. Owner area: capacity owner/front, nested
Workflow dispatch and host coordination adapter. Implement D9 leases and report
which clients are covered. Initially use a fixed conservative configured cap;
only adapt to quota after valid samples are available.
Acceptance: concurrent projects cannot over-reserve; expired/crashed owners are
recovered safely; nested launch has no parent/child deadlock; reserved review
capacity completes in-flight work; store failure never becomes unlimited capacity;
unknown account scope does not merge unrelated subscriptions.

**OPT-13 / REQ-97 — Versioned experiment report and next-change intake.**
Depends on OPT-01, OPT-02 and OPT-03; final combined evaluation follows OPT-12
and all treatments being evaluated. Owner area: stats/report generator and backlog
manifest. Record baseline/treatment versions, coverage, outcomes and decision.
Acceptance: repeated report generation is idempotent; failed runs remain included;
partial data returns inconclusive; rollback leaves audit history; findings create
linked candidate backlog items without auto-launching work.

Exit: assess the combined policy only after individual effects are understood.
Enable a proven treatment independently; an inconclusive treatment stays opt-in.
No autonomous online model-policy rewriting from one day's measurements.

## Evaluation protocol

### Cohort and accounting

Freeze repository revision, runtime versions, effective policy and collector
version. Define cohorts before treatment: task type (implementation/repair/review),
risk, size band, repository and backend. Include research/planning cost when
attributable; otherwise report it as shared overhead rather than dropping it.

Use at least 20 completed tickets per arm as an initial pilot target, drawn from
comparable strata, plus every failed/parked/interrupted ticket started in those
arms. If sufficient work is unavailable, label the result a pilot/inconclusive;
20 is not a statistical guarantee. Do not rerun production mutations merely to
manufacture paired data. Use deterministic replays for correctness, prospective
matched cohorts for economics. Alternate comparable assignments where practical
and record selection bias. Never aggregate Claude and Codex as identical tokens.

One treatment at a time. Wait through the predeclared observation period and a
7-day post-merge defect window before default promotion. Report sample size,
median, p90, spread and confidence interval when supported; do not hide tails.

### Metrics and proposed gates

| Metric | Definition | Pilot decision |
|---|---|---|
| Input per verified completion | All arm input, including failed attempts, divided by verified completions; show cache categories and advisor separately | Seek at least 20% lower ordinary input for overhead treatments; report advisor/output tradeoffs separately |
| Orchestrator turns | Model responses per verified completion, separate from tool calls | Seek at least 25% fewer for OPT-06; unchanged-state replay must eliminate redundant work requests |
| Subscription delta | Observed used-window change under known account/window and coverage | Required to claim quota savings; otherwise state quota impact unknown |
| Autonomous completion | Verified completions without unscheduled intervention / all started tickets | No observed deterioration over 5 percentage points; uncertainty can prevent promotion |
| Quality | Escaped defects, reopens, invalid carries, false greens and skipped mandatory review, with severity | Zero false green/invalid carry/skipped mandatory gate; no increase in serious escaped defects |
| Latency | Median and p90 start-to-verified completion, including waiting | No p90 deterioration above 15% unless explicitly accepted for measured savings |
| Recovery | Duplicate dispatch, orphaned owned work, lost constraints after handoff | Zero in failure-injection suite and observed pilot |
| Coverage | Dispatch-to-usage attribution and finalized output coverage | At least 95% attribution for routing comparisons; publish all missing categories; no total-cost claim with incomplete output |

These are initial acceptance targets, not evidence that those improvements exist.
Quality uncertainty is a reason to extend observation, not to call a small sample
safe. Independent review samples matched baseline and treatment patches against
the same acceptance criteria; the optimizer cannot approve its own quality score.

### Report and follow-up lifecycle

Use the [evaluation template](ADR-011-EVALUATION-TEMPLATE.md) for every trial.

For each treatment save a versioned report under `docs/audits/optimization/` with
run/cohort IDs, collection coverage, metrics, quality review, subscription limits
of attribution, verdict (`promote`, `continue_trial`, `rollback`, `inconclusive`)
and next hypothesis. Report generation runs at a completed wave/experiment
boundary, not on every sentinel poll.

A regression creates a candidate item with source experiment, failure signature,
expected outcome, reproduction, affected policy and rollback status. Triage it
through the manifest, amend the ADR if policy changes, then decompose a new wave.
Only evidence-backed closures retire items; all original notes remain readable.
