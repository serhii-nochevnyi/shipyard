# Research contract — INV-007 (target-project delivery at scale → phase 42)

Read-only research. Do not edit code or any file except your own artifact.

## Inputs
- `PROBLEM.md` (this directory) and `intake/findings-report.md` (items 2 and 5–18; items 1, 3 and 4
  are already in phase 40 as D-43..D-45 and are out of scope here), `intake/target-project-workarounds.md`.
- Transcript evidence: `intake/transcript-timeline.txt` — every user message, assistant note, tool call
  and truncated tool result of the pdffiller session, one line each, prefixed with the UTC time.
- Current plans that must not be duplicated: `.planning/phases/40-*/40-*-PLAN.md`,
  `.planning/phases/41-*/41-*-PLAN.md`, `.planning/backlog/*.md`, ADR-014, ADR-017, ADR-019.
  The phase-40 amendment (D-43..D-45) is not on this branch yet; its full diff is `intake/phase40-amendment.diff`.
- Everything you need is inside this worktree; do not try to read paths outside it.

## Findings to cover (ids from the intake report)
- F2 publish-gate base resolution (`plugins/delivery-pipeline/scripts/publish-gate.cjs:24-38`; T-41-08 merged only worktree resolution).
- F5 conveyor scratch files make `claude-role-host.cjs:131` refuse (backlog `base-merge-refuses-on-the-scratch-files…` covers base-merge only).
- F6 verdict carry across base-merges that bring already-judged sibling squashes (backlog `a-conform-verdict-does-not-survive…`, `the-carry-window-closes…`).
- F7 executor verification environment (Claude `--restricted` sandbox: no docker/php/network/deps) and merges of commits without executor receipt / trusted finalization.
- F8 `run-reachability.cjs:59` ENOBUFS; `sentinel.cjs:202` `treeBlobs` full recursive trees.
- F9 stale bot approval blocks merge (`reviewers.cjs` `reviewFreshness`, `sentinel.cjs:1053`).
- F10 request builders missing for research, decompose, arch-review and fix-round (T-40-15 covers executor and pr-sentinel only).
- F11 state-sync wall time (`pr_fetch_limit`, merged tickets re-synced).
- F12 `ci-wait.cjs` window vs Claude Bash 600 s cap; CANCELLED routed to ci-fix.
- F13 comment-policy vs annotations required by the target repository and ADR-required comment edits.
- F14 `role-artifact.cjs:1276` rejects a whole arch-review on one unknown finding type.
- F15 decompose cannot bind pre-existing Jira issues (`jira-export.cjs` label lookup, `on_no_match: create`).
- F16 decompose-written ROADMAP blocks gsd-sync; `pipeline-config.cjs:927-931` drops `pipeline.gsd_sync` silently.
- F17 `human_checkpoint` semantics under `auto_merge: epic`.
- F18 premature human escalation when the repository has an automatable remedy (screenshot regeneration workflow).

## Per line
- **system-state**: for each finding, the exact current behaviour at file:line on this revision, the
  transcript evidence (timestamp + command), and whether any phase-40/41 ticket or backlog entry
  already changes it (name the ticket and why it does or does not cover the observed case).
- **alternatives**: 2–3 options with trade-offs for each decision finding (F6, F7, F13, F15, F17,
  F18) and the cheapest correct shape for each point fix; propose a ticket slicing for phase 42.
- **constraints**: ADR-014 boundary (receipts, no widened launch authority), Codex parity, phase-40/41
  file ownership (list every file each finding would touch and every 40/41 plan that also touches it,
  with the ordering needed), test strategy per finding (unit/fixture/live), backward compatibility
  for the Shipyard repository.
- **risks**: what breaks if each fix is wrong (fail-open merges, lost receipts, false refusals), and
  what cannot be verified without a live target-project run.

Every claim about code carries a file path and line. Every transcript claim carries a timestamp.
