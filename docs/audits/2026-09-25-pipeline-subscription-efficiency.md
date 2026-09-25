# Investigation, decomposition and delivery: subscription efficiency audit

Date: 2026-09-25. Source revision: `4830411b`.

Follow-up: [today's Claude session measurements](2026-09-25-claude-session-efficiency.md) provide runtime evidence and revise priorities. In particular, the judgment host overrides the generic 12k packet ceiling with 360k, injects all 203 active backlog sections, and T-39-17 already addresses much of this. The findings below remain the original static audit.

Scope: static analysis of the repository implementation and existing local delivery journal. No pipeline execution, provider benchmark, implementation change or new test run was performed. Findings distinguish current code, historical observations and proposed experiments. This is an advisory audit, not an accepted ADR.

## Conclusion

Prioritize fewer redundant model inputs and launches, especially delivery orchestration, before reducing reasoning quality. The repository already has bounded artifact handbacks, targeted context packets, deterministic drift eligibility, failure signatures, wait events, durable handoffs and measurement tools. The opportunity is to improve their behavior and adoption, not recreate them.

There is insufficient evidence to claim a percentage reduction in subscription consumption. `usage-report.cjs:655` explicitly reports processing units, sets `subscription_usage: null`, and leaves `input_per_verified_completion` uncomputed pending a delivery-outcome join. OpenAI also describes usage as dependent on model, task complexity, context, reasoning, speed, tools and execution location: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan . Context7 was queried first but returned a monthly quota error; the official help page was consulted as fallback. No equivalent quantitative Claude subscription claim is made.

## Evidence collected

Read `commands/{investigate,decompose,deliver}.md`, the investigation workflow, runtime hosts, model policy, context builder, usage/overhead reporting, sentinel and drift eligibility, and existing tests as source material. Used `rg`, `sed`, and a read-only Python aggregation of `.planning/graph/delivery-log.jsonl`. Command sizes were measured with `Path.read_bytes()`; estimates below use bytes/4, not a model tokenizer or billed usage.

| Instruction source | Bytes | Approximate tokens, UTF-8 bytes/4 |
| --- | ---: | ---: |
| investigate.md | 10,607 | 2,652 |
| decompose.md | 37,683 | 9,421 |
| deliver.md | 179,850 | 44,962 |
| references/pr-sentinel.md | 39,616 | 9,904 |

These are potential ingestion sizes, not proof that every dispatch loads every document or incurs uncached processing.

The local journal contains 1,307 events between 2026-08-25 and 2026-09-24, including 421 dispatch records:

| Role | Dispatch records |
| --- | ---: |
| pr-sentinel | 138 |
| executor | 85 |
| review-fix | 67 |
| arch-review | 65 |
| drift-check | 42 |
| ci-fix | 21 |
| integrator | 3 |

Sentinel accounts for 32.8% of recorded dispatches. This is not its token or quota share. The journal mixes historical versions and runtimes; 270 dispatch records lack a model field. There are 147 attempt events, including 114 review-fix events, but these must not be equated with 147 distinct agent launches. Of 38 reuse-scan results, 37 are fresh and one stale. A fresh result can still be valuable evidence and does not prove a scan was unnecessary.

No JSONL usage/overhead/telemetry measurement files were found under the checked `.planning` tree. Such records may exist in external runtime stores or transcripts; this audit did not search personal transcript archives. Counts cannot establish current policy compliance, historical spend or causal savings.

## Prioritized proposals

### P0 — Make optional context reduction effective

Evidence: `scripts/context-packet.cjs:441–466`. When an oversized packet has optional references, the builder removes their content and computes `reducedEstimate`. If this brings the packet below the ceiling, it restores the full optional content. Thus, for sufficiently large optional sources, the successful reduction is undone. The 12,000-token ceiling is explicitly soft; required material is retained.

Proposal: retain digest-verified references when optional content removal achieves the target. Treat “content omitted” separately from “required material exceeds the ceiling”; currently validation at approximately line 564 allows omitted optional content through the overflow path. Update builder, validator and contract together. Keep policy, acceptance criteria and constraints complete.

Existing source test `tests/unit/context-packet.test.cjs:142` explicitly describes retaining optional content. This needs a deliberate contract revision and a case with a genuinely large optional file. The behavior is confirmed by static control-flow inspection, not a reproduced failing test. Measure serialized bytes and downstream retrievals; an index that immediately forces every worker to reread the whole source would merely move the cost.

### P0 — Load delivery instructions by stage and runtime

Evidence: `commands/deliver.md` is 2,870 lines and approximately 45k tokens by bytes/4. It combines cold start, runtime protocols, tracker operations, execution, repairs, sentinel, integration, telemetry and recovery. The sentinel brief is another approximately 10k estimated tokens.

Proposal: a small common entry contract plus explicit stage modules and runtime-specific modules. A host assembles only the current stage's instructions and mandatory invariants. Move historical incident narratives and duplicated dispatch examples into reference documents. Preserve a versioned manifest that proves required rules are included, including recovery and cross-repository handling when relevant.

Suggested engineering target: common entry below 3–5k estimated tokens, with stage-specific additions measured separately. This is a proposed target, not a predicted saving. Evaluate full prompts and ancestor context, not only packet accounting.

### P0 — Connect existing measurements to verified outcomes

Evidence: `scripts/usage-report.cjs:655–677`, `scripts/orchestration-overhead.cjs:15–38`, and the missing local measurement streams. Phase 33/34 verification projections say the work was delivered; they are not comparative efficiency measurements.

Proposal: automatically collect provider-supported usage for parent orchestration and child dispatches, join it to durable receipts and completed delivery outcomes, and report input, cached input, output/reasoning where supported, attempts, failed/parked work and model/effort. Avoid double counting reasoning or cached tokens that are subsets of provider totals. Include nested work inside a checker callback; “three receipts” alone is not proof of only three model calls.

Use the existing baseline/treatment machinery, which already defines a minimum of 20 completions and a 95% attribution target. These are readiness thresholds, not statistical proof. Report median and p90 cost per verified completion, total cohort cost, reopens and escaped defects. Keep missing usage unknown. Record observed subscription allowance changes only when available and comparable; never infer them from bytes/4.

### P1 — Make sentinel orchestration deterministic

Evidence: `commands/deliver.md:291–327` launches a Codex sentinel per ticket; Claude supports round membership. `references/pr-sentinel.md:126` directs the agent to run `state-sync`, obtain deterministic `sentinel duty`, serve actions and return when only CI waits remain. The journal has 138 sentinel dispatch records.

Proposal: move the routine state/duty/dispatch loop into the trusted host/controller. Reserve LLM calls for code repair and architectural judgment. Persist reservations, use existing wait events/waker, and invoke model work only when a duty or relevant evidence changes. Keep live merge checks and every repair/review dispatch inside the existing boundary.

The existing inline-duty fallback demonstrates that duty enumeration need not itself be a model launch. Productionizing it requires controller ownership and recovery, not merely toggling `pipeline.sentinel: off`, which can transfer overhead to the parent model. Do not count shell polls as LLM turns: polling already happens in scripts. Measure eliminated model turns and parent re-ingestion.

### P1 — Adapt investigation fan-out while preserving four perspectives

Evidence: `workflows/investigation-research.mjs:90` requires exactly four research lines; `commands/investigate.md:80` starts four workers, and `scripts/model-policy-internal.cjs:69` routes Codex research to Sol/high by default. Every line receives shared problem/contract material, and the synthesizer copies findings into several documents.

Proposal: determine research scope with a cheap repository index and explicit complexity criteria. For a bounded problem, one researcher can produce all four clearly separated sections; medium work can use two workers; complex or high-risk work retains four independent workers. Preserve coverage of system state, alternatives, constraints and risks regardless of worker count. Maintain an evidence index instead of repeatedly copying complete findings into multiple downstream documents.

This requires coordinated changes to workflow validation, artifact ownership, receipt cardinality and command contracts. Never fabricate four dispatch receipts from one launch. Four-to-one workers means 75% fewer worker starts for eligible investigations, not 75% less usage: the remaining worker does more work and synthesis still costs tokens. Risk: correlated blind spots; retain independent critique for high-risk decisions.

### P1 — Reuse investigation evidence in decomposition

Evidence: `commands/decompose.md:285–309` sends shared context to exactly three callbacks: phase researcher, planner and checker. Investigation has just produced research artifacts. Checker convergence can include up to three cycles internally (`decompose.md:362`).

Proposal: make the mandatory researcher first validate and reuse INV evidence, then research only gaps relevant to implementation. Key reuse by repository, source/reference digests, ADR/problem digest, policy version and evidence scope. Begin with exact revision reuse; broader reuse needs dependency-aware invalidation. Keep planner/checker independence. A valid reused artifact is not a new research execution receipt.

Use deterministic schema/graph validation before semantic checking, so a costly checker does not discover mechanically detectable defects. Track unresolved finding IDs across convergence cycles; rerun only affected plan sections with all applicable constraints. Stop when findings are resolved; retain the cycle ceiling for unresolved cases.

### P1 — Reduce repair rounds and per-ticket fixed overhead

Evidence: the journal has 114 review-fix attempt events. `commands/decompose.md:251` exposes coarse/standard/fine granularity. Each ticket adds execution, publication, review, sentinel and merge overhead. Delivery already supplies attempt hypotheses and signed failure signatures.

Proposal: collect all actionable comments for the same PR head into a single repair input; deduplicate by comment/failure identity and invalidate when head/evidence changes. Preserve the prior rejected hypotheses and require a materially new hypothesis on a repeat. Measure actual review-driven rework before selecting an earlier model escalation.

Prefer cohesive tickets with one acceptance boundary and rollback unit. Use coarse slicing selectively for low-risk related changes, not globally. Larger PRs can increase defect rates and review cost, so compare total verified-delivery cost, not ticket count. Existing granularity is a usable tuning knob; it does not justify bypassing the planner.

### P2 — Extend evidence-keyed reuse for drift and reviews

Evidence: `scripts/drift-needed.cjs` already prefilters by the ticket's actual base and affected directories; sentinel already checks that architectural conformance belongs to the current head. These optimizations must remain.

Proposal: assess repeated equivalent scans using a key containing repository, plan/ADR digests, relevant source/base identity, policy and tool versions, and evidence scope. Reuse only when dependencies are proven unchanged. Batch deterministic fetch/index preparation per repository and base. Keep separate ticket decisions and invalidate unknown or stale evidence. Do not remove drift gates merely because 37 of 38 historical scans were fresh.

### P2 — Add run-wide admission budgets using existing resource primitives

Evidence: `scripts/failure-signature.cjs:154` already evaluates token/time/capacity budgets; session handoffs store budgets, and controllers support quota waits and retry limits. The inspected launch boundary does not demonstrate a common aggregate pre-launch token budget across all three stages.

Proposal: connect those primitives to one host-owned run/phase budget, reserving estimated capacity atomically before concurrent launches and reconciling with usage afterward. Protect enough remaining capacity for verification and durable checkpointing. Unknown usage must be explicit; use conservative launch/attempt caps where token evidence is unavailable. Exhaustion produces a resumable resource state, not a correctness failure or permission to skip gates. This limits runaway consumption; it is not a hard guarantee on provider billing for an already-running call.

### P2 — Experiment with narrower model policy changes

Evidence: `scripts/model-policy-internal.cjs:69–103` already uses Luna/max for normal Codex executors/repairs, Luna/medium for sentinel, and Sol/high for research/decomposition/architecture/integration. Model and effort overrides conflicting with canonical policy are rejected. Claude has its own separate ladder.

Proposal: preserve the executor baseline. First test Luna/max for bounded factual research or mechanical plan validation, keeping Sol for alternatives, ambiguous decisions and independent semantic review. Evaluate the complete cost including retries; a cheaper first call that increases repairs may be worse. Change canonical policy, fingerprint, generated roles and validation together under an accepted design. Setting a legacy economy/model profile alone is not a reliable override of ADR-014 dispatch policy. Do not infer Claude results from Codex experiments.

## Suggested rollout

1. Establish usage/outcome joins and fix optional-context handling, then compare actual prompt sizes.
2. Split delivery instructions and make deterministic duty handling the normal controller path; retain receipts, merge gates and recovery guarantees.
3. Introduce research reuse and adaptive fan-out with explicit coverage contracts.
4. Tune ticket granularity, repair grouping and model roles on matched workloads after measurement is reliable.

Proposed experiment target: at least 20% lower processing input per verified completion with no observed increase in false greens, skipped gates, lost constraints, duplicate dispatches or escaped defects. This is an acceptance target to test, not an estimate of subscription savings. Also report output/reasoning, completion rate, p90 and rework so optimizing input alone cannot hide worse overall performance. Evaluate treatments separately before combining them.
