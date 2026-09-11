# Phase 35 integration review

- **Compared:** `epic/35-gsd-and-shipyard-workflow-loop` against `origin/main`
  at the phase integration tree
- **Tickets:** T-35-01 / PR #96, T-35-02 / PR #98, T-35-03 / PR #101
- **Integration follow-up:** runtime-local GSD context / PR #105
- **Review scope:** the combined projection, both lifecycle surfaces, generated
  native artifacts, and the shared Claude/Codex runtime boundary

## Cross-ticket coherence

The phase forms one vertical path: `gsd-sync.cjs` derives the native GSD read
model from plans, graph state, integration evidence, and the roadmap; the
capability launcher invokes that same script at the four lifecycle points; and
the project documentation/bootstrap carries the resulting source fingerprint
and generated artifacts. The runtime follow-up keeps runtime selection
process-local while leaving the project-relative delivery-rules projection
shared (`plugins/delivery-pipeline/scripts/gsd-sync.cjs:868-930`,
`capabilities/delivery-pipeline/checks/gsd-sync-gate.cjs:67-116`,
`plugins/delivery-pipeline/scripts/runtime-context.cjs:106-154`).

There is no second synchronizer or runtime-specific generated projection. The
Codex installer passes `GSD_RUNTIME=codex` and `SHIPYARD_RUNTIME=codex` only to
the generator process, while the Claude-side process uses its own runtime
handshake; neither installer persists a shared project runtime
(`scripts/install-shipyard-codex.sh:68-74`, `scripts/install-shipyard-codex.sh:311-321`).

## Architecture conformance

- **ADR-013 source authority:** the synchronizer reads the canonical planning
  and delivery inputs, fingerprints normalized source bytes, and publishes only
  marked generated files. Missing/unreadable state is a blocker, and every plan
  must have a valid delivery-state observation (`plugins/delivery-pipeline/scripts/gsd-sync.cjs:76-105`,
  `plugins/delivery-pipeline/scripts/gsd-sync.cjs:432-466`,
  `plugins/delivery-pipeline/scripts/gsd-sync.cjs:868-925`).
- **Evidence precedence:** missing integration evidence remains pending;
  failed/needs-fix evidence remains non-green; a phase becomes passed only when
  all plans are merged and repository-local verification evidence is positive
  (`plugins/delivery-pipeline/scripts/gsd-sync.cjs:319-417`).
- **Concurrency boundary:** projection publication uses the same `state` lock
  as state-sync and front refresh, so delivery observations cannot be read from
  one snapshot and published beside another (`plugins/delivery-pipeline/scripts/gsd-sync.cjs:1029-1040`,
  `plugins/delivery-pipeline/scripts/state-sync.cjs:828-850`).
- **Lifecycle boundary:** the launcher selects only a complete canonical script
  bundle, invokes write/check mode with explicit native-artifact adoption, and
  preserves synchronizer exit codes. The capability registers blocking write
  gates after planning/execution/verification and a check gate before ship
  (`capabilities/delivery-pipeline/checks/gsd-sync-gate.cjs:67-116`,
  `capabilities/delivery-pipeline/capability.json:109-185`).
- **Interface contract:** the gate-only ownership transition is documented as
  `--adopt-native`; direct synchronization remains fail-closed for unmarked
  native artifacts (`.planning/architecture/INTERFACES-013-gsd-workflow-synchronization.md:3-30`).

## Acceptance sweep

### T-35-01 — deterministic native GSD projection

The synchronizer covers applicability, scoped delivery detection, graph/state
identity, source fingerprints, evidence precedence, ownership markers, atomic
publication, idempotency, and check mode. Unit coverage includes ordinary GSD
prose containing `delivery:`, missing delivery state, missing ticket
observations, and shared-lock publication (`tests/unit/gsd-sync.test.cjs:50-310`).

### T-35-02 — lifecycle gates on both runtimes

The gate is inert for ordinary GSD projects, blocks malformed/stale conveyor
projects, adopts native artifacts only after applicability is proven, and
selects complete installed bundles. The capability manifest declares the
runtime-neutral synchronization setting and all four lifecycle points
(`tests/unit/gsd-sync-gate.test.cjs:39-130`,
`capabilities/delivery-pipeline/capability.json:41-59`,
`capabilities/delivery-pipeline/capability.json:109-185`).

### T-35-03 — project bootstrap and documentation

The generated project artifacts are reviewed as projections: they retain
pending/non-green historical evidence rather than inventing completion, while
the phase-35 integration record supplies the explicit evidence required for
this phase to become green. T-35-03 remains a human checkpoint in both the
plan frontmatter and regenerated graph, so the final epic merge cannot be
silently delegated. The public workflow documents the same projection and
runtime boundary (`docs/gsd_multilevel_delivery_pipeline.md:47-62`,
`docs/gsd_multilevel_delivery_pipeline.md:888-893`,
`docs/gsd_multilevel_delivery_pipeline.md:917-943`).

## Verification evidence

- `node plugins/delivery-pipeline/scripts/validate-graph.cjs` passed on the
  integration tree: 82 tickets, 15 waves; only pre-existing graph warnings
  were reported.
- `node tests/unit/gsd-sync.test.cjs` passed: 22 tests.
- `node tests/unit/gsd-sync-gate.test.cjs` passed: 9 tests.
- `make test-fast` passed on the exact integration tree: 160 tests passed, 0
  failed; graph, worktree, sentinel, docs, and SSH sync smoke suites passed.
- `make test-codex-shipyard` passed: `codex-shipyard smoke: OK`.
- `git diff --check origin/main...HEAD` passed with no whitespace errors.

## Findings

No cross-ticket coherence, architecture, acceptance, or verification finding
remains after the integration fixes recorded in this review. Historical phase
findings outside phase 35 remain projected in their existing non-green state;
they are not changed by this integration report.

**Verdict: passed**
