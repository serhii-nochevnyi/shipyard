---
status: open          # open | closed — Gate 1 sets `closed`
closed:               # YYYY-MM-DD, filled in at Gate 1
adr:                  # path to .planning/architecture/ADR-NNN-*.md, filled in at Gate 1
---

# Problem

## What we are solving

Proving-ground session 3f4c2390 (MYD-17627, 2 h) reached INV → ADR → 12 PLAN
files → 12 Jira issues, but never followed the conveyor as designed. After the
0.61.0 release (origin/main `befc970c`) closed the typed-host blocker (phase 38),
ten friction points remain in the path from a raw request to delivered tickets:

1. Host refusals from `scripts/claude-decompose-host.cjs` and
   `scripts/claude-investigation-host.cjs` surface only internal codes
   (`REFERENCE_UNAVAILABLE`, `INVALID_INPUT`); the commands do not require a
   plain-language relay to the user.
2. No investigate → decompose bridge: `commands/investigate.md:65` sends the user
   to `/gsd-new-project` and stops; decompose needs `config.json`, `ROADMAP.md`,
   `REQUIREMENTS.md` but never creates them from the ADR.
3. `scripts/stop-gate.cjs` blocks sessions that never ran deliver: it selects the
   freshest front across all repository worktrees (`stop-gate.cjs:83-91`).
4. The auto-route hook written by `scripts/install-shipyard-claude-hook.sh` has
   no investigate route or triggers and fires on `<task-notification>` and slash
   prompts.
5. No `templates/adr/ADR.md`; Gate 1 (`commands/investigate.md:170-184`) does not
   run `scripts/adr-ingest.cjs` as a validator.
6. Jira issue and link creation is performed by the model by hand
   (`commands/decompose.md:537`); `scripts/jira-project.cjs` only watermarks
   status transitions.
7. Linearization prose (`commands/decompose.md:432`,
   `skills/delivery-rules/SKILL.md:114`) is vaguer than
   `scripts/validate-graph.cjs:547`; order-only links become `depends_on`.
8. No preflight warning when `.planning/` is untracked by git.
9. The GSD UI gate is invoked for prototype / no-Figma scopes.
10. `scripts/gsd-tune.cjs:326` reports "the conveyor's own project root" with no
    actionable instruction.

## For whom

Developers who drive shipyard on a real project through Claude Code (primary)
and Codex (generated parity), and the model that executes the conveyor on their
behalf.

## Current pain

~17 min of blocker explanations, ~11 min of `gsd-new-project` detour with
invented requirements, hand-made Jira export (22 MCP calls with manual link
direction), a strictly serial 11-wave graph, three rejected AskUserQuestion
prompts in a row, and stop-hook demands to deliver from sessions that only
analysed.

## What success will be

- Every item above has a deterministic fix with a focused unit or fixture test;
  `make test-fast` and `make test` stay green; Codex outputs are regenerated.
- A repeat of MYD-17627 on the released version goes investigate → decompose →
  Jira without manual detours, invented requirements, or unexplained refusals.

## What is definitely out of scope

- Upstream GSD defects (multi-line `**Goal**` parsing, `~/.gsd/defaults.json`
  warning) — reported to gsd-core, not fixed here.
- Changes to the ADR-014 model/effort grid or the dispatch boundary contract.
- Removing the fail-closed receipt verification closed by phase 38.
- Planner latency optimisation (measured after the repeat run, not designed now).
- Exporting this initiative's own tickets to Jira (user decision 2026-09-24):
  decomposition stops at PLAN files and the validated graph. Item 6 (a
  deterministic Jira export capability for projects that use Jira) stays in
  scope as a conveyor feature.
