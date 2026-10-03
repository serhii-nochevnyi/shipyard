---
status: accepted
---
# ADR-024 — Model ladder refresh

- **Status:** accepted; locked operator substitutions and expedited native scope, authenticated INV-011 Gate 1
- **Date:** 2026-09-30
- **Decision owner:** repository maintainer; exact ladder selected in the INV-011 dialogue
- **Scope:** phase 46; native ADR-014 policy, adapters, generated roles, application verification, scoped tests and installation provenance
- **Supersedes:** current ADR-014 model/effort selections; historical evidence remains immutable
- **Related:** ADR-014, ADR-021, ADR-022, ADR-023
- **UI design:** none

## Context

The operator requests prompt adoption of the September 30 model proposal, with GPT-6.1 Sol/low replacing every proposed Luna/max placement and Sonnet 5.5/xhigh replacing every proposed Opus 5.5/medium placement. The operator authorizes investigation, decomposition and execution, retaining independent gates and ongoing phase-43/45 ownership.

The [advisory audit](../../docs/audits/2026-09-30-model-ladder-refresh.md) records official release research and inspected baseline evidence. Official references include [Codex model guidance](https://learn.chatgpt.com/docs/models), [Codex pricing](https://learn.chatgpt.com/docs/pricing), [Sonnet 5.5 release](https://www.anthropic.com/claude-sonnet-5-5) and [Claude model configuration](https://code.claude.com/docs/en/model-config). These vendor facts do not prove that a Shipyard worker applies a requested selection or establish subscription savings.

[INV-011](../investigations/INV-011-model-ladder-refresh/PROBLEM.md) and its [locked decisions](../investigations/INV-011-model-ladder-refresh/DECISIONS.md) establish the authorized scope. All four canonical Codex-host research lines completed at source revision `c105349656e445275db8b72cebd398c670f1b5ae`; the host sealed their findings and the orchestrator independently verified the four references, manifests and archived bytes. See [system state](../investigations/INV-011-model-ladder-refresh/research/system-state.md), [alternatives](../investigations/INV-011-model-ladder-refresh/research/alternatives.md), [constraints](../investigations/INV-011-model-ladder-refresh/research/constraints.md) and [risks](../investigations/INV-011-model-ladder-refresh/research/risks.md). This establishes implementation constraints, not new-model application, quality or subscription savings. No planning or production activation is asserted here.

## Decision

- **P46-A — Codex native ladder:** pin Sol to `gpt-6.1-sol`; use Sol/low for ordinary execution, initial ci-fix/review-fix and drift-check. Retain Sol/high and Sol/xhigh judgments and receipt-backed repair escalation. Keep Luna/medium sentinel unchanged and Astra outside the ordinary routed grid.
- **P46-B — Claude native ladder:** pin Sonnet to `claude-sonnet-5-5` and retain `claude-opus-5-5`; adopt the exact role matrix below, proving native model and effort compatibility. Preserve existing declared critical/checkpoint and judgment signals, conservative unknown checkpoint treatment, and the existing Fable window rule until a separately accepted amendment.
- **P46-C — Application and evidence integrity:** migrate canonical policy, runtime adapters, generated role sources/outputs, capability checks and requested/applied/observed verification together under a new policy version/fingerprint. Preserve authenticated repair predecessor checks, fail closed on unsupported or mismatched selections, and preserve historical receipt/control bytes and ownership of in-flight old-policy runs.
- **P46-D — Reviewable installation and rollback:** update supported install/provenance documentation and checks with the native ladder. Validate installation in an isolated runtime home; do not mutate another active runtime or controller. Rollback restores the prior reviewed package/policy while preserving evidence; outer coordination activation remains with the existing ADR-023 D6 owner seam.
- **P46-E — Scoped regression and honest outcomes:** verify the exact role grid, generation, native application, negative mismatches, repair progression and historical evidence compatibility through focused tests and independent review. Adopt the operator-authorized policy migration separately from long-term economy experiments; do not add duplicate experiment infrastructure or claim a measured quota saving.

## Locked role matrix

### Codex

Sol means `gpt-6.1-sol`; Luna means `gpt-6-luna`.

| Role | Base | Escalation |
|---|---|---|
| research | Sol/high | Sol/xhigh for explicit very-complex |
| decomposition | Sol/high | Sol/xhigh for critical/checkpoint |
| executor | Sol/low | Sol/high for critical/checkpoint |
| arch-review | Sol/high | Sol/xhigh on existing judgment signals |
| integrator | Sol/high | Sol/xhigh on existing judgment signals |
| ci-fix / review-fix | Sol/low | Verified repeat → Sol/high; verified repeat_exhausted → Sol/xhigh |
| pr-sentinel | Luna/medium | No automatic tier promotion |
| drift-check | Sol/low | No automatic tier promotion |

### Claude

Sonnet means `claude-sonnet-5-5`; Opus means `claude-opus-5-5`.

| Role | Base | Escalation |
|---|---|---|
| research | Sonnet/xhigh | Opus/high for explicit very-complex |
| decomposition | Sonnet/xhigh | Opus/high for critical/checkpoint |
| executor | Sonnet/medium | Sonnet/xhigh for existing critical/checkpoint signals; additional failure-driven promotions are deferred |
| arch-review | Sonnet/xhigh | Opus/high for contested/critical; preserve existing Fable window rule |
| integrator | Sonnet/xhigh | Opus/high for contested/critical |
| ci-fix / review-fix | Sonnet/high | Verified repeat → Sonnet/xhigh; verified repeat_exhausted → Opus/high |
| pr-sentinel | Sonnet/low for a bounded actionable duty | Return to host classification if outside scope |
| drift-check | Sonnet/medium for bounded semantic inventory | Refuse/reroute uncertain scope through a defined policy amendment |

The fast slice uses the existing authenticated selection signals. The advisory executor Sonnet/high after a capability-related failure and Opus/high for proven harder reasoning require a new trusted failure-evidence producer/consumer contract and are a follow-up. Existing prior-applied receipts prove what ran, not why it failed. Implementation must not invent caller-asserted failure signals or unreachable promotion rungs. Existing gated repair handling retains the Sonnet/high → Sonnet/xhigh → Opus/high recovery ladder.

## Consequences

- Common execution and repair paths use fewer model families, while independent review and integration retain their own verified dispatches. Fewer transitions may improve complete-task usage, but higher per-token rates or reasoning output may outweigh the benefit.
- Native model availability, effort application and exact observed identity are rollout conditions. A CLI alias or vendor benchmark alone is insufficient.
- Changes to overlapping policy/generator surfaces must have explicit ticket ownership and real dependencies. Active phase-43/45 work is preserved; no unrelated host repairs enter this phase.
- Long-term attribution and economy observations continue through existing ADR-021/022/023 contracts and remain inconclusive until supported by evidence.

## Out of scope

- Automatic cross-provider fallback, quota scheduling, gate removal, historical receipt rewriting, global runtime setting mutation or takeover of active controllers.
- Broad context/coordination redesign, new experiment infrastructure or automatic promotion based on unmeasured quota hypotheses.
- Outer coordination activation: proposed routine Codex Sol/low and Claude Sonnet/medium (substantive reasoning Sonnet/xhigh; proven harder reasoning Opus/high) remain a recorded follow-up at the existing D6 seam. This native-role migration does not activate them or rewrite ADR-023's historical Luna/max selection.
- Changing the current Fable measured-window rule or adding Astra/Haiku rescue lanes.

## Rollout and rollback

After Gate 1 validation, establish phase-46 context and run exactly researcher, planner and checker through the supported decomposition host. Gate 2 requires the materialized receipt-bound plan set and validate-graph success. Implementation and independent review precede a concrete isolated-install validation and operator rollout boundary. Preserve old-policy in-flight runs and evidence; rollback targets only the new reviewed policy/package.
