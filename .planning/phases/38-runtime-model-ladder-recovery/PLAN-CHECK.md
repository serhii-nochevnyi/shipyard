# Phase 38 plan check

## Verdict

Eight implementation tickets are planned, including the merged model-ID pin.
PRs #190–195 have merged into the phase epic. T-38-05 is in progress. Final
routing review found that Claude still has no executable host for
`arch-review` and `integrator`; T-38-07 covers those roles. Review also found
that the documentation falsely assigns round-to-ticket sentinel membership to
T-33-08, whose scope is session ownership. T-38-08 adds the authenticated
round-membership bridge and sentinel host before T-38-05 completes command
routing and independent rollout. Phase 38 is not ready to close: implementation
evidence, architecture review, green CI, GitHub review, and the authorized merge
gates remain required.

Live state-sync has reconciled the merged PRs and the new pending tickets, and
the generated GSD projection is current for this plan revision. Continue to use
live GitHub state and a refreshed epic head for delivery decisions; a current
projection does not mean the phase is complete. No Jira tickets are created.

The consolidated graph validates with 146 tickets and 20 computed waves.
T-38-05 intentionally joins four same-phase parents, so validation warns that
the ticket branch inherits only its primary parent. Before implementation,
refresh the epic and verify that it contains the merge commits for T-38-04,
T-38-06, T-38-07, and T-38-08; do not cut T-38-05 from a stale parent branch.
The remaining graph warnings concern pre-existing tickets and the new files
created by T-38-07/08.

## Goal-backward coverage

| Requirement | Covered by | Result |
|---|---|---|
| REQ-113 provider-pure host paths | T-38-03, T-38-04, T-38-05, T-38-07, T-38-08 | Planned |
| REQ-114 Claude selection and delivery evidence | T-38-02, T-38-03, T-38-05, T-38-06, T-38-07, T-38-08 | Planned |
| REQ-115 Codex selection and delivery evidence | T-38-04, T-38-05 | Planned |
| REQ-116 durable application receipts | T-38-01 through T-38-08 | Planned |
| REQ-120 independent provider rollout | T-38-01, T-38-02, T-38-04, T-38-05, T-38-07, T-38-08 | Planned |
| REQ-121 GPT-6 Codex IDs and Luna/max base | T-38-01, T-38-04 | Planned |
| REQ-122 Claude Opus 5.5 and exact-session evidence | T-38-01, T-38-02 | Planned |
| REQ-123 native subscription authentication | T-38-05 | Planned |
| REQ-124 exact typed GSD agent application | T-38-03, T-38-04, T-38-06 | Planned |

## Structural checks

- T-38-02 reads the exact transcript path returned by the launched Claude
  session's `SessionStart` hook. Ordinary launches retain `--restricted`;
  typed GSD launches supply the exact agent definition and role while keeping
  strict MCP, explicit tools, and the worktree sandbox. Hook and transcript
  evidence must independently agree on the role.
- T-38-03 connects Claude delivery and investigation, resolves only
  allowlisted references, and owns signed commit finalization.
- T-38-04 connects Codex delivery and typed GSD children. Native child metadata
  binds role, model, effort, and parent thread; the pinned installed role file
  and developer instructions are independently verified.
- T-38-06 supplies Claude's typed GSD decomposition entrypoint.
- T-38-07 supplies Claude's `arch-review` and `integrator` entrypoints through
  the mandatory dispatch boundary.
- T-38-08 supplies Claude's `pr-sentinel` round host and authenticated
  round-to-ticket projection. T-33-08 supplies session fencing only; its name
  is not evidence of round-membership support.
- T-38-05 waits for T-38-04, T-38-06, T-38-07, and T-38-08, then routes every
  model-bearing delivery role, investigation, and decomposition through a
  provider-specific executable host.
- Claude and Codex remain provider-pure. Capability smokes do not call a model;
  live smokes are opt-in and run in disposable worktrees.
- Negative tests cover missing or contradictory evidence, role mismatch,
  sandbox denial, out-of-scope changes, stale branch state, unsigned commits,
  and round-membership identity mismatches.
- Jira remains disabled and no Jira tickets are part of this phase.

## Dependency order

T-38-01 through T-38-04 and T-38-06 are merged. T-38-03 provides the shared
commit finalizer; T-38-04 depends on it. T-38-06 supplies Claude typed GSD
decomposition. T-38-07 depends on T-38-04 and connects Claude judgement roles.
T-38-08 depends on T-38-07 and connects the round-scoped sentinel with its
membership projection. T-38-05 waits for T-38-04, T-38-06, T-38-07, and
T-38-08, then starts from an epic head containing each landed parent.

## Remaining proof

1. Pass each ticket's scoped tests and `make test-fast` in CI.
2. Run each required opt-in live smoke in a disposable worktree: Claude runtime,
   Claude typed GSD, Claude judgement role, and Codex runtime. They must record
   real model and effort evidence; typed decomposition must prove native agent
   identity; delivery must prove signed host commits and denial of child access
   to Git metadata and the GPG agent.
3. Complete architecture review and GitHub review/CI gates before merge.
4. Complete T-38-07, T-38-08, and T-38-05 integration and phase verification
   before release.
