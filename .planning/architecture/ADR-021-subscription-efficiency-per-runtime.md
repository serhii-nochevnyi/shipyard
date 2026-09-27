---
status: accepted
---
# ADR-021 — subscription-efficiency-per-runtime

- **Status:** accepted
- **Date:** 2026-09-27
- **Decision owner:** repository maintainer; decisions taken in the INV-009 dialogue
- **Scope:** phase 44 (P44-A–G), decomposed in two passes: A, D and G now; B, C, E and F after the phase-43 epic reaches main. Implementation details belong to its plans.
- **Supersedes:** none
- **Related:** ADR-014, ADR-017, ADR-019, ADR-020
- **UI design:** none

## Context

Phase 44 was queued on 2026-09-26 to reduce avoidable subscription consumption per verified
completion on Claude Code and Codex. Its preparation (`.planning/phases/44-optimize-subscription-efficiency-per-runtime/`)
was a proposal without an accepted design. The 2026-09-25 audits found repeated architecture
reviews on identical inputs, duplicated research reads, required instructions loaded differently
per runtime, rotation advice without comparable measurements, and no subscription observation at
all. Investigation `.planning/investigations/INV-009-runtime-subscription-efficiency/` re-checked
this on revision `bc127635`, after phases 40–42 shipped in 0.67.0. Four sealed research lines and
host checks found the following. The hosts already save quota data in their transcripts (Claude
`rate_limit_event`, Codex `token_count.rate_limits`), and nothing reads it. Arch-review verdicts are
indexed only by dispatch id. The checkpoint model signal is a boolean derived at two seams. Effort
cannot be a treatment because it is a cohort key. Pending phase-43 tickets own many of the files
involved, including T-43-12 (F17 checkpoint values) and T-43-13 (changed-base carry). Evidence
with file:line is in the INV's `RESEARCH.md` and `research/`.

## Decision

- Phase 44 is decomposed in two passes: P44-A, P44-D and P44-G now, and P44-B, P44-C, P44-E and P44-F after the phase-43 epic merges to main, because they share files with pending phase-43 tickets and Gate 2 rejects unordered shared paths; this ADR fixes the contracts of all seven items, and the second pass materializes plans against the landed code.
- Subscription observation reads the quota records the hosts already save: Claude `rate_limit_event` in the host transcripts and Codex `token_count.rate_limits` in the native transcript, parsed by the usage reader into one whitelisted envelope, without changing `claude-runtime-host.cjs` or `codex-runtime-host.cjs`, starting a process or making a call.
- The interactive Claude parent session is observed by a reversible statusline wrapper with its own supported installer entry point: it buffers stdin once, forwards identical bytes to the preexisting renderer, never changes the renderer's output or exit, restores only owned settings on uninstall, and is developed against isolated homes without touching the user's active statusline.
- The observation envelope keeps provider, account label, bucket id, window, reset, used percentage normalized per source (the Claude stream reports a fraction, the statusline and Codex report percent), source, freshness and a concurrency status; it never maps `primary`/`secondary` to 5 h / 7 d by position, never sums across provider, account or bucket, and treats a reset, a decrease, an account-label change or unknown concurrent usage as a discontinuity or an inconclusive result.
- Idle Codex baselines and the Codex parent session are recorded as `unverified`; phase 44 builds no app-server client, daemon, model turn, account mutation, API key or limit-reset operation.
- Per-account samples live in private host state under `~/.local/state/shipyard/<runtime>/subscription/` (file mode 0600, directory 0700, bounded retention); tracked reports carry only derived per-outcome and per-cohort values; no prompt, transcript excerpt or credential is stored.
- An account is identified by an operator-declared local label per runtime home; a missing label makes the observation `unattributed`; e-mail, user id, Codex `credits` and `plan_type` are never stored.
- Rotation advice stays in `recommendRotation`: the comparable key adds model, effort, policy hash and instruction digest, a mismatch yields `unknown`, one shadow decision is recorded per (recommendation id, source-state fingerprint), resume, history-copying fork, compaction and fresh start are separate classes whose costs include checkpoint collection, successor startup, rereads and cache warmup, and `automatic_transfer.allowed: false` and T-41-02's ownership invariants are unchanged.
- Effort experiments get a versioned schema and report, eligibility rules, metrics that count failed, repair, escalation and abandoned work, and a promotion rule that is always a recorded human decision above the 20-completion / 95 % attribution / seven-day floor; no resolver, policy object, config key or dispatch changes and nothing is active; the existing treatment set and report schema are extended only by a new versioned schema.
- Architecture review reuses a sealed verdict only on an exact, versioned manifest of every governing input (PR number, head and head tree, base, merge-base and their trees, integration-base tree, exact diff, plan content and acceptance, ADR refs including excluded and unresolved, reference digest, packet digest and selected backlog ids, signals including live `contested` and `inputTokens`, policy hash, applied model and effort, host identity, instruction digest), looked up after authenticated preparation and before evidence preparation; an input outside the manifest disables reuse.
- A reuse hit returns a distinct `reused` outcome with the original dispatch id and receipt and no new launch receipt; a reused violation still blocks; live CI, approval and merge gates are re-evaluated; there is no reuse across a changed base and a carried verdict is never a reuse source; a verdict never satisfies a separately required other-provider review.
- Concurrent identical arch-review requests are single-flighted through a reservation record with states `inflight`, `completed`, `failed` and `unknown`, written under `lock.cjs` without holding a lock across a model run; `unknown` blocks automatic redispatch and names a recovery action; Codex reuse is a named gap until a Codex arch-review host exists.
- Mandatory instruction coverage is a shared manifest of rule ids (source digest, scope, mandatory roles, loading mechanism per runtime) plus a verifier that records the paths and digests each installed runtime actually loaded and fails when a mandatory rule is missing; native instruction delivery is unchanged in phase 44, and generating native forms from the manifest needs a later decision.
- Research gets a file-level source index (repository, revision, path, sha256, provenance) whose entries a changed source invalidates, and the packet builder refuses when a source the research contract marks mandatory is not embedded; the four lines, the 500-character handback, `planning.v1`, `shipyard.research-result.v1` and durable full artifacts are unchanged, and new fields are optional and versioned.
- A typed checkpoint reason is recorded as `delivery.checkpoint_reason` with values `administrative`, `technical`, `mixed` and `unknown` (default `unknown`), parsed, validated and projected by the graph but orthogonal to `human_checkpoint`, `preauthorized` and T-43-12's `checkpoint` field; `signals.checkpoint` keeps promoting exactly as today, including for `review` and `merge`, and the receipt policy hash is unchanged.
- Installed-host unknowns (idle Codex rate-limit read, effective Codex AGENTS.md budget, Claude loaded-instruction evidence, the complete arch-review input inventory, T-02-12 concurrency) are resolved by a spike at the start of the ticket that needs them, and an unknown value never becomes launch authority or a passing gate.
- Each item records installed, behaviourally verified and efficiency-measured states separately; every report says `inconclusive` until matched cohorts exist, and no acceptance criterion contains a savings percentage.
- Planning runs state-sync in the phase-44 planning worktree before Gate 2, because the committed delivery-state projection lists merged phase-40 tickets as pending and Gate 2 takes its merged set from it.

## Consequences

- The conveyor can observe subscription use per runtime for the first time without a new process, installer-managed daemon or host change; interactive Claude sessions need the operator to install the wrapper and declare an account label.
- The first pass is small and independent of phase 43; the second pass waits for the phase-43 epic and re-reads line references against it.
- Arch-review reuse removes identical re-reviews on Claude but makes the manifest a correctness boundary: a missed input is a stale verdict, so the inventory and per-field mutation tests are part of the work.
- Instruction coverage and the research index detect gaps rather than save quota by themselves; any saving must be shown by the observation data.
- Typed checkpoint reasons and effort experiments produce records and protocols only; activating either needs a later ADR-014 amendment or a separate ADR, with observed receipts on both native grids.

## Out of scope

- Any change to the ADR-014 grids, promotion rules, `POLICY_HASH`, resolver input schema or receipt shape, including activation of `checkpoint_reason` and any experiment assignment.
- Changed-base verdict carry (T-43-13), F17 approval semantics (T-43-12) and F18 remedy policy (T-43-18).
- Phase-45 work (INV-008): the Stop gate, stacked delivery, planning reliability and delivery treatments, including whole-INV reuse, stage instruction loading, drift-scan reuse and the admission ledger.
- Blanket model downgrades, mandatory double-provider review, provider fallback, quota-based scheduling, automatic session transfer, new daemons, and destructive instruction edits in target repositories.
- Generating native instruction forms from the coverage manifest, and range- or claim-level research indexing.
- API-price or token-to-quota conversion, and any fixed savings target.
