# INV-006 research synthesis

Status: all four canonical research lines completed through the locally patched
Codex host. Each has an authenticated durable dispatch receipt and sealed file
index. This is research completion, not an accepted ADR or Gate 2 pass.
Source checkout: `68e3a158f9224709caa32665726355d4f4127b1b`.

## Complete evidence

The full reports retain all source paths, read commands, constraints, unknowns
and options. They are preserved verbatim because their bytes are sealed:

- [System state](research/system-state.md).
- [Alternatives](research/alternatives.md).
- [Constraints and ownership](research/constraints.md).
- [Risks and acceptance scenarios](research/risks.md).
- [Authenticated receipt/artifact references](RESEARCH-RECEIPTS.json).

Seed audits remain linked from the phase CONTEXT. Their processing totals are
historical evidence, not subscription credits or a causal savings percentage.

## Consolidated findings

| Priority | Existing seam and residual work | Ownership fence |
| --- | --- | --- |
| A | `context-packet.cjs`, `claude-role-host.cjs`: observe complete prompts and installed identities; compare first-response usage | T-39-17 owns selection/bounds; verify its integrated implementation first |
| B | `session-handoff.cjs`, `run-waker.cjs`: adopt bounded decision/gate/artifact checkpoints with fenced resume | Preserve attempts and active dispatches; include startup and cache warmup |
| C | `stop-gate.cjs`, `stop-gate-arm.cjs`: prove installed arming and owner-only wake behavior | T-39-03 owns arming; implement only reproduced residual gaps |
| D | `codex-delivery-host.cjs`, `delivery-commit-finalizer.cjs`: persist an authenticated execution candidate before finalization and resume it idempotently | No stale green reuse; phase 40 retains formatter/provenance/stream work |
| E | `gsd-sync.cjs`: derive each projection fingerprint from governing inputs and dependent edges | Keep aggregate invalidation and read-only consistency checks |
| F | `usage-report.cjs`, `usage-attribution.cjs`, `orchestration-overhead.cjs`: join deduplicated parent/child usage to verified outcomes | Unknown remains unknown; existing quality and readiness gates remain |

Exact source lines and commands for each row are in the four complete reports.
The narrow reuse option matches the already approved P41-A–F scope. Broader
assemblers, automatic session rotation, a daemon and a new ledger are outside it.

## New operational observations and reconciliation

1. At the user's explicit request, a worktree-bound local host was installed
   outside Git at `/Users/serhii/.local/state/shipyard/phase41-local-host`.
   It calls the real Codex delivery/decomposition hosts and boundary. All four
   investigation calls completed with real receipts, containment checks and
   SHA-256 indexes. The global installation was not modified by this work.
2. Each local context packet was 218,008 bytes (54,502 bytes/4 estimated tokens)
   despite an explicit empty selected-backlog list: this installed builder still
   carries the inventory. This is one observed bootstrap configuration, not a
   claim about T-39-17's newly integrated source or a savings measurement.
3. The orchestrator queried GitHub: PR #231 merged at 2026-09-25T10:27:34Z;
   phase-39 epic PR #215 merged to main at 10:35:19Z. The pinned research checkout
   was not rebased during runs. Reconcile the new main before detailed plans.
4. The constraints report's requirement to deliver the entire phase-40 closure
   was explicitly a source-only inference. It predates successful operation of
   the user-authorized local consumer. That inference no longer blocks local
   investigation. Production support and the three typed decomposition roles
   are not proven by these four research receipts.

## Remaining design and execution checks

See OPEN-QUESTIONS.md and RISKS.md. Installed role/hook behavior, total handoff
cost and sufficient outcome attribution need later observations. They become
explicit acceptance conditions; unknown efficiency does not mean a functional
fix must wait for a full cohort. The local patch does not complete any phase-40
ticket. Tests were neither added nor run for the temporary host; syntax checks
and actual research operations are the evidence recorded here.
