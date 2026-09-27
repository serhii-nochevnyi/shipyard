# Defect: an armed Stop gate can select another session's board

**Status:** reproduced on the installed Claude hook 0.66.0; accepted into the [phase-45 S1 work package](../phases/45-close-residual-pipeline-efficiency-gaps/WORK-PACKAGES.md) as a separate high-risk correctness fix. Captured 2026-09-26. Do not merge it with an efficiency treatment or D1 sentinel scheduling.

## Observed failure

The user reports a second cross-session Stop-gate refusal; an earlier occurrence selected `plan40-target-amend`. A controlled reproduction against the installed `~/.claude/hooks/shipyard-stop-gate/stop-gate.cjs` created two worktrees of one repository. Session A was armed in worktree A, whose board was a fixpoint. Worktree B had a newer actionable board. Invoking A's Stop hook with A's `session_id` returned `decision: block` for B's `T-99-01`, and its reason named B's `.planning/graph` path. The scratch repository was removed afterward. This proves the selection defect independently of the user's reported session; it does not prove which specific live session wrote the user's foreign board.

Installed hook, plugin cache 0.66.0 and this checkout's `plugins/delivery-pipeline/scripts/stop-gate.cjs` had identical SHA-256 `a41aea770ee9a812fb41e3098f20907eca9413ac7ab17d9d147e23de5f926c06` at reproduction. This is current behavior, not a stale installed copy.

## Cause and existing phase coverage

- `stop-gate-arm.cjs:33-45` writes `{session_id, armed_at, cwd}` in the Git common directory, but `isArmed()` checks only `session_id`.
- `stop-gate.cjs:491-531` uses run-owned front selection only when a `run_id` or scoped environment is present. Its normal armed Claude path scans the caller's worktree plus every linked worktree and selects the newest `generated_at`, without matching a session owner, run or selected delivery scope.
- T-39-03 / ADR-016 intentionally added per-session **arming** while retaining cross-worktree newest-front discovery. It did not bind a board to the arming session.
- T-41-03 / REQ-153 tested foreign work under an explicitly scoped `run_id` and unarmed sessions. Its test does not exercise an armed, unscoped session A next to an unrelated active session B. It says a reproduced residual source defect needs a scoped follow-up ownership amendment. Both tickets are merged, so this is a new standalone correction, not unfinished work in either ticket.
- The current authoritative `origin/main` phase 43 is ADR-020 target-project delivery at scale; its context does not own Stop-gate session affinity. The queued phase 45 (renumbered from local phase 44 on 2026-09-27) includes this defect as S1, but its phase number and scope remain provisional until the local/remote roadmap collision is reconciled.

## Required correction

Bind the armed Claude session to an explicit, authenticated delivery board/worktree or run scope before the Stop gate may enforce a front. Preserve the legitimate case where the Claude session's process `cwd` is a stale main checkout while its delivery run owns a linked phase worktree. A stored arming `cwd` alone cannot identify that phase worktree or distinguish two runs launched from the same checkout. The design must define how the selected scope is recorded, updated, invalidated, and recovered after a crash or fork. A foreign/newer front must never win merely by timestamp. Scoped controller behavior must remain run-owned.

Acceptance cases for a separate ticket:

1. Two simultaneously armed sessions in sibling worktrees with opposite board states: each Stop hook reads only its own selected board; B's newer timestamp cannot block A or allow A to stop over A's live board.
2. One Claude session parked in stale main `cwd` but explicitly owning an active phase worktree: the hook still enforces that phase worktree's live board.
3. Missing, unreadable, stale, altered, or ambiguous scope cannot silently select an unrelated board. The refusal/allow behavior and remedy are explicit and bounded; no permanent trap on abandoned scope.
4. Re-arming, `--fork-session`, scope switch and run completion invalidate or replace the old binding without broadening authority to another session.
5. The installed copied hook and arming helper are tested after installation, not inferred from source tests or package version. Include a fixture matching the observed A/B reproduction, plus the old stale-main regression and scoped-run controls.

**Risk:** high. The Stop hook can force extra model turns and steer the agent toward a foreign run; an overrestrictive change can also allow a live owning run to stop too early. Keep this as its own reviewed fix and do not treat a shorter prompt or reduced wake count as proof of correctness.
