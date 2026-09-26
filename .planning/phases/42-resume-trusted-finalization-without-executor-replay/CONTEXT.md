# Phase 42 — Resume trusted finalization without executor replay

Split from phase 41 T-41-04 on 2026-09-25 by operator decision. Scope, research and threat model are inherited from phase 41 (`../41-reduce-pipeline-subscription-overhead/CONTEXT.md` P41-D and `41-RESEARCH.md:251-260`), and the plan text was already approved by phase 41's independent checker.

Delivery order: after phase 41, before phase 40. Phase 40 tickets that extend the Codex delivery host or the commit finalizer (T-40-01, T-40-09, T-40-12, T-40-14, T-40-18, T-40-27) depend on T-42-01.

Environment constraint: the trusted verification runner's OS sandbox denial tests need a host where `sandbox-exec` or `bwrap` can be exercised directly. Two sandboxed executor runs could not do this.
