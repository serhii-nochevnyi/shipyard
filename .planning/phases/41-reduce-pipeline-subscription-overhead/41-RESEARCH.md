# Phase 41: Reduce pipeline subscription overhead — Research

Researched: 2026-09-25. Source revision: dc4a7a1cc2397c02c146d891ec99c23fe63ae65a. Domain: Shipyard orchestration, trusted recovery, projections and usage evidence. Confidence: HIGH for inspected source; UNKNOWN for current installed behavior and live efficiency. No new package or framework is recommended.

<user_constraints>
## User Constraints (from CONTEXT.md)

The following accepted scope and boundaries are copied verbatim from CONTEXT.md:43-178 and :317-324. Later planning amendments are identified separately below. The ADR records the original six decisions at ADR-019:29-48.

### Locked Decisions

### P41-A — Complete-prompt measurement and installed packet verification

Build on T-39-17, not a second packet-selection implementation. Capture the
assembled prompt size, packet estimate, observed first-response input and
installed host/policy identity for each role. Separate cache reads, cache
creation and output. Compare like-for-like runtime/model/effort and role scope.

Acceptance:

- Installed arch-review, sentinel and integrator paths demonstrably use the
  selected source/backlog behavior and bounds delivered by T-39-17.
- No implicit full-backlog fallback occurs for those targeted role packets;
  selected inventory and source content are not duplicated unnecessarily.
- Packet bytes/4 is labeled as an estimate, not presented as the provider's
  full launch input. Oversized mandatory input produces a named remedy before
  model launch; rules and applicable constraints are never silently omitted.
- Supersession is scoped to the decisions it replaces: source selection must
  retain still-governing constraints and transitive references.
- Fixtures prove selection/admission behavior; installed-runtime observations
  prove that the shipped path uses it. Neither alone proves quota savings.

### P41-B — Bounded orchestrator continuation

Use the existing session-handoff/controller machinery to carry a compact,
durable checkpoint across phase boundaries and long waits. Include task/run
ownership, accepted decisions, artifact digests, unresolved findings, pending
gates and exact next action. Do not transfer the entire conversation by default.

Acceptance:

- A successor resumes the correct scope without repeating completed delivery
  work, losing constraints or resetting attempt history.
- Measure checkpoint collection, successor startup and cache warmup as part of
  the treatment; a smaller parent transcript alone is not proof of savings.
- Missing/stale checkpoints refuse unsafe continuation and name recovery.
- No live dispatch is orphaned or duplicated by the handoff.

### P41-C — No model wakeup for foreign or unchanged waiting work

Treat T-39-03 as the implementation dependency. Phase 41 verifies installation
and caller behavior rather than reimplementing the stop gate. Extend only a
demonstrated residual ownership/wakeup gap.

Acceptance:

- A foreign worktree's actionable board does not wake an unarmed/waiting
  session; unchanged wait observations do not cause repeated model replies.
- The owning run resumes once relevant CI/review/dependency state changes.
- Installed hook identity and behavior are checked, so a merged source fix
  cannot be reported as deployed merely from the package version.
- The six false replies in the baseline are retained as regression scenarios;
  shell polls and model turns are counted separately.

### P41-D — Resume trusted finalization after completed execution

Persist completed execution evidence before commit/finalization. After a host,
signing or base-resolution failure, recover from that candidate instead of
automatically launching the complete executor again.

Acceptance:

- An unchanged authenticated candidate can finish trusted finalization without
  another executor launch; repeated recovery is idempotent.
- The candidate binds repository, ticket, worktree, tree/base, plan/policy and
  verification evidence. A changed identity requires bounded revalidation or
  explicit refusal, never reuse of a stale green result.
- Base movement invalidates affected checks; failed/pending gates remain
  visible and a host error does not become a successful execution receipt.
- A scenario matching T-39-16 distinguishes completed code work from failed
  finalization and measures any necessary revalidation separately.

### P41-E — Local GSD projection fingerprints

Preserve the existing phase-41 commitment: compute projection fingerprints from
the inputs that actually govern each projection, instead of injecting one
repository-wide digest into every generated file.

Acceptance:

- Changing one plan/ticket only rewrites affected projections and legitimately
  dependent aggregates; unrelated phase artifacts remain byte-identical.
- The read-only consistency check still detects stale relevant projections,
  and changed dependency edges invalidate all affected outputs.
- Compare generated file count and diff bytes on a representative plan/state
  change; do not convert reduced diff bytes directly into quota savings.

### P41-F — Comparable end-to-end efficiency evidence

Extend the existing usage-attribution/orchestration-overhead reporting rather
than creating another ledger. Join parent and child usage with verified outcomes
where identities permit, retaining missing attribution as unknown.

Acceptance:

- Deduplicate streamed/replayed messages; do not add iteration/thinking/cache
  subcounts twice. Include failed, interrupted, parked and recovery work.
- Report processed input, cache categories, output, model turns and retries,
  plus median/p90 per verified completion and total cohort consumption.
- Compare one behavioral treatment at a time and track false greens, skipped
  gates, lost constraints, duplicate work, reopens and escaped defects.
- Reuse the existing 20-completion / 95%-attribution readiness criteria for a
  savings claim. Until sufficient live evidence exists, report inconclusive;
  do not block shipping a verified functional fix solely to collect a sample.
- The release report distinguishes implemented, installed, behaviorally
  verified and efficiency-measured results. No fixed subscription percentage
  or financial saving is promised from token counts.

### Ownership and boundaries

- Phase 39 release, especially T-39-03 and T-39-17: verify effective installation.
- Phases 33–34: reuse existing handoff, wait-event, usage and treatment machinery.
- Phase 40 planning already owns work on host provenance (T-40-21), stream
  compatibility (T-40-08/11), request construction (T-40-15), finalizer formatting
  (T-40-18) and judgment hosts (T-40-22 and ADR-018 additions).
- Phase 41 must remain deliverable before phase 40. During decomposition, give
  shared files explicit ordering and update phase-40 dependencies when a
  phase-41 contract changes. Do not introduce a circular dependency or silently
  duplicate the phase-40 features. Schema compatibility work beyond what is
  needed for finalization recovery stays with its existing owner.
- INV-006/ADR-019, if created concurrently, must ingest this measured scope and
  preserve prior decisions; this context is not permission to overwrite them.

Keep independent planner/checker and integrator judgments: today's runs found
real defects. Preserve canonical model/effort selection and trusted launch,
artifact, verification and merge gates. Global model downgrades, adaptive
investigation fan-out, a new sentinel daemon, broad ticket resizing and a full
instruction-document rewrite are follow-up experiments outside this phase's
priority scope.

### the agent's Discretion

Source: ADR-019; mode standard, granularity standard; TDD descriptions for
eligible implementation tasks. No code/tests are implemented during planning.
Safe explicit handoff boundaries first; automatic thresholds remain deferred.
Changed-base candidate reuse refuses unless a plan preserves complete bounded
revalidation. Use existing matched-cohort/readiness/quality rules. Assign exact
contracts, dependency input sets and later phase40 file ownership in plans.

### Deferred Ideas (OUT OF SCOPE)

Global model downgrades, adaptive investigation fan-out, a new sentinel daemon, broad ticket resizing and a full instruction-document rewrite are follow-up experiments outside this phase's priority scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Owner | Planning support |
| --- | --- | --- |
| REQ-151 / P41-A | T-41-01 | Selected packet, full prompt and first-response seam |
| REQ-152 / P41-B | T-41-02 | Fenced checkpoint/resume contract |
| REQ-153 / P41-C | T-41-03 | Installed arm, stop and owner-wake contract |
| REQ-154 / P41-D | T-41-04 | Authenticated candidate, finalizer and native wait race |
| REQ-155 / P41-E | T-41-05 | Per-output projection dependency contract |
| REQ-156 / P41-F | T-41-06 | Deduplicated usage and verified outcome contract |
| REQ-157 | T-41-08 | Later user-approved push-path point fixes; separate from ADR-019 P41-A–F |

The six P41 decisions are ADR-019:29-39. REQ-157 was moved from REQ-149a/b and T-40-02 later; it appears in ROADMAP.md:773-779 and 41-08-PLAN.md:1-40 [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:29-39; .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:197-201; .planning/ROADMAP.md:773-779; .planning/phases/41-reduce-pipeline-subscription-overhead/41-08-PLAN.md:1-40].
</phase_requirements>

## Summary and Recommendation

Plan six narrow efficiency slices on existing hosts, controllers and reports; T-41-08 is an independent later addition. Keep canonical runtime/model floors, authenticated host receipts/artifacts, independent judgments, verification and merge gates. Do not promise subscription-credit savings from processed token counts [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:29-55; .planning/investigations/INV-006-pipeline-subscription-overhead/research/system-state.md:5-9].

Phase 39 is in this source baseline: git log -10 --oneline places T-39-17 commit 8ee1da06 beneath PR #231 and phase-39 epic PR #215, and git merge-base --is-ancestor 8ee1da0636702d75d50034af4982ac5418a5ad74 HEAD exited 0. INV-006's 68e3a158 snapshot predates that integration; its absent-selection finding is historical [VERIFIED: git log -10 --oneline; git merge-base --is-ancestor 8ee1da0636702d75d50034af4982ac5418a5ad74 HEAD, exit 0; .planning/investigations/INV-006-pipeline-subscription-overhead/research/system-state.md:15-19].

**Primary recommendation:** put installed-path observation before an efficiency claim, make candidate recovery refuse changed identity by default, derive projection hashes from renderer inputs, and join usage only to authenticated verified outcomes [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:31-48].

## Architectural Responsibility Map and Standard Stack

| Capability | Primary owner | Existing support |
| --- | --- | --- |
| Prompt assembly/admission | Claude role host | Context packet builder [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:677-728]. |
| Checkpoint and wake | Session controller | Stop gate and run waker [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:799-870; plugins/delivery-pipeline/scripts/run-waker.cjs:155-234]. |
| Execution recovery | Codex delivery host | Authenticated dispatch recorder and signed finalizer [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:193-251,290-333; plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:699-705; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:108-165]. |
| GSD projections | gsd-sync builder | Parsed graph, state and plans [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:1089-1126]. |
| Outcome evidence | usage-report/orchestration-overhead | Existing usage attribution and delivery outcomes [VERIFIED: plugins/delivery-pipeline/scripts/usage-attribution.cjs:14-17,35-53; plugins/delivery-pipeline/scripts/usage-report.cjs:623-671]. |

Use repository Node.js CommonJS scripts and existing unit harness/Makefile. No new package, framework, accounting ledger, wake daemon, commit path or receipt format is needed [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:37-55; Makefile:46-54]. Package legitimacy and registry-version audits do not apply because the accepted phase installs no external package.

## Exact File and Contract Map

| Slice / files | Current source fact and implementation guidance |
| --- | --- |
| A: claude-role-host.cjs, context-packet.cjs and paired tests | buildPacket passes verbatim “selectedBacklogIds: selectedBacklogIds(canonical.worktree, sources.plans)” and “backlogInventory: 'selected'”, deduplicates refs and rejects packet overflow before dispatch [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:677-700]. Each targeted role embeds “reference_content: reference” and makePrompt then includes both “packet.role_context.reference_content” and “JSON.stringify(packet)”; measure packet and whole prompt separately, remove this demonstrated duplicate only with role fixtures preserving trusted instructions [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:437-449,522-544,630-656,703-723]. Current packet accounting says “provider_tokens: null”; attach first-response counters by supported dispatch/transcript identity [VERIFIED: plugins/delivery-pipeline/scripts/context-packet.cjs:354-381]. architectureRefs skips entire superseded ADRs and follows DECISIONS paths only from retained refs; reproduce a governing partial-supersession loss before changing selection [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:265-329]. |
| B: session-handoff.cjs and test | Existing sequence is checkpoint → resume → revalidate → acknowledge. Pending launch refuses checkpoint/takeover, stale refs refuse, and acknowledgement requires live revalidation plus compare-and-swap owner change [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:597-615,799-870]. Carry accepted decisions, attempts, findings, pending gates, artifact digests, owner and exact next action at explicit safe boundaries; measure collection/startup/cache warmup. Automatic transfer currently returns verbatim “status: 'unsupported'” [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:750-760]. |
| C: stop-gate.cjs, stop-gate-arm.cjs, run-waker.cjs and tests only after reproduced residual | Unscoped stop calls isArmed before scanning; scoped mode checks the selected run front. Ledger checks board/journal advancement; waker claims by run plus wake/revision [VERIFIED: plugins/delivery-pipeline/scripts/stop-gate.cjs:395-430,490-531; plugins/delivery-pipeline/scripts/run-waker.cjs:155-234]. Verify installed hook and caller against six false-reply scenarios, unchanged wait and one relevant owner wake; count shell polls apart from model turns [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:86-100]. Amend T-41-03 before editing phase-40-owned source [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:197-201]. |
| D: codex-delivery-host.cjs, delivery-commit-finalizer.cjs, codex-runtime-host.cjs and tests | Host preflights ticket/branch/base/head/signer, launches, then finalizedArtifact demands a verified receipt and calls finalizer; finalizer enforces scope and signed commit [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:193-251,290-333; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:108-165,180-225]. Persist a candidate before finalization bound to repository/ticket/worktree/tree/head/base/graph/plan/policy/original dispatch/receipt/verification. Recover unchanged candidate idempotently without executor launch; changed identity refuses unless affected gates are explicitly revalidated. Parent parser currently demands verbatim “waited.timed_out === false && waited.message === 'Wait completed.'”, although child parser separately requires verbatim “completed !== 1” to refuse missing/duplicate completion and checks parent/task/role/model/effort/instructions [VERIFIED: plugins/delivery-pipeline/scripts/codex-runtime-host.cjs:625-671,687-730]. The later T-41-04 amendment accepts timeout-only waits followed by this exact authenticated child, retaining structural wait/output and containment checks; the old failed dispatch remains failed [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:180-195; .planning/phases/41-reduce-pipeline-subscription-overhead/41-04-PLAN.md:48-70]. |
| E: gsd-sync.cjs and tests | One fingerprint currently hashes all plans and phase integration refs and goes into STATE, REQUIREMENTS, ROADMAP, summaries, UAT and VERIFICATION [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:1089-1125]. Derive each fingerprint from actual parsed renderer inputs, including old/new phase membership; keep global aggregate invalidation, read-only byte comparison and locked publication [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:559-585,1159-1231]. |
| F: usage-report.cjs, orchestration-overhead.cjs and tests; read usage-attribution.cjs | Attribution stores dispatch/transcript correlation metadata; report matches message, then request, then session and deduplicates Claude response ID/UUID [VERIFIED: plugins/delivery-pipeline/scripts/usage-attribution.cjs:14-17,35-53; plugins/delivery-pipeline/scripts/usage-report.cjs:145-178,293-329]. It currently emits verbatim “input_per_verified_completion: null” and says a transcript stop is not completion [VERIFIED: plugins/delivery-pipeline/scripts/usage-report.cjs:653-671]. Join parent/child/recovery to verified outcome; keep ambiguous/missing joins unknown and failed/interrupted/parked work in cohort consumption. |
| REQ-157: state-sync.cjs, scripts/shipyard-pre-push-gate.sh and new tests | Later point fix. Current YAML begins verbatim “# generated by state-sync.cjs from live GitHub state — do not edit” and adds a generation comment; hook selects a text-derived worktree without git-toplevel resolution [VERIFIED: plugins/delivery-pipeline/scripts/state-sync.cjs:959-967,1118-1126; scripts/shipyard-pre-push-gate.sh:11-18,25-38]. Plan removes YAML comments while preserving metadata/stdout generation and resolves/refuses named push targets through git [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/41-08-PLAN.md:33-65]. |

## Projection and Phase-40 Boundaries

Ticket SUMMARY depends on its plan/ticket delivery state. Phase UAT/VERIFICATION depends on phase metadata, member plans/status and integration/verification evidence. Changed membership must invalidate both old and new phase outputs. Global STATE/REQUIREMENTS/ROADMAP remain legitimate aggregate projections; ROADMAP's generated block is excluded from its own hash [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:559-585,680-692,850-905,978-1007,1081-1125]. The existing sourceFingerprint hashes ordered name/content entries [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:314-318]. [ASSUMED] Exact per-output selector signature is a plan choice.

Keep 39 → 41 → 40 and have later phase-40 PRs consume merged phase-41 source, not cross-epic stacked PRs [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:37-54; .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:197-201].

| P41 owner | Later P40 consumer | Boundary |
| --- | --- | --- |
| T-41-01 role host | T-40-16/22 | Phase 40 retains sentinel preflight/provenance [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:262-291]. |
| T-41-04 delivery/runtime host and finalizer | T-40-01/09/12/14/18/27 | Phase 40 retains fixtures, research consumer/in-flight behavior and commit formatting; preserve candidate and native child contracts [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:213-261,279-303]. |
| T-41-08 state-sync and push gate | T-40-03, then T-40-19/27 | T-40-03 is next state-sync writer and follows merged T-41-08 [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:304-312; .planning/phases/41-reduce-pipeline-subscription-overhead/41-08-PLAN.md:42-49]. |

## Runtime State Inventory

Stored data: E regenerates derived GSD markers, not delivery records [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:1089-1125]. Live service config: no external service change is authorized; operator copies are unknown [ASSUMED]. OS-registered state: installed Claude hooks need digest and behavior checks at release [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:92-100; .planning/phases/41-reduce-pipeline-subscription-overhead/41-08-PLAN.md:86-112]. Secrets/env: signer is host preflight; candidate stores identity, not secret material [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:109-126]. Build/installed artifacts: source integration does not prove deployed behavior [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:49-68]. [ASSUMED] Exact installed digests at execution are unknown here.

## Validation Architecture and Security

Config quotes “nyquist_validation”: true, “tdd_mode”: true and “security_enforcement”: true [VERIFIED: .planning/config.json:20-25,45-50]. Existing test paths below were found by rg --files tests/unit. REQ-157 tests are planned as Wave 0 files [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/41-08-PLAN.md:67-82].

| Req | Fast check | Critical fixture |
| --- | --- | --- |
| 151 | node tests/unit/context-packet.test.cjs; node tests/unit/claude-role-host.test.cjs | Three roles, empty/selected inventory, overflow, partial supersession, full prompt |
| 152 | node tests/unit/session-handoff.test.cjs | Stale digest/head/base, pending launch, carry and fenced acknowledgement |
| 153 | node tests/unit/stop-gate.test.cjs; node tests/unit/stop-gate-arm.test.cjs; node tests/unit/run-waker.test.cjs | Foreign/unchanged wait and one owner wake |
| 154 | node tests/unit/codex-delivery-host.test.cjs; node tests/unit/delivery-commit-finalizer.test.cjs; node tests/unit/codex-runtime-host.test.cjs | Same candidate twice, changed identity refusal, timeout-only wait with exact child and negative identities |
| 155 | node tests/unit/gsd-sync.test.cjs; node tests/unit/gsd-sync-gate.test.cjs | Local edit/edge, unrelated phase byte identity, read-only stale detection |
| 156 | node tests/unit/usage-attribution.test.cjs; node tests/unit/usage-report.test.cjs; node tests/unit/orchestration-overhead.test.cjs | Replay, missing join, failed/recovery cohort, median/p90 and quality |
| 157 | node tests/unit/state-sync-yaml.test.cjs; node tests/unit/pre-push-gate.test.cjs | New tests for deterministic comment-free YAML and git-resolved target |

Run focused checks per task, make test-fast per wave and make test at phase gate; the latter includes network-backed Codex smoke [VERIFIED: Makefile:46-54]. This research read source and test paths but ran no tests or installed trials. Local-host security controls are packet/candidate validation, authenticated receipt/digest, fenced owner/worktree and signed commit; no web session library is needed [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:677-723; plugins/delivery-pipeline/scripts/session-handoff.cjs:799-870; plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:699-705; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:108-225]. [ASSUMED] A formal ASVS category mapping for this CLI would require separate standards review.

The existing overhead report declares verbatim “DEFAULT_MIN_COMPLETED = 20” and “DEFAULT_ATTRIBUTION_TARGET = 0.95”; missing evidence yields “inconclusive” and named quality/recovery failures force “rollback” [VERIFIED: plugins/delivery-pipeline/scripts/orchestration-overhead.cjs:12-35,405-454]. Match runtime/model/effort and role, compare one treatment at a time, include handoff/startup/warmup and do not turn counts into quota [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:135-154]. command -v found node, git, gpg, gh, claude, codex and shasum; node --version returned v24.10.0 and git --version 2.54.0 (Apple Git-157). Signer and installed release identity remain execution checks [VERIFIED: command -v node git gpg gh claude codex shasum; node --version; git --version; plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:109-126].

## Assumptions and Open Questions

| ID | Unresolved item | Next check / owner |
| --- | --- | --- |
| A1 | [ASSUMED] Real partial-supersession loss exists; only source branch is proven. | RED fixture before selection edit — T-41-01. |
| A2 | [ASSUMED] Bounded checkpoint needs no digested spillover artifact. | Specify byte bound/overflow — T-41-02. |
| A3 | [ASSUMED] Candidate and verified-outcome producer fit existing recorder APIs. | Define schema, crash matrix and producer identity — T-41-04/06. |
| A4 | [ASSUMED] Live parent/child usage reaches 95% verified-outcome attribution. | Measure coverage, retain unknown — T-41-06. |
| A5 | [ASSUMED] Effective installed host/hooks match this source revision. | Record installed digests and controlled role/wake behavior — release operator. |
| A6 | [ASSUMED] Phase-40 dependency amendments remain valid at merge. | Recheck acyclic graph and shared-file owners — planner/integrator. |

## Sources and Method

Primary evidence is the exact source ranges cited inline, accepted ADR-019 and its normalized ingest, phase CONTEXT, INV-006 synthesis/system-state/constraints, and later T-41-08 plan. Commands run here: git rev-parse HEAD, git log -10 --oneline, git merge-base --is-ancestor, git branch --contains, git status --short, rg --files, rg -n and nl -ba. No external documentation lookup, product edit, test run, commit, rollout or service mutation occurred. Valid until source, installed host or phase-40 plan graph changes [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:14-55; .planning/.adr-ingest/ADR-019-pipeline-subscription-efficiency.ingest.md:14-55; .planning/investigations/INV-006-pipeline-subscription-overhead/RESEARCH.md:37-64].
