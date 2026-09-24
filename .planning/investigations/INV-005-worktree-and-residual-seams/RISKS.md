# Risks

Detail: `research/risks.md` §2 (R1–R16).

## R1 — Phase 39 and phase 40 deadlock on the integrator
severity: high
mitigation: Decide where the integrator fix lands before decomposition (OPEN-QUESTIONS).

## R2 — Excluding .planning from the integrator diff hides contract edits and may not scale
severity: high
mitigation: Keep `.planning` as a name-status summary with digests; refuse with a remedy when the scoped diff still exceeds the bounds; measure again for phase 40.

## R3 — Relaxing the clean-worktree check weakens the evidence boundary
severity: high
mitigation: One scratch registry; the role's own evidence path must be absent (or moved aside with a digest) before launch; test "stale evidence present before launch is refused".

## R4 — T-40-22's provenance sidecar re-creates defect (5)
severity: high
mitigation: Host-owned file set covers provenance; new ticket orders after T-40-22 or T-40-22 is amended.

## R5 — A carry across sibling merges approves unreviewed interactions
severity: high
mitigation: Only a mechanical proof on tree objects; the integrator stays the cross-ticket judge.

## R6 — Sentinel narrowing lets a round act on unjudged PRs
severity: medium
mitigation: New PRs are excluded from the round, never acted on; test for the non-member case.

## R7 — Executor re-verification after a base move weakens the fail-closed contract
severity: medium
mitigation: Keep the base binding; accept only a proven clean rebase or the recorded base.

## R8 — GPG signing breaks hermetic tests and headless host commits
severity: medium
mitigation: Hermetic fixtures (T-40-01) and a signing precondition with a remedy.
