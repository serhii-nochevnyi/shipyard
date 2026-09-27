# Phase 44 research handoff

The user-approved scope comes from the prior source-backed research. This file indexes that evidence; it does not claim a new authenticated researcher receipt.

- [Session audit](evidence/REPORT.md): concrete main-context growth, repeated review, research duplication, observed native model selections and subscription attribution limits.
- [Implementation research](evidence/IMPLEMENTATION-RESEARCH.md): all seven residual proposals, source seams, acceptance/refusal matrices and exclusions.
- [Runtime-specific addendum](evidence/RUNTIME-SPECIFIC-ADDENDUM.md): separate quota collection, instruction loading, context lifecycle, model grids, typed-parent overhead and changed phase-42 ownership.
- [Source manifest](evidence/MANIFEST.json): immutable copies and original paths.

## Implementation entry points

- `plugins/delivery-pipeline/scripts/claude-role-host.cjs`: authenticated preparation, evidence preparation, launch and sealed verdict; reuse lookup must precede destructive evidence preparation.
- `plugins/delivery-pipeline/scripts/lock.cjs`: existing ownership-aware locking and atomic writes for bounded reservation operations.
- `plugins/delivery-pipeline/scripts/session-handoff.cjs` and `runtime-context.cjs`: existing advisory rotation and ownership/capability enforcement; do not create another transfer manager.
- `plugins/delivery-pipeline/scripts/context-packet.cjs` and `workflows/investigation-research.mjs`: required refs, selected context and bounded handbacks; new work is fact/index selection.
- `plugins/delivery-pipeline/scripts/orchestration-overhead.cjs` and `usage-attribution.cjs`: existing measurements/outcome joins; effort treatments need an explicit versioned contract.
- `plugins/delivery-pipeline/scripts/model-policy-internal.cjs`, `validate-graph.cjs` and native host signal producers: checkpoint reason propagation and separately controlled experimental policy.
- `scripts/gen-codex-shipyard.cjs` and supported installers: preserve generated ownership and native role instructions.

Proposed modules and test names in WORK-PACKAGES.md are not existing source files. The planner must rebase references on the final phase-40/42 interfaces.

## Current documentation findings

Claude uses documented statusline rate-limit fields; the user's existing renderer already reads them. Codex 0.157.0 locally generated schema confirms account/rateLimits/read and sparse account/rateLimits/updated; no live account retrieval was performed. Codex instruction loading and Claude path rules require separate adapters. Parent/child launch costs and observed selection must be measured, not inferred from defaults.

## Prior validation

Existing rotation recommendation tests: 7 passed. Existing overhead tests: 8 passed. These checks establish existing primitives only. The runtime addendum generated the installed Codex schema without a model turn. Required new behavior is not implemented or tested yet.

## Planning questions already resolved by scope

Keep both providers native, preserve independent review and human authorization, queue after current dependencies, and measure subscription percentages rather than API prices. Use advisory rotation and disabled experimental policy by default. No further user choice is necessary to register this queued preparation.

## Questions to close through authenticated planning

Confirm final shared-file owners after upstream merge; effective Codex instruction limit/loading on the launched host; authenticated account snapshot availability; exact review key completeness; F17 checkpoint reason interface; supported experimental effort pairs and eligibility. Do not convert unknown evidence into launch authority.
