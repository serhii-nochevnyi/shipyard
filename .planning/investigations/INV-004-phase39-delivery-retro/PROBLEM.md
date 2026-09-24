---
status: closed        # open | closed — Gate 1 sets `closed`
closed: 2026-09-24
adr: .planning/architecture/ADR-017-delivery-seams-and-pr-hygiene.md
---

# Problem

## What we are solving

The first end-to-end Claude delivery of phase 39 (session `7bcbbf57`, worktree
`/Volumes/KINGSTON/.wt-claude-shipyard/inv-003`, 2026-09-24 11:35–15:20 UTC)
ran one four-ticket wave three times and never completed a PR-sentinel round.
The evidence, with transcript line references, is in
`research/session-evidence.md`. The findings that phase 39 (T-39-01..T-39-12)
and the existing backlog do not already cover:

0. Systemic: boundary unit fixtures are authored to the consumer's expectation,
   not captured from the real producer. Three live Claude host ↔ workflow
   defects passed `make test-fast` (missing `--json-schema`, adapter handing the
   host wrapper instead of `output`, `normalizeScope` rejecting a
   `shipyard.run.v1` scope). 0.61.0 shipped without one live executor round.
1. The stop gate demands dispatch while dispatches are in flight: the dispatch
   mark lands only after the receipt, at the end of the work.
2. There is no deterministic front → dispatch entry point; the orchestrator
   hand-wrote executor request files (`mkexec.cjs`) and got `signals` and
   `planPath` wrong, and hand-managed `nohup`/`pgrep`/`kill -0`.
3. `pipeline-config.cjs resolveDispatch` rejects `signals.type:
   "implementation"`, a value the graph carries.
4. The PR sentinel has undocumented preconditions (fresh local base ref, a
   committed state-sync after every push/base merge) and failed three rounds in
   a row.
5. The `source-contract` runtime-file digest pin has no repair path; a
   legitimate adapter fix was unblocked by the model rewriting the digest.
6. Branch-name truncation differs between `tickets.json` and
   `ticket-worktree.sh` (`…-to-eve` vs `…-to-ev`).
7. The research host refusal names the wrong remedy ("install an
   ADR-014-capable host") when a line result fails validation; the whole
   fan-out is discarded instead of the one line.
8. Delivery is driven by foreground polling loops (up to 570 s); capacity 4 is
   not used concurrently with CI and the sentinel.
9. Unmerged fixes were copied over the installed plugin cache to unblock
   delivery; there is no supported dogfood mode and nothing records it.
10. The generated `delivery-state.yaml` header forces a restore ritual before
    every push (~8 times) and stale GSD projections failed CI (#203). Backlog
    entry exists; severity is higher than recorded.
11. The pre-push hook derives the worktree from the command text/cwd and fails
    on `cd X; …` and unexpanded `$W`.
12. Codex CLI (FlowPDF session, `research/codex-flowpdf-evidence.md`) could not
    run loop 1 or loop 2 at all — Phase 9 never got plans:
    - C1 `model_profile: inherit` refusal carries a reinstall remedy instead of
      the config fix;
    - C2 `gsd-tune --apply --runtime codex` writes Claude-only `models.*` keys;
    - C3 no Codex research consumer exists although `investigate.md` documents
      one; the agent improvised a host from internal APIs;
    - C4 `codex-decompose-host.cjs:18` forces the GSD researcher read-only while
      the contract requires it to write its artifact (a test pins the defect);
    - C5 the parent relays a shortened task to `spawn_agent` and the host checks
      no digest of the message;
    - C6 neither decompose host seals `decomposition-result.v1` (shared);
    - C7 the out-of-repo host state directory is not explained to the agent;
    - C8 `make doctor` looks for the wrong Codex manifest and always skips.
13. Pipeline internals leak into target-project PRs
    (`research/pr-hygiene-evidence.md`): titles `T-NN-NN:` / `epic: …
    integration`, body lines `Ticket: T-…`, `Phase N (ADR-NNN)`, `cascades off
    ticket/…`, `ticket/T-…` branch names, and epic → main diffs that carry
    `.planning/` files. The user requires target-project PRs to contain no
    conveyor/GSD technical detail. The `Ticket:` line is a matching key today.

## For whom

Developers who drive shipyard delivery on Claude Code (primary) and Codex
(generated parity), and the orchestrating model that runs deliver.

## Current pain

~1 h of executor time × 4 lost to two blocked rounds, three consecutive sentinel
failures, a hand-built dispatch script, a patched installed plugin, repeated
stop-gate interruptions during in-flight work, and push rituals.

## What success will be

- Every item has a deterministic fix with a focused unit or fixture test;
  boundary fixtures for items 0/4 are captured from real launches.
  `make test-fast` and `make test` stay green; Codex outputs are regenerated.
- A Codex run on FlowPDF (or an equivalent fixture project) completes
  investigate research and decompose through the shipped Codex hosts with no
  improvised host and no inline research.
- A target-project PR opened by the conveyor (ticket and epic) contains no
  `.planning/`/`.shipyard/` paths and no ticket/phase/ADR/plan identifiers in
  its title, body or branch name, while ticket ↔ PR matching still works.
- A live wave of phase 40 is dispatched through the new entry point with no
  hand-built request and no patched cache, and its PR sentinel passes on the
  first round.

## What is definitely out of scope

- Changes to the ADR-014 model/effort grid or the dispatch boundary contract.
- Removing fail-closed receipt verification.
- Work already ticketed as T-39-01..T-39-12 (refusal hints, session-scoped stop
  gate, auto-route hook, research summary cap, gsd-tune message, schema/output/
  run-scope fixes) and the backlog entry for
  the Codex plan-checker lease flake (the decompose artifact index entry is
  absorbed by the shared sealer decision).
- Exporting this phase's tickets to Jira.
- Phase ordering: tickets that touch files changed by phase 39 take a
  cross-phase dependency; the rest start from main (user decision 2026-09-24).
