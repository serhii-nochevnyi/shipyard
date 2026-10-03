---
status: closed
closed: 2026-09-30
adr: .planning/architecture/ADR-024-model-ladder-refresh.md
---
# Problem

## What we are solving
Ship a narrowly scoped, versioned model-ladder refresh for Claude Code and Codex using the explicitly operator-selected September 30 proposal. Investigate native compatibility and ownership first, then decompose and implement through supported Shipyard hosts. The operator authorizes parallel work where independent and asks for prompt adoption.

## For whom
The Shipyard repository operator using ChatGPT-authenticated Codex and Claude Code subscriptions, including their installed marketplace plugins and future target-project delivery runs.

## Current pain
The canonical ADR-014.v6 maps Sol to GPT-6 Sol and mixes Luna/max with stronger escalation models. The operator prefers GPT-6.1 Sol/low wherever the proposal selected Luna/max, and Sonnet 5.5/xhigh wherever it selected Opus 5.5/medium. Existing generated agents, application checks, repair receipt chains and installed copies must agree. The root checkout is dirty and stale; this investigation is isolated at remote main 9e9ddbf575c8ab3f8265b0641f5df9a1bebd2245.

## What success will be
A concrete accepted policy amendment, authenticated research/decomposition evidence, a validated dependency graph and small implementation PRs that pass scoped tests and independent review. Verify requested/applied/observed model and effort, installation provenance and preservation of historical evidence. Adopt the approved ladder without promising a quota-saving percentage; long-term non-inferiority/usage observations remain separate evidence.

## What is definitely out of scope
No automatic cross-provider fallback, quota-driven provider transfer, gate removal, historical receipt rewriting, global runtime setting mutation before reviewed rollout, active phase-43/45 controller takeover, or fixes to unrelated hosts. Do not implement broad context/coordination redesign already owned by ADR-021/022/023. Keep proposed outer coordination selection aligned in documentation; identify an existing supported explicit selection seam and do not invent a new controller to activate it.

## Locked input
Read docs/audits/2026-09-30-model-ladder-refresh.md and DECISIONS.md. The user's exact substitutions apply to the proposal, not historical control tables. Existing Luna/medium sentinel, high/xhigh Sol judgments and Opus/high escalations remain as proposed. A production policy version migration is expressly requested; it is not a claim of already proven quota savings.
