---
# shipyard:gsd-sync generated; sync-version: 1; source fingerprint: 3cd62328e7ad203b16358d5301b339c92a0ac46ea71ecb9a2d1c2a566b434e9d
phase: 25
verified: 2026-09-10T09:03:52.068Z
status: gaps_found
shipyard_source_fingerprint: 3cd62328e7ad203b16358d5301b339c92a0ac46ea71ecb9a2d1c2a566b434e9d
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
- `node /Users/serhii/.codex/gsd-core/bin/gsd-tools.cjs phase uat-passed 25 --raw`

## Gaps Summary

**Not green:** integration evidence records a finding or failed verdict.
