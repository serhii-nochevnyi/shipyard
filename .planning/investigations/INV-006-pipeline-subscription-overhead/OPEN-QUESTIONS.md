# Investigation closure and planning handoff

All scope-level questions are resolved by the approved P41-A–F context and
ADR-019. Exact implementation contracts are the next phase-research/planning
work, not new product-scope choices or evidence of already implemented code.

- [x] Projection inputs and aggregate invalidation: reuse gsd-sync; the phase researcher must enumerate exact input-to-output dependencies. REQ-155 preserves all affected edges and read-only staleness detection.
- [x] Handoff transition: use existing fenced checkpoint/resume at safe explicit phase/long-wait boundaries. Automatic thresholds are deferred; no live launch can be transferred ambiguously. REQ-152.
- [x] Candidate contract: bind all identities listed in REQ-154, retain failed/pending gates, and refuse changed-base reuse unless complete bounded revalidation is specified. No stale green reuse.
- [x] Wake/packet ownership: T-39-03/T-39-17 retain fixes; both phase39 PRs are merged. Installed observations are explicit REQ-151/153 implementation acceptance checks, not assumptions.
- [x] Usage/outcome join: extend existing attribution/reporting with stable identity, deduplication and unknown retention. Exact join fields are phase research; no new ledger. REQ-156.
- [x] Shared phase40 files: retain phase41-before40, inspect current ownership, order later contracts explicitly and validate the graph. Planner must resolve concrete file collisions before Gate 2.
- [x] Bootstrap: user authorized a local host pending phase40. Four research lines completed with genuine receipts; three typed planning callbacks remain required.
- [x] First measurement cohort: matched runtime/model/effort and role scope, one treatment at a time, retaining existing readiness/quality thresholds. Live sample selection is an execution task; inconclusive is a valid result.

See DECISIONS.md, RESEARCH.md and RISKS.md. Runtime behavior and savings remain
unproven until the recorded acceptance scenarios are executed; closure does not
claim otherwise. Source baseline advanced to main release 0.63.0 after research;
the typed phase researcher will reconcile that delta before planning.
