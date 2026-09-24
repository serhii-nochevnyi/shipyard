# The Codex plan-checker lease test flakes on CI

**Found:** 2026-09-24, PR #202 (planning only).
**Scope:** none of the phase 39 tickets.

`production gsd-plan-checker reaches its native child and records session evidence`
failed once with `run-controller: the run lease has expired`
(`codex-runtime-host.cjs:1034` → `run-controller.cjs:801`) and passed on a rerun
of the same commit. The test is timing-sensitive against the controller lease.
Fix candidate: inject the clock or extend the lease in the fixture.
