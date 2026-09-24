# Risks

Detail and evidence: `research/risks.md` §2.

## R1 — Phase 39 fixes are unmerged, so overlapping phase 40 work builds on moving ground
severity: high
mitigation: Cross-phase dependencies for every overlapping ticket (user decision); non-overlapping tickets (item 3 mapping, item 10, item 11, C5, C7 prose, item 13 matching) start from `main`; the live acceptance run happens only after the phase 39 epic is on `main` and a release is cut.

## R2 — Captured fixtures go stale or leak private data
severity: high
mitigation: Scrub step with a test that rejects home paths, tokens and real session ids; every fixture records the producing CLI version and a check flags a mismatch with the installed CLI; capture is a manual `make` target, never CI.

## R3 — A digest repair path weakens the runtime-file pin
severity: high
mitigation: The refresh command requires a commit trailer naming the changed runtime file, CI verifies the trailer accompanies any digest change, and the test still fails when the file changes without the pinned update.

## R4 — A dogfood mode becomes an unreceipted supply path
severity: high
mitigation: Dogfood receipts carry host source sha and a dirty flag; doctor reports a cache that matches no release; dogfood hosts are refused for merges into a target project's default branch.

## R5 — An early in-flight record silences the stop gate for a dead dispatch
severity: medium
mitigation: The record is host-issued at launch, carries pid and TTL (reuse the dispatch-record TTL), and the gate fails closed once the process is gone or the TTL expires; the durable mark still follows the receipt.

## R6 — The entry point duplicates request-schema knowledge
severity: medium
mitigation: The entry point calls the host's own request validator and its tests round-trip through the real host parse path.

## R7 — Mapping `signals.type` is read as an ADR-014 grid change
severity: medium
mitigation: The fix is a mapping at the graph → dispatch boundary; the resolver enum and grid are untouched; deliver prose stops listing ticket `type` as a signal.

## R8 — Live acceptance depends on external state
severity: medium
mitigation: An in-repo fixture project is the primary acceptance target; FlowPDF is secondary after its leftover `.planning/graph/{receipts,transcripts}/codex/` are cleaned; one CI-infrastructure rerun is allowed in "first round".

## R9 — Codex regeneration and GSD projections conflict between parallel tickets
severity: medium
mitigation: The item 10 fix lands early; projections are refreshed per PR as today; generated Codex outputs are verified in one integration step.

## R10 — Widening the Codex researcher's write access
severity: medium
mitigation: Writes are limited to the contained artifact path or the host materializes the artifact from a bounded return; a write outside it is refused; the pinned read-only fixture is replaced by one generated from a real agent file.

## R11 — Per-line research acceptance hides a missing line
severity: medium
mitigation: The fan-out stays failed until all four canonical lines are sealed; only the failed line is re-dispatched; Gate 1 never passes with a line missing.

## R12 — C5 relay verification may be impossible host-side
severity: medium
mitigation: Pass the task by file path plus digest instead of inline text; if the child evidence cannot prove the digest, refuse the launch rather than accept an unverifiable relay.

## R13 — PR hygiene breaks ticket ↔ PR matching or merged-work detection
severity: medium
mitigation: Exact head-branch match stays primary; the PR number is recorded in delivery state at creation; the title/prefix fallback remains only for legacy PRs; fixtures cover a re-decompose rename.

## R14 — Evidence line numbers drift
severity: low
mitigation: Planners re-resolve anchors by symbol at the ticket base revision.

## R15 — A single maintainer reviews every gate
severity: low
mitigation: Gates are mechanical and CI-checked rather than review-based.
