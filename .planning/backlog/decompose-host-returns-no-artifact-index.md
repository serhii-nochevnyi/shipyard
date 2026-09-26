# The Claude decompose host returns no decomposition artifact index

**Found:** 2026-09-24, decomposing phase 39.
**Scope:** none of the phase 39 tickets.
**Resolved:** T-40-10 — `planning-result-sealer.cjs` `sealDecomposition` seals a
bounded `artifact_index` over CONTEXT.md and every PLAN.md, and
`claude-decompose-host.cjs` returns it from `runDecomposition`.

`commands/decompose.md` requires a sealed `shipyard.decomposition-result.v1`
envelope with an `artifact_index` (paths, bytes, SHA-256 of CONTEXT.md and every
PLAN.md) before Gate 2. `claude-decompose-host.cjs` returns only
`{role, result, receipt, run_id, dispatch_id}`; nothing seals or checks the
index, so the command's materialization check is performed by hand.
A planning branch that is not the default branch also has no documented path to
the phase epic; phase 39 used a planning PR into the epic (#202).
