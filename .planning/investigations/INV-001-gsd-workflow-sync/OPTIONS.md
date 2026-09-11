# Options

## Option A — Deterministic native-GSD projection with lifecycle gates

Add one canonical `gsd-sync.cjs` to the delivery plugin. It reads the validated
local plan/graph/delivery evidence and writes `STATE.md`, `REQUIREMENTS.md`,
per-plan `SUMMARY.md`, phase UAT/verification artifacts, and a marked roadmap
status block. Add an applicability-scoped capability gate and invoke it from
the relevant GSD lifecycle boundaries. Missing evidence remains pending or
failed, so the projection cannot manufacture completion.

## Option B — Manual backfill of GSD documents

Create the currently missing Markdown files once and keep them updated by
operator discipline after every delivery run.

## Option C — Replace GSD lifecycle artifacts with Shipyard-only state

Treat `.planning/graph/*` and `INTEGRATION.md` as the only workflow state and
change GSD/Shipyard documentation so native GSD progress is intentionally not
maintained.

## Comparison

| | Option A | Option B | Option C |
|---|---|---|---|
| Synchronization | Deterministic and repeatable | Human-dependent | One-sided; GSD loses state |
| Failure behavior | Can fail closed at lifecycle gates | Drift is discovered late | Native GSD tools remain misleading |
| Complexity | Medium: one projection and gates | Low initially, high ongoing | Medium documentation/runtime churn |
| What it forecloses | Duplicate manual edits to generated fields | Nothing; drift remains possible | Native GSD resume/progress workflows |
| Cross-runtime support | Shared canonical script and generator | Depends on operator | Requires permanent divergence |
