# Decisions

<!-- Every accepted position is recorded IMMEDIATELY at the moment of the decision, not at the end. -->
<!-- Record format: -->
<!-- ## <decision, as an affirmative statement> -->
<!-- **Why:** ... -->
<!-- **What was rejected:** ... -->
<!-- **Scope fence:** what this decision explicitly does NOT cover -->
<!-- These sections become the locked decisions in the ADR when Gate 1 is closed. -->

## Build the seams first and gate releases on a live round (strategy B+C)
**Why:** Invented boundary fixtures let three host ↔ workflow defects ship, and a hand-built dispatch request cost two full executor rounds; only structural seams plus a live round stop both classes (RESEARCH item 0, item 2; OPTIONS comparison).
**What was rejected:** A (point fixes only: item 0 and item 2 recur), B alone (Codex proven only against fixtures), A+C (model keeps assembling requests), D.
**Scope fence:** No change to the ADR-014 grid, resolver input, receipt shape or fail-closed verification; the entry point calls the existing hosts and boundary, it is not a second boundary.

## Capture boundary fixtures from real producers and require them for registered boundaries
**Why:** Item 0; `tests/fixtures/claude-assistant-session.jsonl` is synthetic and T-39-12 kept inline shapes (RESEARCH).
**What was rejected:** hand-authored fixtures; live CLI calls in CI (CI is offline).
**Scope fence:** Capture is a manual `make` target with scrubbing and a recorded CLI version; CI only replays committed fixtures.

## One deterministic front → dispatch entry point for Claude and Codex with a host-issued in-flight record
**Why:** Items 1, 2, 3, 6, 8 share one cause: the model builds requests, launches and waits by hand (RESEARCH).
**What was rejected:** documenting the request shape better; a stop gate reading process tables; model-written marks before launch.
**Scope fence:** The in-flight record is host-issued at launch with pid and TTL and fails closed on expiry; the durable dispatch mark still follows the verified receipt; ticket `type` is mapped, never forwarded as `signals.type`; branch and plan path come from the graph and the ticket worktree.

## The conveyor establishes sentinel preconditions itself
**Why:** Item 4; three consecutive sentinel refusals on a stale base ref and unsynced state (RESEARCH).
**What was rejected:** relaxing identity or base checks; documenting a manual ritual.
**Scope fence:** A preflight fetches and fast-forwards the base ref, runs state-sync and commits it, or refuses naming the exact command; a swallowed fetch failure becomes a refusal.

## A live release gate on an in-repo fixture project
**Why:** 0.61.0 shipped without one live executor round (Option C); FlowPDF alone is external state (RISKS R8).
**What was rejected:** FlowPDF as the only acceptance target; CI-driven live runs.
**Scope fence:** `make test-live` runs locally with the cheapest allowed model per runtime; the release script refuses without a fresh passing live receipt; FlowPDF is a secondary acceptance run after its leftovers are cleaned.

## Target-project PRs carry no conveyor or GSD internals
**Why:** Item 13, user requirement 2026-09-24; proving-ground PRs expose `T-NN-NN` titles, `Ticket:`/phase/ADR lines, `ticket/T-…` branches and `.planning/` files (research/pr-hygiene-evidence.md).
**What was rejected:** a hidden HTML ticket marker; cleaning only `.planning/` and bodies.
**Scope fence:** Branches `<type>/<slug>` or `<type>/<JIRA-KEY>-<slug>`, stored in the graph; conventional-commit titles; bodies without ticket, phase, ADR, plan or conveyor terms; matching by exact head branch plus the PR number recorded in delivery state, with the title/prefix fallback kept only for legacy PRs; `.planning/` untracked in target projects; a publish-time PR hygiene gate checks title, body, branch and diff paths. The Shipyard repository's own PRs are exempt.

## A supported dogfood mode with recorded host provenance
**Why:** Item 9; three installed cache files were overwritten with unmerged code and receipts cannot tell (RESEARCH).
**What was rejected:** detection only (forces a release per fix); silent cache patching.
**Scope fence:** Hosts run from a worktree through a separate install root; receipts carry source sha and a dirty flag; doctor reports a cache matching no release; a dogfood host may not merge into a target project's default branch.

## Point-fix forks follow alternative 1
**Why:** User decision 2026-09-24 accepting the recommended alternative for each remaining fork (OPTIONS "Other item-level forks").
**What was rejected:** the alternative-2 column for each fork.
**Scope fence:** Digest refresh via a make target plus a CI-checked commit trailer (item 5); research keeps valid lines sealed and re-dispatches only the failed line, the fan-out stays failed until all four exist (item 7); header-free deterministic state YAML (item 10); pre-push resolves the worktree through git, not command text (item 11); one shared sealer for research and decompose results on Claude and Codex, absorbing the Claude-only backlog entry `decompose-host-returns-no-artifact-index.md` (C3/C6); Codex tasks passed by file path plus digest (C5); C1 remedy, C2 Claude-only keys, C4 researcher write scope limited to its artifact, C7 prose, C8 doctor manifest path as point fixes.
