# The generated state YAML header blocks a push from the project checkout

**Found:** 2026-09-24, delivering phase 39.
**Scope:** none of the phase 39 tickets.

`state-sync.cjs` writes `.planning/graph/delivery-state.yaml` with a first line
`# snapshot generation N — observed <ts>`. The installed pre-push hook runs
`publish-gate.cjs --working-tree` against `origin/main`; the comment policy treats
that added YAML comment as a non-allowed comment and blocks every push made from
the project checkout after a state-sync (planning branches, epic refresh).

Workaround used: restore the YAML to the base edition before pushing.
Fix candidates: emit the header as a directive-shaped marker (`shipyard: generated …`),
or exempt generated graph files from the comment policy.
