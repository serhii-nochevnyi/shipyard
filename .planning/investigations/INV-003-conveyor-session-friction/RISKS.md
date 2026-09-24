# Risks

Detail and evidence: `research/risks.md` §2.

## R1 — Scoping the stop gate re-opens the inert-gate failure
severity: high
mitigation: Discriminate by positive evidence that this session ran deliver
(armed marker or recorded owner), never by cwd; keep `tests/unit/stop-gate.test.cjs:393,417`
green; add fixtures for "analysis-only session + fresh foreign front" and the
2026-08-30 stale-main-checkout case.

## R2 — Installed-by-copy hooks do not reach operators
severity: high
mitigation: The MYD-17627 repeat procedure starts with
`make install-shipyard-claude-hook` and `make doctor`; extend doctor to compare
the route hook.

## R3 — Auto-route filtering suppresses legitimate routing
severity: medium
mitigation: Fixture payloads (plain request, slash command, task-notification,
pure question) in `tests/smoke/claude-hook-smoke.sh`; inject on unparseable input.

## R4 — The bridge fabricates requirements or clobbers a project
severity: high
mitigation: Create missing files only; every REQ id traces to one ADR decision
bullet from `adr-ingest`; refuse in plain language when the ADR has no
decisions; fixture proves existing ROADMAP stays byte-identical.

## R5 — Coupling to GSD file formats
severity: medium
mitigation: Generate the minimal subset and validate it in a fixture; record the
gsd-core version the fixture targets.

## R6 — adr-ingest at Gate 1 deletes staged ingests
severity: medium
mitigation: Add a no-write `--check` mode with a unit test; validate the ADR
template with the same function.

## R7 — Refusal hints break code contracts or Codex parity
severity: medium
mitigation: Keep codes/exit status; add a separate hint; put the relay rule in
canonical command text; add `tests/unit/claude-investigation-host.test.cjs`.

## R8 — Jira export crosses the credential boundary
severity: high
mitigation: Script emits a pure-data plan with explicit link direction; the
agent executes via MCP; fixture tests only; no live Jira in CI.

## R9 — Linearization change alters cascade topology
severity: medium
mitigation: Keep `depends_on` semantics; any new signal is additive or a
warning; update graph fixtures deliberately.

## R10 — Untracked-planning warning becomes noise
severity: low
mitigation: Warn once per command preflight with the exact remedy; never block.

## R11 — The initiative recreates a serial graph
severity: medium
mitigation: Slice into independent same-phase tickets with disjoint
`files_modified`; no order-only `depends_on`.

## R12 — The repeat run has no objective pass/fail
severity: medium
mitigation: Define an observable checklist before the run (no `/gsd-new-project`
detour, no unexplained refusal code, no stop-hook block in an analysis-only
session, no invented REQ, graph not a single chain) and keep the transcript.

## R13 — Research sealing still fails after the fix
severity: medium
mitigation: Forward the declared output schema to the runtime or bound the
summary host-side before validation; fixture with an over-long summary.

## R14 — Hook payload shape differs from documentation
severity: medium
mitigation: The route hook reads `prompt` or `prompt_text`, skips a prompt that starts with `<task-notification>` or is marked expanded from a slash command, and injects on anything unparseable; fixture payloads cover both field names. The stop-gate marker treats a changed `session_id` (fork, possibly compaction) as unarmed, which fails open.
