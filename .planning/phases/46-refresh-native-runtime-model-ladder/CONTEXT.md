# Phase 46 — native runtime model ladder refresh

**Source:** ADR Ingest Express Path (.planning/phases/46-refresh-native-runtime-model-ladder/ADR-024.ingest.md)
**Accepted ADR SHA-256:** f96c03235c600886b119a38964f221bcfbeecfe7e09d23f235653e0693ca2f47
**Mode:** standard
**Granularity:** coarse
**UI design:** none

<domain>
The operator requests prompt adoption of the September 30 model proposal, with GPT-6.1 Sol/low replacing every proposed Luna/max placement and Sonnet 5.5/xhigh replacing every proposed Opus 5.5/medium placement. The operator authorizes investigation, decomposition and execution, retaining independent gates and ongoing phase-43/45 ownership.

The [advisory audit](../../docs/audits/2026-09-30-model-ladder-refresh.md) records official release research and inspected baseline evidence. Official references include [Codex model guidance](https://learn.chatgpt.com/docs/models), [Codex pricing](https://learn.chatgpt.com/docs/pricing), [Sonnet 5.5 release](https://www.anthropic.com/claude-sonnet-5-5) and [Claude model configuration](https://code.claude.com/docs/en/model-config). These vendor facts do not prove that a Shipyard worker applies a requested selection or establish subscription savings.

[INV-011](../investigations/INV-011-model-ladder-refresh/PROBLEM.md) and its [locked decisions](../investigations/INV-011-model-ladder-refresh/DECISIONS.md) establish the authorized scope. All four canonical Codex-host research lines completed at source revision `c105349656e445275db8b72cebd398c670f1b5ae`; the host sealed their findings and the orchestrator independently verified the four references, manifests and archived bytes. See [system state](../investigations/INV-011-model-ladder-refresh/research/system-state.md), [alternatives](../investigations/INV-011-model-ladder-refresh/research/alternatives.md), [constraints](../investigations/INV-011-model-ladder-refresh/research/constraints.md) and [risks](../investigations/INV-011-model-ladder-refresh/research/risks.md). This establishes implementation constraints, not new-model application, quality or subscription savings. No planning or production activation is asserted here.
</domain>

<decisions>
- **P46-A — Codex native ladder:** pin Sol to `gpt-6.1-sol`; use Sol/low for ordinary execution, initial ci-fix/review-fix and drift-check. Retain Sol/high and Sol/xhigh judgments and receipt-backed repair escalation. Keep Luna/medium sentinel unchanged and Astra outside the ordinary routed grid.
- **P46-B — Claude native ladder:** pin Sonnet to `claude-sonnet-5-5` and retain `claude-opus-5-5`; adopt the exact role matrix below, proving native model and effort compatibility. Preserve existing declared critical/checkpoint and judgment signals, conservative unknown checkpoint treatment, and the existing Fable window rule until a separately accepted amendment.
- **P46-C — Application and evidence integrity:** migrate canonical policy, runtime adapters, generated role sources/outputs, capability checks and requested/applied/observed verification together under a new policy version/fingerprint. Preserve authenticated repair predecessor checks, fail closed on unsupported or mismatched selections, and preserve historical receipt/control bytes and ownership of in-flight old-policy runs.
- **P46-D — Reviewable installation and rollback:** update supported install/provenance documentation and checks with the native ladder. Validate installation in an isolated runtime home; do not mutate another active runtime or controller. Rollback restores the prior reviewed package/policy while preserving evidence; outer coordination activation remains with the existing ADR-023 D6 owner seam.
- **P46-E — Scoped regression and honest outcomes:** verify the exact role grid, generation, native application, negative mismatches, repair progression and historical evidence compatibility through focused tests and independent review. Adopt the operator-authorized policy migration separately from long-term economy experiments; do not add duplicate experiment infrastructure or claim a measured quota saving.
</decisions>

<canonical_refs>
- .planning/architecture/ADR-024-model-ladder-refresh.md
- .planning/investigations/INV-011-model-ladder-refresh/RESEARCH.md
- .planning/investigations/INV-011-model-ladder-refresh/RESEARCH-EVIDENCE.json
- .shipyard/generated/gsd-delivery-rules/SKILL.md
</canonical_refs>

<specifics>

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


</specifics>

<deferred>
- Additional executor failure-driven Sonnet/high and proven-harder Opus/high require a trusted failure-evidence contract.
- Outer D6 activation stays with its owner; revised candidate is Sol 6.1/low and substantive Sonnet 5.5/xhigh.
- Empirical quality/economy cohorts stay with existing ADR-021 owners and remain inconclusive.
</deferred>

<scope_fence>
- Automatic cross-provider fallback, quota scheduling, gate removal, historical receipt rewriting, global runtime setting mutation or takeover of active controllers.
- Broad context/coordination redesign, new experiment infrastructure or automatic promotion based on unmeasured quota hypotheses.
- Outer coordination activation: proposed routine Codex Sol/low and Claude Sonnet/medium (substantive reasoning Sonnet/xhigh; proven harder reasoning Opus/high) remain a recorded follow-up at the existing D6 seam. This native-role migration does not activate them or rewrite ADR-023's historical Luna/max selection.
- Changing the current Fable measured-window rule or adding Astra/Haiku rescue lanes.
- No unnecessary edits to hot phase43/45 hosts/controllers/pipeline-config; pinned-ID exact fallback is already supported.
- Preserve original sealed reports and historical captures.
- Source/test correctness and isolated installation are required; live-role evidence must be real, not synthetic pair prompts or fabricated failure/predecessor records.
</scope_fence>

## Requirements

P46-A, P46-B, P46-C, P46-D, P46-E map one-to-one to the accepted ADR decision bullets and ROADMAP entry.

## Success criteria

Exact reachable role matrix; coherent version/hash, generated and installed identities; authenticated adjacent repair chains and negative refusals; focused regression tests and independent gates; isolated provenance and explicit rollback. No default global activation or quota-saving claim is asserted by this intake.

## Targeted CI-atomic recovery decision and rollout HOLD

- The previous six-plan layout had a real dependency deadlock: `.github/workflows/test.yml:70` invokes `make test-fast`, `Makefile:72` runs every `tests/unit/*.test.cjs`, and policy-only T-46-01 made existing current-policy fixtures fail. Former T-46-02/03 were barred until T-46-01 merged, so the parent could not pass CI to merge. The revised T-46-01 owns policy, all known coupled current-policy tests and active instructions in one reviewable PR. Former T-46-02/03 are retired as separate executable tickets because their tests are required for 01's CI rather than meaningful independent post-merge acceptance. Their old scopes are preserved in the private original planning evidence. T-46-04 owns supported operator docs/runbook, T-46-05 owns final package and historical attribution, and T-46-06 owns independent review, authentic native observation and the sole operator rollout checkpoint. Canonical graph/ticket projections must retire 02/03 before any new native dispatch; stale materialization is not authority.
- T-46-01 removes exactly `model_overrides.gsd-code-reviewer=opus` and `effort.agent_overrides.gsd-code-reviewer=xhigh` from repository-local `.planning/config.json`, preserving all other values. The compatibility fixture at `/Users/serhii/.local/state/shipyard/ladder-refresh-20260930/phase46-reviewer-compatibility-evidence.json` shows each blocks ordinary reviewer selection under v6; it is not a new-model receipt. T-46-01 now also proves ordinary and critical canonical reviewer selections.
- Signed native T-46-01 commit `1ca29f3658717efc8c212f6a5e81d33cfb2557f5` and verified dispatch receipt `dispatch-muo7hdkm-15942a6d-abb7-4a07-aadc-8b7973f63e85` are code reuse with old installed v6 Luna/max and pre-commit pass only. That worker emitted neither required `.shipyard-pr-body.md` nor `.shipyard-evidence.md`. The revised genuine executor must produce both complete files and a bounded result for the trusted finalizer; no PR/CI/review or new-model application is accepted yet.
- T-45-09/PR369 actively owns `tests/unit/dispatch-boundary.test.cjs`, and T-45-10 owns `tests/unit/claude-decompose-host.test.cjs`; both have required current-policy assertions. Resolve their test-only amendments with actual owners through a supported reviewed merge/base barrier before core execution. Do not edit active owner checkouts/controllers or send the private PR369 transport proposal. Phase 45 is not asserted main-landed. T-43-14/15/19 are merged only into their epic, which is not a main ancestor at planning time; narrow core prose edits to the current base and reconcile later integration without a blanket cross-phase dependency.
- T-46-05 waits for actual T-46-01 and T-46-04 PR merges into the phase epic and proves both merge SHAs are ancestors of its refreshed effective base before package worktree preparation. Ticket/epic PR bases skip package freshness in `tests/unit/marketplace-install.test.cjs:70-75`, permitting the atomic core PR; final acceptance requires the package mirror to match source exactly.
- Current account entitlement, actual native application for all new Codex/Claude pairs and installed Claude plugin provenance remain unverified. T-46-06 automatically collects authentic host-owned same-session receipts or specific HOLD reasons before the one operator checkpoint. Retained Luna/medium and Fable are regression requirements. No model list, fixture-derived capability, historical receipt or synthetic predecessor proves new native application. No quota-saving result is claimed.
- `46-VALIDATION.md` tracks scoped commands and pending outcomes. Its bytes require separate operator hash verification because the plan seal indexes CONTEXT and PLAN files only.
