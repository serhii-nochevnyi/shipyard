---
# shipyard:gsd-sync generated; sync-version: 1; source fingerprint: bb9c03f4b26f9fe9e38f0aed8f728398052bb931e6e1e9fe17a6e1dab801c99d
phase: 41
status: gaps_found
shipyard_source_fingerprint: bb9c03f4b26f9fe9e38f0aed8f728398052bb931e6e1e9fe17a6e1dab801c99d
---

# Phase 41: Reduce pipeline subscription overhead — Verification Projection

**Status:** gaps_found

## Observable Truths

| Truth | Evidence | Status |
|---|---|---|
| Every phase plan is accounted for | 9/9 delivery records are merged | ✓ VERIFIED |
| Integration is coherent | integration evidence records passed | ✓ VERIFIED |
| Verification evidence is present | verification evidence records a failed check | ✗ FAILED |

## Plan Evidence

| Ticket | Delivery | Plan status |
|---|---|---|
| T-41-01 | merged | ✓ VERIFIED |
| T-41-02 | merged | ✓ VERIFIED |
| T-41-03 | merged | ✓ VERIFIED |
| T-41-04 | merged | ✓ VERIFIED |
| T-41-05 | merged | ✓ VERIFIED |
| T-41-06 | merged | ✓ VERIFIED |
| T-41-07 | merged | ✓ VERIFIED |
| T-41-08 | merged | ✓ VERIFIED |
| T-41-09 | merged | ✓ VERIFIED |

## Verification Commands

- `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json`
- `gsd-tools phase uat-passed 41 --raw`

## Gaps Summary

**Not green:** verification evidence records a failed check.
