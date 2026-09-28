# INV-009 — research line 3: constraints

- Investigation: INV-009-runtime-subscription-efficiency (phase 44, P44-A..G)
- Line: constraints (feeds RESEARCH.md "Constraints" and seeds CONSTRAINTS)
- Source revision: `bc127635242959a3d6ff76c7d76e8ce456df512d` (checked: `git rev-parse HEAD`)
- Policy hash in packet: `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968` (policy version `adr-014.v6`)
- Policy signals for this dispatch (preserved as DATA): `{"type":"facts"}`
- Runtime of this worker: Claude, `claude-opus-5-5`/medium (resolved by the caller).
- Scope: read-only. The only file written is this artifact. No provider account API was called, no model was launched, no source file was changed.

## 0. Method and evidence rules

Every code claim below names the command that checked it. Commands were run from the worktree root
`/Volumes/KINGSTON/.wt-claude-shipyard/plan44-decompose` (Bash) or through the repository Grep tool
(ripgrep) with the stated pattern and path. "Grep(pattern, path)" below means that tool call.
Confidence levels: **high** = read directly in accepted ADR text or verified in source on this revision;
**medium** = derived from accepted text plus source but requires interpretation;
**low / assumption** = not checkable by a command in this worktree; the next check is named.

Two tool calls were refused by the session's permission layer (a `cd` into a subdirectory and a
`grep` with a shell-computed path). Both were re-run with absolute paths / the Grep tool; no evidence
was lost.

## 1. Delivery-state facts that bound every constraint

| # | Fact | Command / evidence | Confidence |
|---|---|---|---|
| S-1 | Phase 40 epic is merged and released: HEAD first-parent history contains `20228321 Merge pull request #313 … epic/40-build-delivery-seams-and-clean-target-project-prs` and `d7c7aa74 … release/version-0.67.0`; `git tag --contains 1e814d91` prints `v0.67.0`. | `git log --oneline --first-parent HEAD \| head -45`; `git tag --contains 1e814d91` | high |
| S-2 | Phase 41 (T-41-01..09) and phase 42 (T-42-01..03) are merged (PRs #235–#250, #255, #270, #274). | `node -e` over `.planning/graph/delivery-state.json` (T-4x statuses) | high |
| S-3 | **The committed delivery state is stale for phase 40**: `.planning/graph/delivery-state.json` (last committed 2026-09-26 17:37 +0300) still lists every T-40-* as `pending`, and `.planning/graph/delivery-front.json` lists them under `parked.blocked`, although S-1 shows the epic merged. Planning must run state-sync on the authoritative tree before deriving file ownership from the graph; do not trust the committed front. | `git log -1 --format=%ci -- .planning/graph/delivery-state.json`; same `node -e` | high |
| S-4 | The local `main` ref in this worktree is stale (first-parent tip `22ef429b`, PR #253), behind HEAD. Any `git branch --contains`/`git log main` check must use `origin/main` or HEAD. | `git log --oneline --first-parent main \| head` vs HEAD | high |
| S-5 | Phase 43 is mostly undelivered on this revision: delivery state shows T-43-02 `merged pr#264`, T-43-07 `pr-open pr#266`, all others `pending`; no T-43 ticket merge appears in HEAD's first-parent history (the `43-*-SUMMARY.md` files are gsd-sync projections with `tokens: 0`, not delivery evidence). | same `node -e`; `git log --oneline HEAD \| grep -E 'T-43\|43-'`; `head -12 .planning/phases/43-*/43-12-SUMMARY.md` | medium (state file may be stale like S-3; re-check with state-sync) |
| S-6 | `plugins/delivery-pipeline/scripts/subscription-observation.cjs` and `review-reuse.cjs` do not exist (proposed names only). | `[ -f … ]` loop over key scripts (prints `MISSING`) | high |
| S-7 | Existing primitives still pass on this revision: `rotation-recommendation.test.cjs` 7 passed 0 failed; `orchestration-overhead.test.cjs` **16** passed 0 failed (the evidence recorded 8 — the suite grew with phase 41/40); `model-policy.test.cjs` 26 passed 0 failed. | `node tests/unit/<name>.test.cjs \| tail -2` for each | high (output line; exit status of node itself not captured separately because of the pipe) |

## 2. Hard technical constraints

### 2.1 ADR-014 boundary (applies to P44-B, P44-D, P44-F, P44-G; indirectly to all)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| C-01 | Two independent native grids; Claude never resolves Codex logical names through aliases and vice versa; generated Codex `.toml` files are adapter output, never a policy source. No phase-44 item may introduce cross-grid aliasing or "effort translation" (e.g. Sonnet/high → Luna/high). | ADR-014 §1, §3; `CLAUDE.md:88` ("Do not alias either grid through the other"); RUNTIME-SPECIFIC-ADDENDUM §4 (still holds: `model-policy-internal.cjs:120` Claude executor base `sonnet`/`max`, `:124` pr-sentinel `sonnet`/`high` — Grep(`model_key: 'sonnet'`, model-policy-internal.cjs)) | high |
| C-02 | Every routed launch goes resolve → validate → launch → application receipt → record. Hard refusal on unknown runtime, unsupported selection, stale/missing generated variant, conflicting override, inline/session-inherited selection, missing receipt. A reused review verdict (P44-B) is **not** a launch and must not fabricate a new application receipt; it must present the original receipt plus a distinct "reused" outcome. | ADR-014 §4; ADR-014-INTERFACES.md `ApplicationReceipt` (`compliance: 'verified'`, `applied_*` from the adapter, not the caller) | high |
| C-03 | Launch authority must not widen: no per-role override, generic GSD tier, project config or experiment flag may become launch authority. "A conflicting override is a configuration error, not a promotion or downgrade." P44-G's arms must be resolved by the trusted boundary, not by a request-time override. | ADR-014 §5; `CLAUDE.md:88`; IMPLEMENTATION-RESEARCH §7 ("no arbitrary request-time override") | high |
| C-04 | Any change to the canonical policy object changes `POLICY_HASH`: `model-policy-internal.cjs:300` hashes `stableStringify(policy)`; the hash is embedded in generated Codex agents (`scripts/gen-codex-shipyard.cjs:365` `policy_hash: policy.POLICY_HASH`); a stale generated variant hard-refuses (C-02). Therefore P44-F (resolver/signal change) and any P44-G experiment data placed in the policy require: a canonical ADR-014 amendment, a policy version bump from `adr-014.v6`, regenerated Codex agents and the generated marketplace copy (`plugins/shipyard/host/plugins/delivery-pipeline/scripts/model-policy-internal.cjs`, which also contains `adr-014.v6`), and both-runtime fixtures. | Grep(`function computePolicyHash\|createHash`, model-policy-internal.cjs) → `:300`; Grep(`model-policy\|policy_hash`, gen-codex-shipyard.cjs) → `:108,:365`; Grep(`adr-014\.v6\|30e71fb4066f`, repo excl. .planning) → 2 files | high |
| C-05 | Signals are role-scoped and a missing signal never silently promotes; fixed roles (pr-sentinel, drift-check) never promote. P44-F must keep `checkpoint=true` promotion for unknown/legacy reasons (conservative) and may only stop promotion for an explicitly administrative reason after the ADR-014 amendment. | ADR-014 §3; `model-policy-internal.cjs:635-643` (checkpoint → critical rung, "global checkpoint state cannot promote a fixed role") | high |
| C-06 | Where `checkpoint` is derived today (every seam must migrate together): `plugins/delivery-pipeline/scripts/deliver-dispatch.cjs:90` (`if (row.human_checkpoint === true) signals.checkpoint = true`) and `claude-role-host.cjs:377` (`checkpoint: rows.some(({ row }) => row.human_checkpoint === true)`); resolver rules at `model-policy-internal.cjs:160,163,166,178,193`; allowed signal set at `claude-role-host.cjs:98`. The evidence cited `claude-role-host.cjs:359` and `model-policy-internal.cjs:156-193` — line numbers moved but the seams still hold. | Grep(`human_checkpoint\|preauthorized\|checkpoint`, 6 host/policy scripts) | high |
| C-07 | The ADR-014 receipt shape and resolver input schema are out of scope for ADR-020/phase 43 and may only change through an ADR-014 amendment. Phase 44 should add new fields (reuse outcome, experiment arm id, checkpoint reason) outside `ApplicationReceipt` or through that amendment — never by silently extending it. | ADR-020 "Out of scope" ("The ADR-014 model/effort grid, the resolver input schema and the receipt shape"); ADR-014-INTERFACES.md | high |
| C-08 | Observed model/effort may be `unknown` only when the runtime contract says so; unknown application is never compliant. P44-G's "observed arm identity" and P44-A's collector must not treat unknown as a match. | ADR-014-INTERFACES.md "Application receipt" | high |
| C-09 | Rollback is a versioned compatibility mode; never a return to implicit session inheritance. Applies to disabling P44-F or P44-G. | ADR-014 "Rollout and rollback"; ADR-014-ROLLOUT.md last paragraph | high |

### 2.2 Runtime-host boundaries (P44-A, P44-C, P44-D)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| C-10 | The Codex execution backend is CLI `codex exec --json` with explicit model/effort, `forced_login_method="chatgpt"` and `--ignore-user-config`, and it strips `OPENAI_API_KEY`/`CODEX_API_KEY`. Global Codex config is therefore not launch authority; a P44-A Codex collector must be a separate read-only integration and must not replace the exec backend or introduce API keys. Evidence cited `codex-runtime-host.cjs:841`; on this revision the args are at `:1006-1007`, key stripping at `:993`, required help markers at `:15`, dispatch-adapter checks at `codex-dispatch-adapter.cjs:95,128-129`. Claim still holds; line numbers moved. | Grep(`ignore-user-config\|forced_login_method\|fork_turns\|OPENAI_API_KEY\|CODEX_API_KEY`, scripts/) | high |
| C-11 | The Codex typed GSD path requires `fork_turns: none` (`codex-runtime-host.cjs:581,790`). P44-D/P44-E must not use a history-copying fork as a "fresh" start and must not remove the model-parent launch to save cost (phase 45 P4 owns parent-wait overhead). | same Grep; RUNTIME-SPECIFIC-ADDENDUM §5 | high |
| C-12 | No Claude statusline/rate-limit handling exists in Shipyard source today: Grep(`rate_?limit\|statusline\|statusLine\|rateLimits`, -i) over `plugins/delivery-pipeline/scripts`, `scripts`, `tests/unit` matches only `sentinel-preflight.cjs:36,97` (`gitStatusLines`, unrelated). The only settings writers are `scripts/install-shipyard-claude-hook.sh:29` (`SETTINGS="$CLAUDE_HOME/settings.json"`) and the reader `scripts/shipyard-doctor.cjs:214`. P44-A Claude collection is therefore net-new and must go through the supported installer, preserving and restoring a preexisting custom `statusLine` command. | Grep calls quoted | high |
| C-13 | The user's live statusline (`~/.claude/statusline.sh`, reading `rate_limits.five_hour/seven_day`) is outside this worktree and was not read. The evidence claim (IMPLEMENTATION-RESEARCH "Evidence" item 3, lines 31–33 of that script) is **unverified on this revision**. Development and tests must use isolated runtime homes; editing the user's active statusline is excluded. | Contract: "do not read paths outside it"; WORK-PACKAGES WP-B | assumption — next check: installed-host sample by the operator |
| C-14 | Codex `account/rateLimits/read` and sparse `account/rateLimits/updated` are known only from a locally generated 0.157.0 schema (RUNTIME-SPECIFIC-ADDENDUM §1, "Validation and limits"). Schema support is not proof of authenticated retrieval; no live snapshot may be claimed without a read-only installed-host check. Sparse updates must merge into the last snapshot; missing metadata does not erase previous metadata; `primary`/`secondary` must not be hard-coded as 5 h / 7 d. | RUNTIME-SPECIFIC-ADDENDUM §1 | medium (external doc + local schema; not rechecked here — no provider call allowed) |
| C-15 | The authenticated role host for arch-review exists only on Claude on this revision: `claude-role-host.cjs:945,947` scope `runtime: 'claude'`; Grep(`arch.?review\|role-host`, `codex-*.cjs`) → no matches. Phase 43 T-43-14 (pending) builds arch-review requests in `deliver-dispatch.cjs` "with Codex parity or a named reason" (ADR-020). P44-B's reuse key must include runtime, but its Codex adapter depends on whatever Codex arch-review path T-43-14 lands; until then P44-B Codex parity must be declared as a named gap, not faked. | Grep calls quoted; ADR-020 Decision bullet on `deliver-dispatch.cjs` | high (source) / medium (T-43-14 outcome) |
| C-16 | The reuse lookup seam is `createClaudeRoleHost().run()` at `claude-role-host.cjs:1219-1223`; evidence preparation `roleArtifact.prepareRoleArtifact(...)` at `:1250`. Reuse lookup must sit after authenticated preparation and before `:1250` (which can replace evidence). Evidence cited `:1090`; seam still holds at new lines. | Grep(`prepareRoleArtifact\(\|async run\(\|function createClaudeRoleHost`, claude-role-host.cjs) | high |
| C-17 | `recommendRotation` exists at `session-handoff.cjs:148` and the status integration at `:811`; it is advisory and forbids automatic transfer. P44-D must extend it, not add a second recommender or transfer manager. | Grep(`function recommendRotation`, session-handoff.cjs); ADR-019 Consequences ("Automatic threshold-driven session rotation is deferred") | high |
| C-18 | `orchestration-overhead.cjs:18` hard-codes `TREATMENT_KEYS = ['wait_events','bounded_context']`, `:19-20` values, `:98` `normalizeTreatment()`; `:535` requires a declared experiment boundary; `:570` report carries `experiment_id`. P44-G must add a versioned effort-experiment schema/report, not relabel effort as an existing treatment (evidence cited `:17`; still holds at `:18`). | Grep(`TREATMENT\|normalizeTreatment\|wait_events`, orchestration-overhead.cjs); Grep(`experiment\|shadow`, same) | high |
| C-19 | Bounded research handback is enforced: `workflows/investigation-research.mjs:46` (`maxLength: 500`), `:76-91,128` require `artifactContract: 'planning.v1'` and one `artifactPaths` entry per line, `:215` refuses a longer summary. P44-E must keep four lines, the `planning.v1` contract and the `shipyard.research-result.v1` sealer; it adds fact/source selection only. Evidence cited `:222`/`:205`; still holds at new lines. | Grep(`500\|artifactContract\|planning\.v1`, investigation-research.mjs) | high |
| C-20 | `context-packet.cjs` has no instruction-file handling (Grep(`instruction\|AGENTS\.md\|CLAUDE\.md`, -i) → no matches). P44-C cannot extend an existing instruction path in the packet builder; it needs a new coverage manifest consumed by the packet builder and by `gen-codex-shipyard.cjs` (which writes `developer_instructions` at `:312` and a fenced AGENTS.md auto-route block at `:320`). | Grep calls quoted | high |

### 2.3 Measurement semantics (P44-A, P44-D, P44-G)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| C-21 | No API-price or token-to-quota conversion; provider/account/bucket percentages are never added across providers; input/output/cache/reasoning are explanatory only. | PROBLEM.md "out of scope"; CONTEXT.md "Locked safety"; ADR-019 Out of scope ("Promising a fixed subscription-credit … saving from token totals") | high |
| C-22 | Concurrent uncontrolled usage, account switch, reset or decrease → discontinuity / inconclusive; never an attributed saving. | CONTEXT.md "Locked safety"; WORK-PACKAGES WP-A | high |
| C-23 | Count parent and child model work without double-counting CLI/transcript views; missing cache/reasoning detail is unavailable, not zero. Extend `usage-attribution.cjs` (1788 lines) / `usage-report.cjs` (976 lines) / `orchestration-overhead.cjs` (643 lines) rather than add another ledger. | ADR-019 REQ-156 and Consequences ("does not introduce another … accounting ledger"); `wc -l` loop | high |
| C-24 | 20 completions / 95 % attribution / seven-day defect window are the minimum evidence discipline, not proof of non-inferiority; one behavioural treatment at a time on matched runtime/model/effort/role. Efficiency stays inconclusive until matched cohorts exist; no fixed savings % is an acceptance condition. | ADR-019 Consequences; CONTEXT.md; PROBLEM.md "What success will be" | high |
| C-25 | Installed, behaviourally verified and efficiency-measured status are recorded separately; a source merge is not installation. | CONTEXT.md "Locked safety"; ADR-019 Consequences | high |

### 2.4 Approval semantics (P44-F)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| C-26 | `human_checkpoint` is the approval obligation; `preauthorized` records plan-time approval and "must never collapse into" human_checkpoint; `preauthorized` requires a checkpoint; high risk requires a checkpoint. P44-F adds a reason; it must not change who approves or merges. | `validate-graph.cjs:15,211-218,249-251,520-531` | high |
| C-27 | ADR-020 (F17 owner, delivered by pending T-43-12) changes `human_checkpoint` to accept `true|false|review|merge` and adds a projected `checkpoint: 'merge'|'review'|null` field in `tickets.json`/`tickets.yaml`; today `validate-graph.cjs:211` still reads `delivery.human_checkpoint === true` (so the change has not landed). P44-F's reason field must be designed against T-43-12's final shape and land after it; it must not reinterpret `review`/`merge` (those are merge semantics, not model signals). | ADR-020 Decision bullet 4; `.planning/phases/43-*/43-12-PLAN.md:4,35,45`; Grep on validate-graph.cjs | high |
| C-28 | Unknown and legacy checkpoints stay conservative (promote as today); no automated reinterpretation of existing checkpoints as administrative; activation needs the ADR-014 amendment plus observed-selection receipts on both native grids. | CONTEXT.md P44-F; IMPLEMENTATION-RESEARCH §6 | high |

## 3. Product constraints (flows that must not change)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| P-01 | Same acceptance contracts, required tests/CI and independent reviews; optimization never turns missing evidence green. | CONTEXT.md "Locked safety" | high |
| P-02 | A reused arch-review verdict: a reused violation still blocks; never carried across a changed base (changed-base carry is ADR-020/T-43-13); never satisfies a separately required cross-provider review; live gates are re-checked on a hit; unknown in-flight child → refuse, no duplicate launch. | CONTEXT.md P44-B; ADR-020 bullet 3; RUNTIME-SPECIFIC-ADDENDUM §6 | high |
| P-03 | Required instructions: no silent truncation, blanket omission, or reliance on Claude `.claude/rules` semantics in Codex; the pdffiller layout is a fixture, not authorization to edit six target repositories; no destructive instruction cleanup in target repos. | CONTEXT.md P44-C; PROBLEM.md out of scope | high |
| P-04 | Research keeps four independent lines, complete mandatory refs, critical primary-source rechecks and durable full artifacts. Reducing lines is deferred to a separately accepted design (phase 45 "Deferred"). | CONTEXT.md P44-E; phase-45 WORK-PACKAGES "Deferred" | high |
| P-05 | Automatic session transfer stays disabled; rotation is advisory/shadow only. | CONTEXT.md P44-D; ADR-019 Consequences | high |
| P-06 | Effort experiments are disabled by default; Claude Sonnet/high vs max is a candidate, not a new baseline; Codex first measures Luna/max; activation and promotion need their own recorded gate; infrastructure completion is not a saving. | CONTEXT.md P44-G; WORK-PACKAGES WP-I | high |
| P-07 | Excluded outright: blanket model downgrade, mandatory double-provider review, provider fallback, quota-based scheduler, new daemon, automatic limit-reset/credit operation, account mutation. | PROBLEM.md; CONTEXT.md "Exclusions" | high |
| P-08 | Target-project PRs carry no conveyor internals; `.planning/` is untracked in target projects (Shipyard repo exempt). Any P44 artifact that would be written into a target project must follow that hygiene. | ADR-017 Decision (PR hygiene bullet) | high |

## 4. Privacy of observation data (P44-A primarily; P44-B/E manifests)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| V-01 | Collector input is a strict whitelist (provider, account scope, surface, observed_at, bucket_id, window duration, resets_at, used_percentage, source, freshness, concurrency status); no raw prompts, transcripts or credentials persisted. | WORK-PACKAGES WP-A/WP-B; RUNTIME-SPECIFIC-ADDENDUM §1 envelope | high (as requirement) |
| V-02 | Account identity must be a scoped/opaque identifier, not an e-mail or token. Precedent: phase 45 R8 must rebuild the capture scrubber for `session_meta.creator_user_id` "and other account fields" — account identifiers already leaked into captures once. | phase-45 WORK-PACKAGES R8 | medium |
| V-03 | Storage location: `CLAUDE.md:126` says measurements go in existing `.planning` locations, but `.planning/` is **tracked** in the Shipyard repository (ADR-017 exemption), so per-account quota samples written there would be committed and pushed. Account-level samples should live in the private out-of-repo host state directory (ADR-017 point fix "the out-of-repo host state directory") with restrictive permissions; only derived, de-identified per-outcome joins belong in tracked reports. No `0o600`/mode handling exists in `usage-attribution.cjs` today (Grep(`stateDir\|0o600\|0o700\|mode:\s*0o`) → no matches), so this is new work. | CLAUDE.md:126; ADR-017 Decision; Grep quoted | medium (design inference) |
| V-04 | Credential boundary: Codex host strips API keys (`codex-runtime-host.cjs:993`); Claude host defines `CROSS_PROVIDER_CREDENTIAL_ENV = ['OPENAI_API_KEY','CODEX_API_KEY']` (`claude-runtime-host.cjs:43`). A Codex rate-limit reader must use the subscription login, never add an API key, and must not run inside a Claude worker's environment with Codex credentials. | Grep in §2.2 C-10 | high |
| V-05 | Collection must make no network call beyond the provider's own supported read, no model turn and no account mutation. | CONTEXT.md P44-A; WORK-PACKAGES WP-B/C | high |

## 5. File ownership, overlap with open phase-43 plans, and ordering

Ownership derived from `files_modified` in every `.planning/phases/4[0-3]-*/4*-PLAN.md` (awk extraction
over front matter) plus delivery state (S-2, S-3, S-5). Phase 40, 41 and 42 owners are merged; they
constrain *interfaces*, not scheduling. Pending phase-43 owners constrain scheduling: by analogy with
ADR-020's final bullet (a ticket sharing a file with a pending ticket of another phase waits through a
cross-phase dependency), each P44 ticket that shares a file with a pending T-43 ticket needs an explicit
cross-phase dependency on it. Phase-45 files are listed only to draw the boundary.

| Item | Files it would touch (existing unless marked new) | Merged prior owners (interface to respect) | Pending phase-43 plans on the same file → ordering | Phase-45 boundary |
|---|---|---|---|---|
| **P44-A** Claude | new `scripts/…/subscription-observation.cjs` + test; `scripts/install-shipyard-claude-hook.sh`; `scripts/shipyard-doctor.cjs`; `tests/smoke/claude-hook-smoke.sh`; `usage-attribution.cjs`, `usage-report.cjs` (+tests); generated `plugins/shipyard/` | T-40-21 (installer, doctor, hook smoke), T-40-05 (doctor, hook smoke), T-41-06 (usage-report, overhead) | none | D5 admission ledger consumes P44-A observations; P44-A must not build admission/scheduling |
| **P44-A** Codex | new read-only collector module; `scripts/install-shipyard-codex.sh` / `install-shipyard-marketplace.cjs` (if installed); must **not** change `codex-runtime-host.cjs` launch path | T-40-09, T-41-04, T-42-02 (codex-runtime-host), T-40-21 (installers) | none | R8 capture scrubber (`capture-boundary-fixtures.cjs`) is phase 45's |
| **P44-B** | new `review-reuse.cjs` + test; `claude-role-host.cjs` (+test); `role-artifact.cjs` (+test); `lock.cjs` (reservation); possibly `dispatch-record.cjs` | T-40-16, T-40-22, T-41-01, T-41-09 (claude-role-host); T-40-18 (role-artifact); T-40-14/22 (dispatch-record) | **T-43-05** (role-artifact), **T-43-06** (claude-role-host, role-artifact), **T-43-13** (gate-trailer/base-merge verdict carry — key must not implement carry), **T-43-14** (deliver-dispatch arch-review builder; defines Codex arch-review parity) → P44-B after all four | D4 drift-scan reuse shares "only a proven identity primitive" → P44-B owns and ships the primitive first; R3 (review next merge candidate) is phase 45's |
| **P44-C** | new coverage manifest + test; `skills/delivery-rules/SKILL.md` and `.shipyard/generated/gsd-delivery-rules/SKILL.md`; `references/*.md`; `commands/deliver.md` (only if needed); `scripts/gen-codex-shipyard.cjs` (+`gen-codex-shipyard.test.cjs`); `context-packet.cjs`; `CLAUDE.md` | T-40-20 (SKILL.md), T-40-11 (gen-codex test), T-40-24 (deliver.md), T-40-26 (CLAUDE.md) | **T-43-12** (delivery-rules SKILL.md ×2), **T-43-14** (deliver.md), **T-43-18** (`references/ci-fix.md`, `pr-sentinel.md`), **T-43-19** (`pr-sentinel.md`) → after them | D2 splits `deliver.md` and *consumes* P44-C rule IDs/manifest → P44-C must land before D2; P44-C must not split deliver.md |
| **P44-D** | `session-handoff.cjs`, `runtime-context.cjs`, `orchestration-overhead.cjs` (+`rotation-recommendation.test.cjs`, `session-handoff.test.cjs`) | T-41-02 (session-handoff, rotation tests), T-41-06 & T-40-18 (overhead + test) | none | R9 makes the `session-handoff` successor-race test deterministic → coordinate test-file edits; no scheduling dependency |
| **P44-E** | `context-packet.cjs`, `workflows/investigation-research.mjs`, `planning-result-sealer.cjs`, `claude-delivery-host.cjs`/`codex-decompose-host.cjs` (only if packet fields change), `commands/investigate.md`/`decompose.md`, `deliver-dispatch.cjs` (research builder) | T-40-10, T-40-13 (sealer, workflow, delivery host), T-40-11 (codex-decompose-host), T-40-25 (investigate/decompose.md) | **T-43-15** (deliver-dispatch planning builders; investigate.md, decompose.md), **T-43-11**, **T-43-12** (decompose.md), **T-43-16/17** (claude/codex-delivery-host) → after them | P5 aligns its source identities with P44-E → P44-E identity first |
| **P44-F** | ADR-014 amendment doc; `model-policy-internal.cjs` (+generated copy); `validate-graph.cjs`; `tests/smoke/graph-validator-smoke.sh`; `deliver-dispatch.cjs:90`; `claude-role-host.cjs:377`; `front.cjs`/`pipeline-stats.cjs` if they project the reason; `skills/delivery-rules/SKILL.md` (+generated); `model-policy.test.cjs`; regenerated Codex agents | T-40-20 (validate-graph), T-40-15 (deliver-dispatch) | **T-43-12** (validate-graph, graph smoke, front, pipeline-stats, SKILL.md, decompose.md — F17 checkpoint values), **T-43-14/T-43-15** (deliver-dispatch), **T-43-06** (claude-role-host) → strictly after T-43-12 | none |
| **P44-G** | new effort-experiment schema/report module + test; `orchestration-overhead.cjs` (reference only or versioned extension); `dispatch-record.cjs` (arm identity); `pipeline-config.cjs` only if a disabled flag is registered | T-41-06, T-40-18 (overhead); T-40-17 (pipeline-config) | **T-43-01**, **T-43-10** (pipeline-config) if a config key is added → after them | none |

Additional ordering constraints inside phase 44 (real data dependencies, from WORK-PACKAGES and the
constraints above):

1. P44-A contract (WP-A) precedes the Claude/Codex collectors, P44-D shadow cohorts and P44-G reporting.
2. P44-C rule identity precedes P44-E where required rules become source refs, and precedes P44-G (instruction digest is part of arm identity).
3. P44-F waits for T-43-12 (F17) and the ADR-014 amendment; P44-G's resolver activation (if any) waits for the same amendment path.
4. P44-B waits for T-43-05/06/13/14.

## 6. Claude/Codex parity and generated artifacts

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| G-01 | The Claude plugin and shared scripts are canonical; Codex skills/agents/payload are generated by `scripts/gen-codex-shipyard.cjs`; the marketplace package under `plugins/shipyard/` is generated and its `host/` copy is never edited directly. | `CLAUDE.md:6-7,73-81,123` | high |
| G-02 | Ticket PRs into `epic/*` (or stacked on `ticket/*`) do **not** regenerate `plugins/shipyard/` and CI skips its staleness check for them; regenerate once on the epic before the epic → main PR, where staleness is enforced. P44-F/G policy-hash changes therefore show up as generated drift only at the epic PR. | `CLAUDE.md:79-81` | high |
| G-03 | The runtime-file digest pin covers `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs`; changing either requires `make refresh-runtime-digests` and the printed commit trailer, which CI verifies. P44 items should avoid these files; if unavoidable (e.g. P44-G arm identity in the adapter), plan the trailer. | `node -e` over `tests/unit/runtime-file-digests.json` (2 keys); `CLAUDE.md:130-131`; ADR-017 last Decision bullet | high |
| G-04 | Both adapters must pass shared quality/identity contract scenarios with provider-native fixtures; boundary fixtures come from real producers via `make capture-fixtures BOUNDARY=…` and a contract test refuses inline shapes for registered boundaries. New host-facing shapes in P44-A/B/E must be captured, not hand-written. | CONTEXT.md "Completion criteria"; ADR-017 Decision bullet 1; `Makefile` `capture-fixtures` target | high |
| G-05 | Parity may be declared as a named gap only where a runtime lacks the host (C-15 Codex arch-review), never silently. | ADR-020 `deliver-dispatch.cjs` bullet ("Codex parity or a named reason") | high |

## 7. Test strategy per item (unit / fixture / installed-host)

Deterministic gate: `make test-fast` (= test-unit, graph, worktree, worktree-gates, gsd-sync, sentinel,
docs, hooks, comment-policy, model-ladder-runtime; `Makefile:58`) after each edit (`CLAUDE.md:56`);
`make test-codex-shipyard` for generator/installer changes (`Makefile:94`); release requires a fresh
`make test-live` receipt per runtime (ADR-017; `Makefile:107-109`). Every fix carries tests that fail on
base (ADR-020 last bullet sets this for phase 43; assume the same discipline — assumption, confirm with
the planner/checker rules).

| Item | Unit | Fixture / contract | Installed-host proof (cannot be done in CI) |
|---|---|---|---|
| P44-A | whitelist, fractional %, reset/decrease/account-change discontinuity, sparse-update merge, legacy alias dedup, missing windows, no model/network turn, private storage | isolated `CLAUDE_HOME` statusline wrapper through the installer (extend `tests/smoke/claude-hook-smoke.sh`); captured Codex app-server schema/notification fixtures | one interactive Claude statusline sample; one read-only authenticated Codex `account/rateLimits/read`; headless-worker coverage stated explicitly |
| P44-B | key completeness (head/base/plan/policy/instruction/model/effort/runtime/host-validator version each miss), altered/missing evidence refuses, violation reuse blocks, cross-provider review not satisfied | `claude-role-host.test.cjs` native-host contract; concurrency test with injected clock/barrier (not wall-clock — cf. phase-45 R9 flakiness in `dispatch-boundary`) for single-flight; new `review-reuse.test.cjs` | none required for correctness; Codex parity depends on T-43-14 |
| P44-C | manifest parse, duplicate-version detection, coverage check fails on a missing rule, no truncation | generated Codex agents/AGENTS.md block via `gen-codex-shipyard.test.cjs` and `make test-codex-shipyard`; pdffiller layout as a fixture only | effective loaded-source digests on both installed hosts (Codex 32 KiB project-doc budget behaviour is unverified — C-14 class) |
| P44-D | cohort matching on model/effort/policy/instruction; fork ≠ fresh; unchanged advice → no wake | extend `rotation-recommendation.test.cjs` (7 passing), `session-handoff.test.cjs` | shadow observations from real runs only |
| P44-E | changed source invalidates; contradictions force expansion; mandatory refs never dropped | `context-packet.test.cjs`, `investigation-research.test.cjs`, `claude-investigation-host.test.cjs`, sealer tests | one installed four-line investigation per runtime |
| P44-F | parser accepts reason × F17 values; unknown/legacy promote; administrative-only stays base (only after amendment); merge permission unchanged | `tests/smoke/graph-validator-smoke.sh`, `model-policy.test.cjs` (26 passing), `test-model-ladder-runtime` smoke, both-grid resolver matrix | observed-selection receipts on both native grids before activation |
| P44-G | schema versioning, disabled by default, arm identity, all repairs/escalations/failures counted, missing evidence → inconclusive, stop rule | `orchestration-overhead.test.cjs` (16 passing) or new report test | pilot only after recorded activation gate — outside phase acceptance |

## 8. Backward compatibility

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| B-01 | Historical dispatches/receipts are never relabelled; new policy applies only after rollout. | ADR-014 Consequences/Scope fences | high |
| B-02 | Legacy graph data: `human_checkpoint: true` keeps meaning `merge`; `preauthorized: true` keeps working (ADR-020); a missing P44-F reason must mean "unknown" → conservative promotion (C-28). `tickets.json`/`tickets.yaml` projections gain fields additively; P41-E projection fingerprints must stay correct (unrelated phase artifacts byte-identical). | ADR-020 bullet 4; ADR-019 REQ-155; `validate-graph.cjs:658-659,702-703` | high |
| B-03 | `shipyard.research-result.v1` / `shipyard.decomposition-result.v1` sealed envelopes and the `planning.v1` handback stay valid; P44-E adds optional, versioned index fields or a new versioned schema. | ADR-017 Decision (shared sealer); C-19 | high |
| B-04 | The orchestration-overhead report schema (`REPORT_SCHEMA`, `SCHEMA_VERSION` at `orchestration-overhead.cjs:570`) must be versioned, not mutated in place, for P44-G. | Grep in C-18 | high |
| B-05 | Statusline install/uninstall restores only owned settings and the preexisting custom command; renderer stdout and failure behaviour unchanged. | WORK-PACKAGES WP-B; IMPLEMENTATION-RESEARCH §1 | high (requirement) |
| B-06 | Deprecated config aliases follow D-45: registered in `pipeline-config.cjs`, `delivery_pipeline.*` wins, bad shapes warn and fall back. Any P44-G/A config key must follow it. | ADR-020 Consequences | high |

## 9. Delivery constraints (process)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| D-01 | No PLAN, ticket or global REQ ID may be materialized until an accepted ADR covers P44-A–G and the typed researcher/planner/checker artifacts plus the real `validate-graph` gate pass; ADR-019 covers phase 41 only. | PROBLEM.md; PLANNING-STATUS.md "Blocking formal decomposition"; ADR-019 Scope line | high |
| D-02 | Policy/authorization changes (P44-F activation, P44-G activation/promotion) are human checkpoints; high-risk tickets need `human_checkpoint` (`validate-graph.cjs:520-521`). | WORK-PACKAGES "Planner output required"; source | high |
| D-03 | Phase integration uses the normal post-merge independent integrator, not a duplicate ticket. | WORK-PACKAGES "Integration and rollout" | high |
| D-04 | Rollout order: metadata collection + instruction coverage → reuse/observation/index → typed policy/experiment infrastructure. | WORK-PACKAGES "Integration and rollout" | high |
| D-05 | Comment policy gate (`make test-comment-policy` → `publish-gate.cjs --working-tree`) blocks net-new free comments. | `Makefile:91-92` | high |
| D-06 | Phase 45 belongs to another session (INV-008); phase 44 may define primitives phase 45 consumes (P44-A observations, P44-B identity primitive, P44-C manifest, P44-E identity) but must not implement D1–D5, P1–P5, S1 or R1–R11. | RESEARCH-CONTRACT; phase-45 WORK-PACKAGES "Boundary and sequencing" | high |
| D-07 | Preserve unrelated worktree changes; this worktree has uncommitted `.planning/graph/delivery-front.json`, `dispatches.json` and untracked `.planning/graph/provenance/` from another actor. | gitStatus snapshot; `git diff --stat .planning/graph/` (2 files, 15+/5−) | high |

## 10. Uncertainties and unknowns (feed OPEN-QUESTIONS; not absorbed into prose)

- [ ] Is the committed delivery state authoritative for phase 43, given it is stale for phase 40 (S-3)? Re-run state-sync on the authoritative tree before assigning cross-phase dependencies — owner: repository maintainer / planning session.
- [ ] Which Codex arch-review path does T-43-14 land, and is P44-B's Codex adapter a named gap until then (C-15)? — owner: phase-43 owner.
- [ ] Final shape of T-43-12's `checkpoint` field and whether P44-F's reason is a sibling field or a value of it (C-27) — owner: phase-43 owner + maintainer (ADR-014 amendment author).
- [ ] Does the user's statusline still read `rate_limits.five_hour/seven_day` (C-13)? Outside the worktree; next check: operator runs the installed renderer sample — owner: repository maintainer.
- [ ] Does an authenticated Codex `account/rateLimits/read` succeed on the installed 0.157.x host with ChatGPT login (C-14)? Next check: read-only installed-host probe (not permitted in this investigation) — owner: repository maintainer.
- [ ] Effective Codex instruction-chain loading and byte budget on the launched host (P44-C) — owner: maintainer; recommend `/gsd-spike "measure effective Codex AGENTS.md chain and truncation on the installed host with a synthetic nested-rule fixture"`.
- [ ] Where may per-account quota samples be stored so they are never committed in the Shipyard repo (V-03)? — owner: maintainer.
- [ ] Is "every fix carries a test that fails on base" a repository-wide rule or phase-43-only (§7)? — owner: planner/checker rules owner.
- [ ] Does validate-graph support cross-phase dependency edges from phase 44 onto phase-43 tickets (assumed from ADR-020's final bullet)? Next check: `validate-graph.cjs` dependency parsing during planning — owner: planner.
- [ ] Will P44-G store arms in the canonical policy (forcing a policy-hash/regeneration cycle, C-04) or in a separate experiment registry resolved by the boundary? — owner: ADR author (alternatives line decides options).

## 11. Evidence-copy claims re-checked on this revision

| Evidence claim | Evidence file / section | Status on `bc127635` |
|---|---|---|
| `session-handoff.cjs:148` recommendRotation | IMPLEMENTATION-RESEARCH "Evidence" item 1 | holds (same line) |
| `investigation-research.mjs:222` 500-char handback | IMPLEMENTATION-RESEARCH item 2 | holds; now `:46`, `:215`, `:267` |
| `claude-role-host.cjs:1090` run() seam | IMPLEMENTATION-RESEARCH §2 | holds; now `:1219-1250` |
| `claude-role-host.cjs:359` checkpoint derivation | IMPLEMENTATION-RESEARCH §6 | holds; now `:377` |
| `model-policy-internal.cjs:156-193` checkpoint promotion | IMPLEMENTATION-RESEARCH §6 | holds; `:160-193`, logic `:635-643` |
| `model-policy-internal.cjs:119` Sonnet/max | IMPLEMENTATION-RESEARCH §7 | holds; now `:120` |
| `orchestration-overhead.cjs:17` two treatments | IMPLEMENTATION-RESEARCH §7 | holds; now `:18` |
| `codex-runtime-host.cjs:841` exec args | RUNTIME-SPECIFIC-ADDENDUM "Current evidence" | holds; now `:993-1007` |
| `codex-runtime-host.cjs:605-720` parent/child, `fork_turns: none` | RUNTIME-SPECIFIC-ADDENDUM | holds; `:581`, `:733`, `:790` |
| Overhead tests 8 passed | IMPLEMENTATION-RESEARCH "Validation" | superseded: 16 passed, 0 failed |
| Rotation tests 7 passed | phase-44 RESEARCH.md "Prior validation" | holds: 7 passed, 0 failed |
| `~/.claude/statusline.sh` lines 31-33 | IMPLEMENTATION-RESEARCH item 3 | not checked (outside worktree) |
| Codex 0.157.0 schema has rateLimits methods | RUNTIME-SPECIFIC-ADDENDUM §1 | not rechecked (no provider/host call allowed) |
| Codex decompose host lacks artifact sealing | PLANNING-STATUS "Blocking" | superseded in source by merged phase 40 (T-40-10/11/13); installed-host state not checked |
