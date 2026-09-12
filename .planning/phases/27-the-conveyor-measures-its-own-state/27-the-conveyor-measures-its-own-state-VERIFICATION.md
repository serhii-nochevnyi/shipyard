---
# shipyard:gsd-sync generated; sync-version: 1; source fingerprint: 11b2f6cf3a000355d71adc07c5e612b70a16f7265baabb0f8e5572c8f37cc262
phase: 27
status: gaps_found
shipyard_source_fingerprint: 11b2f6cf3a000355d71adc07c5e612b70a16f7265baabb0f8e5572c8f37cc262
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
