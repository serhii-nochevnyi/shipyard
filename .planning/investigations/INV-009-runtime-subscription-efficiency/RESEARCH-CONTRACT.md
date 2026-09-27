# Research contract — INV-009 (subscription efficiency per runtime → phase 44)

Read-only research. Do not edit code or any file except your own artifact.

## Inputs
- `PROBLEM.md` (this directory).
- Phase-44 preparation, which is a proposal and not an accepted design:
  `.planning/phases/44-optimize-subscription-efficiency-per-runtime/CONTEXT.md`, `RESEARCH.md`,
  `WORK-PACKAGES.md`, `PLANNING-STATUS.md`, and the copied evidence under `evidence/`
  (`REPORT.md`, `IMPLEMENTATION-RESEARCH.md`, `RUNTIME-SPECIFIC-ADDENDUM.md`, `MANIFEST.json`).
  The preparation was written on 2026-09-26, before phase 40 shipped in release 0.67.0; re-check
  every claim it makes about the source against this revision.
- Accepted designs that bound the scope: `.planning/architecture/ADR-014-*.md`, `ADR-017-*.md`,
  `ADR-019-*.md`, `ADR-020-*.md`.
- Owners that must not be duplicated: `.planning/phases/40-*/40-*-PLAN.md`,
  `.planning/phases/41-*/41-*-PLAN.md`, `.planning/phases/42-*/42-*-PLAN.md`,
  `.planning/phases/43-*/43-*-PLAN.md` (phase 43 is being delivered now; most of its tickets are
  pending), and `.planning/phases/45-*/{CONTEXT,WORK-PACKAGES}.md` (phase 45 / INV-008 belongs to
  another session; read it only to draw the boundary).
- Source: `plugins/delivery-pipeline/scripts/`, `plugins/delivery-pipeline/workflows/`,
  `scripts/gen-codex-shipyard.cjs`, the installers under `scripts/`, and `tests/unit/`.
- Everything you need is inside this worktree; do not read paths outside it and do not call any
  provider account API.

## Scope items (phase-local ids from CONTEXT.md)
- P44-A passive provider-specific subscription observation (Claude statusline rate-limit fields;
  Codex `account/rateLimits/read` and sparse `account/rateLimits/updated`).
- P44-B exact-input architecture-review reuse and single-flight.
- P44-C mandatory instruction coverage with runtime-specific delivery.
- P44-D rotation advice on comparable measurements and shadow observations.
- P44-E content-addressed research fact/source index and selective synthesis.
- P44-F typed administrative versus technical checkpoint reasons.
- P44-G disabled-by-default native effort experiment infrastructure.

## Per line
- **system-state**: for each P44 item, the exact current behaviour at file:line on this revision:
  what already exists (for example `usage-attribution.cjs`, `orchestration-overhead.cjs`,
  `session-handoff.cjs`, `runtime-context.cjs`, `context-packet.cjs`, `claude-role-host.cjs`,
  `role-artifact.cjs`, `model-policy-internal.cjs`, `validate-graph.cjs`), what phases 40–43
  changed since the preparation was written, and which phase-40–43 ticket or backlog entry
  already covers part of the item (name it and say what it does or does not cover). Close the
  factual unknowns listed at the end of the phase-44 `RESEARCH.md` wherever the source answers them.
- **alternatives**: 2–3 genuinely different options with trade-offs for each decision item
  (P44-A collector shape per runtime, P44-B reuse key and single-flight mechanism, P44-C coverage
  manifest and delivery, P44-D shadow-observation shape, P44-E index granularity, P44-F reason
  model and its interaction with `human_checkpoint`/`preauthorized` and ADR-020's F17 decision,
  P44-G experiment assignment and promotion rule). Propose a ticket slicing with real data
  dependencies, and say which items could be deferred or dropped without losing the phase goal.
- **constraints**: ADR-014 boundary (receipts, native grids, no widened launch authority, no
  cross-grid aliasing), Claude/Codex parity and generated Codex artifacts, file ownership (list
  every file each item would touch and every open phase-43 plan that also touches it, with the
  ordering needed), test strategy per item (unit/fixture/installed-host), privacy of observation
  data, and backward compatibility.
- **risks**: what breaks if each item is wrong (a reused verdict hiding a violation, a lost
  required instruction, a policy change activated silently, an experiment counted as a saving,
  quota data leaking credentials), and what cannot be verified without an installed host or a
  real subscription account.

Every claim about code carries a file path and line. Every claim taken from the evidence copies
names the evidence file and section, and says whether it still holds on this revision.
