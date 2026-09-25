# Claude development sessions: observed efficiency

Date: 2026-09-25. Supplement to `2026-09-25-pipeline-subscription-efficiency.md`.

## Scope and accounting

Local day: **2026-09-25, Europe/Kyiv (UTC+03)**. Snapshot cutoff: **12:47:44 local**. Selected events from 00:00 local, including sessions that began on earlier days. The original context of those continuing sessions remains part of today's request input; earlier requests themselves are not charged to this table.

Discovered Claude JSONL files under `/Users/serhii/.claude/projects/` whose project directory names identify Shipyard, including repository worktrees. Of 21 files with today's events, 19 contributed unique usage responses; two continuation files contributed no additional unique responses. This is local observed coverage, not a guarantee that remote or generically named temporary sessions are included. Sessions were still active; this is not a full-day total.

Merged usage by stable `message.id`, taking each counter's maximum across streaming fragments/replayed records. Did not add `iterations` on top of response totals or count thinking tokens again as output. A separate call to the repository's `usage-report.cjs` exported `report()` over the timestamp-filtered sources confirmed **861 responses** and the same model totals, without usage-parser warnings. No attribution ledger was supplied: roles below are inferred from the initial task prefix, not verified dispatch receipts. A role name occurring inside an embedded source/diff was explicitly excluded from role classification.

Machine-readable aggregates and source paths: [2026-09-25-claude-session-usage.json](2026-09-25-claude-session-usage.json). Raw prompts and transcript content were not copied into the report artifact. Analysis read the logs and source; no development pipeline or tests were launched and no runtime settings were changed.

## Observed totals

| Metric | Observed tokens |
| --- | ---: |
| Processed input: uncached + cache creation + cache reads | 252,061,225 |
| Cache reads | 245,666,703 |
| Cache creation | 6,392,800 |
| Uncached input field | 1,722 |
| Output | 772,711 |

**97.46% of processed input is cache reads.** This is repeated input processing across requests, not 252 million unique tokens, paid API tokens at one uniform rate, or subscription quota. No monetary or subscription percentage is inferred. The tiny uncached-input field alone would drastically undercount context processing because Claude reports cache creation separately.

| Inferred work category | Responses | Processed input | Share of processed input |
| --- | ---: | ---: | ---: |
| Main orchestrators | 224 | 137,968,609 | 54.74% |
| Executors | 351 | 36,009,741 | 14.29% |
| Integrators | 52 | 32,532,540 | 12.91% |
| Decomposition researcher | 77 | 17,523,458 | 6.95% |
| Planners, including repair-ticket planning | 92 | 14,484,268 | 5.75% |
| Decomposition checker | 46 | 6,867,321 | 2.72% |
| Architecture reviews | 19 | 6,675,288 | 2.65% |

Observed models/effort: 351 Sonnet-5/max responses, 458 Opus-5.5/medium responses and 52 Opus-5.5/high responses. These are transcript observations, not verification that the canonical policy was applied. There is no separately identified sentinel model session in this snapshot. Today's evidence prioritizes parent context and judgment packets above the historical sentinel dispatch count.

## Findings

### 1. Judgment packets automatically include the entire active backlog

All six inspected judgment prompts include **203 selected backlog sections and 203 inventory entries**. Serialized `backlog` is **497,763 bytes** in each. In the four arch-review packets, it accounts for approximately **59–62%** of packet bytes; in the two integration packets, approximately **35–37%**.

Root cause in the inspected checkout:

- `plugins/delivery-pipeline/scripts/claude-role-host.cjs:598` builds a packet without explicit backlog selection.
- `plugins/delivery-pipeline/scripts/context-packet.cjs:240` defaults to all entries except verified-closed, deferred or superseded ones, embedding both inventory and selected content.
- `claude-role-host.cjs:251` enumerates the entire architecture directory; `sourceReferences` makes those files required.

For T-39-14, session `cf6dca95`, the actual packet includes approximately **498 KB backlog**, **255 KB required references**, and a **35.6 KB exact diff**. Its first response processes **345,893 input tokens**. The observed startup payload is dominated by supporting material far beyond the specific diff.

Recommendation: explicit dependency-based ADR and backlog selection, selected-only inventory, one canonical copy per source, and evidence references for optional detail. Do not drop applicable constraints just to fit a number. **Already covered substantially by T-39-17**, which was being delivered by the parallel Claude session; do not create duplicate work. Confirm savings after that implementation is installed and actually used.

### 2. The real role-host ceiling is 360k estimated tokens, not the generic 12k default

`claude-role-host.cjs:24` sets `PACKET_MAX_TOKENS = 360000`; line 611 passes it to the builder. The byte cap is 1,500,000. Thus the generic 12k default discussed in the earlier static audit is not the effective bound on this path.

Examples:

| Session | Role | Initial user prompt, characters | Packet estimate | Observed first-response input |
| --- | --- | ---: | ---: | ---: |
| `ab44bc73` | integrator | 1,363,832 | 340,318 | 587,880 |
| `1c87fe92` | integrator | 1,430,318 | 356,878 | 617,209 |
| `cf6dca95` | arch-review | 817,609 | 203,453 | 345,893 |
| `e5876f0f` | arch-review | 844,627 | 210,214 | 357,716 |

All those packets mark `overflow: false`. Provider input includes surrounding instructions, so this is not a pure tokenizer calibration experiment. Nevertheless, packet-only bytes/4 clearly does not describe the full launch input. The later parent tool result at `2ed5102b:2328` reports `complete role prompt exceeds the bounded launch size`; this was refused before model execution, so it is not counted as a third expensive integrator run.

Recommendation: enforce an admission bound for the complete assembled prompt and compare estimated input with observed first-response usage. Use role budgets and a dependency-aware split when mandatory material cannot fit. T-39-17 already proposes 60k arch-review, 40k sentinel and a diff-dependent integrator bound; the remaining concern is validating that estimator against actual runtime input.

### 3. Long-lived orchestrators are the largest input-processing category

Session `7bcbbf57` has 67 responses with **772,804–858,932** input tokens per response; session `2ed5102b` has 157 responses with **443,362–619,354**. Together they process almost **138 million input tokens**, mostly cached. This category contains useful analysis, installation, coordination and delivery recovery, not only overhead; its full cost cannot be classified as avoidable.

Recommendation: durable handoff/compaction at accepted phase boundaries and before long waits, retaining scope, ownership, pending gates, references and exact next action. Use the existing session-handoff machinery; compare checkpoint, successor startup and cache warmup costs against saved re-ingestion. Avoid replacing every small turn with a fresh full session.

Phase 41 / INV-006 was already discussed in these sessions as the home for orchestrator compaction. This audit supplies a measured baseline for it.

### 4. Six false stop-hook replies consumed 5,097,592 processed input tokens

In `7bcbbf57`, six distinct assistant responses explicitly decline work from another session's board and restate that phase 40 is waiting. Evidence lines: **3813, 3839, 3870, 3920, 3956, 3990**. Summing the corresponding deduplicated message usage yields **5,097,592 input tokens**. This counts only those replies, not every hook event or all waiting-related work.

The transcript identifies the installed hook as reading another worktree's delivery front. The session refers to T-39-03 as the intended ownership fix. The exact installed-version defect is supported here by transcript observations, not a fresh reproduction against the live hook.

Recommendation: session/run ownership must gate hook activation; a foreign board or unchanged wait condition must not wake the model. Verify deployment of the existing fix across installed hook copies. Keep the permission to resume on relevant state changes. This is a concrete avoidable-turn candidate; 5.10m input tokens is still not an equivalent subscription saving.

### 5. T-39-16 was executed twice after host/base recovery

Two Sonnet executor sessions target the same ticket:

- `c6e4acaf`: 109 responses, 14,170,659 input tokens, 83,682 output tokens; its final text reports completed changes and all eight verification commands green.
- `0fde8e7d`: 65 responses, **4,822,956 input tokens**, **41,616 output tokens**; the initial tool sequence reads the existing diff and checks the work again.

Between them, parent transcript `2ed5102b:2124–2184` shows modified files retained in the worktree, executor finalization trouble, a canonical graph/base mismatch, recovery of the parent branch and a fresh executor launch. Pre-push hooks also reject literal `$W`/`$T` paths during recovery. The complete cost of the second run is measured; it is not proven that every token could have been eliminated, because a base change can invalidate verification.

Recommendation: separate execution completion from trusted commit/finalization recovery. Persist a candidate artifact plus exact tree/base/evidence identity; after repairing the host, resume finalization if the identity is unchanged, or perform bounded revalidation when it changed. Do not default to replaying the complete executor task. Give the host explicit canonical paths instead of relying on shell-variable interpretation by hooks.

### 6. Schema and installation mismatches create recovery work; real reviews also found valuable defects

Parent tool outputs show:

- `2ed5102b:1585`: `ticket must be non-empty text`.
- `2ed5102b:1931`: `integrator finding 0.ticket ... must be a non-empty text value` after the model already wrote integration evidence.
- `2ed5102b:2328`: oversized complete prompt before launch.

The parent also reports mismatched `ticket_set` examples, mixed installed/local host versions and artifact preparation deleting an integration report. Treat those broader explanations as transcript-reported unless independently reproduced.

Recommendation: validate installed host/reference/schema compatibility before expensive launches; reuse a completed result through a trusted, identity-checked deterministic normalization only where semantics are unambiguous. A malformed identity or changed code still requires refusal/revalidation. Pin the runtime bundle for a run and expose a digest, so the session does not discover compatibility by repeatedly executing an expensive role. T-39-12/14/16 and ADR-018 already address parts of this chain.

Do **not** remove the integrator: its two substantive passes reported a cross-ticket Jira ownership regression and a bootstrap-to-gsd-sync incompatibility. The phase-40 checker reported four blockers and six warnings, then fixed plan gaps. These findings argue for preserving independent review while shrinking context and avoiding protocol retries.

## Decomposition observations

The ADR-018 addition to phase 40 ran researcher `93ed8d6c`, planner `18e94ccd`, checker `0b98c356`: **148 responses, 29,120,547 input tokens, 198,903 output tokens**. The planner produced 11 additional plans. Researcher's context grows from 31,913 to 374,074 tokens. Planner/checker each request the full research artifact, then further ranges; tool outputs include 50,491-character chunks. These may be necessary reads of a long artifact, not proof of redundant complete reads, but they establish why file-backed handbacks alone do not bound downstream input.

Proposal: structured findings and requirement-to-evidence indexes, relevant plan subsets, explicit unresolved questions and dependency invalidation, preserving exact references for deeper checks. Measure reduced read volume together with checker quality. There is no four-line investigation fan-out identified in today's selected usage; the prior fan-out proposal remains a static architectural recommendation, not a measured explanation for this day's cost.

## Revised priority and existing work

1. **Finish and deploy T-39-17**, then measure real judgment startup input; confirm irrelevant backlog and superseded material disappear without losing governing constraints.
2. **Deploy/verify session ownership for stop hooks**, using the six observed false wakeups as regression evidence.
3. **Phase 41: bounded parent context and local projection fingerprints**, already identified by the live sessions. Validate actual savings; do not count phase planning or an installed version string as proof of adoption.
4. **Recover host finalization without rerunning completed execution**, with exact tree/base/evidence checks.
5. **Host/schema compatibility preflight and research artifact indexing**.
6. Only then compare model changes on matched completed work. Today's ordinary executors already use Sonnet/max, while independent reviews demonstrably found defects.

The installed runtime, integration worktrees and the main checkout are at different stages of delivery. This supplement records observed behavior and planned remedies at the snapshot; it does not claim that T-39-17 or phase 41 is complete or effective.
