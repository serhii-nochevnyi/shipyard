---
status: open
closed:
adr:
---

# Problem — residual pipeline efficiency after phase 44

## What we are solving

Investigate the eleven phase-45 work packages (the separate S1 Stop-gate correctness fix, P1–P5 and D1–D5) against the installed Claude and Codex hosts, accepted ADRs, and phase-39–44 owners. Decide the smallest safe contracts and rollout order before authenticated decomposition into plans and tickets. The user explicitly requested this investigation on 2026-09-26 and added S1 to the local phase-45 scope after a second foreign-board incident.

## For whom

The repository maintainer running Shipyard through Claude Code and Codex subscriptions, and maintainers who must review and recover its delivery runs.

## Current pain

The audits and phase-45 queue entry identify repeated planning judgments, parent/wait turns, routine sentinel turns, repeated scans, and unbounded aggregate launches. Their quota impact is not yet proven by comparable provider-specific completed-outcome measurements. Separately, an installed Claude 0.66.0 Stop hook selected another armed session's newer worktree board and falsely blocked the owner; this is an observed correctness defect, not a quota experiment. Premature reuse or launch suppression could lose ownership, required instructions, independent review, or a quality gate.

## What success will be

Four authenticated research lines establish current behavior, alternatives, constraints, and risks, including S1's session-to-board binding. The resulting accepted ADR explicitly settles ownership, reuse identities, refusal conditions, runtime-specific rollout and quality measurements. A subsequent typed GSD researcher/planner/checker chain materializes phase-45 PLAN files with global requirements and a passing graph gate; only then is decomposition complete. S1 gets its own high-risk PLAN and human checkpoint, with installed-hook correctness as its acceptance gate.

## What is definitely out of scope

Reimplementing phase-40–43 contracts; global model downgrades; reducing the four independent investigation perspectives; automatic session transfer or cross-provider scheduling; an always-on sentinel daemon; API-credit or token-to-subscription-quota conversion; code implementation, rollout, or bypassing native receipt and planning-artifact gates during investigation.

## Inputs

- [Phase 45 context](../../phases/45-close-residual-pipeline-efficiency-gaps/CONTEXT.md) and [work packages](../../phases/45-close-residual-pipeline-efficiency-gaps/WORK-PACKAGES.md)
- [Reproduced Stop-gate foreign-board defect](../../backlog/stop-gate-selects-foreign-session-board.md)
- [Phase 44 context](../../phases/44-optimize-subscription-efficiency-per-runtime/CONTEXT.md) and [work packages](../../phases/44-optimize-subscription-efficiency-per-runtime/WORK-PACKAGES.md)
- [Pipeline efficiency audit](../../../docs/audits/2026-09-25-pipeline-subscription-efficiency.md), [Claude session audit](../../../docs/audits/2026-09-25-claude-session-efficiency.md), and [Codex planning audit](../../../docs/audits/2026-09-25-codex-phase41-pipeline-behavior.md)
- Accepted ADR-014, ADR-019 and existing phase-40–42 plans; these are source material, not automatic approval of new phase-45 policy.
