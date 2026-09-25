# Options

Full per-item option tables with costs: `research/alternatives.md` §3. This file
keeps the overall strategies and the item-level forks that need a human choice.

## Option A — Prose-first (S1)

Tighten `investigate.md`, `decompose.md`, `SKILL.md` and the hook text only.
Cheapest and fully reversible, but prose is what failed in session 3f4c2390 and
most items would have only docs tests.

## Option B — Scripts-first (S2)

Every item gets a deterministic change in its owning script plus a focused
test; prose only calls the scripts. Highest cost (~11 PR-sized tickets), largest
new surface.

## Option C — Hybrid by failure class (S3)

Deterministic code where the model could not or did not comply (1, 2, 3, 4, 5
validator, 6 plan, 11), prose/template plus docs-pinned tests where a pointer
suffices (7 prose, 8, 9, 10).

## Item-level forks

- **Item 2 bridge placement:** 2B at Gate 1 (investigate writes the minimal GSD
  project when absent) vs 2B at decompose Step 0 (decompose bootstraps before
  its preflight). Both reuse `adr-ingest.cjs` decisions; only create missing
  files.
- **Item 3 stop gate:** 3C deliver arms a per-session marker and the gate is
  inert without it; 3A deliver records `session_id` as front owner; 3B parse the
  transcript for a deliver invocation (hook time budget risk).
- **Item 6 Jira export:** 6A deterministic operation plan from `tickets.json`,
  executed verbatim by the agent via MCP, keys recorded by script (fits ADR-008);
  6B direct REST client (supersedes ADR-008 D4, adds a credential).
- **Item 7 order-only links:** 7A prose aligned to the validator + rule "order
  without code dependency is not `depends_on`", with a 7C validator hint for a
  dependency that shares no `files_modified` with its parent; 7B new optional
  order-only field (schema change across consumers).
- **Item 9 UI gate:** pass `--skip-ui` to `/gsd-plan-phase` when the ADR
  declares no design source (explicit marker), vs ask the user once per phase.

## Comparison

| | Option A (prose) | Option B (scripts) | Option C (hybrid) |
|---|---|---|---|
| Complexity | XS–S | L | M |
| Meets "deterministic fix + focused test" | partly (docs tests) | yes | yes, docs-pinned where prose |
| Repeat MYD-17627 without detours | unlikely for 1/2/6 | likely | likely |
| Risks | model ignores prose again | new surface, Jira transport | split is a judgement |
| What it forecloses | little | model discretion everywhere | little |
