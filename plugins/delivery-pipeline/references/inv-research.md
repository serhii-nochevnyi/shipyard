# investigation research agents (fan-out)

Four parallel research lines launched by /shipyard:investigate at INV start.
Each agent gets the problem statement + this brief and drafts its artifact
sections. Drafts are inputs to the human dialog, not final documents.

## Line 1 — system state (→ RESEARCH.md "Поточний стан")
Map how the affected part of the system works TODAY: entry points, data flow,
key modules, existing tests, known warts. Cite file paths. Use
`.planning/codebase/` maps if present (`/gsd-map-codebase` output) instead of
re-discovering.

## Line 2 — alternatives & prior art (→ OPTIONS.md draft)
Enumerate 2–4 genuinely different approaches (including "do nothing" /
"buy not build" where sane). For each: sketch, cost/complexity, risks,
what it forecloses. Comparative table mandatory. No recommendation yet —
options belong to the human.

## Line 3 — constraints (→ RESEARCH.md "Обмеження" + seeds for CONSTRAINTS)
Hard technical constraints (compat promises, schema/migration limits, perf
budgets, security boundaries), product constraints (flows that must not
change, flags policy), delivery constraints (review/PR conventions, CI gates).
Each constraint: source (file/doc/person) + confidence.

## Line 4 — risks & unknowns (→ RISKS.md + OPEN-QUESTIONS.md drafts)
What can bite: integration risks, data risks, rollout risks, org risks.
Every unknown becomes an OPEN-QUESTIONS.md checkbox item
(`- [ ] <question> — owner: <who can answer>`); do not silently absorb
unknowns into prose.

## Shared rules
- Read-only: no code changes, no scaffolding.
- If a hypothesis needs empirical validation by throwaway code, do not do it —
  recommend a `/gsd-spike "<idea>"` instead and list it in the draft.
- Every claim about the codebase carries a file path; every external claim
  carries a source.
