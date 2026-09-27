# Risks

From `research/risks.md` §4 (full evidence there), plus risks moved here from OPEN-QUESTIONS.md.
Severity is the impact if the item is built wrong.

## Cross-cutting

## R-X1 — Checkpoint signal silently dropped when T-43-12 lands
severity: high
mitigation: Both seams test `human_checkpoint === true` (`claude-role-host.cjs:377`, `deliver-dispatch.cjs:90`). Plan P44-F strictly after T-43-12. Add a regression fixture that `review`, `merge` and `true` all still yield `signals.checkpoint=true` until an accepted ADR-014 amendment. Ask the T-43-12 owner to include the assertion.

## R-X2 — Shared-file collisions with pending phase-43 tickets
severity: high
mitigation: Every P44 PLAN names the phase-43 ticket it follows on each shared file (RESEARCH.md Delivery constraints) and re-reads line references after that ticket merges. Gate 2 rejects unordered shared paths.

## R-X3 — Readiness read from a stale state projection
severity: medium
mitigation: `delivery-state.json` lists phase 40 pending although it is merged. Readiness for phase 44 is defined by merged commits on `origin/main` plus installed-host digests, never by the projection. Run state-sync on the authoritative tree before the phase-44 graph gate; this investigation does not rewrite the projection (another session owns the main checkout).

## R-X4 — Source present is not installed is not verified
severity: high
mitigation: Each P44 item records installed, behaviourally verified and efficiency-measured states separately; installed-host proofs are explicit steps in the plans.

## R-X5 — Phase-45 boundary erosion
severity: medium
mitigation: P44-B reuse stays arch-review only; any shared identity primitive is versioned and documented as the only shared surface; no ledger or scheduler in phase 44.

## R-X6 — Efficiency claimed from inference
severity: high
mitigation: Reports say `inconclusive` until matched cohorts exist; no acceptance criterion contains a savings percentage.

## P44-A

## R-A1 — Collector breaks or alters the user's statusline
severity: high
mitigation: If a wrapper is built, it buffers stdin once and forwards identical bytes; collector failure never changes renderer output or exit; install/uninstall touch only owned keys; tests use an isolated HOME.

## R-A2 — Credentials or account identifiers persisted
severity: high
mitigation: Strict field whitelist; Codex `credits` and `plan_type` excluded; no e-mail, user id or token; private file mode and bounded retention; a negative fixture asserts no auth material in stored records.

## R-A3 — Non-additive percentages summed or mis-windowed
severity: medium
mitigation: Bucket identity is provider + account scope + bucket id + window + reset; units are normalized per source (Claude stream fraction, statusline and Codex percent); reset, decrease or account change gives a discontinuity.

## R-A4 — Codex observer becomes a model launch or a second backend
severity: high
mitigation: Observation is read-only and never sends a turn; no change to the `codex exec` launch path.

## R-A5 — No idle baseline for Codex
severity: medium
mitigation: Idle `account/rateLimits/read` is unverified. Phase 44 relies on in-turn snapshots, marks idle coverage `unverified`, and treats a later read-only probe as an optional follow-up, not an acceptance condition.

## R-A6 — Uncontrolled concurrent usage attributed to Shipyard
severity: medium
mitigation: `concurrent_usage=unknown` by default, which makes the result inconclusive.

## P44-B

## R-B1 — Reused verdict hides a violation or misses a changed input
severity: high
mitigation: Inventory every host input before fixing the key; a mutation test per key field must miss; a reused violation stays blocking; an unknown input field disables reuse.

## R-B2 — Reuse composes with T-43-13 carry and double-grants a verdict
severity: high
mitigation: Exact reuse requires an identical base; a carried verdict is never a reuse source; plan P44-B after T-43-13.

## R-B3 — Single-flight deadlock or duplicate launch after a crash
severity: high
mitigation: Reservation states `inflight|completed|failed|unknown`; `unknown` blocks automatic redispatch and names a recovery action; no file lock is held across a model run; crash-boundary fixtures.

## R-B4 — Usage double-counted or original receipt replaced
severity: medium
mitigation: `outcome: reused` carries the original dispatch id and receipt; attribution deduplicates by the original dispatch.

## R-B5 — One provider's verdict satisfies a required other-provider review
severity: high
mitigation: Runtime/provider is a key field; a cross-provider requirement is evaluated independently of any cache.

## P44-C

## R-C1 — Required instruction lost on one runtime
severity: high
mitigation: Coverage per rule id × role × runtime; installed-host loaded-source digests as acceptance; refuse a launch whose mandatory rule is unaccounted.

## R-C2 — Relying on Claude path rules for mandatory checks
severity: medium
mitigation: Mandatory rules load at role level; path rules only for scoped reference material.

## R-C3 — Destructive edits to target repositories
severity: medium
mitigation: Target layouts are fixtures; any migration is a separate human-authorized change.

## R-C4 — Generated Codex artifacts drift from the Claude source
severity: medium
mitigation: Changes go through `gen-codex-shipyard.cjs` and its drift check, with a parity test through both adapters.

## R-C5 — Effective Codex instruction budget unknown
severity: medium
mitigation: The effective AGENTS.md budget and nested loading under `--ignore-user-config` are unverified. The P44-C plan starts with a spike on the installed host and treats the measured limit as an input, never an assumed 32 KiB.

## P44-D

## R-D1 — Advisory silently becomes automatic transfer
severity: high
mitigation: Keep the `automatic_transfer.allowed: false` literals; test that no P44-D path mutates ownership.

## R-D2 — Mixed cohorts produce misleading advice
severity: medium
mitigation: Cohort key includes model, effort, policy hash and instruction digest; mismatch gives `unknown`.

## R-D3 — Fork counted as a small fresh context; warmup omitted
severity: medium
mitigation: Separate resume/fork/compact/fresh-start classes; totals include checkpoint, successor startup, rereads and cache warmup.

## R-D4 — Extra model wake for unchanged advice
severity: low
mitigation: One decision per (recommendation, source-state fingerprint).

## P44-E

## R-E1 — A shared false claim propagates to all four lines
severity: high
mitigation: Critical risk and constraint claims are rechecked against primary sources per line; contradictions force expansion.

## R-E2 — Stale facts after a source change
severity: medium
mitigation: Content digest plus revision; any change invalidates.

## R-E3 — Selection omits material evidence without an overflow signal
severity: high
mitigation: Observed in this INV: contract-named files sat only in `source_refs`. The packet builder must refuse when a contract-mandated source is absent; add a fixture.

## P44-F

## R-F1 — Policy change activated silently
severity: high
mitigation: A record-only migration leaves the resolver and the policy hash unchanged; a test asserts the receipt policy hash is unchanged by that ticket.

## R-F2 — Legacy or unknown reason de-escalated
severity: high
mitigation: Absent, unknown and legacy reasons keep today's promotion; no bulk reclassification.

## R-F3 — Approval semantics altered
severity: high
mitigation: The reason is orthogonal to the `human_checkpoint` value; merge-permission fixtures are identical before and after.

## R-F4 — Grids diverge per reason
severity: medium
mitigation: Observed-selection receipts on both grids per reason value before any activation.

## P44-G

## R-G1 — Experiment arm treated as baseline or active by default
severity: high
mitigation: Separate versioned schema, not a third `TREATMENT_KEYS` entry; disabled by default; activation only through recorded approval.

## R-G2 — Experiment counted as a saving
severity: high
mitigation: Failed, repair, escalation and abandoned costs are included; insufficient evidence is inconclusive.

## R-G3 — Trials consume the quota they measure
severity: medium
mitigation: Any pilot needs approval with an explicit cap.

## R-G4 — Arbitrary model override path introduced
severity: high
mitigation: Arms resolve only through the trusted host; no request-time override.

## R-G5 — Duplicate-review concurrency unknown
severity: low
mitigation: The audit does not record whether the T-02-12 reviews overlapped. The P44-B choice does not depend on it if single-flight is kept; if single-flight is dropped, concurrent duplicates remain possible and are measured by the reuse report.
