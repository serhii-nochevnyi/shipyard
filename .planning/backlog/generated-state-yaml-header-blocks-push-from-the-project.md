> **CLOSED 2026-09-25 — REQ-157a.** `state-sync.cjs`'s YAML writer emits neither
> comment line; the file carries no `#` line at all, so comment-policy has
> nothing to block. Fixed candidate 2 was closer than candidate 1: a
> directive-shaped marker would still be an ADDED comment line on every
> regenerating push, so the header is dropped outright rather than reshaped.
> `since`/`mergeable_since` (derived from the sync's own wall clock) are also
> excluded from the YAML body, and object keys are written in sorted order —
> both needed so two independent syncs of identical GitHub state are
> byte-identical, not merely comment-free. The stdout generation line and
> `delivery-state-meta.json` are unchanged. Verified:
> `node tests/unit/state-sync-yaml.test.cjs`.

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
