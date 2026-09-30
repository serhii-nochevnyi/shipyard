# Model ladder refresh after the September releases

Date: 2026-09-30. Status: advisory research and proposed policy amendment, not an accepted ADR, authenticated four-line INV result, activated experiment, or production configuration change.

## Recommendation

Update the Codex Sol target to GPT-6.1 Sol. Per the operator's September 30 revision, propose GPT-6.1 Sol/low everywhere the earlier proposal selected GPT-6 Luna/max: native execution, initial repair, drift-check and routine outer coordination. Retain the current Luna/max selections only as historical controls. For Claude, make Sonnet 5.5 explicit and evaluate medium/high execution instead of inheriting Sonnet 5/max. Per the operator's further revision, use Sonnet 5.5/xhigh wherever the proposal previously selected Opus 5.5/medium, including research, planning and independent judgment. Retain Opus 5.5/high as the capability escalation. Optimize outer coordination and context separately from native role selection; this is where the existing observations identify the largest repeated-input burden.

This recommendation has two stages: refresh existing Sol/Sonnet identities with unchanged role efforts and quality gates, then separately evaluate the proposed Luna/max → Sol 6.1/low replacement and Claude effort/role-placement changes. Each change needs its own attributable results. No measured subscription-saving percentage is available.

## Scope and inspected baseline

The checkout is dirty main at `22ef429b5cf6f7326065e11ba9c5b56c4bfe4f13`. The frozen local remote-tracking main is `9e9ddbf575c8ab3f8265b0641f5df9a1bebd2245`; this audit did not fetch or reconcile live GitHub state. These surfaces must not be treated as identical.

The installed `/Users/serhii/.codex/shipyard/scripts/model-policy-internal.cjs` exports `adr-014.v6`, fingerprint `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968`. Its runtime adapters map Luna to `gpt-6-luna`, Sol to `gpt-6-sol`, Opus to `claude-opus-5-5`, Sonnet to `sonnet`, and Fable to `fable`. Astra is registered but no routed rung selects it. The installed CLI versions are Codex 0.159.2 and Claude Code 2.1.285. A CLI version or this session's tool palette is not proof that a Shipyard dispatch can apply every new selection.

The existing [ADR-014](../../.planning/architecture/ADR-014-mandatory-runtime-model-ladder.md) and installed canonical grid agree on the following relevant defaults:

| Role | Current Codex | Current Claude |
|---|---|---|
| research / decomposition | Sol/high | Opus 5.5/medium |
| executor | Luna/max; critical/checkpoint → Sol/high | Sonnet/max; critical/checkpoint → Opus 5.5/low |
| arch-review / integrator | Sol/high; critical/contested → xhigh | Opus 5.5/medium; critical/contested → high |
| ci-fix / review-fix | Luna/max → Sol/high → Sol/xhigh | Opus 5.5/medium → high → high |
| pr-sentinel | Luna/medium | Sonnet/high |
| drift-check | Luna/max | Opus 5.5/high |

Claude arch-review additionally selects Fable/medium when measured input exceeds 250,000 tokens. Normal executor complexity and large context do not by themselves authorize promotion. Repair promotion requires the preceding compliant applied receipt.

## Verified release facts

Context7 was queried first for Claude Code and Codex documentation; both requests returned a monthly-quota error. The fallback was fetched official vendor documentation. OpenAI Docs was also applied. Facts below describe vendor releases, not measured Shipyard outcomes.

| Release | Official facts relevant to this proposal |
|---|---|
| Claude Sonnet 5.5, September 28 | Concrete ID `claude-sonnet-5-5`; intended for focused everyday work. Anthropic reports faster generation and fewer tokens per task than Sonnet 5. Haiku 5.5 is still announced for coming weeks, not released. [Release](https://www.anthropic.com/claude-sonnet-5-5). |
| Claude Opus 5.5, September 22 | Already pinned in Shipyard. Anthropic positions it for sustained judgment and reports lower task costs than Opus 5 in its evaluations. [Release](https://www.anthropic.com/claude-opus-5-5). |
| GPT-6 Sol and Luna, September 22 | Already represented by Shipyard's runtime mapping. [Official changelog](https://learn.chatgpt.com/docs/changelog). |
| GPT-6.1 Sol, September 29 | New target `gpt-6.1-sol`; OpenAI recommends it for complex coding and repeated long-running work. Access depends on account, client and workspace rollout. [Official changelog](https://learn.chatgpt.com/docs/changelog), [model guidance](https://learn.chatgpt.com/docs/models). |

Claude Code 2.1.284 changed the Sonnet alias to 5.5 on the Anthropic API. The installed 2.1.285 therefore has the relevant alias behavior, but pins, gateways and restrictions can change the actual selection. Medium is the new default for both 5.5 models; effort is calibrated per model rather than comparable by name across generations. Both have native 1M context on the direct Anthropic API. [Claude model configuration](https://code.claude.com/docs/en/model-config).

### Economics: compare the right quantities

| Claude API USD per 1M tokens | Input | Cache read | Cache write, as listed on release page | Output |
|---|---:|---:|---:|---:|
| Sonnet 5.5 | 2 | 0.20 | 2.50 | 10 |
| Opus 5.5 | 4 | 0.20 | 5 | 20 |

Source: [Sonnet 5.5 pricing comparison](https://www.anthropic.com/claude-sonnet-5-5). These are API rates, not subscription debits. Identical cache-read rates are particularly relevant to cached coordination workloads: changing Opus to Sonnet alone does not halve that component. Lower effort can also lose its apparent advantage if repairs or verification work increase. Conversely, the operator-selected Sonnet 5.5/xhigh replacement raises reasoning effort versus the Opus 5.5/medium control; its lower input/output rates do not establish lower total cost. Compare reasoning/output, repairs and complete accepted outcomes.

| Codex Standard credits per 1M tokens | Input | Cached input | Output |
|---|---:|---:|---:|
| GPT-6 Luna | 2.5 | 0.25 | 12.5 |
| GPT-6 Sol | 50 | 5 | 250 |
| GPT-6.1 Sol | 50 | 2.5 | 250 |
| GPT-6 Astra | 250 | 25 | 1,250 |

Source: [Codex pricing](https://learn.chatgpt.com/docs/pricing). Sol 6.1 halves the listed cached-input credit rate versus Sol 6, with unchanged input/output rates. Luna remains 20 times cheaper on input/output and 10 times cheaper on cached input than Sol 6.1 for equal token counts. These ratios are credit-rate arithmetic, not task-cost or subscription-saving predictions. The operator-selected Sol 6.1/low candidate has higher per-token rates than the Luna/max control; lower reasoning effort and fewer repairs may offset this, but that is an empirical hypothesis. The revised objective is stronger baseline capability with bounded reasoning, evaluated by total cost and quality per accepted outcome.

Fast mode consumes included Codex allowance at 2.5 times Standard, while purchased-credit billing uses a 2-times multiplier. Use Standard for the efficiency baseline. Max extends reasoning; Ultra introduces subagents and must not be treated as just another effort step. [Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [effort guidance](https://learn.chatgpt.com/docs/models).

For API-backed deployments specifically, Sol 6.1 lists 1,050,000 context and different pricing above 272K input tokens. Do not apply that API pricing rule to ChatGPT-authenticated Codex without a matching product contract. [API model reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

## Proposed native ladders

These are candidate selections, not selections currently permitted by overriding project config. Model identity, effort, signals and observed application must remain a versioned boundary contract.

### Codex: first rollout candidate

`Sol 6.1` below means `gpt-6.1-sol`; `Luna` means `gpt-6-luna`. The operator revision replaces every previously proposed Luna/max selection with Sol 6.1/low. Luna/medium for pr-sentinel remains unchanged because it was outside that requested replacement.

| Role | Base | Escalation | Difference from current policy |
|---|---|---|---|
| research | Sol 6.1/high | Sol 6.1/xhigh for explicit very-complex | Sol identity only |
| decomposition | Sol 6.1/high | Sol 6.1/xhigh for critical/checkpoint | Sol identity only |
| executor | Sol 6.1/low | Sol 6.1/high for critical/checkpoint | Operator-selected model + effort replacement; compare against current Luna/max |
| arch-review | Sol 6.1/high | Sol 6.1/xhigh on existing judgment signals | Sol identity only; preserve independent review |
| integrator | Sol 6.1/high | Sol 6.1/xhigh on existing judgment signals | Sol identity only |
| ci-fix / review-fix | Sol 6.1/low | Verified repeat → Sol 6.1/high; verified repeat_exhausted → Sol 6.1/xhigh | Preserve verified predecessor chain; amend its required base selection from Luna/max to Sol 6.1/low |
| pr-sentinel | Luna/medium | No automatic tier promotion | Unchanged; reduce unnecessary launches first |
| drift-check | Sol 6.1/low | No automatic tier promotion | Operator-selected model + effort replacement; deterministic eligibility first |

Do not lower every Sol role to medium during this identity refresh. Although vendor guidance recommends starting from defaults, that is not proof of non-inferiority for Shipyard's judgments. Sol 6.1/medium is a separate later treatment. Evaluate the operator-selected Sol 6.1/low base for bounded execution and repair against the current Luna/max control, without lowering independent reviewer effort.

Keep Astra out of the ordinary routed grid. A future separately approved rescue lane could use Astra/low after a verified unresolved Sol 6.1/xhigh attempt or an explicit hardest-work classification. Infra failures, quotas and stale context are not capability evidence. Astra is an experiment candidate, not an automatic response to every repeated failure.

### Claude: measured optimization target

`Sonnet` below means pinned `claude-sonnet-5-5`; `Opus` means the existing `claude-opus-5-5`. First pin/verify identity while retaining current efforts; introduce the following placements one treatment at a time. Per the operator revision, every previously proposed Opus/medium placement becomes Sonnet/xhigh. Historical Opus/medium observations and controls remain unchanged.

| Role | Candidate base | Candidate escalation | Disposition |
|---|---|---|---|
| research | Sonnet/xhigh | Opus/high for very-complex | Operator-selected replacement; compare with current Opus/medium |
| decomposition | Sonnet/xhigh | Opus/high for critical/checkpoint | Operator-selected replacement; preserve semantic planning/checking contract |
| executor | Sonnet/medium | Sonnet/high after capability-related failure; Sonnet/xhigh for critical/checkpoint; Opus/high for proven harder reasoning | Test medium/high/xhigh against the max control; critical work starts directly on Sonnet/xhigh |
| arch-review | Sonnet/xhigh | Opus/high for contested/critical | Operator-selected replacement; preserve independent reviewer and known-defect detection |
| integrator | Sonnet/xhigh | Opus/high for contested/critical | Operator-selected replacement; preserve independent integration judgment |
| ci-fix / review-fix | Sonnet/high | Verified repeat → Sonnet/xhigh; verified repeat_exhausted → Opus/high | Separate role-placement trial against current Opus control; verified predecessor chain retained |
| pr-sentinel | Sonnet/low for a bounded actionable duty | Return to host classification if outside scope | Separate trial; host owns unchanged-duty waiting and gates |
| drift-check | Sonnet/medium for bounded semantic inventory | Refuse/reroute uncertain scope through a defined policy amendment | Separate trial; keep current Opus/high control |

The executor's existing Opus/low critical rung becomes a control for the proposed Sonnet/xhigh critical placement. Validate critical fixtures and escalation behavior; Sonnet/xhigh is the operator-selected candidate, not evidence of equivalence to Opus. Model tier and effort are separate axes, so Sonnet/xhigh → Opus/high is a capability escalation despite the lower-named effort. Do not redefine administrative checkpoints as harmless during this model refresh; retain conservative treatment for unknown reasons until the typed checkpoint contract is installed.

Revisit Fable's window-only ceiling separately. A >250K packet is no longer evidence that Opus 5.5 lacks context capacity on the direct API. Preserve the current rule until its amendment is accepted, then test an Opus/high control against the existing Fable treatment. Account/provider capacity, reasoning quality and unnecessary packet size must be distinguished. Fable remains an explicit capability experiment candidate, not a universal fourth rung. Haiku 5.5 remains a future re-evaluation trigger.

## Fewer cross-model transitions: operator hypothesis

The revised ladder keeps more Codex work on Sol 6.1 with low/high/xhigh effort and more Claude work on Sonnet 5.5 with medium/high/xhigh effort. Opus/high remains a capability escalation. This reduces the proposed number of model families used along common execution and repair paths.

Hypothesis: a stronger base can avoid failed attempts and escalation, while fewer cross-model transitions can reduce startup and context handoff work where the host actually creates a new session. An effort change does not itself prove session continuity, cache reuse, or lower quota consumption; those depend on the host and provider. Do not attribute a saving to model continuity without observing it.

Evaluate transition count together with accepted completions, repair frequency, escalation frequency, startup/warmup usage, total reasoning/output and account-window deltas. The expected benefit is fewer total attempts and repeated inputs per accepted completion. Higher Sol token rates and Sonnet/xhigh reasoning can outweigh that benefit, so the quota conclusion remains empirical.

## Outer coordination and optimization dependencies

The [September 25 Claude audit](2026-09-25-claude-session-efficiency.md) attributed 54.74% of processed input to main coordinators; 97.46% of all processed input was cache reads. The [September 30 analysis](2026-09-30-pipeline-critical-analysis.md), citing September 28 phase-43 observations, reports 84.6% of measured Codex input in outer coordination. These are prior observations with attribution limits, not newly measured quota shares.

| Layer | Proposed treatment | Boundary |
|---|---|---|
| Deterministic scheduling/waits | Compute duty changes, readiness and waits in the host; no model turn for unchanged duty | Preserve owner binding, cancellation, CI and review gates |
| Routine outer Codex coordination | Short authenticated handoff + Sol 6.1/low, replacing the earlier Luna/max proposal | Separate from native execution; critical/contested judgment stays on Sol 6.1/high or xhigh |
| Routine outer Claude coordination | Short handoff + Sonnet 5.5/medium candidate; Sonnet 5.5/xhigh for real design/recovery reasoning; Opus 5.5/high for proven harder reasoning | Separate outer treatment; native reviewer placement is evaluated independently |
| Long-lived main coordinator | Measure loaded context and bounded successor startup/warmup; route substantive reasoning explicitly | A history-copying fork is not a fresh short context |
| Review/research reuse | Use exact governing-input identity and source provenance | New model, effort or policy changes invalidate relevant reuse/cohort identity |

The installed canonical nine-role grid does not govern the outer coordinator. Updating it alone cannot prevent parent-model inheritance in outer agents. Outer model/effort, actual loaded instructions, parent/child identities and usage must be observed explicitly.

The accepted D6 scope still names Luna/max; the new Sol 6.1/low candidate requires a recorded amendment before activation. The operator's proposal revision does not rewrite that historical decision or authenticate a new dispatch.

Align implementation with ADR-021/022/023 in frozen `origin/main`: phase-44 observation/experiment contracts and phase-45 D1/D2/D6, C1/C2/C3 and R13 already own adjacent work. Do not duplicate those packages or expand an in-flight ticket silently. The local untracked phases 43/44 use older numbering. Reconcile the final owning tree before allocating implementation plans.

## Adoption and validation plan

1. **Freeze controls.** Record repository and installed-host revisions, model policy/hash, requested/applied/observed model and effort, speed, provider and instruction identity. Separate outer coordination, role wrappers and native workers. The model availability check must be followed by a real bounded host dispatch; this audit has not performed one.
2. **Refresh identities first.** Propose an ADR-014 amendment for Sol 6.1 and pinned Sonnet 5.5. For the identity-only slice keep current efforts and signals; the subsequent Sol 6.1/low base replacement and Opus 5.5/medium → Sonnet 5.5/xhigh replacement each change both model and effort and need their own policy/experiment identities. Update canonical adapters/grids, generated agents, native dynamic/static launches, capability checks, policy fingerprint, installation and negative fixtures together. Existing `codex-model-remap.cjs` refuses noncanonical replacements; a config-only override is insufficient.
3. **Retain exact evidence.** Pin the Sonnet observation check rather than accepting any family version through the current `matchesModelObservation` regex. Confirm effort was applied, including organization clamps; provider fallback cannot be reported as the requested model. Preserve historical policy and receipt bytes and reconcile in-flight work before new-policy dispatches.
4. **Measure context changes independently.** Bounded mandatory instructions, owner-correct wakes, exact review reuse, source indexing and finalization recovery precede claims about model savings. Hold context fixed for model tests and model selection fixed for context tests.
5. **Run separately approved treatments.** Start with Sonnet 5.5 medium/high/xhigh execution against the existing max control and the operator-selected Sol 6.1/low treatments for execution, initial repair, drift-check and short-context outer coordination. Compare the native treatments against current Luna/max controls and the outer treatment against the observed Sol/high control. Separate bounded-handoff changes from the outer model/effort change. Separately evaluate Sonnet 5.5/xhigh against the existing Opus 5.5/medium controls for research, decomposition, independent review, integration and the affected repair/coordination rungs. Replay known review findings and planning blind spots. Then test fixed-role effort. Keep independent review and the same acceptance criteria in every arm; include failure, abandonment, repairs, escalation, startup and warmup costs.
6. **Use existing evidence floors.** ADR-021 requires a recorded human promotion decision after at least 20 completions, 95% attribution and seven days. Its current schema does not authorize arbitrary new model-pair treatments: version the schema/eligibility before activating them. Predeclare quality tolerances and stop conditions; a small pilot is feasibility evidence, not automatic production promotion.
7. **Evaluate complete outcomes.** Compare accepted completions, escaped/reopened defects, safety/ownership failures, repair and escalation frequency, total tokens by category, elapsed time and attributable subscription-window deltas. Preserve decimals and account/reset boundaries. Confounded or missing quota observations produce `inconclusive`. Stop on a severe regression; revert only the new versioned treatment while retaining evidence and gates.

## Evidence and unresolved points

The companion [evidence index](2026-09-30-model-ladder-refresh-evidence.json) records inspected file digests, policy identity, commands and source URLs. Source review and document checks were performed; no benchmark, native model worker, accepted-ADR ceremony, ticket/PR, or model-policy activation was performed.

Remaining empirical questions are whether Sol 6.1/low improves complete-outcome cost and quality versus Luna/max in the replaced lanes, Sol 6.1 preserves known review findings, Sonnet 5.5/medium reduces complete-outcome cost without more repair, Sonnet 5.5/xhigh preserves judgment quality and improves complete-outcome economics versus Opus 5.5/medium, bounded outer coordination preserves ownership/instruction coverage, and provider quota observations can isolate these treatments. Vendor benchmarks and the API/credit rate tables do not answer those questions.
