# Claude Code and Codex: separate runtime strategies

Date: 2026-09-26. Supplements [IMPLEMENTATION-RESEARCH.md](IMPLEMENTATION-RESEARCH.md). Status: proposed design, no production changes or accepted policy amendments.

## Conclusion

Keep acceptance criteria, ownership, artifact validation, review independence and completion gates shared. Implement subscription measurement, context lifecycle, instruction delivery, usage parsing and model selection separately for each runtime. The repository already has separate model grids and runtime adapters; extend those seams rather than create two unrelated pipelines.

This can remove avoidable work and improve correctness. It does not establish a numeric quota saving or justify declaring either provider universally better at planning, implementation or review.

## Current evidence and scope correction

- Inspected repository HEAD: `ff4ccb032f5b500f9a07c69dd4efd26e6fe821f0`; the working tree contains concurrent planning changes. No changes to that tree were made here.
- Local `codex --version`: `codex-cli 0.157.0`. Claude version 2.1.282 is the previous audited session's identity, not a fresh claim about every installed Claude entry point.
- `codex-runtime-host.cjs:841` launches `codex exec --json` with explicit model/effort, `forced_login_method="chatgpt"`, and `--ignore-user-config`. It strips API-key environment variables. Therefore a global Codex config edit is not a reliable way to change pipeline execution; changes must be admitted by the host.
- Its typed GSD path checks the parent and native child separately (`:605–720`) and requires `fork_turns: none`. The parent launch is additional model work, not a free shell wrapper. Measure both, but do not bypass typed-role receipt requirements to remove it.
- The phase numbering has changed since the first report: current main contains `42-resume-trusted-finalization-without-executor-replay/42-01-PLAN.md`, moved from T-41-04. The earlier target-scale worktree's proposed phase 42 is a different planning artifact. Exclusions must use requirement/content identity, not phase number alone. Trusted execution recovery remains excluded; the earlier F6/F17/F18 work remains separately owned until reconciled.

## 1. Subscription collectors must be provider-specific

**Claude:** retain the existing statusline renderer and collect the documented `rate_limits.five_hour/seven_day` metadata before display rounding. Do not assume headless workers call this renderer. Account samples describe shared consumption; worker attribution still comes from receipts and usage records.

**Codex:** use an adapter for the installed app-server protocol. The [official reference](https://learn.chatgpt.com/docs/app-server) documents `account/rateLimits/read` and `account/rateLimits/updated`, with bucket identity, percentage, duration and reset time. `primary` and `secondary` are not safely hard-coded as five hours and seven days. Prefer the multi-bucket view when present and avoid counting its legacy single-bucket alias twice.

I generated the local 0.157.0 JSON schema without starting a model turn. It confirms these methods and warns that update notifications are sparse: merge provided values into the last snapshot or refetch; missing metadata does not erase previous metadata. Schema availability proves protocol support, not successful account retrieval. A read-only authenticated integration check is still required at implementation time.

Normalize to a shared envelope:

```text
provider, runtime, account_scope, surface, observed_at,
bucket_id, window_duration_seconds, resets_at, used_percentage,
source, freshness/availability, concurrent_usage_status
```

Keep provider/account/bucket boundaries in reports. Do not add Claude and Codex percentages or infer subscription consumption from API list prices. Use separate quota-per-verified-completion and quality results. Account switching and reset discontinuities invalidate a comparison window. No reset-credit redemption or account mutation belongs in collection.

Proposed tests: sparse Codex updates; bucket aliases; independent resets; missing Claude windows; unknown account identity; multiple sessions displaying the same meter; no model launch during collection.

## 2. Separate recovery, compaction and a fresh-context handoff

These actions need separate capability flags and accounting. A new process, thread ID or fork is not evidence of a small model context.

**Claude:** use observed prompt-cache state alongside context and handoff costs. The [cache documentation](https://code.claude.com/docs/en/prompt-caching) distinguishes model switches, model-dependent effort changes, tool-definition changes and compaction. Keep model/effort and tool configuration stable inside a task where possible; evaluate rotation at meaningful boundaries. Cache-read volume alone is not a subscription bill.

**Codex:** the [app-server reference](https://learn.chatgpt.com/docs/app-server) distinguishes resume, history-copying fork and compaction. Resuming should recover the existing task; a bounded fresh start should consume the checkpoint rather than copy full history. Do not copy Claude cache TTL assumptions into this decision. Measure the installed Codex behavior and total transition cost.

The current Shipyard Codex execution path is CLI `exec`, not an app-server execution backend. App-server documentation is not permission to replace that path. A quota collector can be a separate read-only integration; lifecycle changes still need the existing host's receipt, ownership and capability contract. Reuse phase-41 handoff and phase-42 recovery work.

## 3. One instruction policy, two delivery mechanisms

**Claude:** supports its own `CLAUDE.md` imports, `.claude/rules` path conditions and subagent skill loading. Path rules need explicit supplements for mandatory checks before a matching read or when creating new files.

**Codex:** the [AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md) describes an instruction chain built at startup from project root to working directory, override precedence and a default 32 KiB project-doc budget. It does not give `.claude/rules` Claude semantics. Starting at repository root cannot be assumed to preload every nested rule. The advanced reference phrases the byte limit differently, so validate effective loading in the installed host rather than infer truncation from totals alone.

pdffiller's root AGENTS.md is 31,738 bytes, already close to 32 KiB; global Codex AGENTS.md is 1,628 bytes. This is a reason to measure the effective instruction chain, not proof that 598 bytes were truncated or that the global file consumes the same project budget.

Maintain a shared rule-ID/coverage manifest. Supply Claude-specific loading rules and Codex-specific startup/role references from that manifest. Record effective loaded paths/digests and verify mandatory coverage before the first relevant action. Keep complete required content even if a soft target is exceeded. Do not use blanket instruction suppression or raise limits as the only response to duplication.

## 4. Preserve native model ladders and run distinct experiments

Current policy in `model-policy-internal.cjs:69–193`:

| Role | Claude baseline | Codex baseline |
|---|---|---|
| Research | Opus / medium | Sol / high |
| Decomposition | Opus / medium | Sol / high |
| Executor | Sonnet / max | Luna / max |
| Critical executor | Opus / low | Sol / high |
| Architecture review | Opus / medium | Sol / high |
| PR sentinel | Sonnet / high | Luna / medium |

These are inspected Shipyard policy selections, not comparative benchmark results. The same effort word is not a common unit of reasoning work across models/providers.

Keep the Claude Sonnet/high pilot separate. For Codex, first measure the current Luna/max baseline, repair frequency, escalation and parent/child overhead. Only then propose a supported alternative through an accepted policy experiment. Do not automatically translate Sonnet/high into Luna/high or promote every task to Sol. Verify both requested and observed selection.

Administrative checkpoint reasons can share one semantic schema, but each resolver must map those reasons to its own ladder. Preserve human approval obligations, technical-risk escalation and conservative legacy handling in both runtimes.

## 5. Share facts and artifacts, not unbounded conversation history

Use a common versioned source manifest and bounded findings index. Each runtime adapter must produce its required prompt/role format while preserving complete mandatory inputs. Keep the four research perspectives and independent source checks.

Claude subagent or fork behavior and Codex parent/child spawning are distinct mechanisms. The current Codex typed GSD host explicitly requires no history fork; preserve that invariant. A compact role task is not a substitute for the installed typed agent's instructions. A model-only parent needed by the current host must be included in measurements, not hidden in the orchestrator bucket.

Use separate usage parsers. Claude's repeated usage across message blocks requires response deduplication; Codex `turn.completed` usage and native transcript records require their own identities and cumulative/delta semantics. Do not sum CLI, transcript and parent/child views blindly. Normalize only after provider-specific extraction and preserve provenance. Missing reasoning/cache details remain unavailable, not zero.

## 6. Review deduplication is shared logic with runtime-scoped identities

Both adapters should consult the same exact-input reuse contract. Include runtime, provider, actual model/effort, reviewer instructions and host/validator version in addition to all source/contract identities.

A Claude verdict must not satisfy a separately required independent Codex review, or vice versa. Share source discovery and deterministic test artifacts when their contract allows it; preserve independence of judgments. Mandatory dual-provider review on every task would increase consumption and is not justified by this audit. Consider it only for selected critical/contested work after evaluating marginal defect detection versus added cost.

## 7. Capability-aware admission and optional quota-aware scheduling

Extend existing preflight evidence rather than add another launch authority. Useful capabilities include authenticated role launch, artifact sealing, observed selection evidence, context operation support, instruction coverage and quota observation. Bind evidence to installed runtime/host versions and role: generic model availability does not prove a particular research artifact path works.

This helps prevent launching a model for work that cannot be accepted afterward. Phase-40 planning-host completion and phase-42 trusted finalization remain their current owners; this addendum does not create duplicate tickets for them.

An optional future scheduler can choose among already approved and capability-verified runtime routes **before** dispatch, considering per-account limits and task eligibility. Keep runtime pinned during an active task and preserve ownership, attempts and artifacts on an explicitly supported handoff. No silent provider fallback on host failure.

Using spare capacity in a second subscription may improve throughput; it does not prove less total model work. Routing should be driven by matched quality/repair evidence, not a blanket assumption that Claude plans and Codex codes better. This scheduler would require a policy decision and is not implemented or accepted here.

## Revised priorities

1. Provider-specific subscription observations and effective instruction coverage.
2. Exact-input review deduplication with runtime-scoped keys.
3. Separate context lifecycle measurements and verified handoff decisions.
4. Shared fact index with native instruction/agent adapters.
5. Typed checkpoint semantics, coordinated with existing approval work.
6. Independent effort experiments; optional quota scheduling only afterward.

Proposed contract tests should run the same quality/identity assertions through both adapters while using provider-native fixtures. Add negative cases for treating a fork as a clean start, losing nested Codex instructions, importing Claude quota window assumptions into Codex, counting sparse updates twice and reusing the other provider's required review.

## Validation and limits

No model workload was launched and no account meter was fetched. Local verification used CLI version/help and `codex app-server generate-json-schema --out /tmp/shipyard-runtime-research-20260926-schema` (exit 0), then inspected request, notification and rate-limit response schemas. This verifies the installed schema, not live authentication or efficiency. Context7 returned a monthly-quota error; official OpenAI documentation and Claude documentation were used instead. Previous 15 passing tests remain evidence for the previous report's existing primitives, not tests of this proposed addendum. The earlier formal investigation/Gate-1 limitation remains; no new claim of authenticated four-line completion is made.
