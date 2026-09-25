# Phase 41: Reduce pipeline subscription overhead — Research

Researched: 2026-09-25. Source revision: 8d0c2c2a65b14c3bfce5fec7f5a301d085f8ce92. Domain: Shipyard orchestration, trusted recovery, projections and usage evidence. Confidence: HIGH for inspected source and installed file identity; UNKNOWN for live efficiency. No new package or framework is recommended.

<user_constraints>
## User Constraints (from CONTEXT.md)

The following accepted scope and boundaries are copied verbatim from CONTEXT.md:43-178 and :196-203. The ADR records the same six decisions at ADR-019:29-48.

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

| ID | Description (verbatim from ROADMAP.md) | Research support |
| --- | --- | --- |
| REQ-151 | Complete-prompt/first-response measurement and installed T-39-17 verification preserve governing constraints. | Packet/host boundary and installed hash checks below |
| REQ-152 | Bounded durable handoff uses existing ownership, artifact and gate contracts without repeated or orphaned work. | Handoff controller contract below |
| REQ-153 | Installed stop-gate/waker behavior suppresses foreign and unchanged model wakeups while preserving owner transitions. | Installed hook and wake claim below |
| REQ-154 | Authenticated completed-execution candidates resume trusted finalization idempotently without stale verification or automatic executor replay. | Candidate and finalizer interface below |
| REQ-155 | GSD projection fingerprints use governing local inputs and dependency edges while preserving aggregate invalidation and consistency checks. | Dependency table below |
| REQ-156 | Existing usage reporting joins deduplicated parent/child and recovery usage to verified outcomes with honest unknowns, comparable cohorts and quality/readiness gates. | Usage join below |
</phase_requirements>

The descriptions above are quoted verbatim from .planning/ROADMAP.md:387-392 [VERIFIED: .planning/ROADMAP.md:387-392]. ROADMAP.md and ADR-019 supply the accepted requirement declarations for this planning pass [VERIFIED: .planning/ROADMAP.md:387-392; .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:29-39].

## Summary

Phase 39 has merged into the source baseline: git log -8 --oneline shows PR #231 then epic PR #215 before release 0.63.0, and git merge-base --is-ancestor 8ee1da0636702d75d50034af4982ac5418a5ad74 HEAD exited 0. The earlier INV-006 snapshot at 68e3a158 is historical; its whole-backlog inference must not be carried forward [VERIFIED: git log -8 --oneline; git merge-base --is-ancestor 8ee1da0636702d75d50034af4982ac5418a5ad74 HEAD, exit 0; .planning/investigations/INV-006-pipeline-subscription-overhead/RESEARCH.md:37-55].

At this revision the judgment host supplies selected backlog IDs and a selected inventory, deduplicates required refs and refuses an over-bound packet before dispatch. A concrete residual remains: each of the three role contexts embeds reference_content in the packet, while makePrompt adds the same content as a separate trusted prompt segment before serializing the whole packet. The installed Claude 0.63.0 role host, context packet and stop hook hash-match source, but no controlled first-response or stop-hook behavior was observed in this research run [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:437-449,522-544,630-656,703-723; plugins/delivery-pipeline/scripts/context-packet.cjs:397-410; shasum -a 256 on source and installed files, outputs recorded under Phase 39 delta]. Treat installed identity, behavioral verification and efficiency measurement as separate gates.

**Primary recommendation:** plan six narrow requirement slices against existing seams, with installed-path observation first, an explicit authenticated candidate contract for finalization, per-output projection inputs, and one outcome-linked reporting extension [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:29-48].

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Reason |
| --- | --- | --- | --- |
| Prompt assembly and packet admission | Trusted role host | Context packet builder | Host chooses selected sources and sees complete prompt before launch [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:677-728]. |
| Checkpoint ownership and wake | Durable run/session controller | Stop hook and run waker | Controller fences owners; hook/waker only decide whether an owned run should resume [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:763-810; plugins/delivery-pipeline/scripts/run-waker.cjs:155-230]. |
| Execution recovery | Trusted Codex delivery host | Existing finalizer and durable receipt recorder | Host has launch/finalization sequence; finalizer owns signed commit [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:309-331; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:108-225]. |
| GSD projections | Local projection script | Planning graph and delivery state | One builder already computes all outputs and read-only drift [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:1050-1127,1159-1231]. |
| Efficiency outcome report | Existing usage/reporting scripts | Delivery outcomes/quality state | Attribution maps transcript identities to dispatches; outcome join is currently null [VERIFIED: plugins/delivery-pipeline/scripts/usage-attribution.cjs:4-17,35-53; plugins/delivery-pipeline/scripts/usage-report.cjs:653-671]. |

## Recommendations

1. **P41-A and C first:** record source revision, installed file hashes, policy hash, assembled prompt bytes, selected-ref inventory, model/effort and first-response provider usage for arch-review, sentinel and integrator. Add a fixture only for a reproduced residual selection or ownership defect; do not rebuild T-39-17 or T-39-03. The existing host returns packet digest and estimate, while makePrompt contains role reference content plus packet JSON, so packet size is not complete launch size [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:703-728,1157-1163; .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:49-100].
2. **P41-B:** use the existing explicit checkpoint → successor resume → revalidate → acknowledge sequence at phase boundaries or a durable long wait. The current controller rejects unresolved launch reservations and requires a compare-and-swap acknowledgement; preserve these guards [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:799-810,825-870].
3. **P41-D:** make completed executor work a trusted, durable candidate before calling the existing finalizer. Recovery is a separate host-only operation keyed to the original dispatch and candidate, never another executor launch. A changed base/head/tree/graph/plan/policy/verification identity refuses by default; if bounded revalidation is later designed, each invalidated gate needs new evidence before finalization [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:193-251,309-331; .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:34,45-47]. [ASSUMED] The exact candidate schema and storage API remain design choices for the plan.
4. **P41-E and F:** use deterministic, output-specific source fingerprints and extend usage-report/orchestration-overhead from existing attribution and verified delivery records. Keep null/unknown on missing joins and the existing inconclusive readiness verdict [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:1089-1125; plugins/delivery-pipeline/scripts/usage-report.cjs:653-671; plugins/delivery-pipeline/scripts/orchestration-overhead.cjs:405-454].

## Standard Stack and Existing Patterns

Use Node.js CommonJS, repository-local scripts, the existing tests/unit assert-harness or node:test style according to each neighboring file, Git for tree/base identity, the durable dispatch recorder, and the current session-handoff, run-waker, gsd-sync, usage-report and orchestration-overhead modules. No external package, UI design or AI framework integration is needed for the accepted scope [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:1-15; tests/unit/codex-delivery-host.test.cjs:1-17; tests/unit/claude-role-host.test.cjs:1-11; Makefile:47-54; .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:1-8,29-55]. Node v24.10.0 and the node executable at /opt/homebrew/bin/node were observed by command -v node and node --version. This is environment availability, not a minimum supported version claim [VERIFIED: command -v node; node --version, output v24.10.0].

## Don't Hand-Roll

Do not rebuild model policy/rungs, launch receipt authentication, commit finalization, a stop-hook daemon, a transcript ledger or a broad packet assembler. Use the existing policy resolver, durable recorder getVerifiedRecord, finalizer, run controller and reports [VERIFIED: plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:276-287,699-705; plugins/delivery-pipeline/scripts/role-artifact.cjs:250-285; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:108-225; .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:37,50-55].

## Phase 39 Delta and Installed Observations

| Check | Current finding | Planning implication |
| --- | --- | --- |
| Source integration | git log -8 --oneline places T-39-17 commit 8ee1da06 under merged PR #231 and epic PR #215 before release merge d0c2804e; git merge-base --is-ancestor 8ee1da06 HEAD exits 0 [VERIFIED: those commands, exit 0]. | Do not treat the old 68e3a158 investigation's whole-backlog source as current [VERIFIED: .planning/investigations/INV-006-pipeline-subscription-overhead/RESEARCH.md:37-55]. |
| Selection | Host reads plan references, skips items with excluded status, matches plan text/path to backlog IDs, then passes selectedBacklogIds and backlogInventory value “selected” [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:332-340,677-693]. Builder's fallback still chooses active items only when selectedBacklogIds is absent, but the targeted host supplies it [VERIFIED: plugins/delivery-pipeline/scripts/context-packet.cjs:236-269]. | Test all three targeted role callers and no accidental omission of the explicit selection option. |
| Duplicates and bounds | Required source refs are path-deduplicated; selected inventory contains selected IDs only; optional content may be indexed under overflow; host refuses packet overflow before launch and makePrompt has an independent complete-prompt byte limit. However, reference_content appears once in role_context and again outside the JSON packet in makePrompt for all three roles [VERIFIED: plugins/delivery-pipeline/scripts/context-packet.cjs:397-418,450-475; plugins/delivery-pipeline/scripts/claude-role-host.cjs:437-449,522-544,630-656,694-728]. | Record packet estimate and full assembled prompt bytes separately. Remove proven duplicate content only after a fixture shows the trusted role instruction and packet validation remain intact; verify mandatory source remains present. |
| Potential residual | architectureRefs discards an entire ADR when superseded status matches and follows only DECISIONS.md paths found in retained ADRs; whether any still-governing constraint is lost is unproven [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:265-329]. | Build a partial-supersession/transitive-reference fixture before altering selection. [ASSUMED] A real partial-supersession loss may be reproducible. |
| Installed identity | shasum -a 256 source versus installed paths gave equal host 9bb1ad1b49f6beb546609dd179cea8617747942f829395527e5f010a3d089659, packet f90d9d90e478c8be3c2c4554bda9a83c1c7c0005424a4e97b3419733c59ed23c, hook a41aea770ee9a812fb41e3098f20907eca9413ac7ab17d9d147e23de5f926c06 and arm helper 3a2703c3ab1898b571c580d57f248e7740425d53d78612ff4df42714b5be1b06. installed_plugins.json quotes “version”: “0.63.0” and “gitCommitSha”: “d0c2804e517dda9e1924312362749f04f429caff”; settings.json invokes the installed stop-gate path [VERIFIED: /Users/serhii/.claude/plugins/installed_plugins.json:131-139; /Users/serhii/.claude/settings.json:82-99; shasum -a 256 on six source/installed files, equal outputs]. | Identity is observed now; runtime behavior and first-response usage remain an acceptance observation. |
| Policy identity | node plugins/delivery-pipeline/scripts/model-policy.cjs fingerprint returned “policy_version”: “adr-014.v6” and “policy_hash”: “30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968” [VERIFIED: node plugins/delivery-pipeline/scripts/model-policy.cjs fingerprint, exit 0]. | Record this from the effective installed host at each launch; do not infer it from package version alone. |

The local worktree-bound planning host is outside Git and the INV-006 research synthesis explicitly says its four sealed research calls do not prove phase-40 completion. Treat its receipts as local bootstrap evidence only [VERIFIED: .planning/investigations/INV-006-pipeline-subscription-overhead/RESEARCH.md:37-64; .planning/phases/41-reduce-pipeline-subscription-overhead/PLANNING-BLOCKERS.md:5-22].

## Exact File and Contract Map

| Req | Files to assign in phase 41 | Contract boundary |
| --- | --- | --- |
| 151 | claude-role-host.cjs, context-packet.cjs; paired unit tests | buildPacket/makePrompt, selected refs, complete-prompt/first-response observations [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:677-728,1114-1163]. |
| 152 | session-handoff.cjs; session-handoff.test.cjs | checkpoint → resume → revalidate → acknowledge, with no pending launch [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:799-870]. |
| 153 | stop-gate.cjs, stop-gate-arm.cjs, run-waker.cjs and paired tests only on reproduced gap | armed owner and one claimed relevant wake [VERIFIED: plugins/delivery-pipeline/scripts/stop-gate.cjs:490-525; plugins/delivery-pipeline/scripts/run-waker.cjs:155-230]. |
| 154 | codex-delivery-host.cjs, delivery-commit-finalizer.cjs and paired tests | authenticated candidate between launch and trusted commit; host-only recovery [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:220-251,309-331]. |
| 155 | gsd-sync.cjs and paired tests | output-specific fingerprint inputs with the existing check/publish lock [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:1089-1125,1159-1231]. |
| 156 | usage-report.cjs, orchestration-overhead.cjs and paired tests; read usage-attribution.cjs and optimization-report.cjs | deduplicated identity → verified outcome → cohort and quality report [VERIFIED: plugins/delivery-pipeline/scripts/usage-report.cjs:145-215,653-671; plugins/delivery-pipeline/scripts/orchestration-overhead.cjs:405-454]. |

## Architecture Patterns

The trusted boundaries provide the main flow; phase 41 inserts observation and recovery at those boundaries [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:677-728,1114-1163; plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:309-331; plugins/delivery-pipeline/scripts/usage-report.cjs:653-671].

    Work/wait event → scoped owner or wake claim → trusted role host
      → selected source packet → admission decision → authenticated dispatch
      → runtime response/receipt
          → usage attribution → verified outcome join → report
          → completed executor candidate → identity/gate decision
              → same: trusted signed finalizer → committed artifact
              → changed/unknown: explicit refusal or complete bounded revalidation

## Implementation Contracts

### A/C — selected prompt and owner wake

The installed judgment launch should emit one metadata-only observation per launch: original dispatch/run identity, role and subject, source revision, host file digest/install version, policy hash, selected backlog IDs and source-ref digests, packet bytes and bytes/4 estimate, complete makePrompt bytes, and observed first-response provider input/cache-read/cache-creation/output. The provider counters must be attached only through a supported transcript/receipt identity; lack of a match remains unknown. The host already returns packet digest and estimated tokens, while recordPacketMeasurement records only packet bytes and null provider tokens [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:703-728,1157-1163; plugins/delivery-pipeline/scripts/context-packet.cjs:354-381]. The role reference duplication is a reproduced source-flow residual; keep the trusted instruction copy or an equivalent authority boundary while eliminating unnecessary packet copy, and protect this with fixtures for all three roles [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:437-449,522-544,630-656,703-723]. [ASSUMED] The observation field layout and deduplication representation are proposed design choices.

For stop behavior, run the six historical false-reply shapes as fixtures under unarmed foreign worktree, armed owner, unchanged wait and changed owner state. The current unscoped hook allows an unarmed session before scanning worktrees; scoped mode reads the selected run's front. The block ledger checks board/journal advancement; run-waker returns no launch until readiness and claims a wake by run plus wake/revision [VERIFIED: plugins/delivery-pipeline/scripts/stop-gate.cjs:395-430,490-525; plugins/delivery-pipeline/scripts/run-waker.cjs:155-230]. Count shell polls and model turns independently; a passing fixture and matching installed hash are necessary but still not a live turn count [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:92-100].

### B — checkpoint and safe handoff

Use current makeCheckpoint required fields verbatim (listed in the file map). Place accepted decisions, unresolved findings, attempt history and pending gate references inside bounded current_snapshot or digest-pinned artifact_refs; the planner must state exact size limits and references. The metadata validator refuses prompt/transcript/secret-like keys, so the checkpoint carries decisions and references, not a raw conversation [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:510-565]. A completed phase boundary is already recognized as an explicit safe manual rotation recommendation; use a durable long-wait only after the run has no unresolved launch [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:140-160,799-810]. Checkpoint refuses a pending launch, and successor acknowledge requires explicit live revalidation of head/base, worktree, reviews/checks and child enumeration before compare-and-swap ownership transfer [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:597-615,799-870]. A stale/missing checkpoint or changed pinned artifact must name recovery; no automatic transfer is available in the current controller, whose requestAutomaticTransfer says “status: 'unsupported'” and “automatic_transfer: ... allowed: false” [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:568-593,751-760]. Use existing cost stages “checkpoint_collection”, “successor_startup”, “cache_warmup” and keep the predecessor's attempt history [VERIFIED: plugins/delivery-pipeline/scripts/orchestration-overhead.cjs:23-34; plugins/delivery-pipeline/scripts/session-handoff.cjs:839-843,872-880]. [ASSUMED] The exact checkpoint metadata shape for decisions/findings is not yet defined.

### D — authenticated finalization candidate and idempotency

**Candidate creation point:** after launchAgent returns and the durable recorder confirms the original dispatch with getVerifiedRecord, after checking nonempty scoped delta and graph stability, but before finalizeDeliveryCommit. Today the host only checks the returned receipt object and then calls finalizer in one function; the durable recorder already authenticates recorded receipts, and the role-artifact validation pattern cross-checks dispatch ID, proof, policy hash and resolution [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:220-251,309-331; plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:699-705; plugins/delivery-pipeline/scripts/role-artifact.cjs:250-285]. The candidate must be written by the trusted host outside the executor worktree; storageDirectory already enforces an outside-worktree root [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:138-162]. [ASSUMED] Candidate persistence and any new state schema are proposed phase-41 code.

**Identity to bind:** canonical repository ID and worktree realpath, ticket/branch and allowed paths, original run and dispatch/launch IDs, original authenticated receipt reference, graph digest, source plan digest, policy hash/model/effort, expected HEAD and base, signer, exact scoped worktree tree, and each verification artifact/command/status/digest plus pending/failed gates. The existing preflight already returns branch/base/head/signer/files and graph digest; canonicalCliScope computes repository identity; the finalizer checks HEAD/base/branch and uses a private Git index to create a signed tree [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:165-217; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:129-190]. **Plan gap:** the current host does not capture an authenticated verification-evidence bundle or pre-finalization tree; the plan must name their producer and validation rule before calling a candidate reusable. [ASSUMED] Binding these new fields is a proposed contract, not a claim that they exist.

**Recovery interface:** a host-only resumeFinalization(candidate identity, live scope) reads the candidate and original durable receipt, reacquires the correct owner/fence, compares all bound identities and gate evidence, then calls the existing finalizer without launchAgent. If any bound identity differs, refuse and retain the candidate as failed/pending unless the plan specifies complete bounded revalidation of each affected check. Base movement invalidates base-sensitive tests/reviews/checks by default. Reusing a dispatch ID must never call dispatch again because the boundary refuses duplicate IDs [VERIFIED: plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:1533-1553; .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:108-118]. [ASSUMED] The host-only method signature and refusal codes are proposed.

**Idempotency after a crash:** before attempting a commit, recognize a candidate already finalized only when HEAD, parent, signed commit, signer, tree and scoped changed paths match the candidate and a trusted finalization record; return that same committed artifact. If HEAD remains at expected pre-commit HEAD and scoped tree is unchanged, finalization can retry under the owner lock. All other states refuse for reconciliation. The current finalizer performs scoped staging and signed commit with branch compare-and-swap, then returns commit/signer/changed; it refuses when no worktree delta remains, so recovery needs the committed-state check before invoking it [VERIFIED: plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:145-149,156-225]. [ASSUMED] The finalization record and crash recovery logic are proposed.

### E — projection dependency inputs

The current one-fingerprint source set includes cleaned ROADMAP text, PROJECT, config, graph, every plan, phase INTEGRATION files, a stable delivery-state projection and controller/usage observations; it feeds global and every phase/ticket output [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:1081-1125]. Use the same canonical normalization/hash algorithm and sync-version salt, but derive each output marker from only its render inputs and dependency edges [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:153-157,314-318]. Recommended input sets:

| Projection | Fingerprint inputs and invalidation edge |
| --- | --- |
| Ticket SUMMARY | Own parsed PLAN metadata/content/path, own stable ticket delivery status/PR/merge date, and containing phase directory identity. A plan reassigned to another phase invalidates old/new phase aggregates too [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:625-634,830-884]. |
| Phase UAT and VERIFICATION | That phase's declaration/title, member ticket plans and stable delivery entries, its INTEGRATION/verification evidence, plus explicit membership edges. A changed plan phase or ticket association invalidates both old and new phase outputs [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:559-585,887-975]. |
| Global STATE | All phase membership/evidence and plan status, PROJECT core value, global blockers, last activity, stable run/receipt/usage projection. It is a legitimate aggregate and may change after one ticket [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:230-297,695-827]. |
| Global REQUIREMENTS | Clean ROADMAP requirement text and phase mapping, PROJECT core value, phase evidence/status. A requirement moved between phases invalidates this output; phase outputs change only if their own render inputs change [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:346-390,655-692]. |
| Generated ROADMAP block | Clean human ROADMAP, all phase names, plan totals and phase evidence/status; preserve block-stripping so its own generated marker is not an input [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:978-999,1103-1109]. |

Dependency extraction must use the same parsed records the renderers consume, not a manually maintained path allowlist. Keep checkSnapshot's read-only byte comparison and buildSnapshot inside the shared state lock on publication; the --phase mode still keeps globals coherent [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:1159-1231]. [ASSUMED] The exact output-specific fingerprint helper signature is a design detail.

### F — usage/outcome join and missing data

usage-attribution fields include “project_id”, “run_id”, “dispatch_id”, “ticket”, “role”, “runtime”, “provider”, “session_id”, “request_id”, “message_id”, “pass_id”, “model”, “effort”, “completion_status” and treatment identifiers; its recorder requires dispatch plus a transcript identity [VERIFIED: plugins/delivery-pipeline/scripts/usage-attribution.cjs:14-17,35-53]. usage-report matches message first, then request, then session, and labels ambiguous/conflicting matches; its metadata emits dispatch/run/ticket/role and runtime/model/effort [VERIFIED: plugins/delivery-pipeline/scripts/usage-report.cjs:145-215]. It deduplicates Claude responses by message ID/UUID and has a ticket/dispatch efficiency grouping; provider totals separate input/cache-read/cache-creation/output, and verified completion is explicitly null today [VERIFIED: plugins/delivery-pipeline/scripts/usage-report.cjs:293-329,402-433,623-671].

Join by authenticated repository/project scope plus dispatch ID where available, then run ID/ticket and verified delivery outcome; record parent continuation and child launches as separate usage observations that roll up to the same verified completion only when the owner relationship is proven. A transcript stop marker is not a verified completion. Unmatched parents, ambiguous attribution, absent model/effort, absent usage, failed/parked/interrupted work and recovery passes remain visible with null per-completion values where needed; do not discard their cohort consumption. Deduplicate before aggregation and do not add cache/read/iteration/reasoning subsets a second time [VERIFIED: plugins/delivery-pipeline/scripts/usage-report.cjs:145-178,293-329,600-671; plugins/delivery-pipeline/scripts/optimization-report.cjs:9-17; .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:135-154]. [ASSUMED] The canonical verified-outcome record joining ticket to parent run needs a precise producer chosen in the plan.

Use orchestration-overhead's current verdict gate: quote “DEFAULT_MIN_COMPLETED = 20”, “DEFAULT_ATTRIBUTION_TARGET = 0.95”, and quality failure keys “false_green”, “invalid_carry”, “skipped_gate”, “recovery_loss”, “duplicate_dispatch”, “orphaned_work”, “lost_constraints”. The report also requires comparable arms, output coverage, a seven-day defect window and no quality/recovery failure [VERIFIED: plugins/delivery-pipeline/scripts/orchestration-overhead.cjs:12-35,405-454]. Add total cohort consumption and median/p90 per verified completion to the existing report. Keep inconclusive when coverage fails, and never convert processed tokens into subscription credits [VERIFIED: plugins/delivery-pipeline/scripts/usage-report.cjs:653-671; plugins/delivery-pipeline/scripts/orchestration-overhead.cjs:420-454].

## Code Examples

Proposed host-only recovery sequence, not an existing API [ASSUMED]. The trusted recorder lookup and finalizer call are existing primitives [VERIFIED: plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:699-705; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:108-110]:

    const record = recorder.getVerifiedRecord(originalDispatchId);
    assertRecordedReceiptMatchesCandidate(record, candidate);
    assertCandidateIdentityAndGates(candidate, liveScope);
    return finalizeDeliveryCommit(candidate.commitOptions);

The two assert helpers and candidate.commitOptions are proposed; a plan must specify them, including already-committed recovery before the finalizer call [ASSUMED]. The projection equivalent is to pass each renderer only its governing entries to existing sourceFingerprint; the entry selector is proposed, while sourceFingerprint and renderers exist [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:314-318,1113-1125] [ASSUMED].

## Phase 40 Collision Resolution and Safe Order

Phase 40's current verification projection quotes “0/27 delivery records are merged” and every ticket as pending. These plans establish future ownership, not present implementation [VERIFIED: .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-build-delivery-seams-and-clean-target-project-prs-VERIFICATION.md:14-50]. The local bootstrap described in PLANNING-BLOCKERS.md is outside Git, so none of the following interfaces may depend on it at product runtime [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/PLANNING-BLOCKERS.md:5-22].

| Phase-41 slice and shared path | Later phase-40 owner | Required plan adjustment |
| --- | --- | --- |
| A: claude-role-host.cjs and its test | T-40-22 provenance/merge integration [VERIFIED: .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-22-PLAN.md:7-14] | Add the A ticket as a cross-phase parent of T-40-22 and rebase its host edit; P41 records installed hashes without implementing T-40-21 host-provenance.cjs [VERIFIED: .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-21-PLAN.md:7-14]. [ASSUMED] Exact T-41 ticket ID awaits decomposition. |
| C: run-waker.cjs only if a residual is reproduced | T-40-15 deliver-dispatch/request construction [VERIFIED: .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-15-PLAN.md:7-13] | Prefer zero code overlap; if needed, T-40-15 follows the C ticket and adapts to its wake contract. |
| D: codex-delivery-host.cjs and its test | T-40-12 research consumer and T-40-14 in-flight/host input [VERIFIED: .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-12-PLAN.md:7-10; .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-14-PLAN.md:7-15] | Keep recovery as a distinct host-only method, not a broadened launch request; make later host tickets depend on D or explicitly rebase onto its contract. Do not add planning sealer or producer/consumer fixture migration. |
| D: delivery-commit-finalizer.cjs and its test | T-40-18 commit formatting [VERIFIED: .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-18-PLAN.md:7-13] | Phase 41 owns only tree snapshot/expected-tree and recovery verification API; T-40-18 retains formatting and follows D. |
| F: transcript/usage reporting | T-40-08/11 captured-stream compatibility [VERIFIED: .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-08-PLAN.md:7-15; .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-11-PLAN.md:7-15] | Consume current supported observation schema; later fixture migration adapts to reporting, without phase-41 stream parser work. |

Within phase 41, A and C establish installed behavior; B, D and E can be planned as independent implementation slices; F consumes their observation contracts and is last for the end-to-end report. Add cross-phase edges only from later phase-40 tickets toward assigned phase-41 tickets, never the reverse; retain phase 39 → 41 → 40 ordering and revalidate the graph before delivery [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:37-48; .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-PLAN-CHECK.md:8-34]. [ASSUMED] Exact ticket numbering and shared-file parent chain await the phase-41 planner.

## Runtime State Inventory

This is an efficiency refactor with installed/runtime state, so the planner must account for more than repository files. No renamed key is authorized [VERIFIED: .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:29-55].

| Category | Checked state and required action |
| --- | --- |
| Stored data | Existing generated GSD files carry the one common source fingerprint in their markers; P41-E must reproject affected generated files and keep --check able to detect stale relevant bytes. This is regeneration of derived artifacts, not a mutation of the underlying delivery records [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:135-141,1089-1125,1159-1180]. |
| Live service config | The local phase-41 bootstrap host lives outside Git and was used for research receipts; it is not product deployment. No external service config change is planned [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/PLANNING-BLOCKERS.md:5-22]. [ASSUMED] Other operator-managed host copies, if any, are not inventoried; check at install verification. |
| OS-registered state | Claude settings invokes the installed stop-gate path; its installed file and arm helper currently hash-match source. Recheck after release/install. No OS service registration change is part of the accepted scope [VERIFIED: /Users/serhii/.claude/settings.json:82-99; shasum -a 256 source and installed hook/arm files; .planning/architecture/ADR-019-pipeline-subscription-efficiency.md:50-55]. |
| Secrets and environment variables | The trusted finalizer requires a configured signing key and validates signer fingerprint; phase 41 does not rename a secret or environment variable. A recovery candidate must never persist the secret itself [VERIFIED: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:109-126; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:153-154]. [ASSUMED] Operator-specific env injection should be rechecked at execution. |
| Build artifacts and installed packages | Installed Claude plugin 0.63.0 role/packet files and hook copies hash-match this source; changing those files requires a new installed digest observation before behavioral claims [VERIFIED: /Users/serhii/.claude/plugins/installed_plugins.json:131-139; shasum -a 256 on source and installed host/packet/hook/arm files]. |

## Common Pitfalls

- The old full-backlog source finding predates merged T-39-17; this installed host passes selectedBacklogIds. A current first-response observation, not the old audit or matching hash alone, is needed for a savings claim [VERIFIED: .planning/investigations/INV-006-pipeline-subscription-overhead/RESEARCH.md:37-55; plugins/delivery-pipeline/scripts/claude-role-host.cjs:677-728].
- A superseded ADR may still contain governing constraints; test partial supersession and transitive decisions before changing source selection [VERIFIED: plugins/delivery-pipeline/scripts/claude-role-host.cjs:265-329; .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:62-68].
- A missing/stale checkpoint, unresolved child, changed candidate identity or incomplete verification must refuse continuation/finalization, preserving pending and failed gates [VERIFIED: plugins/delivery-pipeline/scripts/session-handoff.cjs:597-615,799-870; .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:79-84,108-118].
- Local fingerprints must include membership edges and still invalidate global aggregates; usage must deduplicate provider responses and preserve unknown outcome joins [VERIFIED: plugins/delivery-pipeline/scripts/gsd-sync.cjs:559-585,1089-1125; plugins/delivery-pipeline/scripts/usage-report.cjs:293-329,653-671].
## Validation Architecture

Nyquist validation and TDD are enabled: config quotes “nyquist_validation”: true and “tdd_mode”: true [VERIFIED: .planning/config.json:20-25,45-50]. The planner should describe RED fixture first, GREEN code second and a focused regression command for each implementation slice; no tests or product code were created in this research pass.

| Req | Fast check to run during its implementation | Required fixture / live gate |
| --- | --- | --- |
| REQ-151 | node tests/unit/context-packet.test.cjs; node tests/unit/claude-role-host.test.cjs | Selected empty/nonempty backlog, duplicate ref, over-bound mandatory source, partial supersession; installed arch-review/sentinel/integrator prompt and first-response record. |
| REQ-152 | node tests/unit/session-handoff.test.cjs; node tests/unit/orchestration-overhead.test.cjs | Durable checkpoint, missing/stale artifact, changed head/base, unresolved launch, attempt/gate carry, no duplicate child, cost stages. |
| REQ-153 | node tests/unit/stop-gate.test.cjs; node tests/unit/stop-gate-arm.test.cjs; node tests/unit/run-waker.test.cjs | Six false-wake scenarios, foreign board, unchanged wait and exactly one changed owner wake; installed hook hash and observed model turn count. |
| REQ-154 | node tests/unit/codex-delivery-host.test.cjs; node tests/unit/delivery-commit-finalizer.test.cjs | Signing/base/host failure after completed code, same candidate resumed twice, crash after commit, changed tree/base/graph/plan/policy/verification refusal, no second executor launch. |
| REQ-155 | node tests/unit/gsd-sync.test.cjs; node tests/unit/gsd-sync-gate.test.cjs | Change one plan/status and a dependency edge, compare generated file count/bytes, unrelated phase byte identity; node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json on fixture state. |
| REQ-156 | node tests/unit/usage-attribution.test.cjs; node tests/unit/usage-report.test.cjs; node tests/unit/orchestration-overhead.test.cjs | Replay dedupe, parent/child join, ambiguous/missing attribution, failed/parked/recovery, exact total/median/p90, quality rollback and inconclusive threshold. |

All named test files were found by rg --files tests/unit; Makefile provides make test-fast and make test for wave and final gates respectively [VERIFIED: Makefile:46-54]. Tests were not run here because this is a planning research artifact. Before a release claim, run the focused tests, make test-fast, then make test with its documented network-backed Codex smoke, and perform installed-runtime observations and the independent checker/integrator gates [VERIFIED: Makefile:46-54; .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:171-178].

## Security Domain and Environment

Project config has “security_enforcement”: true and ASVS level 1 [VERIFIED: .planning/config.json:46-49]. OWASP ASVS 5.0 names V2 Validation and Business Logic, V6 Authentication, V7 Session Management, V8 Authorization and V11 Cryptography; this is the current category numbering, rather than the older template's numbering [CITED: https://cornucopia.owasp.org/taxonomy/asvs-5.0]. For this CLI/host phase, the applicable controls are trusted candidate/packet input validation (V2), authenticated dispatch proof (V6 analogue), fenced owner/continuation state (V7 analogue), worktree/path/role authorization (V8), and signed commit/digest integrity (V11). This mapping is an engineering inference for a local CLI, not a claim that every web-application control applies [VERIFIED: plugins/delivery-pipeline/scripts/context-packet.cjs:527-565; plugins/delivery-pipeline/scripts/role-artifact.cjs:250-285; plugins/delivery-pipeline/scripts/session-handoff.cjs:568-615; plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:183-225].

No new package/service is required. command -v returned git, gpg, shasum, gh, claude, codex and node; git --version returned 2.54.0 (Apple Git-157), gpg --version returned 2.2.41 and node --version returned v24.10.0. This checks local availability only; signing-key readiness must still be checked at executor preflight [VERIFIED: command -v git gpg shasum gh claude codex node; git --version; gpg --version; node --version; plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:109-126].

## Assumptions and Open Questions

| ID | Assumption or unknown | Next check / owner |
| --- | --- | --- |
| A1 | [ASSUMED] A real partial-supersession loss exists; current code shows a possible whole-ADR exclusion but no failing fixture. | Reproduce with a governing-constraint/transitive-reference fixture before changing selection — P41-A implementer. |
| A2 | [ASSUMED] Checkpoint decisions/findings can fit bounded current_snapshot without another artifact; no size contract is set here. | Specify byte bound and digested spillover artifact in B plan — P41-B planner. |
| A3 | [ASSUMED] A verification-evidence producer and scoped tree snapshot can be attached to the host candidate without duplicating finalizer logic. | Define producer/API, crash matrix and affected-gate revalidation in D plan; spike only if needed — P41-D planner. |
| A4 | [ASSUMED] Existing outcome identity can link all parent usage to a verified ticket. | Measure coverage on live records; leave missing joins unknown — P41-F implementer. |
| A5 | Installed file identity implies neither installed behavior nor quota savings. | Controlled role/hook observation plus matched cohorts — release operator [VERIFIED: .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md:58-68,92-100,149-154]. |

## Sources and Method

Primary: source files and exact line ranges cited inline; accepted ADR-019, phase-41 CONTEXT, ROADMAP, INV-006 synthesis and its system-state/constraints reports. Source revision and integration checked with git rev-parse HEAD, git log -8 --oneline, git merge-base --is-ancestor 8ee1da0636702d75d50034af4982ac5418a5ad74 HEAD (exit 0). Installed identity checked with shasum -a 256 on source and installed Claude host/packet/hook/arm files plus installed_plugins.json and settings.json. External security category names checked against [OWASP ASVS 5.0 taxonomy](https://cornucopia.owasp.org/taxonomy/asvs-5.0); Context7 MCP and ctx7 CLI were unavailable. No npm registry research or package audit applies because no package installation is proposed. Valid until source, installed artifacts or phase-40 plans change; re-run identity and ownership checks at planning and execution.
