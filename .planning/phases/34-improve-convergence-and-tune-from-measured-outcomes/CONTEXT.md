# Phase 34 context

Phase 34 closes the convergence loop opened by the runtime ladder and the Phase 33 evidence model. The implementation must preserve separate Claude and Codex runtimes, the live merge gates, authenticated dispatch receipts, and model floors.

## Decisions

- Review findings use stable signatures built from rule or class, path, and code location. Missing identity stays unknown and cannot count as progress.
- CI and review progress remain evidence based. Attempt, time, token, and capacity budgets are accounting signals; they never create `plan_defect`, suppress a retry backstop, or authorize a merge.
- A model change is applied only when the runtime capability snapshot proves the selected model and effort, and adaptive repair has a completed authenticated predecessor. Unknown capability evidence falls back to the previous permitted rung.
- Manual merge carry proves the live PR identity, judged head, ancestry, unchanged head tree, and unchanged base tree. Any missing or concurrent proof triggers a fresh review.
- Capacity is admitted through account-scoped leases. A missing scope, failed store, expired owner, or nested launch is represented explicitly; none becomes unlimited capacity.
- Optimization reports are versioned, idempotent, include failed and interrupted runs, and produce a verdict plus a linked backlog candidate. Reports do not rewrite policy or launch work.

## Boundaries

The phase changes deterministic pipeline scripts, their callers, local durable data, tests, and the evaluation documentation. It does not change the model floors, mix Claude and Codex palettes, add a daemon or external queue, or claim economic savings from fixture data.

## Success condition

The review, capability, carry, admission, and report paths are connected to real pipeline callers; negative evidence is visible and fail closed; `make test-fast` passes; and the phase integration report records the measured limits of local verification.
