# ADR-016 — conveyor session friction

- **Status:** accepted
- **Date:** 2026-09-24
- **Decision owner:** repository operator
- **Scope:** Shipyard investigate, decompose and host hooks on Claude Code and Codex
- **Supersedes:** none
- **Related:** ADR-008, ADR-013, ADR-014, ADR-015, INV-003
- **UI design:** none

## Context

Proving-ground session 3f4c2390 (MYD-17627) reached an ADR, twelve plans and
twelve Jira issues, but never followed the conveyor as designed. Release 0.61.0
closed the typed-host blocker. INV-003 re-verified the remaining friction at
`befc970c`:

- host refusals surface only internal codes (`claude-decompose-host.cjs:26-30`,
  `claude-investigation-host.cjs:66-72`);
- investigate stops without `.planning/` and nothing builds the GSD project
  decompose needs (`investigate.md:65`, `decompose.md:63,329`, `gsd-tune.cjs:326`);
- the stop gate enforces a foreign worktree's front in sessions that never ran
  deliver (`stop-gate.cjs:83-91,514-529`);
- the auto-route hook has no investigate route and injects on every prompt
  (`install-shipyard-claude-hook.sh:109-131`, `install-shipyard-codex.sh:592-610`);
- no ADR template, and Gate 1 does not run `adr-ingest.cjs`;
- Jira export is performed by the model by hand (`decompose.md:488-613`);
- linearization prose is vaguer than `validate-graph.cjs:545-549`, and
  order-only relations become `depends_on`, serializing the graph;
- no warning for untracked `.planning/`, the GSD UI gate runs for scopes with no
  design source, and `gsd-tune` gives no next step;
- the research consumer discards verified research when a summary exceeds a
  500-character bound the worker never saw (`claude-delivery-host.cjs:506-516`).

Detail: `.planning/investigations/INV-003-conveyor-session-friction/`.

## Decision

- Fix the friction as a hybrid by failure class: deterministic scripts with focused tests where the model could not or did not comply, and prose or templates pinned by docs tests where a pointer suffices.
- Host refusals keep their codes, exit status and fail-closed behaviour, and add a plain-language hint with a remedy from one shared code-to-hint map used by the Claude and Codex hosts; investigate and decompose relay the hint to the user in the user's language and never suggest bypassing a host.
- Decompose bootstraps a minimal GSD project from the accepted ADR when `config.json`, `ROADMAP.md` or `REQUIREMENTS.md` is missing: one phase per ADR, one requirement id per ADR decision bullet parsed by `adr-ingest.cjs`, only missing files are created, and an ADR without decisions is refused in plain language; investigate needs only `.planning/investigations/`.
- The stop gate enforces a front only in a session that deliver armed with a per-session marker keyed by `session_id`; a missing, unreadable or foreign marker allows the stop, and cross-worktree front discovery stays for armed sessions.
- The auto-route hook routes unclear or research-needing work to `/shipyard:investigate` through `/shipyard:route`, reads the prompt from stdin, stays silent for `<task-notification>` turns and expanded slash commands, injects on unparseable input, and the Codex AGENTS.md block and `make doctor` follow it.
- Shipyard ships `templates/adr/ADR.md`, `adr-ingest.cjs` gains a no-write `--check` mode, and Gate 1 fails when the new ADR does not pass it.
- A script builds a deterministic Jira export plan from `tickets.json` with issue content, repo-namespaced labels and explicit `is blocked by` direction, the agent executes it verbatim through MCP, and keys are recorded by script; no network code or credential enters the conveyor.
- Ordering without a code dependency is not a `depends_on`; the decompose and delivery-rules prose adopt the validator's condition, and `validate-graph.cjs` warns when a same-phase dependency shares no `files_modified` with its parent.
- Decompose passes `--skip-ui` to `/gsd-plan-phase` only when the ADR declares `UI design: none`.
- Decompose warns once, without blocking, when `.planning/` is not tracked by git, naming the consequence for delivery worktrees and the remedy.
- `gsd-tune` names the missing configuration file and the command that creates it, keeping exit code 2 and its prefix.
- Research handbacks receive their 500-character bound at launch and are bounded or refused deterministically with a message naming the line and length, before the trusted consumer seals them.

## Consequences

- A repeat of MYD-17627 can go investigate → decompose → Jira plan without a
  `/gsd-new-project` detour, invented requirements or unexplained refusals.
- The stop gate stops interrupting analysis and investigation sessions, at the
  cost of a new marker that deliver must write; a forked session must re-arm.
- The route hook becomes a small program with fixture tests instead of static text.
- Jira export needs one MCP pass that follows a plan instead of free-form calls.
- Graphs built under the new rule should have more parallel waves; the
  diamond-child base limitation still requires linearizing real multi-parent
  code dependencies.
- Installer changes reach users only after reinstall; the repeat run starts with
  `make install-shipyard-claude-hook` and `make doctor`.

## Out of scope

- Upstream GSD defects: multi-line `**Goal**` parsing and the `~/.gsd/defaults.json` warning.
- The ADR-014 model/effort grid, the dispatch boundary contract and fail-closed receipt verification.
- A direct Jira REST client or any change to ADR-008 D4.
- A new order-only field in the graph schema.
- Exporting this initiative's own tickets to Jira.
- Planner latency optimisation.
