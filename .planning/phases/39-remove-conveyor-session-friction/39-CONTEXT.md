# Phase 39: Remove conveyor session friction - Context

**Source:** [ADR-016](../../architecture/ADR-016-conveyor-session-friction.md) (accepted 2026-09-24), ingested as `.planning/.adr-ingest/ADR-016-conveyor-session-friction.ingest.md`
**Investigation:** `.planning/investigations/INV-003-conveyor-session-friction/`
**Research:** `39-RESEARCH.md`
**Requirements:** REQ-125 .. REQ-135
**UI design:** none

<domain>
## Phase boundary

Remove the friction that proving-ground session 3f4c2390 hit on the
investigate → decompose → Jira → deliver path: explainable host refusals, an
ADR-derived GSD bootstrap, a stop gate armed only by deliver, an
investigate-aware route hook, ADR validation at Gate 1, a deterministic Jira
export plan, ordering kept out of `depends_on`, an explicit UI-gate skip, an
untracked-planning warning, a clearer gsd-tune message and bounded research
handbacks. All work stays in this repository and adds no npm packages, network
code or external tools.
</domain>

<decisions>
## Locked decisions (ADR-016 `## Decision`, one per bullet)

- **D-01:** Fix the friction as a hybrid by failure class: deterministic scripts with focused tests where the model could not or did not comply, and prose or templates pinned by docs tests where a pointer suffices.
- **D-02:** Host refusals keep their codes, exit status and fail-closed behaviour, and add a plain-language hint with a remedy from one shared code-to-hint map used by the Claude and Codex hosts; investigate and decompose relay the hint to the user in the user's language and never suggest bypassing a host. (REQ-125)
- **D-03:** Decompose bootstraps a minimal GSD project from the accepted ADR when `config.json`, `ROADMAP.md` or `REQUIREMENTS.md` is missing: one phase per ADR, one requirement id per ADR decision bullet parsed by `adr-ingest.cjs`, only missing files are created, and an ADR without decisions is refused in plain language; investigate needs only `.planning/investigations/`. (REQ-126)
- **D-04:** The stop gate enforces a front only in a session that deliver armed with a per-session marker keyed by `session_id`; a missing, unreadable or foreign marker allows the stop, and cross-worktree front discovery stays for armed sessions. (REQ-127)
- **D-05:** The auto-route hook routes unclear or research-needing work to `/shipyard:investigate` through `/shipyard:route`, reads the prompt from stdin, stays silent for `<task-notification>` turns and expanded slash commands, injects on unparseable input, and the Codex AGENTS.md block and `make doctor` follow it. (REQ-128)
- **D-06:** Shipyard ships `templates/adr/ADR.md`, `adr-ingest.cjs` gains a no-write `--check` mode, and Gate 1 fails when the new ADR does not pass it. (REQ-129)
- **D-07:** A script builds a deterministic Jira export plan from `tickets.json` with issue content, repo-namespaced labels and explicit `is blocked by` direction, the agent executes it verbatim through MCP, and keys are recorded by script; no network code or credential enters the conveyor. (REQ-130)
- **D-08:** Ordering without a code dependency is not a `depends_on`; the decompose and delivery-rules prose adopt the validator's condition, and `validate-graph.cjs` warns when a same-phase dependency shares no `files_modified` with its parent. (REQ-131)
- **D-09:** Decompose passes `--skip-ui` to `/gsd-plan-phase` only when the ADR declares `UI design: none`. (REQ-132)
- **D-10:** Decompose warns once, without blocking, when `.planning/` is not tracked by git, naming the consequence for delivery worktrees and the remedy. (REQ-133)
- **D-11:** `gsd-tune` names the missing configuration file and the command that creates it, keeping exit code 2 and its prefix. (REQ-134)
- **D-12:** Research handbacks receive their 500-character bound at launch and are bounded or refused deterministically with a message naming the line and length, before the trusted consumer seals them. (REQ-135)

## Scope fences (INV-003 DECISIONS, binding)

- The ADR-014 model/effort grid, the dispatch boundary, refusal codes and fail-closed receipt verification do not change.
- Bootstrap creates only missing files and never rewrites existing ones; one phase per ADR; every requirement id maps 1:1 to an ADR `## Decision` bullet parsed by `adr-ingest.cjs`; it refuses in plain language when the ADR has no decisions; it adds no launch outside the decompose hosts.
- The stop-gate marker is per `session_id` and never tracked; a missing, unreadable or foreign marker means allow; existing stop-gate behaviour for armed sessions stays green; `--fork-session` yields a new id, so a forked session must re-arm.
- Jira: no network code in scripts; export never blocks decomposition; this initiative's own tickets are not exported.
- Linearization: the hint is a warning, never a Gate 2 error; the contested-path rule and the diamond warning are unchanged.
- UI: without the marker decompose invokes GSD exactly as today; Shipyard does not change GSD's UI detection.
- Hints: codes, exit status and fail-closed behaviour are unchanged; the hint never suggests bypassing a host; Claude and Codex hosts share the map.
- Route hook: it still only points at `/shipyard:route`; it injects on unparseable input; the Codex AGENTS.md block gets the same route; `make doctor` compares the installed hook.
- ADR check: `--check` writes nothing; the template is validated by the same function in a test; existing accepted ADRs are not re-validated.
- Untracked planning: warning only, with the exact consequence and remedy; never blocks.
- gsd-tune: exit code 2 and the `gsd-tune:` prefix are unchanged; only the message text changes.
- Handback: the bound is passed to the worker and enforced deterministically; the sealed envelope and receipt checks are unchanged.

## Claude's discretion (resolved by the planner)

- Module names: `scripts/refusal-hints.cjs`, `scripts/adr-bootstrap.cjs`, `scripts/stop-gate-arm.cjs`, `scripts/auto-route.cjs`, `scripts/jira-export.cjs` (all under `plugins/delivery-pipeline/`).
- Hint wire format: host stderr line 1 is unchanged; line 2 is `hint[<CODE>]: <plain language> — remedy: <action>`. Capability JSON gains a `hint` field.
- Stop-gate marker: `<git rev-parse --git-common-dir>/shipyard/stop-gate-armed/<session_id>.json`; outside git, `<cwd>/.planning/graph/stop-gate-armed/<session_id>.json` (gitignored).
- REQ-135 uses **bound plus notice** (not refuse): an over-long summary is capped with the `capSummary` rule and a stderr line names the line id and original length, so verified research is not discarded for the whole fan-out.
- Partial GSD project at bootstrap: create only the missing files and report `skipped_existing`; never edit an existing ROADMAP or REQUIREMENTS file.
- After a fresh bootstrap, decompose may run `gsd-tune --apply` only for a `config.json` the bootstrap created in the same run.
- Prose tickets pin their text with their own contract test files and do not extend `tests/unit/source-contract.test.cjs`; they stay text-only so they carry no code dependency on the script tickets. Script existence is checked at the phase gate.
- Fixed CLI contracts shared by prose and script tickets:
  - `node ${CLAUDE_PLUGIN_ROOT}/scripts/adr-ingest.cjs --check --input <adr> [--input …] [--json]` → exit 0 / exit 1
  - `node ${CLAUDE_PLUGIN_ROOT}/scripts/adr-bootstrap.cjs --adr <adr> [--phase <N>] [--json]` (project root) → exit 0 + report / exit 1 + plain refusal
  - `node ${CLAUDE_PLUGIN_ROOT}/scripts/jira-export.cjs plan --repo <owner/repo> --project <KEY> [--issue-type <t>] [--epic-issue-type <t|none>] [--graph <dir>] [--json]`
  - `node ${CLAUDE_PLUGIN_ROOT}/scripts/jira-export.cjs record <T-NN-MM> <KEY> [--graph <dir>]`
  - `node ${CLAUDE_PLUGIN_ROOT}/scripts/stop-gate-arm.cjs arm --session-id "${CLAUDE_SESSION_ID}"` (Claude only)
</decisions>

<ticket_map>
## Ticket map

| Ticket | Requirements | Decisions | Wave | depends_on |
|---|---|---|---|---|
| T-39-01 refusal hints | REQ-125 | D-01, D-02 | 1 | — |
| T-39-02 ADR template + `--check` | REQ-129, REQ-126 (`decisionEntries`) | D-06, D-03 | 1 | — |
| T-39-03 deliver-armed stop gate | REQ-127 | D-04 | 1 | — |
| T-39-04 route hook | REQ-128 | D-05 | 1 | — |
| T-39-05 Jira export plan | REQ-130 | D-07 | 1 | — |
| T-39-06 order-only validator hint | REQ-131 | D-08 | 1 | — |
| T-39-07 gsd-tune message | REQ-134 | D-11 | 1 | — |
| T-39-08 research handback bound | REQ-135 | D-12 | 1 | — |
| T-39-09 ADR bootstrap | REQ-126 | D-03 | 2 | T-39-02 (imports `decisionEntries`) |
| T-39-10 decompose prose | REQ-125, REQ-126, REQ-130, REQ-131, REQ-132, REQ-133 | D-02, D-03, D-07, D-08, D-09, D-10 | 1 | — |
| T-39-11 investigate prose | REQ-125, REQ-126, REQ-129 | D-02, D-03, D-06 | 1 | — |

T-39-09 → T-39-02 shares no `files_modified`; it is a real import dependency, so
the new REQ-131 warning on it is expected and correct.

Single-owner files that carry other tickets' text (plan check, 2026-09-24):
`README.md` is owned only by T-39-04 and also states the REQ-126 intake/bootstrap
and REQ-127 deliver-armed stop-gate behaviour (text only, no code dependency);
`tests/unit/dispatch-record.test.cjs` is owned by T-39-03 because it drives the
real stop gate with an unarmed `{}` payload.
</ticket_map>

<deferred>
## Out of scope (ADR-016 `## Out of scope`)

- Upstream GSD defects: multi-line `**Goal**` parsing and the `~/.gsd/defaults.json` warning.
- The ADR-014 model/effort grid, the dispatch boundary contract and fail-closed receipt verification.
- A direct Jira REST client or any change to ADR-008 D4.
- A new order-only field in the graph schema.
- Exporting this initiative's own tickets to Jira.
- Planner latency optimisation.
- Version bump and release notes (`plugin.json`, capability version, release entry): a post-phase release step, not a phase ticket.
- Changing the adapter `REPAIR` constant in `claude-dispatch-adapter.cjs`.
</deferred>

## Phase gate

- `make test-fast` green after all tickets merge (per-wave merge check, not a ticket verification command).
- Script-existence check over the prose: `grep -ohE 'scripts/[a-z-]+\.cjs' plugins/delivery-pipeline/commands/decompose.md plugins/delivery-pipeline/commands/investigate.md | sort -u | xargs -I{} test -f plugins/delivery-pipeline/{}`.
- On the host: `make test`, `make install-shipyard-claude-hook`, `make install-shipyard-codex`, `make doctor`.
