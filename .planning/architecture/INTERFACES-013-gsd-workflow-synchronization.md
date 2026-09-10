# Interfaces — ADR-013 GSD workflow synchronization

## CLI

```text
node plugins/delivery-pipeline/scripts/gsd-sync.cjs [--check] [--json] [--phase <N>]
```

Exit codes:

- `0`: projection written or already synchronized;
- `1`: source/config/artifact conflict, stale projection in `--check`, or
  verification state that cannot be represented safely; and
- `2`: malformed CLI arguments.

The JSON result is stable and contains `ok`, `mode`, `source_fingerprint`,
`generated_files`, `phases`, `counts`, and `blockers`.

## Gate launcher

`capabilities/delivery-pipeline/checks/gsd-sync-gate.cjs` resolves the canonical
script from its installed sibling, checks applicability, and runs either write
or check mode according to the lifecycle hook. It must not fall back to a
different project checkout silently.

## Ownership marker

Every wholly generated file carries this marker in its first bytes. For files
with required YAML frontmatter (`STATE.md`, summaries, UAT, and verification),
the marker is the first comment inside the opening `---` block so GSD's parser
still sees frontmatter at byte zero. Human-authored `ROADMAP.md` keeps the same
marker as a begin/end block around only the generated section:

```text
<!-- shipyard:gsd-sync generated; source fingerprint: <sha256> -->
```

The roadmap uses the same marker as a begin/end block so human-authored text
outside that block is retained.
