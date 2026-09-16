---
# shipyard:gsd-sync generated; sync-version: 1; source fingerprint: 91e4942cc8b98b9c604cb5e8653c1d0460432d41a1d5215e87a51b3d23357a78
phase: 27
status: gaps_found
shipyard_source_fingerprint: 91e4942cc8b98b9c604cb5e8653c1d0460432d41a1d5215e87a51b3d23357a78
---

# Phase 27: The conveyor measures its own state — Verification Projection

**Status:** gaps_found

## Observable Truths

| Truth | Evidence | Status |
|---|---|---|
| Every phase plan is accounted for | 9/9 delivery records are merged | ✓ VERIFIED |
| Integration is coherent | integration evidence records a finding or failed verdict | ✗ FAILED |
| Verification evidence is present | integration evidence records a finding or failed verdict | ✗ FAILED |

## Plan Evidence

| Ticket | Delivery | Plan status |
|---|---|---|
| T-27-01 | merged | ✓ VERIFIED |
| T-27-02 | merged | ✓ VERIFIED |
| T-27-03 | merged | ✓ VERIFIED |
| T-27-04 | merged | ✓ VERIFIED |
| T-27-05 | merged | ✓ VERIFIED |
| T-27-06 | merged | ✓ VERIFIED |
| T-27-07 | merged | ✓ VERIFIED |
| T-27-08 | merged | ✓ VERIFIED |
| T-27-09 | merged | ✓ VERIFIED |

## Verification Commands

- `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json`
- `gsd-tools phase uat-passed 27 --raw`

## Gaps Summary

**Not green:** integration evidence records a finding or failed verdict.
