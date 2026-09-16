---
# shipyard:gsd-sync generated; sync-version: 1; source fingerprint: 91e4942cc8b98b9c604cb5e8653c1d0460432d41a1d5215e87a51b3d23357a78
gsd_state_version: '1.0'
status: planning
progress:
  total_phases: 17
  completed_phases: 5
  total_plans: 116
  completed_plans: 116
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated by Shipyard GSD synchronization)

**Core value:** Keep delivery decisions truthful, resumable, and synchronized between the Shipyard conveyor and native GSD workflows.
**Current focus:** Phase 20: Autonomy of the drive-to-green loop

## Current Position

Phase: 1 of 17 (Phase 20: Autonomy of the drive-to-green loop)
Plan: 6 of 6 merged
Status: pending
Last activity: 2026-09-16 — Shipyard projection synchronized

Progress: [██████████] 100%

## Performance Metrics

- Total plans completed: 116
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
| 25 | 6 | 6 | passed |
| 26 | 15 | 15 | gaps_found |
| 27 | 9 | 9 | gaps_found |
| 28 | 9 | 9 | gaps_found |
| 29 | 8 | 8 | passed |
| 30 | 10 | 10 | pending |
| 31 | 7 | 7 | pending |
| 32 | 7 | 7 | passed |
| 33 | 0 | 0 | pending |
| 34 | 0 | 0 | pending |
| 35 | 3 | 3 | passed |
| 36 | 12 | 12 | passed |

## Accumulated Context

### Decisions

- Shipyard delivery state is authoritative for execution; this file is a native GSD projection.
- A merged ticket does not imply a verified phase.

### Pending Todos

Review and resolve phase integration findings shown in the phase artifacts.

### Blockers/Concerns

- Phase 20: INTEGRATION.md is missing
- Phase 21: INTEGRATION.md is missing
- Phase 22: INTEGRATION.md is missing
- Phase 23: INTEGRATION.md is missing
- Phase 24: integration evidence records a finding or failed verdict
- Phase 26: verification evidence records a failed check
- Phase 27: integration evidence records a finding or failed verdict
- Phase 28: integration evidence records a finding or failed verdict

## Deferred Items

| Category | Item | Status | Deferred At | Milestone |
|---|---|---|---|---|
| Evidence | Historical phases without integration proof | Visible, not fabricated | 2026-09-10 | ADR-013 |

## Session Continuity

Last session: 2026-09-16 17:20
Stopped at: Shipyard GSD projection synchronized from the delivery graph.
Resume file: None
