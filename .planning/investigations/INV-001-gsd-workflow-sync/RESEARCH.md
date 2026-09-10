# Research

## Current system state

- The installed GSD version is `1.13.0` in both the Codex and Claude homes;
  `@opengsd/gsd-core` is the active package. The GSD core documentation
  identifies `ROADMAP.md`, `STATE.md`, and `REQUIREMENTS.md` as the foundation
  artifacts, and its progress model counts plan summaries.
- `node /Users/serhii/.codex/gsd-core/bin/gsd-tools.cjs query validate.health
  --raw` currently returns `status: broken` with `E004 STATE.md not found` and
  warnings for missing canonical PROJECT headings and four roadmap phases with
  no phase directory.
- `node .../gsd-tools.cjs query roadmap.analyze --raw` finds 79 plans across
  phases 20–29 and 32, but zero summaries. The delivery graph contains the
  same 79 ticket/plan identities and the delivery front reports all 79 as
  `done`/`merged`.
- `.planning/phases/*/INTEGRATION.md` exists for phases 24–29 and 32. Existing
  evidence is not uniformly passing: phase 27 records `needs-fix`, while phase
  29 records a passed repository-verifiable integration review.
- `capabilities/delivery-pipeline/capability.json` currently blocks Gate 2 at
  `plan:post` and the UAT predicate at `ship:pre`, but it has no synchronizer
  step or projection gate.
- `scripts/install-shipyard-capability.sh` and
  `scripts/install-shipyard-codex.sh` copy every plugin `scripts/*.cjs` into
  the installed capability/check bundle; the Codex generator copies the whole
  scripts/references/templates payload. A canonical synchronizer under
  `plugins/delivery-pipeline/scripts/` will therefore reach both runtimes.

## Constraints

### Technical

- PLAN frontmatter and `.planning/graph/tickets.json` are the stable mapping
  between GSD plan identity and Shipyard ticket identity; the synchronizer
  must refuse ambiguous or missing mappings rather than guess.
- `.planning/graph/delivery-state.json` is a local cache of observed delivery
  facts, while `delivery-front.json` is the actionable projection. The GSD
  projection may read both, but it must not invent live GitHub facts.
- GSD `phase uat-passed` requires at least one real `### N. ...` block with a
  column-zero `result: passed|pass` and no blockers. A generated UAT file must
  obey this parser and must report pending/failed evidence honestly.
- Writes must be atomic and serialized. A `--check` mode must compare the
  expected projection without changing files.
- Human-authored roadmap and integration prose must be preserved. Generated
  sections need explicit markers or wholly generated files.

### Product

- The user asked for high synchronization and a closed GSD workflow. This
  implies one authoritative execution state with a native GSD read model, not
  two independently edited workflows.
- A green delivery ticket is not automatically a green phase: the phase still
  needs integration/verification evidence. The projection must retain that
  distinction.

### Delivery

- The current delivery loop deliberately replaces GSD's native execute/ship
  orchestration for PR-per-ticket work, as documented in
  `docs/gsd_multilevel_delivery_pipeline.md`. The synchronization seam must
  complement that replacement rather than dispatch GSD executors in parallel.
- All generated Codex artifacts must continue to come from the Claude plugin
  source; changes to the canonical scripts must be covered by generator and
  smoke tests.

## Unknowns

- None that block the implementation. The parser shape and lifecycle hook
  points are documented by the installed GSD 1.13.0 and are covered by the
  decisions below.
