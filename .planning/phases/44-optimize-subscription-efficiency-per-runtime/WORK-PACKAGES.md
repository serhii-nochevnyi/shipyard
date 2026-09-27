# Phase 44 proposed decomposition

These are bounded work packages for the authenticated planner, not executable PLAN files or allocated ticket IDs. Cross-package ordering here expresses real data/interface dependencies; serialize edits to shared files at planning time instead of inventing ticket dependencies merely for scheduling.

## WP-A — Subscription observation contract and comparable reporting

Covers P44-A/G. Define provider/account/bucket/window identities, sparse-update semantics, freshness, source provenance and outcome joins. Extend existing attribution/reporting rather than replacing it. Proposed module: `subscription-observation.cjs`; focused test: `subscription-observation.test.cjs`. Keep percentages separate by provider; input/output/cache/reasoning are explanatory metrics, not quota conversion. Failed/interrupted work stays visible.

Acceptance: decimal percentages retained; resets/account changes/decreases cause discontinuity; duplicate views counted once; uncontrolled concurrent activity yields inconclusive; no raw prompts or credentials persisted. Contract is the prerequisite for WP-B/C and experiment reporting.

## WP-B — Claude subscription collector and reversible installation

Depends on WP-A contract. Extend supported Claude installer with an opt-in wrapper that buffers statusline stdin once, records whitelisted metadata and forwards identical input to the preexisting renderer. Do not edit the user's active statusline as part of development. Tests use isolated runtime homes. Preserve custom command, output and failure behavior; uninstall restores owned settings only.

Acceptance: malformed/missing windows, cancellation, renderer failures, private bounded storage, fractional values, no network/model turn from collection. Installed interactive sample proves the path; headless-worker coverage is explicit. Required test commands are determined from the final installer owner in phase 40.

## WP-C — Codex subscription collector

Depends on WP-A contract. Use the supported installed app-server schema and subscription authentication; do not introduce API keys or replace the existing execution backend. Preserve multi-bucket identity and merge sparse updates safely. Model execution remains behind the existing host.

Acceptance: initialized protocol, unsupported versions/auth refusal, partial notifications, legacy alias deduplication, resets and account changes, bounded observation frequency and no model turn. Distinguish schema support from successful authenticated retrieval. Integration fixture plus read-only installed subscription snapshot required before claiming availability.

## WP-D — Runtime-specific instruction coverage

Covers P44-C. Inventory and classify shared required rule IDs, create a coverage manifest, and adapt existing role/packet generation for Claude imports/path rules and Codex startup/role refs. Keep universal constraints present. Use pdffiller's instruction layout as a fixture or explicit later migration target, not an implicit application-repository edit.

Acceptance: planning before reads, new files, deletions, PHP/frontend/test/review roles, override precedence, effective budget, duplicate-version detection and installed loaded-source evidence. Native instructions remain consistent with the shared policy. No blanket omit/increase-budget shortcut.

## WP-E — Exact-input review identity, immutable evidence and single-flight

Covers P44-B. Build a versioned full governing-input manifest, reuse authenticated immutable verdicts before evidence preparation, and use fenced reservations for simultaneous identical requests. Native hosts return distinct launched/reused outcomes while preserving original receipts and current live gates. Coordinate with changed-base carry owner but never implement carry here.

Acceptance: one launch for two simultaneous exact requests; reused violation blocks; head/base/plan/policy/instruction/model/runtime changes miss; missing/altered evidence refuses; unknown child liveness prevents duplicate launch; crash recovery cannot fabricate completion; independently required second-provider review remains required. Run native-host contract tests plus new focused `review-reuse.test.cjs` (proposed).

## WP-F — Rotation observation adapter and shadow decisions

Covers P44-D. Depends on stable phase-41 handoff/measurements and WP-A reporting contract. Feed existing advice comparable model/effort/policy/instruction observations; deduplicate advice and classify resume/fork/compact/fresh-start separately. Automatic transfer stays disabled in this package.

Acceptance: mixed cohorts unknown, no extra model wake for unchanged advice, active/unknown children block handoff, costs include warmup and startup, fork does not count as small fresh context, existing CAS ownership invariant preserved. Extend rotation-recommendation tests; do not reimplement phase-41 checkpoints.

## WP-G — Research fact manifest and selective synthesis

Covers P44-E. Depends on installed phase-40 planning artifact host; integrates WP-D required-rule identity where applicable. Add source and claim index with repository/revision/digests/provenance and bounded finding references. Preserve four lines, complete mandatory material and full durable research artifacts.

Acceptance: changed source invalidates; false shared claim independently challenged; contradictions force evidence expansion; all material constraints survive synthesis; optional-source selection lowers measured complete workload without hiding research or parent costs. Extend packet/workflow fixtures and installed-path evidence; preserve current receipt/sealer contracts.

## WP-H — Typed checkpoint reason and conservative policy migration

Covers P44-F. Depends on final approval semantics from the previously identified F17 owner, not its former proposed phase number. Add authenticated administrative/technical/mixed/unknown reason, preserving human_checkpoint authorization. Propose canonical ADR-014 amendment and migrate parser/projections/signals/native resolver fixtures together. Legacy and unknown remain conservative.

Acceptance: administrative action stays human-gated; technical/critical/contested signals still promote; both native grids produce observed receipts; merge permission unchanged. Activation remains blocked until the policy amendment passes the required review; no production override shortcut.

## WP-I — Separate native effort experiment infrastructure

Covers P44-G. Depends on WP-A/B/C measurement, WP-D instruction identity and a stable baseline after upstream work. Version the experiment schema; define eligibility, assignment, observed arm identity, unchanged tests/reviewer, cost accounting, stop/rollback and non-inferiority evaluation. Preserve the production model grid by default. Claude Sonnet/high vs max is an experimental candidate; Codex alternatives require its own supported-pair decision after Luna/max baseline data.

Acceptance: no arbitrary model override, no silent activation, independent arms/worktrees, all repairs/escalations/failures counted, missing evidence inconclusive, severe quality regression stops experiment. A finite controlled pilot can be activated only through recorded policy/experiment approval. Infrastructure completion is not proof of quota savings or quality equivalence.

## Integration and rollout

Use the normal post-merge independent phase integration gate, not an extra duplicate ticket. First ship metadata collection and instruction coverage, then reuse/observation/index changes, then typed policy/experimental infrastructure. Collect matched outcomes with unchanged gates; keep runtime-installed proof separate from unit fixtures. No automatic production experiment or provider scheduler is activated by this queue entry.

## Planner output required

Every PLAN must have exact ownership, requirements, dependencies, bounded tasks, meaningful verification, must_haves and rollout/refusal checks. Assign ticket IDs and global requirements only in the validated flow. Mark policy/authorization changes as human checkpoints. Required shared files should have an explicit serialization/ownership plan. No task is deliverable until typed researcher/planner/checker artifacts and the real graph gate pass.
