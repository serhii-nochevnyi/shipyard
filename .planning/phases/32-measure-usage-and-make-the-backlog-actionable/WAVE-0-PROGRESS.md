# Wave 0 progress — 2026-09-10

Status: tooling implementation and review; economic experiment not yet started.
Scope: T-32-01 / T-32-02 only. These contracts do not complete all of phase 32.

## Delivered behavior under review

- Explicit-file usage-report CLI: Claude snapshots, ordinary/advisor separation,
  cumulative Codex observations, late metadata, malformed records and iteration
  reconciliation. No quota conversion or automatic collection.
- Backlog-index CLI: local notes, GSD 999.x directories and roadmap entries,
  stable source-qualified section IDs, manifest structure validation, stale
  evidence and bounded queries. No automatic closure or cold-start wiring.

## Observations

- Full historical Shipyard Claude session smoke: 1763 deduplicated responses.
- The local Codex fixture smoke recognized cumulative token_count records and
  kept cached input / output / reasoning categories separate.
- Current local backlog: 39 source notes, 200 sections; all untriaged without an
  evidence manifest. Section count is not a count of open defects.
- Targeted tests: usage-report 12 cases; backlog-index 7 cases. Both CLIs have
  real subprocess tests. Full test-fast runs and PR checks are recorded on #92/#93.

## No savings verdict yet

There is no matched treatment cohort, prospective ticket attribution or
subscription-window history in this slice. Token reduction, autonomous completion
rate and quota savings are therefore unknown, not zero and not an improvement.
Use ADR-011-EVALUATION-TEMPLATE.md after the collection and reconciliation owners
are integrated. The repository also contains the separate accepted ADR-012
task-level ladder amendment; its adaptive setting is a canary for routing and
telemetry, not a result from these smoke tests and not permission for automatic
online policy changes.

## Required continuation

1. Complete review and merge T-32-01/02 into the phase epic.
2. Revalidate ownership against phases 30/31 before adding cold-start/config/launch
   integration. Materialize OPT-03–05 and the remaining OPT-01/02 integration as
   separate contracts; the current two PLANs do not own those files.
3. Verify backlog items against landed source, write a lifecycle manifest with
   evidence, and collect the prospective baseline with dispatch attribution.
4. Apply one treatment at a time under the ADR's quality and recovery gates.
