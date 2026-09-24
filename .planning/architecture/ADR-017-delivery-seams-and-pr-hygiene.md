# ADR-017 — delivery seams, Codex loop repair and PR hygiene

- **Status:** accepted
- **Date:** 2026-09-24
- **Decision owner:** repository operator
- **Scope:** Shipyard deliver, investigate and decompose hosts, fixtures, release process and target-project PRs on Claude Code and Codex
- **Supersedes:** none
- **Related:** ADR-004, ADR-014, ADR-016, INV-004
- **UI design:** none

## Context

The first end-to-end Claude delivery of phase 39 ran one four-ticket wave three
times and never completed a PR-sentinel round. Three host ↔ workflow defects
passed `make test-fast` because boundary fixtures are authored by the consumer
(`tests/fixtures/claude-assistant-session.jsonl` is synthetic; unit tests stub
the CLI inline in `tests/unit/claude-runtime-host.test.cjs`). The orchestrator
hand-built executor requests that no script produces
(`claude-delivery-host.cjs:19` is the only reference to the request schema),
forwarded the ticket `type` as `signals.type` as `deliver.md:1711-1713` tells it
to (refused at `model-policy-internal.cjs:422-423`), polled in the foreground,
and overwrote three installed cache files with unmerged code. The stop gate
fired during in-flight work because the dispatch mark lands only after the
receipt (`deliver.md:1826`). The sentinel refused on a stale base ref and
unsynced state (`claude-role-host.cjs:168-188`, `:485-520`).

A Codex session on FlowPDF could not run loop 1 or loop 2: no Codex research
consumer exists (`sealPlanningResearch` only at `claude-delivery-host.cjs:506`),
the GSD researcher is forced read-only while it must write its artifact
(`codex-decompose-host.cjs:18`, pinned by `tests/unit/codex-decompose-host.test.cjs:35,103`),
neither decompose host seals a decomposition result, the parent relays a
shortened task undetected (`codex-runtime-host.cjs:638-643`), a config refusal
recommends a reinstall (`codex-agent.cjs:21,187`), `gsd-tune --runtime codex`
writes Claude-only keys (`gsd-tune.cjs:606-609`), and doctor looks for a
manifest the installer never writes (`shipyard-doctor.cjs:192-195`).

Target-project PRs expose conveyor internals: `T-NN-NN:` titles, `Ticket:`,
phase and ADR lines, `ticket/T-…` branches and `.planning/` files in the epic →
main diff (proving-ground #693, #702). Evidence: INV-004 `research/`.

## Decision

- Strategy: build the seams first and gate releases on a live round; point fixes land on top of the seams.
- Boundary fixtures for registered producer ↔ consumer boundaries are captured from real producers by a manual scrubbed `make` target that records the CLI version, and a contract test refuses inline shapes for those boundaries.
- One deterministic front → dispatch entry point for Claude and Codex builds host requests from the graph (branch from the graph, plan path from the ticket worktree, ticket `type` mapped and never forwarded as `signals.type`), launches detached, and offers `status` and `wait` through a `dispatch` wait kind.
- The host writes an in-flight record with pid and TTL at launch that the stop gate honours and that fails closed on process exit or expiry; the durable dispatch mark still follows the verified receipt.
- A sentinel preflight fetches and fast-forwards the base ref, runs and commits state-sync, or refuses naming the exact command; a failed fetch is a refusal, never swallowed.
- `make test-live` runs one real research → decompose → executor → sentinel round per runtime on an in-repo fixture project with the cheapest allowed model, and the release script refuses without a fresh passing live receipt.
- Target-project PRs carry no conveyor or GSD internals: branches `<type>/<slug>` or `<type>/<JIRA-KEY>-<slug>` stored in the graph, conventional-commit titles, bodies without ticket, phase, ADR or plan identifiers, `.planning/` untracked in target projects, and a publish-time PR hygiene gate over title, body, branch and diff paths; the Shipyard repository is exempt.
- Ticket ↔ PR matching uses the exact head branch plus the PR number recorded in delivery state at creation; the title and `ticket/<ID>-` fallback stays only for legacy PRs.
- A supported dogfood mode runs hosts from a worktree through a separate install root, stamps receipts with host source sha and dirty flag, is refused for merges into a target default branch, and doctor reports an installed cache that matches no release.
- The runtime-file digest pin is refreshed only by a make target and a commit trailer that CI verifies.
- Research keeps valid lines sealed, names the failed line and its real cause, and re-dispatches only that line; the fan-out stays failed until all four lines are sealed.
- One shared sealer produces `shipyard.research-result.v1` and `shipyard.decomposition-result.v1` with an artifact index for Claude and Codex research and decompose hosts.
- The Codex GSD researcher writes only its contained artifact path, and Codex child tasks are passed by file path plus digest that the host verifies.
- Point fixes: the state YAML is header-free and deterministic; the pre-push hook resolves the worktree through git instead of command text; the Codex config refusal names the config fix; `gsd-tune --runtime codex` writes no Claude-only keys; investigate and decompose prose explain the out-of-repo host state directory; doctor reads the Codex agents manifest.
- Unit fixtures that create git repositories are hermetic against global commit signing and fixed `/tmp` paths.

## Consequences

- The model no longer assembles dispatch requests or wait loops; `deliver.md` shrinks around the entry point.
- Boundary changes require a re-capture; fixtures age with the CLI and a version check makes that visible.
- Releases need local credentials and a few minutes of live runs.
- Target-project branch names and PR text change shape; old `ticket/T-…` PRs still match through the legacy fallback.
- Most tickets overlap phase 39 files and wait for the phase 39 epic on `main`; the live acceptance happens after phase 39 is released.
- Installer and hook changes reach users only after reinstall; acceptance starts with `make install-shipyard-claude-hook`, `make install-shipyard-codex` and `make doctor`.

## Out of scope

- The ADR-014 model/effort grid, the resolver input schema, the receipt shape and fail-closed receipt verification.
- Work already planned as T-39-01..T-39-12.
- The Codex plan-checker lease flake backlog entry.
- Exporting this phase's tickets to Jira.
- Applying PR hygiene to the Shipyard repository's own PRs.
