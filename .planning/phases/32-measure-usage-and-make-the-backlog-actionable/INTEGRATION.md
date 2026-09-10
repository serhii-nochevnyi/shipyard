# Phase 32 integration review

- **Compared:** the phase epic against `origin/main` after both ticket merges
- **Tickets:** T-32-01 / PR #92, T-32-02 / PR #93
- **Review date:** 2026-09-10
- **Verdict:** **passed**

## Cross-ticket coherence

The two ticket slices are file-disjoint and meet at the phase contract rather
than through duplicated helpers. T-32-01 owns the explicit transcript collector
and its tests; T-32-02 owns the source index and its tests. Both CLIs are
read-only, have bounded output, and document the later integration work instead
of pretending to complete the full attribution rollout (`docs/usage-report.md:26-32`,
`docs/backlog-index.md:26-32`). No merge-order or import seam is introduced.

## Architecture conformance

- **ADR-011 D1:** Claude snapshots are keyed by stable message identity with a
  UUID fallback and maxima are retained across updates (`usage-report.cjs:27-39`).
  Ordinary iterations are reconciled before replacing the response aggregate,
  while advisor passes remain separate (`usage-report.cjs:76-90`). Codex
  `token_count` rows are grouped by session and cumulative snapshots are
  de-duplicated by timestamp; decreases remain explicit unknowns
  (`usage-report.cjs:92-121`). Missing counters, malformed rows and incomplete
  input coverage produce warnings rather than fabricated totals
  (`usage-report.cjs:140-147`, `usage-report.cjs:161-185`). Prompt text and
  subscription attribution are excluded by contract (`docs/usage-report.md:26-37`).
- **ADR-011 D2:** The backlog index uses source-qualified, stable section IDs,
  detects repeated headings, tracks source hashes and requires evidence fields
  for verified states (`backlog-index.cjs:69-88`). It covers local notes, GSD
  `999.x` phases and roadmap-only entries without mutating sources
  (`backlog-index.cjs:38-52`, `backlog-index.cjs:90-107`).
- **ADR-011 D3/D11:** Both commands are deterministic, explicit-input tools;
  no network, global settings, model routing or runtime behavior is changed.
  Unknown or incomplete evidence stays visible in the result and the documented
  follow-up packages own collection, attribution and lifecycle writes
  (`docs/usage-report.md:26-32`, `docs/backlog-index.md:26-32`).

## Acceptance sweep

### T-32-01 — usage collector

The unit and CLI tests cover duplicate replay and paths, partial/final updates,
late model metadata, ordinary/advisor iteration reconciliation, cumulative Codex
snapshots and resumed files, counter resets, malformed containers, missing
identity, invalid counters, prompt redaction and unreadable paths
(`tests/unit/usage-report.test.cjs:13-104`). The latest pushed head also passes
the repository `test-fast` check on PR #94.

### T-32-02 — backlog index

The tests cover stable IDs for repeated sections and new files, manifest evidence
validation, stale source hashes, duplicate/invalid states, symlink refusal,
bounded queries without source mutation, GSD phase discovery, roadmap-only
`999.x` discovery and flag-like query terms (`tests/unit/backlog-index.test.cjs:9-59`).

## Verification evidence

- PR #92: CI `test-fast` passed at head `db5427902ec00f984ccecc8a92c0e4f650e46981`; its review threads are resolved and the ticket was merged into this epic.
- PR #93: CI `test-fast` passed at head `7a8f0173fadf9403cba5aecbe2af0af610188221`; its review threads are resolved and the ticket was merged into this epic.
- PR #94: the latest CI `test-fast` run passed on the complete phase diff; the integration PR has no unresolved review threads.

The phase intentionally stops at reliable, read-only measurement and inventory.
Dispatch attribution, prospective collection, lifecycle writes and cold-start
selection remain the explicitly scheduled follow-up packages; they are not
required for this isolated Wave 0 exit.
