# Phase 34 integration review

- **Phase:** 34 — Improve convergence and tune from measured outcomes
- **Compared:** the Phase 34 implementation branch against `origin/main` at
  `59c8fc09711097927b2ad67487e22390884f04f5`
- **Scope:** T-34-01 through T-34-05, covering OPT-09 through OPT-13
- **Delivery:** PRs #167, #168, #169, #170 and #171 merged into the phase epic
- **Review mode:** repository-local architecture review plus focused contract tests

## Verdict

**passed (repository-verifiable acceptance)**

The five slices use the existing dispatch, review, front, state-sync, trailer,
usage and backlog boundaries. Review identity, model capability, carry proof,
capacity admission and optimization reporting are separate contracts with
explicit unknown/degraded outcomes. No new launch path, provider mixing or
online policy mutation was introduced.

## Cross-ticket coherence

1. Reviewer output is decorated by `review-signature.cjs`; sentinel persists a
   bounded observation history and uses it to classify progress. Missing identity
   and corrupted history remain unknown, so neither can reset a retry backstop.
2. `model-capability.cjs` is called only from the dispatch boundary for model-axis
   decisions. Adapter snapshots preserve the native Claude or Codex palette, and
   unsupported or unknown selections use a bounded preceding rung.
3. `gate-trailer.cjs carry` proves ancestry, head tree, base tree and live PR
   identity twice around the write. A race or changed base returns the work to a
   fresh review.
4. `capacity-lease.cjs` is injected by the host and consumed by the boundary;
   `state-sync.cjs` and `front.cjs` publish the same shared-capacity coverage.
   Provider and declared account scope are part of the lease key.
5. `pipeline-stats.cjs` emits metadata-only optimization input. The report and
   candidate writers are atomic and idempotent, retain failed evidence, and
   never auto-launch or rewrite the canonical policy.

## Acceptance sweep

| Ticket | Integrated result | Evidence |
|---|---|---|
| T-34-01 | Stable review signatures, persisted progress and independent resource state. | `review-signature.cjs`, `failure-signature.cjs`, `sentinel.cjs`, focused unit tests |
| T-34-02 | Capability-aware escalation with same-runtime bounded fallback and repair evidence. | `model-capability.cjs`, both adapters, `dispatch-boundary.cjs`, focused unit tests |
| T-34-03 | Carry refuses changed ancestry, trees, PR identity and concurrent movement. | `gate-trailer.cjs`, `tests/unit/trailer.test.cjs` |
| T-34-04 | Distinct-agent leases, nested parent checks, expiry and degraded fallback. | `capacity-lease.cjs`, `front.cjs`, `state-sync.cjs`, focused unit tests |
| T-34-05 | Versioned report, rollback decision and non-launching backlog candidate. | `optimization-report.cjs`, `pipeline-stats.cjs`, `backlog-index.cjs`, focused unit tests |

## Architecture review findings

The review found and corrected three boundary issues before delivery: a deep
repair fallback could lose its predecessor dispatch identity, arbitrary review
sentences could masquerade as stable rule classes, and a corrupt review history
could be overwritten during settlement. The final implementation keeps all three
cases explicit and fail-closed.

## Verification evidence

- `make test-fast` passed: all unit and smoke suites passed with 0 failures.
- `make test-codex-shipyard` passed: `codex-shipyard smoke: OK`.
- `make test-releases` passed: release notes smoke passed for all 72 tags.
- `node plugins/delivery-pipeline/scripts/validate-graph.cjs` passed.
- `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json` passed.
- `git diff --check origin/main...HEAD` passed with no whitespace errors.

## Measurement limits

Repository fixtures prove attribution, accounting and decision safety. They do
not claim provider quota savings or treatment effectiveness. A production report
requires real joined usage, explicit provider/account scope, a predeclared cohort
and the quality observation window; incomplete evidence remains inconclusive.
