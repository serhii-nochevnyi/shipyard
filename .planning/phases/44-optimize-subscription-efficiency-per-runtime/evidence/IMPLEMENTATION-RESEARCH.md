# Residual subscription-efficiency changes: implementation research

Status: implementation proposal, not an accepted ADR, implementation, or completed four-line Shipyard investigation.
Updated analysis: [Claude Code and Codex runtime-specific addendum, 2026-09-26](RUNTIME-SPECIFIC-ADDENDUM.md). It refines telemetry, instruction loading, context lifecycle and experiment design, and records the changed phase-42 identity on current main.
Scope: the seven remaining suggestions from the pdffiller Claude-session audit, excluding work owned by phases 40, 41, and the phase-42 investigation. No production source, active Claude settings, policy, or delivery state was changed.

## Evidence and important corrections

The audit baseline is [REPORT.md](REPORT.md), particularly session `b11246f1-9854-4094-aa8f-997e2b873ca6`. The source tree changed during this research because another session is working. [source-manifest.json](implementation-research/source-manifest.json) records a later inspected HEAD and SHA-256 snapshots of relevant files. Installed runtime code and repository code are different evidence surfaces; a source change is not proof of installation.

Four corrections narrow the earlier proposals:

1. Rotation recommendation already exists: `plugins/delivery-pipeline/scripts/session-handoff.cjs:148`. It recommends at a completed phase boundary or when five comparable ordinary inputs each exceed twice the prospective startup median. The result explicitly forbids automatic transfer. Implement integration and calibration, not a second recommendation algorithm.
2. Bounded research handbacks already exist: `plugins/delivery-pipeline/workflows/investigation-research.mjs:222` specifies an artifact and a maximum 500-character callback summary. The residual proposal is source/fact selection and selective synthesis, not another artifact handback mechanism.
3. Actual subscription percentages already reach the user's renderer: `~/.claude/settings.json` points to `bash ~/.claude/statusline.sh`; that script reads `rate_limits.five_hour` and `seven_day` at lines 31–33. It rounds display values and does not persist samples. The new work is a collector and attribution report.
4. `CLAUDE.md` importing `AGENTS.md` is not itself evidence of duplicate loading. Do not remove that import as an optimization without measured duplicate content.

No percentage reduction in subscription consumption is established. Cached input, output, reasoning and dollar estimates are not interchangeable with the subscription meter.

## Scope fence against phases 40–42

| Residual change | Existing owner to depend on, not duplicate |
|---|---|
| Rotation integration/decision policy | 41-02 owns bounded checkpoint, successor and ownership safety. Existing T-33-09 owns advisory recommendation. |
| Research fact index and selective synthesis | Existing research workflow/phase-40 planning host owns authenticated artifacts; 41-01 owns assembled judgment prompt measurement/selection. |
| Instruction decomposition | Phase 41 explicitly defers instruction-document rewrite. Preserve its mandatory reference rules. |
| Exact-input review reuse and single-flight | Phase-42 F6 concerns carry across changed base/sibling merges. This proposal never reuses across a changed identity. |
| Executor effort experiment | ADR-014 owns the model ladder. Phase 41 preserves it; phase 42 excludes changing it. |
| Checkpoint reason versus technical escalation | Phase-42 F17 owns approval/merge semantics, F18 escalation remedies. This proposal only changes typed evidence feeding model selection. |
| Subscription samples | 41-06 owns token/outcome reporting. Extend its evidence with a separate account-level meter, not a replacement reporting pipeline. |

Phase 42 is an investigation, not a finalized implementation contract: `/Volumes/KINGSTON/.wt-claude-shipyard/plan42-target-scale/.planning/investigations/INV-007-target-project-scale/RESEARCH-CONTRACT.md`. Recheck its final ADR before ticket creation. Phase-41 scope is in `.planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md` and its eight plans.

## 1. Account-level subscription observations

**Recommended first delivery.** It establishes the endpoint metric needed to evaluate all other changes.

Existing integration: `/Users/serhii/.claude/statusline.sh:5` consumes stdin once, parses the meter, formats stdout. Add a packaged local collector before formatting, or a wrapper that buffers stdin once and feeds identical bytes to both collector and existing renderer. Do not have two processes independently consume the original stdin. Keep renderer stdout and failure behavior unchanged. Install/uninstall must preserve and restore the previous statusline command rather than overwrite custom settings blindly.

Suggested new module: `subscription-observation.cjs` (proposed, does not exist). Its input is a strict whitelist of metadata:

```text
schema, received_at, session_id, cli_version, runtime
local_account_scope, project/repository identity, model_id, observed_effort
five_hour: { used_percentage, resets_at } | unavailable
seven_day: { used_percentage, resets_at } | unavailable
source=statusline, sample_fingerprint, concurrent_usage=known|unknown
```

Store exact numeric percentages, including fractions. Do not parse rounded terminal text. Do not store full stdin, transcript contents, credentials or cost.total_cost_usd. Local account scope is an attribution label, not a claim that stdin contains an account ID. Account changes invalidate continuity.

Prefer bounded per-session append files under the user state directory, with private permissions and bounded retention. This avoids locking a global account file in a frequently invoked renderer. Aggregate those files later and deduplicate identical observations. Capture a window's reset timestamp as identity; never sum five-hour and seven-day values or sum repeated views of the same account across sessions.

Only compare before/after within the same account scope and reset window. Missing samples, expired windows, decreases/corrections, unknown activity, or reset crossings produce `inconclusive`, not zero usage. `received_at` is not proof that the provider refreshed the underlying meter. A before/after difference is account-level consumption; assigning it to pdffiller requires controlled workload windows with other usage accounted for. Process enumeration alone cannot detect web/mobile activity. Headless worker statusline coverage must be tested; parent samples may cover aggregate consumption but cannot attribute individual workers.

The [official statusline reference](https://code.claude.com/docs/en/statusline) documents these percentages/reset timestamps, optional fields and event-driven updates. Subscription windows can independently be absent; absence must stay unknown. This is a passive local collection design, not an undocumented usage API integration.

**Acceptance:** decimal and missing fields; independent windows; reset boundary; concurrent writers; duplicate/cancelled updates; malformed JSON; failed collector still renders; existing renderer preserved; no model/network launch; report refuses causal attribution with uncontrolled concurrent usage. An installed interactive sample is required before claiming collection works on this setup.

## 2. Exact-input architecture-review reuse

**Recommended second delivery.** The audit found two identical-head/base-tree violation reviews for T-02-12. This is concrete repeated work, but a head/base pair alone is too weak for safe reuse.

Current seam: `claude-role-host.cjs:1090`, `createClaudeRoleHost().run()`. It prepares live inputs, creates new run/dispatch identities, prepares the evidence file, dispatches, revalidates, validates and seals the result. Place reuse lookup after authenticated preparation but before `roleArtifact.prepareRoleArtifact()` can replace evidence. Preserve live authority checks on a hit.

Suggested new shared module: `review-reuse.cjs` (proposed). Construct a versioned deterministic fingerprint from **all review-relevant inputs**:

```text
repository identity + ticket/PR + head commit/tree
base ref/commit + merge-base/tree + exact diff digest
plan, acceptance, governing ADR and transitive source digests
selected backlog/instruction/source digests
policy hash + resolved runtime/model/effort
reviewer prompt/host/validator versions + review-affecting signals
```

Use a semantic input manifest; exclude incidental timestamps and newly generated dispatch IDs. Inventory the host inputs before choosing exclusions. Different instructions, contested status, evidence, policy, base, or source identity is a miss even when head is unchanged. Do not weaken the key just to improve the hit rate.

Persist `inflight | completed | failed | unknown` reservations in repository-shared state, using existing ownership locks and atomic writes (`lock.cjs`) plus fencing/leases. Short lock sections must not hold a filesystem lock for the whole model run. Parallel identical requests join the existing run. Lease expiry alone is not proof that its model child stopped; uncertain liveness blocks automatic redispatch until recovery resolves it.

Reuse only a complete authenticated sealed result whose receipt and artifact digest still validate. Both `conform` and `violation` can be reused; a reused violation must remain blocking. Store immutable evidence by digest because the next host invocation can replace a conventional evidence filename. An exact input cannot become green through reuse.

Return a reuse event referring to the original dispatch and receipt; do not manufacture a new launch receipt. Extend the consumer contract explicitly to distinguish `launched` from `reused`. Deduplicate usage against the original dispatch; otherwise accounting could count the same model run twice. Authorization to merge and other current gates must still be evaluated independently.

**Acceptance:** simultaneous identical requests cause one launch; repeated violations remain blocking; original receipt preserved; head/base/plan/policy/instruction mutations invalidate; corrupted/missing evidence refuses; unknown/crashed in-flight request cannot produce duplicate work; hit does not delete evidence; no reused verdict bypasses current CI/approval gates.

Start with architecture review only. Sentinel rounds and integrator checks have different live inputs and should not be generalized into the same cache in the initial change. Coordinate with phase-42 F6 without implementing its changed-base carry policy.

## 3. Connect rotation advice to verified handoff

Current files: `session-handoff.cjs:148` (`recommendRotation`), `:473` (status integration), `runtime-context.cjs` (transfer capability). Existing comparison groups only role/backend/runtime. Five large inputs are a heuristic, not a measured subscription break-even point.

Implement an observation adapter from phase-41 measurements, and invoke advice at real lifecycle boundaries without an additional LLM turn. Require comparable session segment, instruction/policy identity, model and effort when constructing a cohort. Missing prospective startup evidence stays `unknown`; do not invent it by treating the first ever request as a current restart cost.

Recommended first mode is advisory/shadow. Record one decision per recommendation and source-state fingerprint, avoid repeated alerts, and record what happened when handoff was actually performed. Include checkpoint creation, successor startup, rereading evidence and cache warmup in total work. Avoid fixed rules such as “rotate at 100k tokens”: smaller contexts do not by themselves demonstrate lower subscription consumption.

Only after 41-02 is installed and transfer capability is proven should an automatic mode be considered. Its transitions should reuse existing state and ownership APIs:

```text
advice -> boundary revalidation -> authenticated checkpoint
       -> reserved successor -> successor validation/acknowledgment
       -> ownership transfer -> predecessor retirement
```

Unfinished/unknown children, pending launches, stale source digests, lost ownership or missing constraints block transfer. A recommendation cannot authorize a launch. Crash handling must preserve exactly one owner and follow existing CAS semantics, rather than adding a second transfer manager.

**Acceptance:** existing seven rotation tests plus tests for mixed model/policy data, repeated advice, changed state after advice, active child, crash around acknowledgment, and a successor recovering pending gates without repeating completed work. Benefit is end-to-end usage per verified completion, not just the new session's initial context size.

## 4. Verified fact index for research, retaining four independent lines

Current seams: `context-packet.cjs:385` and `workflows/investigation-research.mjs:205`. Required references are already embedded and deduplicated by path. A fact index must not silently turn required contract/policy input into optional summaries.

Create a deterministic discovery manifest containing repository/source revision, path, file digest, useful range, command/provenance, relevance and uncertainty. Link claims to the manifest. File hashes establish identity, not truth; an LLM-generated interpretation remains a claim until checked. Use a content digest for ranges as well as the containing file identity, since line numbers move.

Distribute a common complete problem/acceptance/policy core plus explicit source selections per line: system-state gets execution paths and observed behavior; alternatives gets interface constraints and options; constraints gets authoritative contracts and mandatory transitive references; risks independently checks critical claims and failure paths. Each line retains access to additional sources. Required context overflow causes an explicit admission remedy, never truncation.

Produce a small finding index (`claim_id`, result, source refs, severity, uncertainty, contradiction links) alongside the existing complete artifact. Synthesis starts with indexes and expands referenced sections for each material decision, contradiction and unresolved assumption. The full reports remain durable. Do not reduce the output by discarding counterevidence or requiring critical risks to fit an arbitrary word cap.

This index changes content selection; do not reimplement phase-40 trusted research hosts or their 500-character handback. Do not reduce four lines to one researcher followed by three paraphrases. Critical risk/constraint checks must consult primary sources independently to avoid shared mistaken assumptions.

**Acceptance:** changed files invalidate facts; false common claim is caught independently; every constraint/decision traces to sources; omitted critical evidence forces expansion; all four canonical lines and original receipts remain; synthesis captures conflicting results. Compare first-response input, subsequent reads, total output, discovery/rework and missed constraints—not only packet size.

## 5. Instruction decomposition and measured duplicate removal

Existing pdffiller sources: `AGENTS.md` (roughly 31.7 KB in the audit) and `CLAUDE.md` containing `@AGENTS.md`. Separate universally required constraints from architectural reference material, framework-specific instructions and task examples. Keep mandatory test/lint workflow visible to relevant implementation and verification roles, including deletions and newly created files.

First create a rule-coverage manifest: stable rule ID, original source/digest, scope, mandatory roles, loading mechanism and acceptance scenarios. Then propose moves section-by-section. In this document, `.claude/rules/*.md` and role skill references are proposed destinations, not changes already made.

The [memory documentation](https://code.claude.com/docs/en/memory) supports path-scoped rules and notes that they trigger on matching reads. It also says `@AGENTS.md` is not loaded twice merely because direct AGENTS support is enabled. Therefore, preserve the import and provide explicit role loading for pre-edit planning/new-file scenarios; path matching alone is insufficient for mandatory rules. Do not put an invented `role:` selector in rule YAML.

The [subagent documentation](https://code.claude.com/docs/en/sub-agents) distinguishes inherited project instructions from preloaded skills; the latter inject full skill content. Role definitions must explicitly carry required references. Avoid a blanket `omitClaudeMd` change. Measure both cold starts and eventual rule loading: deferring text that every task immediately reads is not a demonstrated saving.

For duplicate skill catalogs, compare logical identity, source digest and runtime semantics. Equal names can represent different versions. Remove a redundant installation only through its owning installer and update resolver references; do not deduplicate runtime catalogs by string-name filtering. Keep Codex and Claude native instructions compatible rather than relying solely on Claude-specific rules.

**Acceptance:** coverage for PHP implementation, frontend work, test changes, deletion, new-file creation, planning before reads and review-only roles; required directives available before their first relevant action; no repeated imports/catalogs demonstrated in startup evidence; observed token reduction without extra rediscovery or instruction violations. This is a medium-size semantic migration, not a one-line config optimization.

## 6. Separate administrative checkpoints from technical escalation

Current policy: `model-policy-internal.cjs:156–193` promotes certain roles on `checkpoint=true`; `claude-role-host.cjs:359` derives that signal from authenticated graph rows. `validate-graph.cjs` parses/validates/projects `human_checkpoint`, with high-risk and preauthorization invariants. Changing only a prompt or local `models` field will not correctly change this behavior.

Add a canonical typed reason, for example `administrative | technical-risk | mixed | unknown`, with source provenance. This name is a proposal. Preserve `human_checkpoint` as the approval/authorization obligation. For model selection, use technical risk and critical/contested signals; administrative-only checkpoints need not independently promote model effort. Unknown and legacy checkpoint reasons must retain the current conservative promotion. No automated reinterpretation of all existing checkpoints as administrative.

Required change chain: accepted ADR-014 amendment -> schema/parser and projection migration -> authoritative signal derivation at every launch seam -> resolver rules and receipt identity -> generated runtime assets/install verification. Test both native runtime ladders; changing Claude policy must not accidentally substitute Anthropic models into Codex execution. Preserve technical-risk escalation and all approval gates.

Coordinate the field contract with phase-42 F17; use its resulting approval meaning rather than altering merge behavior here. Do not let this become a second implementation of F17/F18. T-02-13's Jira checkpoint is a motivating case, not proof that every human checkpoint is administrative or that most consumed quota came from this promotion.

**Acceptance:** administrative-only checkpoint retains human action but stays at the normal model rung; technical/mixed/unknown checkpoints escalate as required; high risk and contested results remain effective; legacy data stays conservative; changed policy hash reflected in receipts; repeated/critical routes unchanged; merge permission behavior identical.

## 7. Sonnet/high versus Sonnet/max executor experiment

Do this last. The current Claude baseline is Sonnet/max (`model-policy-internal.cjs:119`), and overriding it locally would bypass the policy contract. The [model configuration reference](https://code.claude.com/docs/en/model-config) describes effort as a capability/work tradeoff; reduced effort is a hypothesis, not a quality guarantee.

First accept a narrowly scoped experimental ADR with eligibility, arms, immutable identities, fallback and stop rules. No global lowering and no arbitrary request-time override. Resolve each arm through the trusted host, recording requested and observed model/effort in the application evidence. Pin actual model identity because a family alias can change over time.

Begin with isolated representative small tasks where acceptance checks are adequate. Exclude high-risk/auth/security/migration/ambiguous tasks from the initial pilot. Use separate disposable worktrees for paired offline trials, keep the same source/acceptance/environment, and randomize arm order to reduce cache/time effects. Do not expose one arm to the other arm's solution. A subsequent controlled production cohort is needed for subscription-meter evidence; offline duplicated work itself consumes quota and must be budgeted.

Keep independent reviewer configuration, required tests and CI unchanged. Compare end-to-end workload including repairs, retries, recovery, abandoned runs and escalation. Blocked environmental tasks are not clean successful effort comparisons; keep their costs visible while distinguishing confounding causes.

The present `orchestration-overhead.cjs:17` accepts only `wait_events` and `bounded_context` treatments; `normalizeTreatment()` rejects unknown dimensions. Add a versioned effort-experiment schema or a separate report instead of relabeling effort as one of those treatments. Preserve matching on other dimensions while treating effort as the explicit experimental variable. Keep baseline and experimental policy hashes distinct and intentionally paired.

Existing phase-41 readiness thresholds (20 completed outcomes, 95% attribution, seven-day defect window) are a minimum evidence discipline, not statistical proof of non-inferiority. Predefine acceptable defect/reopen differences and uncertainty handling; small samples with no observed failures do not prove equal quality. Immediate stop conditions include false green, skipped gate or lost constraints. Increased repairs can cancel the apparent output savings.

**Acceptance:** verified arm identity; no policy bypass; same independent gates; failed and escalated attempts included; no promotion on insufficient data; controlled actual subscription observations; documented rollback; separate reporting of throughput, quota and quality.

## Suggested delivery sequence and review boundaries

| Order | Concrete deliverable | Relative size | Start condition |
|---|---|---|---|
| 1 | Passive subscription collector and window-aware report | Small–medium | Existing renderer interface verified |
| 2 | Exact-input architecture-review reuse, immutable artifact index and single-flight | Medium–large | Authoritative review inputs inventoried; align with F6 |
| 3 | Rotation observation adapter, advice deduplication and shadow results | Medium | Phase-41 measurement/handoff interfaces stable |
| 4 | Research fact manifest and selective synthesis | Medium | Installed planning artifact host verified |
| 5 | Instruction coverage manifest and staged rule migration | Medium | Baseline loading evidence captured |
| 6 | Typed checkpoint reasons and policy migration | Medium–large | F17 semantics stable; ADR-014 decision accepted |
| 7 | Effort experiment protocol, resolver arm and evaluation | Large | Stable pipeline and usable subscription observations |

Rotation automation is a separate later acceptance boundary, not bundled into the first advisory change. Deliver measurement and idempotency first; neither depends on proving that a weaker executor is sufficient. Do not assign new phase numbers or claim these options are accepted decisions.

## Validation performed and limitations

Source inspection commands included targeted `rg`/`sed`, `git rev-parse HEAD`, whitelisted statusline configuration inspection, and SHA-256 source snapshots. No Claude configuration was changed, no live agent was interrupted, and no test task was dispatched against the user's subscription.

Executed existing checks:

- `node tests/unit/rotation-recommendation.test.cjs`: 7 passed, 0 failed, exit 0.
- `node tests/unit/orchestration-overhead.test.cjs`: 8 passed, 0 failed, exit 0.

These tests validate existing primitives, not the seven proposed implementations. New module names, schemas, transitions and tests above are design proposals.

The installed Shipyard research path has a formal workflow limitation. The loaded `/Users/serhii/.agents/skills/shipyard-investigate/SKILL.md` requires a trusted `planning.v1` artifact and says: “accept research output only after that receipt is verified.” The inspected `/Users/serhii/.codex/shipyard/scripts/codex-delivery-host.cjs:309–332` performs trusted artifact finalization only for executors; non-executor runs return the launch result. That inspected entry point does not establish the research artifact sealing contract required by the skill. No private bootstrap or direct-agent substitute was used. Consequently, this document is a source-backed implementation analysis; it does not claim four authenticated research-line results, a passed Gate 1, or an accepted ADR. Formal promotion should use the installed planning host once that contract is available and verified.
