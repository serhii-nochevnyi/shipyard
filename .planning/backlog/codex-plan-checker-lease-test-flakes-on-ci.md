# The Codex plan-checker lease test flakes on CI

**Found:** 2026-09-24, PR #202 (planning only).
**Scope:** none of the phase 39 tickets.

`production gsd-plan-checker reaches its native child and records session evidence`
failed once with `run-controller: the run lease has expired`
(`codex-runtime-host.cjs:1034` → `run-controller.cjs:801`) and passed on a rerun
of the same commit. The test is timing-sensitive against the controller lease.
Fix candidate: inject the clock or extend the lease in the fixture.

**Update 2026-09-24:** it now fails on most CI runs (#202, #209 twice, one of the
three production-role tests each time). Cause: `leaseTtlMs: 120`, `heartbeatMs: 20`
and a child that closes at 170 ms, so an event-loop stall above ~100 ms expires the
lease. A verified local fix is 1200/50/1500 ms (14/14, three runs); it could not
ride on T-39-12 because T-39-01 also edits this test file (Gate 2 contested path).
