# Phase 45 research: Codex coordination model and context routing

Status: observational research for INV-008 and proposed D6; no accepted ADR, ticket, model-policy change, or claim of quota savings. Captured 2026-09-28 during phase-43 delivery. Raw account transcripts remain local and are not committed.

> **Owner mapping after 2026-09-28 (#342, #348).** This document uses phase 44's original work-package letters.
> - WP-A/B/C (observation) and WP-I (effort-experiment protocol) were delivered in 0.68.0 as T-44-01..05 and T-44-07.
> - WP-E, WP-D, WP-G and WP-H moved to phase-45 workstream C as C1 (arch-review reuse), C2 (instruction coverage), C3 (research index) and C4 (checkpoint reason).
> - The `usage-report` Codex-stream gap below is tracked as N48 and phase-45 R13.

## Decision boundary

Phase 44 owns provider-specific subscription observations and reporting (WP-A/B/C), mandatory instruction coverage (WP-D), and the controlled native model/effort experiment (WP-I). Phase 45 already owns planning parent-wait overhead (P4), delivery instruction loading (D2), routine wake scheduling (D1), and aggregate launch admission (D5). The newly observed gap is **outer Codex collaboration coordination**: agents outside the ADR-014 native ticket-dispatch ladder inherited a long parent context and Sol/high model while doing routine delivery coordination. Proposed D6 should change only how eligible outer coordination agents receive a bounded handoff and are routed after phase-44 measurement and policy approval. It must not change the native executor, reviewer, or checkpoint model grids by implication.

## Observed phase-43 subscription window

Codex's local subscription `rate_limits` observations for one `codex` weekly (`10080` minute) bucket showed used percentage 16 at 07:01:49 UTC, 22 at 07:59:57, 27 at 08:56:59, 35 at 09:59:59, and 43 at 11:00:20 on 2026-09-28. The reset identity stayed the same. Later snapshots were 46 at 11:16:55, 47 at 11:31:21, and 49 at 11:39:24. These are **shared account observations**, not debits by ticket or model. No short-window `secondary` bucket was present in these local rows. Claude has a separate subscription; its phase-43 runs cannot raise the Codex bucket.

The audit read native rollout files active in the 07:01:49–11:00:20 interval and joined ticket-bound dispatches to authenticated Shipyard receipts. It used the **first** `session_meta.id` of each rollout to identify a child: resumed/forked files can contain inherited parent metadata later, and using that later metadata incorrectly assigns child work to the coordinator. It subtracted the nearest cumulative token counter at or before the start from the last counter at or before the end. Of 46 active files, 45 had a usable within-window baseline; one T-43-05 child began about 20 seconds before the first quota observation and is excluded from the totals below. All identified local sessions were phase-43 ticket work or its coordination. Other devices, hidden provider work, and nonlocal surfaces cannot be excluded from the account percentage.

| Codex work during the window | Sessions | Input tokens | Cached input | Observed model / effort |
| --- | ---: | ---: | ---: | --- |
| Main phase-43 coordinator | 1 | 120.18M | 119.39M | GPT-6 Sol / high |
| Outer collaboration children | 11 | 233.89M | 231.48M | GPT-6 Sol / high |
| Native ticket executor/fix roles | 24 | 43.59M | 41.29M | GPT-6 Luna / max |
| Native ticket roles | 8 | 17.67M | 16.50M | GPT-6 Sol / high |
| Native ticket architecture review | 1 | 3.41M | 3.26M | GPT-6 Sol / xhigh |

The twelve outer coordination sessions therefore account for 354.06M of 418.74M measured input tokens (84.6%); 350.87M of their input (99.1%) was reported as cached. **Neither 84.6% nor the token counts are a measured share of the 27-percentage-point quota increase.** Provider cache weighting and per-session quota debits are unavailable. The evidence does identify where repeated processing occurs and rules out a sizeable unrelated local model session in this interval.

The largest outer sessions were the main coordinator (120.18M), the agent handling T-43-14 handoff and then T-43-10 (60.79M), the agent handling T-43-03 repair and then T-43-06 (46.45M), T-43-07 coordination (29.95M), and T-43-09 recovery (21.27M). The main coordinator had 958 positive input-counter increments with median 131,694 input tokens; the T-43-14/T-43-10 agent had 428 with median 145,137. These are counter increments, **not** verified provider request counts. They show repeated large-context processing. The collaboration agents inherited Sol/high from the parent session, whereas native ticket dispatches had their own ADR-014 model selection and authenticated observed-model receipts.

Examples of the native boundary working as designed: T-43-07's Sol/xhigh architecture review found real safety blockers; its Luna/max repair used 10.31M input over about 46 minutes. T-43-06 selected Sol/high through authenticated `checkpoint->critical` because its plan has `human_checkpoint:true`; the first attempt failed capability preflight **before** a model call. T-43-10's Luna/max executor used 4.78M input and passed 297 targeted tests plus CI. These runs should not be casually downgraded to improve the outer-agent total.

One reporting gap belongs to phase 44, not D6: `usage-report.cjs` returned zero observations for a Codex host stream transcript containing `turn.completed.usage`, while the native session counter path worked. The phase-44 reporting contract should include stream transcript identity and deduplication tests, rather than treating zero as no consumption.

The separate Claude delivery receipts in this audit showed one Sonnet 5 run (7.714M input tokens) and five Opus 5.5 runs (5.345M input tokens in aggregate). No comparable Claude subscription-window snapshot was available, so those token totals cannot establish which Claude model consumed more of its subscription limit. They also cannot be combined with the Codex percentage change.

## Model-change disposition by owner

| Candidate conclusion | Disposition | Reason |
| --- | --- | --- |
| Short-context Luna/max for routine **outer Codex coordination** | Investigate as phase-45 D6 after phase-44 measurement and model-policy approval | The observed repeated context processing is outside the native ADR-014 ticket grid; eligibility, quality and account-window effect remain unproven. |
| Codex native executor, repair, architecture-review or checkpoint model/effort changes | Phase-44 WP-H/I policy and controlled experiment; no phase-45 default change | Critical review found real blockers, and checkpoint routing intentionally selected Sol/high. Preserve the authenticated role receipts and quality gates. |
| Claude Sonnet/high versus max or Opus selection | Phase-44 WP-I with Claude-specific subscription observations from WP-A/B | The few receipt token totals are not quota measurements or a matched quality comparison. |
| Automatic Claude/Codex fallback, quota-driven provider rotation, or a global downgrade | Deferred pending a separate accepted design | Provider accounts and policies are distinct; neither automatic transfer nor quality equivalence is established. |

## Proposed D6 treatment for formal investigation

1. Define a **bounded outer coordination task** as one ticket or review/CI stage with explicit worktree, exact base/head, plan/ADR references, native host entry point, accepted receipts, scope, completion condition and handoff destination. Generate an authenticated, digest-bound handoff from existing graph/receipt state; do not copy the whole conversation or raw transcript into the child prompt.
2. Record outer collaboration session identity, requested/observed model and effort, parent ID, task/phase identity, start/end, token counters, outcome, retries and native child dispatch IDs. Keep outer usage separate from native role usage, then join both to verified ticket completion. An inherited model must be visible as inherited, not reported as an ADR-014 native selection.
3. Evaluate short-context Luna/max as a candidate for **routine Codex delivery coordination only**. Keep Sol for critical reasoning, contested design, independent architecture review and policy escalation. Preserve the native role-host model grid and the human checkpoint. No silent global downgrade, Claude fallback, or automatic cross-provider scheduling.
4. Pilot one treatment at a time after phase-44 WP-A/B/C and WP-I establish provider-specific observation and an approved model experiment. Match ticket complexity and acceptance contract; count all outer agents, native children, failed/abandoned attempts, repairs, escalations, elapsed time, CI, reviewer findings, reopened defects and verified completions. Compare subscription percentage per verified completion only within the same account/reset window with concurrent work recorded; missing or confounded snapshots are inconclusive. Token counters remain diagnostic.
5. Reject or roll back if the short handoff omits a required instruction/evidence source, loses ticket ownership or cancellation, creates duplicate native dispatches, weakens any scope/test/arch/human gate, increases escaped defects or repair burden beyond the accepted non-inferiority bound, or cannot prove the requested/observed outer model. Start in advisory/shadow mode before policy enforcement.

This is narrower than a global model change. The in-flight phase-43 switch to a short-context Luna/max coordinator on T-43-14 is only a feasibility observation: its task, time, dependency state and concurrency differ from the Sol/high baseline, so it is **not** evidence of quality equivalence or quota savings.

## Questions for INV-008 / ADR before implementation

- Which supported interface should bind outer collaboration sessions to ticket and account/window identity without reading raw prompts or assuming the native receipt covers the parent?
- What is the minimum complete handoff for each delivery stage, and how does phase-44 WP-D prove all mandatory Claude/Codex instructions still loaded?
- Which routine coordination stages are eligible for Luna/max, and which measured signals promote to Sol? Does the installed model/capability policy permit each pair?
- Can provider subscription observations distinguish overlapping outer/native work well enough for a matched pilot, or must the result remain inconclusive?
- How should P4's planning parent-wait treatment and D6's delivery outer-agent treatment share a usage identity without making one cross-stage global switch?

Formal investigation must answer these and obtain ADR/policy review before D6 becomes a ticket. The existing phase-45 queue status remains not execution-ready.
