# Phase 33 Context — Reduce orchestration context and transfer sessions safely

Recorded 2026-09-16. Planning callback only. Sources: explicit user request, accepted ADR-011/014, landed code at a141a0c5 (research commit above Phase 36 baseline 54b87dd3). No product changes, release, runtime launch, or policy migration is authorized by this callback.

## Goal and requirements

Unchanged observations stay in deterministic waiting; every role returns bounded summaries with complete referenced evidence; a successor resumes durable state with exactly one acknowledged dispatch owner at a safe supported boundary.

- REQ-90: Unchanged observations do not require repeated model turns; deterministic waiting remains bounded, recoverable and subordinate to live gates.
- REQ-91: Role boundaries return bounded summaries and complete referenced evidence; selected backlog and required policy remain available.
- REQ-92: Context rotation transfers durable state with one acknowledged owner, only at a safe boundary and on a supported runtime.

## Decisions

<decisions>
- **D-01:** Implement and evaluate OPT-06 waiting and OPT-07 artifacts/context separately before OPT-08 checkpoint/manual resume. Recommendation follows manual recovery. No default promotion from fixture success.
- **D-02:** Preserve live sentinel, scope, review, architecture, human approval, and integration gates. Cached observations, artifact digests, or a checkpoint never authorize mutation or merge.
- **D-03:** Preserve ADR-014 and landed Phase 36 resolve/validate/reserve/launch/application-evidence/record boundary for all nine roles and both runtimes. Native grids, authenticated receipts, repair receipt chains, generated static bytes, and host-owned callbacks remain authoritative. No legacy model fallback, inheritance, fabricated application evidence, or historical receipt relabeling.
- **D-04:** Durable waiting uses bounded backoff, semantic transition identity, persistent next wake/deadline, pending delivery and acknowledgment, unknown outage handling, recoverable parking and action deduplication. Keep foreground wake guarantees. JSON replay is not exactly-once external mutation.
- **D-05:** All role boundaries retain complete evidence and blocking findings behind validated references. Extend executor PR-body/evidence files; cap summaries without capping findings. Bind consumers to dispatch, role, repository/worktree, head/base and policy. Reject missing, stale, escaped, tampered and wrong-dispatch artifacts before acceptance/publication.
- **D-06:** Target child context using required plan/scope/ADR/policy and source-hash-verified selected backlog. Preserve mandatory policy through references; packets have an initial 12k estimated-token soft ceiling with explicit overflow. Measure startup and parent re-ingestion separately.
- **D-07:** Manual checkpoint/resume preserves scope, constraints, evidence, next action and current identities; transfer only at a safe boundary with dirty work, active children and ambiguous launches reconciled. One acknowledged owner may dispatch; late predecessors cannot return through rollback.
- **D-08:** Automatic rotation remains unavailable/recommendation-only until a real runtime-specific fresh-context launch, active-child enumeration, application-evidence continuity and acknowledged takeover path is proven. CLI presence, resume/fork help and synthetic fixtures do not prove support. No speculative automatic-launch adapter in this phase's current plan set.
- **D-09:** Canonical files and generation reach both runtimes; never edit installed agents. Serialize shared command, workflow, journal, generator and boundary ownership. New dependencies/global settings/daemon registrations are outside this scope.
- **D-10:** Evaluate one treatment at a time against prospective comparable baseline; retain failed/interrupted work, advisor/cache/handoff costs and missing attribution. Follow ADR-011 rollout cohort/window and quality gates; report inconclusive rather than claim savings without evidence.
</decisions>

These are restatements of user/accepted architecture constraints, not a newly conducted user interview.

## Planner discretion and evidence corrections

- Nine tickets replace the proposed five: producer/consumer ownership splits artifact work into executor, repair/drift, judgments, and research/decomposition. Every ticket remains a usable vertical slice and has two or three tasks.
- Discovery is Level 0 for implementation: existing Node standard library, assert harness, locks, workflow host, dispatch boundary, index and generator; no external dependency/API choice. Existing research is the runtime-capability evidence; absent proof is represented explicitly, not inferred.
- Source commands: read ci-wait.cjs:364-608, state-sync.cjs:1039-1072, executors.mjs:94-145/218-275, fix-round.mjs:73-97/245-285, drift-gate.mjs:59-94/155-210, investigation-research.mjs:1-95, claude-workflow-host.cjs, claude-dispatch-adapter.cjs:375-392, dispatch-boundary.cjs:2030-2165, gen-codex-shipyard.cjs:287-358. Search: `rg -n 'owner|checkpoint|acknowledg|next_wake' plugins/delivery-pipeline/scripts/{ci-wait,dispatch-record,dispatch-boundary}.cjs`.
- Existing repair receipt leases and expiring dispatch marks are not session ownership. Add a distinct local run owner protocol, preserving their responsibilities.
- state-sync metadata publishes last; front generation can disappear on overlay refresh. Read snapshots under the same store lock and verify published metadata; timestamps alone cannot establish consistency.
- Existing executor results cap summary at 500 characters; fix/drift evidence is inline; research still allows inline draft. Workflow DSL has no imports: use trusted host bridge resources, not require calls inside DSL or serializable callbacks.
- Backlog inventory already exports inventory(root, manifest, query), source hashes and stale flags. Actual launch callers must consume it; checked Phase 32 requirements do not prove that wiring.
- Generator copies canonical scripts/references/templates/workflows and hashes the bundle already. Extend tests, not the generator implementation, unless tests prove the existing copy/manifest contract insufficient (then replan scope).
- ADR-014 supersedes the older ADR-011 rollout's conservative/adaptive rollback prose. Rollback toggles these treatments without restoring old model selection.
- Local GSD state is a projection: merged summaries for 32/36 are delivery evidence, not fresh runtime capability proof. No cross-phase graph edge is invented.
- New helper/test paths in plans are proposed additions, not claims of landed interfaces. Their first task creates runnable behavior tests using tests/unit/assert-harness.cjs.
- Estimates: `node /Users/serhii/.codex/gsd-core/bin/gsd-tools.cjs query estimate-calibration` returned factor 1, sample_count 0, confidence low. Raw projections include source reads, implementation and scoped test output.

## Execution order and ownership

T-33-01 → T-33-02 → T-33-03 → T-33-04 → T-33-05 → T-33-06 → T-33-07 → T-33-08 → T-33-09. Waves 1–9 match that chain. Each parent is required for either interface availability or serialized shared ownership.

| Seam | Ordered owners |
| --- | --- |
| deliver.md | 01, 02, 03, 04, 06, 07, 08, 09 |
| state-sync publication metadata | 01 only; observation/state binding for interrupted publication recovery |
| role-artifact.cjs | 02, 04, 07; 03 and 05 consume the generic validator without changing it |
| Claude adapter | 02, 05, 06, 08 |
| Claude host | 02, 08 |
| Workflow executors | 02, 06 |
| Workflow fix/drift and attempt reader | 03, then context integration via 06 adapters |
| investigation/decompose commands | 05, 06 |
| generated bundle test | 02, 05, 09; generator source read-only |
| dispatch-boundary and dispatch journal | 08 only |
| context packet | 06, 07 |
| wait-event store | 01, 07 |
| session handoff | 08, 09 |
| overhead stream | 07, 09 |

No same-wave file/resource writers. The existing event journal schema stays unchanged except bounded artifact references in the repair consumer if its current reader contract requires them; exact ownership is in 03. Usage attribution remains metadata-only; 07 joins a separate bounded overhead stream.

## Verification and delivery gates

Use scoped offline tests per ticket, real command/host consumers and generated-bundle checks. RED must be the intended behavior assertion; fixture/import failure is not RED. Create new tests in each first task before production changes; no separate foundation-only ticket. Full suite belongs to CI. New fake-time slices target under 30 seconds; existing ci-wait/generator suites may exceed a minute and are integration checks.

High-risk tickets 04 and 08 carry delivery.human_checkpoint true with no preauthorization. Implementation may complete autonomously; Shipyard blocks their merge for review. End-of-phase human checks cover the actual clean-boundary manual handoff, generated runtime smoke, and independent treatment reports. Missing runtime support leaves automatic transfer disabled and is reported, not counted as proven.

## Deferred Ideas

Phase 34 convergence/escalation/shared admission/economics engine, model-grid changes, background daemons, external queues, global settings edits, and automatic-launch implementation without host proof. Recommendation and explicit refusal of unsupported automation ARE in scope.

## Multi-source coverage audit

| Source | ID/item | Plans | Status |
| --- | --- | --- | --- |
| GOAL | deterministic waits, bounded context, recoverable handoff | 01–09 | COVERED |
| REQ | REQ-90 | 01,07 | COVERED |
| REQ | REQ-91 | 02–07 | COVERED |
| REQ | REQ-92 | 08–09 | COVERED |
| RESEARCH | W1 observation/backoff/replay/ack/unknown/snapshot/parking | 01 | COVERED |
| RESEARCH | W2 all producers and consumers, full blocking evidence, revision/path safety | 02–05 | COVERED |
| RESEARCH | W3 backlog caller gap, targeted required context and overflow | 06 | COVERED |
| RESEARCH | W3 startup/re-ingestion and independent measurements | 07 | COVERED |
| RESEARCH | W4 owner fencing, ambiguous launch, restart, acknowledgment | 08 | COVERED |
| RESEARCH | W5 recommendation seeds, host capability unknown, proving ground | 09 | COVERED |
| RESEARCH | no-install, runtime generation, trust boundaries, migration/bootstrap | 01–09 | COVERED |
| RESEARCH | isolated trials, coverage/quality/rollback and inconclusive reports | 07,09 | COVERED |
| CONTEXT | D-01 | 01,07,08,09 | COVERED |
| CONTEXT | D-02 | 01–09 | COVERED |
| CONTEXT | D-03 | 02–09 | COVERED |
| CONTEXT | D-04 | 01 | COVERED |
| CONTEXT | D-05 | 02–05 | COVERED |
| CONTEXT | D-06 | 06,07 | COVERED |
| CONTEXT | D-07 | 08 | COVERED |
| CONTEXT | D-08 | 09 | COVERED |
| CONTEXT | D-09 | 01–09 | COVERED |
| CONTEXT | D-10 | 07,09 | COVERED |

## Checker clarification — callback policy and shared owner identity

The current decomposition/checker callback has no explicit critical/checkpoint routing signal. The landed routed resolver returns Codex `gpt-6-astra` / `low` with launch arguments `model: gpt-6-astra`, `reasoning_effort: low`. High-risk *future tickets* 04/08 do not change this callback's signals. Preserve this resolution; do not substitute generic GSD model profiles. A resolver result is not application evidence; this review does not mint a host receipt or assert what model the surrounding session actually applied.

D-07's canonical repository identity is the realpath of Git's common directory, shared by all its worktrees. The runtime owner store/index lives under that directory; a per-worktree graph is only a projection. T-33-08 explicitly tests cross-worktree and changed-run-ID fence bypass, with independent repositories isolated.
