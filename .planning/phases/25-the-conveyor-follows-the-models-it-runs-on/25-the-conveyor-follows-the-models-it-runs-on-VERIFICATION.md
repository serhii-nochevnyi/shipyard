---
# shipyard:gsd-sync generated; sync-version: 1; source fingerprint: 35ae4d2614bb94ef04e5d654c62e5ab00f7beab2096c7a9d2e2e496908ddb264
phase: 25
verified: 2026-09-11T07:04:01.173Z
status: gaps_found
shipyard_source_fingerprint: 35ae4d2614bb94ef04e5d654c62e5ab00f7beab2096c7a9d2e2e496908ddb264
---

# Phase 25: The conveyor follows the models it runs on — Verification Projection

**Status:** gaps_found

## Observable Truths

| Truth | Evidence | Status |
|---|---|---|
| Every phase plan is accounted for | 6/6 delivery records are merged | ✓ VERIFIED |
| Integration is coherent | integration evidence records a finding or failed verdict | ✗ FAILED |

## Plan Evidence

| Ticket | Delivery | Plan status |
|---|---|---|
| T-25-01 | merged | ✓ VERIFIED |
| T-25-02 | merged | ✓ VERIFIED |
| T-25-03 | merged | ✓ VERIFIED |
| T-25-04 | merged | ✓ VERIFIED |
| T-25-05 | merged | ✓ VERIFIED |
| T-25-06 | merged | ✓ VERIFIED |

## Verification Commands

- `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json`
- `gsd-tools phase uat-passed 25 --raw`

## Gaps Summary

**Not green:** integration evidence records a finding or failed verdict.
