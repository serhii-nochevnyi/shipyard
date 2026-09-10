# Phase 29 integration — 2026-09-10

Verdict: needs-fix
Reviewed epic: 4cbb4674518cbae5d451c16d3bd06ebf0a3ac036
Review mode: inline Codex; no separate agent dispatch is claimed.

T-29-01 through T-29-07 are merged. PR 90's graph invocation ambiguity is fixed
at 087e42572143cb2df5de904d4b68745ff36500aa; its current-head CI passed,
review thread was resolved, and sentinel verified all three declared paths in
the epic. Degenerate-green findings: zero. T-29-07 conforms to ADR-008 D6/D7.

## Finding P1 — the recorder credits a newer item to an older tracker action

jira-project.cjs recordProjection recomputes pendingItemFor and stores item.to
without binding it to the item the agent acted on. Local temporary-graph repro:
plan pr-open/In Progress -> append merged/Done -> record transition 21 with
status In Progress -> watermark projected_to merged -> no remaining items.
This violates ADR-008 D5: the claimed transition did not happen.

Fix contract: 29-08-PLAN.md. Epic must remain draft until this is fixed and
reverified. Live Jira witnessing remains explicitly owed to the proving ground
under ADR-008 D7; this repository has Jira disabled.
