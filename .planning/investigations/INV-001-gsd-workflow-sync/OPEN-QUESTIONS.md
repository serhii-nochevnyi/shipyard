# Open questions

- [x] What is the authoritative source for execution state? → PLAN frontmatter
  plus the validated Shipyard graph and delivery evidence; native GSD files are
  generated projections. See DECISIONS.
- [x] Which missing artifacts must Shipyard generate? → `STATE.md`,
  `REQUIREMENTS.md`, plan `*-SUMMARY.md`, phase `*-UAT.md`, phase
  `*-VERIFICATION.md`, and a marked roadmap synchronization block. See ADR-013.
- [x] How should incomplete historical evidence be represented? → pending or
  gaps-found, never green by ticket count alone. See DECISIONS.
- [x] Where must synchronization run? → at plan completion, delivery completion,
  verification completion, and ship preflight, with an explicit check mode for
  CI and tests. See DECISIONS.
- [x] Does the projection make external mutations? → no; it is local-only and
  does not call GitHub, Jira, or delete worktrees. See DECISIONS.
