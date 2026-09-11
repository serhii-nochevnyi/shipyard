---
# shipyard:gsd-sync generated; sync-version: 1; source fingerprint: 16440c72f52e6fe4b10995d69e9f3446f1f6c51ce3ff27d7af9d1a0bdf17ebf8
phase: 25
status: failed
result: failed
shipyard_sync: evidence-projection
shipyard_source_fingerprint: 16440c72f52e6fe4b10995d69e9f3446f1f6c51ce3ff27d7af9d1a0bdf17ebf8
---

# Phase 25: The conveyor follows the models it runs on — UAT Projection

This file is generated from the delivery graph and phase integration evidence.

### 1. Delivery plans are accounted for
result: passed
expected: all 6 phase plan(s) are merged
actual: 6 merged

### 2. Integration evidence is explicit
result: failed
expected: an explicit passed verdict in .planning/phases/25-the-conveyor-follows-the-models-it-runs-on/INTEGRATION.md
actual: needs-fix — integration evidence records a finding or failed verdict

### 3. Phase verification is evidence-backed
result: failed
expected: the phase verification projection is not green without evidence
actual: gaps_found; passed — integration evidence includes repository-local verification facts
