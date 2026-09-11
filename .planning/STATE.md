---
# shipyard:gsd-sync generated; sync-version: 1; source fingerprint: 26468f091c6e6254c9edbcc1cb21f2c2a9cbbd6df8a490854d43711246c1b077
gsd_state_version: '1.0'
status: planning
progress:
  total_phases: 16
  completed_phases: 3
  total_plans: 82
  completed_plans: 80
  percent: 97
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated by Shipyard GSD synchronization)

**Core value:** Keep delivery decisions truthful, resumable, and synchronized between the Shipyard conveyor and native GSD workflows.
**Current focus:** Phase 20: Autonomy of the drive-to-green loop

## Current Position

Phase: 1 of 16 (Phase 20: Autonomy of the drive-to-green loop)
Plan: 6 of 6 merged
Status: pending
Last activity: 2026-09-11 — Shipyard projection synchronized

Progress: [█████████░] 97%

## Performance Metrics

- Total plans completed: 80
- Average duration: not measured by the projection
- Total execution time: not measured by the projection

**By Phase:**

| Phase | Plans | Merged | Verification |
|---|---:|---:|---|
| 20 | 6 | 6 | pending |
| 21 | 5 | 5 | pending |
| 22 | 5 | 5 | pending |
| 23 | 3 | 3 | pending |
| 24 | 11 | 11 | gaps_found |
| 25 | 6 | 6 | gaps_found |
| 26 | 15 | 15 | passed |
| 27 | 9 | 9 | gaps_found |
| 28 | 9 | 9 | gaps_found |
| 29 | 8 | 8 | passed |
| 30 | 0 | 0 | pending |
| 31 | 0 | 0 | pending |
| 32 | 2 | 2 | passed |
| 33 | 0 | 0 | pending |
| 34 | 0 | 0 | pending |
| 35 | 3 | 1 | pending |

## Accumulated Context

### Decisions

- Shipyard delivery state is authoritative for execution; this file is a native GSD projection.
- A merged ticket does not imply a verified phase.

### Pending Todos

Review and resolve phase integration findings shown in the phase artifacts.

### Blockers/Concerns

- T-35-02: delivery status is pr-open
- T-35-03: delivery status is pr-open
- Phase 20: INTEGRATION.md is missing
- Phase 21: INTEGRATION.md is missing
- Phase 22: INTEGRATION.md is missing
- Phase 23: INTEGRATION.md is missing
- Phase 24: integration evidence records a finding or failed verdict
- Phase 25: integration evidence records a finding or failed verdict

## Deferred Items

| Category | Item | Status | Deferred At | Milestone |
|---|---|---|---|---|
| Evidence | Historical phases without integration proof | Visible, not fabricated | 2026-09-10 | ADR-013 |

## Session Continuity

Last session: 2026-09-11 07:24
Stopped at: Shipyard GSD projection synchronized from the delivery graph.
Resume file: None
