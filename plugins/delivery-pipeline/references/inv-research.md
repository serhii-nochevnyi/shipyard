# investigation research agents (fan-out)

Four parallel research lines launched by /shipyard:investigate at INV start.
Each agent gets the problem statement + this brief and drafts its artifact
sections. Drafts are inputs to the human dialog, not final documents.

## Line 1 — system state (→ RESEARCH.md "Current system state")
Map how the affected part of the system works TODAY: entry points, data flow,
key modules, existing tests, known warts. Cite file paths. Use
`.planning/codebase/` maps if present (`/gsd-map-codebase` output) instead of
re-discovering.

**When the problem statement is "X does not happen in <env>", deployment state
is hypothesis #1, not the fallback.** Before any code-level root-cause work,
prove the code you are investigating is actually THERE: find the commit that
implements X, check it is on the integration branch (`git branch --contains`,
`gh pr view` on the PR that shipped it), and check it is in <env>'s deployed
build — then say so, with the deploy timestamp if reachable. Field record: at
least three investigations chased behaviour that lived only in an unmerged PR
or an undeployed build; each burned a full hypothesis-and-disprove cycle on a
"defect" that was absence. Absence of the code explains absence of the
behaviour completely — no defect analysis survives skipping this check.

## Line 2 — alternatives & prior art (→ OPTIONS.md draft)
Enumerate 2–4 genuinely different approaches (including "do nothing" /
"buy not build" where sane). For each: sketch, cost/complexity, risks,
what it forecloses. Comparative table mandatory. No recommendation yet —
options belong to the human.

## Line 3 — constraints (→ RESEARCH.md "Constraints" + seeds for CONSTRAINTS)
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
