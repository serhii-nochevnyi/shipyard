# INV-009 research line: system state (P44-A–G on revision bc127635)

- Line: `system-state`. Runtime: Claude, `claude-opus-5-5`/medium (the caller resolved it). Policy signals preserved as given: `{"type":"facts"}`.
- Source revision: `bc127635242959a3d6ff76c7d76e8ce456df512d` (`git rev-parse HEAD`). Policy hash: `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968` (ADR-014 `adr-014.v6`).
- Read-only. No product code was changed, no provider account API was called, and no model workload was launched. The only file written is this one.
- `.planning/codebase/` maps: none present. `ls .planning/codebase` returned nothing, so every seam below was found directly in the source.

## 0. Deployment state first: what is actually on this revision

| Fact | Command | Result |
|---|---|---|
| All of phase 40 is merged into HEAD and was released as 0.67.0 | `git log --oneline HEAD \| grep -E "T-40-\|0\.67\.0"` | T-40-01, 03–28 are present (including T-40-09 `6bc85ba0`, 2026-09-27 12:59). Release commit `0ce24f00 chore: release shipyard 0.67.0` is dated 2026-09-27 13:40:28 +0300 (`git log -1 --format='%h %ci %s' 0ce24f00`). `plugins/delivery-pipeline/.claude-plugin/plugin.json:4` reads `"version": "0.67.0"`. |
| Phases 41 and 42 are merged | node table over `.planning/graph/delivery-state.json` plus PLAN frontmatter | T-41-01…09 and T-42-01…03 show `merged`. |
| Phase 43 is mostly **not** delivered | same table, plus `git log --oneline HEAD..origin/epic/43-target-project-delivery-at-scale` | Only T-43-02 is merged (to the epic: `5c0d251f`). T-43-07 is `pr-open` (#266). Every other T-43 ticket is `pending`. Epic 43 is not merged into HEAD. The local ref was last updated 2026-09-27 19:31 +0300. The remote may be ahead; the next check is `git fetch && git log origin/epic/43-…`. |
| **Known wart:** the worktree's delivery-state projection is stale for phase 40 | same table | `delivery-state.json` still lists every T-40 ticket as `pending`, even though git history shows them merged. Do not use this projection for phase-40 status. |
| `main` local ref is stale | `git log -1 --format='%H %ci' main` → `22ef429b… 2026-09-26`; `git rev-parse origin/main` → `2af79f8d` (the parent of HEAD) | Several phase-43 plans cite line numbers "at 22ef429b". On HEAD, those lines have moved (details below). |
| Packaged mirror | `diff -q plugins/delivery-pipeline/scripts/{session-handoff,claude-role-host}.cjs plugins/shipyard/host/plugins/delivery-pipeline/scripts/…` → identical | `plugins/shipyard/host/…` is a committed copy that changes with releases (`git log -3 -- plugins/shipyard/host` → `1e814d91`, `f082ac7a`, `0ce24f00`). Any phase-44 source change must also refresh this copy. Which script generates it is **unknown**; the next check is `grep -rn "shipyard/host" scripts/ Makefile .github/`. |
| Installed hosts (`~/.codex/shipyard`, `~/.claude/plugins`, `~/.claude/statusline.sh`) | not inspected | Out of bounds: the contract forbids reading paths outside the worktree. `claude --version` failed with `operation not permitted`, and `codex --version` printed only a sandbox PATH warning. Installed versions are therefore **unknown** on this line. Captured-fixture identities: Claude `2.1.283` (`tests/fixtures/captured/boundaries/claude-stream.json`), Codex `0.157.1` (`…/boundaries/codex-agent-stream.json`). |

**Superseded claim in the preparation.** `PLANNING-STATUS.md` says the installed `codex-decompose-host.cjs` "accepts only gsd_role/prompt/signals/dispatch_id" and has no sealing. On HEAD, `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:16` imports `sealDecomposition`, and `:137` defines `sealResearchArtifact`. `codex-delivery-host.cjs:12` imports `sealResearch`/`verifySealedLine`, and `:597-680` seals investigation lines, including single-line re-dispatch at `:626-644`. These came from T-40-10/11/12/13, all merged. Found with `grep -n "seal\|artifact" …codex-decompose-host.cjs` and `grep -n … codex-delivery-host.cjs`. That source-level blocker is gone. Whether the **installed** host matches this source is still unknown (see above).

## 1. Baseline test state of the existing primitives (this revision)

Each suite was run as `node tests/unit/<name>.test.cjs` from the worktree root:

| Suite | Exit | Result |
|---|---|---|
| rotation-recommendation | 0 | 7 passed, 0 failed |
| orchestration-overhead | 0 | 16 passed, 0 failed. The preparation reported 8; phase 41 added 8 more. |
| usage-attribution | 0 | pass 59, fail 0 |
| usage-report | 0 | pass 42, fail 0 |
| context-packet | 0 | 11 passed, 0 failed |
| session-handoff | 0 | 16 passed, 0 failed |
| model-policy | 0 | 26 passed, 0 failed |
| investigation-research | 0 | 11 passed, 0 failed |
| claude-role-host | 0 | pass 44, fail 0 |
| role-artifact | 0 | 11 passed, 0 failed |
| gen-codex-shipyard | 1 | 89 passed, 5 failed. All 5 failures are installer cases, and the first shows `mktemp: mkdtemp failed on /var/folders/…/T/tmp.…: Operation not permitted`. That is this line's OS sandbox, not a product defect. Re-run outside the sandbox before treating it as a regression. |

These results cover existing primitives only. None of the P44 behaviour is implemented or tested.

## 2. Per scope item: current behaviour, what changed, which owner covers what

### P44-A — passive provider-specific subscription observation

**What exists**
- No source file parses subscription or quota data. `grep -rn -E "rate_limit_event|rateLimits|rate_limits" plugins scripts tests/unit` returned no matches (exit 0). A search across the whole repo, excluding `.planning`, for `rate_limit|rateLimit|statusline|five_hour|seven_day` matched only `docs/audits/2026-09-10-claude-usage*.{md,py}` and captured fixtures.
- No installer manages the Claude `statusLine` setting. The same grep found no `statusline` in `scripts/` or `plugins/`, so the proposed collector would need a new, reversible installer path (evidence WP-B). The user's `~/.claude/statusline.sh` could not be inspected on this line.
- `usage-report.cjs:4` states "All totals are processing units, never quota." It parses Claude usage fields (`:11`) and Codex `event_msg/token_count` plus `token_usage_record` (`:479-490`), but ignores `rate_limits`.
- `usage-attribution.cjs:1-17` is a correlation ledger. It deliberately stores no prompts or token totals. `:30` maps runtime to provider.
- `orchestration-overhead.cjs:410` `COHORT_KEYS = ['runtime','model','effort','role','account_scope']`, and `:205` accepts `account_scope`. An account-scope label already exists as a cohort dimension, but nothing collects it from a provider.

**New fact that corrects the evidence.** The hosts' own launch paths already receive quota data:
- **Claude headless:** `tests/fixtures/captured/claude-stream-executor.jsonl:8` and `claude-stream-research.jsonl:7`, produced by `claude --print --output-format stream-json` (CLI 2.1.283), contain `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":…,"rateLimitType":"seven_day","utilization":0.57,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.7,"resetsAt":…},"seven_day":{…}}}}`. The **units are a fraction (0–1)**, while the statusline documents `used_percentage`.
  - `claude-runtime-host.cjs:263-280` keeps every record but extracts only session/model/effort/usage/result. `rate_limit_event` is dropped.
  - This contradicts two statements: `RUNTIME-SPECIFIC-ADDENDUM.md` §1 ("Do not assume headless workers call this renderer") and `IMPLEMENTATION-RESEARCH.md` §1 ("Headless worker statusline coverage must be tested"). Headless workers do not call the renderer, but their stream does carry the windows.
  - Found with `grep -n -E "rate_limit" tests/fixtures/captured/*` and a node listing of record types.
- **Codex exec:** `tests/fixtures/captured/codex-agent-stream-parent.jsonl:16,23,29` and `…-child.jsonl:18,22` are `event_msg`/`token_count` records (Codex 0.157.1). They carry `"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":1.0,"window_minutes":10080,"resets_at":…},"secondary":null,"credits":{…"balance":"0"},"plan_type":"prolite","rate_limit_reached_type":null}`.
  - **`primary` is the 7-day window (10080 min) here and `secondary` is null.** This confirms the addendum's warning that primary/secondary must not be hard-coded as 5h/7d.
  - The record also carries `credits` and `plan_type`, which are account data a whitelist must exclude or treat as sensitive.
  - `codex-runtime-host.cjs:250` counts `turn.completed` for the `exec --json` stdout. The native session transcript (`token_count`) is read by `usage-report.cjs:479`. Neither reads `rate_limits`.
  - Found with `grep -n -o -E '.{0,100}rate_limit.{0,250}' tests/fixtures/captured/codex-agent-stream-parent.jsonl`.
- **Consequence for the factual unknown "authenticated Codex rate-limit snapshot availability":** the existing subscription-login `codex exec` path (`codex-runtime-host.cjs:1002-1008`, `forced_login_method="chatgpt"`, `--ignore-user-config`) already produces rate-limit snapshots in the transcript. No app-server integration is needed to observe them. The addendum's `account/rateLimits/read` / `account/rateLimits/updated` remain **unverified** on this line; no schema generation or account call was made. Transcript snapshots only arrive during model turns, so they cannot give an idle before/after baseline without a read-only snapshot. That limit is an **assumption**; check it with an installed-host read-only call.

**What phases 40–43 changed:** T-40-07 and T-40-08 (merged) added the scrubbed capture harness and the real Claude stream fixture. That is how the rate-limit records above now exist in the repo. T-41-06 (REQ-156, merged; `41-06-PLAN.md` frontmatter) joins deduplicated **token** usage to verified outcomes in `usage-report.cjs`/`orchestration-overhead.cjs`.

**Coverage by existing owners:** T-41-06 covers outcome joins and cohort readiness. It does **not** cover quota windows, reset identity or account discontinuity. No ticket in phases 40–43 touches quota. Phase 45 consumes P44-A and does not own it (`45-…/CONTEXT.md:13,27`).

### P44-B — exact-input architecture-review reuse and single-flight

**Current Claude flow (`claude-role-host.cjs`):**
- `ROLES` `:30`; `ARCH_EVIDENCE='.shipyard-arch-review-evidence.md'` `:36`.
- `prepareArch` `:437-470` collects the live PR (`:441-445`), base/merge-base/merge-base tree (`:446-449`), the exact diff (`:450`), plan and ADR refs (`:451-453`, `sourceReferences` `:363-368`), and `reference_digest` (`:462`). It builds the packet (`:464`), signals (`:465`) and prompt (`:466`).
- `observedSignals` `:371-387` derives `risk`, `critical`, `checkpoint` (`:377`, from `row.human_checkpoint === true`) and `contested` (`:378`, from the **live** `reviewDecision === 'CHANGES_REQUESTED'`), plus `inputTokens`. A caller signal that disagrees is refused with `SIGNAL_MISMATCH` (`:381-385`).
- `run()` `:1223-1318`:
  - fresh `runId`/`dispatchId`/`ownerId` (`:1228-1230`)
  - `dispatch-record.recordInflight` (`:1245`, the pid+TTL in-flight record from T-40-14; `dispatch-record.cjs:1503`)
  - **`roleArtifact.prepareRoleArtifact` at `:1250-1251`, before dispatch**
  - dispatch (`:1254`)
  - the exactly-one-launch assertion `:1265` ("boundary did not perform exactly one authenticated model launch")
  - live-input revalidation `:1268`, validate `:1269`, seal `:1270` (`sealResult` `:1206-1217`)
  - result context: `policy_hash`, `packet_digest`, `selected_refs`, `model`, `effort` (`:1293-1302`)
- `role-artifact.cjs`:
  - `prepareRoleArtifact` `:894` **unlinks the existing evidence file** (`:927`).
  - `sealJudgment` `:1821` archives evidence, findings and the manifest under a per-dispatch directory. `ARTIFACT_ARCHIVE_DIR='.shipyard-role-artifacts'` (`:35`); `archivePath(worktree, dispatchId, …)` `:947`.
  - Sealed artifacts are therefore immutable per dispatch and indexed by **dispatch ID, not by input identity**. No lookup exists from input identity to a prior sealed verdict.

**Confirmed from the evidence:**
- `IMPLEMENTATION-RESEARCH.md` §2 ("reuse lookup after authenticated preparation but before `prepareRoleArtifact()`") still holds. The seam has moved from `:1090` to `:1227-1250`.
- `:1265` currently **refuses any outcome other than exactly one launch**. A reuse hit therefore needs an explicit new result variant (launched vs reused). It cannot slip through the current path.

**Codex side:** arch-review has no dedicated role host.
- `grep -c arch-review plugins/delivery-pipeline/scripts/codex-*.cjs` → 0 in every Codex file.
- `commands/deliver.md:1183` routes Claude arch-review to `claude-role-host.cjs` and Codex arch-review to `codex-delivery-host.cjs --args-file` "with the typed role".
- `codex-delivery-host.cjs` `requestValue` `:61-86` accepts only `role`, `signals`, `context`, `dispatch_id` and `gsd_role`, and takes **signals from the caller**. `validateArgs` `:89-96` resolves policy from those signals. No graph-derived signals, PR/diff binding or judgment sealing exists for Codex arch-review here.
- A shared reuse contract therefore has no equivalent Codex preparation seam today. Any Codex P44-B work either builds that seam or refuses reuse on Codex.

**Reuse-key completeness (factual unknown).** These inputs demonstrably affect the Claude verdict or its selection:
- PR number, head and head tree
- live base name and commit, merge-base and merge-base tree, integration-base tree, exact diff
- plan content and acceptance; ADR refs, excluded and unresolved refs
- `reference_digest` (the reviewer reference content, `claude-reference-content.cjs`)
- packet digest and selected backlog IDs
- signals, including **live `contested`** and `inputTokens`, because both change the rung (`model-policy-internal.cjs:193-195`: Claude arch-review `critical` on critical/checkpoint/contested, `ceiling` on inputTokens > 250000)
- `policy_hash`, applied model and effort, and the host identity (`HOST_IDENTITY` in the result `:1294`)

Not bound anywhere today: installed host/validator version beyond `HOST_IDENTITY`, and project instruction digests (see P44-C). This inventory comes from reading `:437-470`, `:371-387` and `:1293-1302`. Whether any **other** input reaches the prompt still needs an exhaustive diff of `makePrompt`/`buildPacket` (owner: the P44-B planner).

**What phases 40–43 changed and who covers what:**
- T-40-14 (merged): in-flight record. It is liveness metadata only, with no deduplication.
- T-43-13 (REQ-161, **pending**, high risk, `human_checkpoint: true`, `preauthorized: true`) owns **changed-base carry** in `gate-trailer.cjs`/`base-merge.cjs`, using patch-id identity (`43-13-PLAN.md:1-60`; ADR-020 line 30). It does not cover same-input reuse or single-flight. P44-B must not carry across a changed base, per its CONTEXT.
- T-43-05 (pending) edits `role-artifact.cjs` (unknown arch finding types stay informational).
- T-43-06 (pending) edits `claude-role-host.cjs`, `role-artifact.cjs` and `codex-delivery-host.cjs` (the scratch set). Both are file-ownership collisions that P44-B must be ordered after.
- T-43-14 (pending) adds `deliver-dispatch build arch-review`. Its plan requires a Codex refusal of the form `codex has no role host for arch-review` if the host role set does not accept it (`43-14-PLAN.md:40`).
- Phase 45 D4 (drift-scan exact-input reuse) is a sibling pattern, owned by phase 45.

### P44-C — mandatory instruction coverage per runtime

**What exists:**
- No rule-ID or coverage manifest. `grep -n -i "rule_id\|coverage manifest\|\.claude/rules\|project_doc\|instruction_digest" plugins/delivery-pipeline/scripts/*.cjs scripts/*` found only `review-signature.cjs:31` (a review-finding field, unrelated) and `codex-runtime-host.cjs:887`.
- **Codex native child:** `codex-runtime-host.cjs:876-891` refuses unless the child's developer messages contain the installed GSD agent `instructions` exactly once (`RUNTIME_EVIDENCE_MISMATCH`), and records `agent_file_digest` and `agent_instructions_digest` (`:886-887`). This verifies the **role** instructions only, not the project AGENTS.md chain.
- **Codex project chain is observable:** `tests/fixtures/captured/codex-agent-stream-parent.jsonl:7` (and the child fixture) contains a user `response_item` starting `"# AGENTS.md instructions\n\n<INSTRUCTIONS>\n<!-- shipyard-auto-route:begin -->…"`. The installed Codex does inject its AGENTS.md chain into the transcript, so loaded content is observable passively. No code extracts or digests it (`grep -o 'AGENTS\.md'` counts: parent 3, child 3; exec 0).
- The launch uses `--cd <worktree> --ignore-user-config` (`codex-runtime-host.cjs:1007`). Global `config.toml` (for example `project_doc_max_bytes`) is not applied. The effective project-doc byte limit on the launched host is therefore Codex's built-in default, which is **unverified**; the next check is an installed-host run on a >32 KiB AGENTS.md fixture.
- **Claude headless:** the stream `system/init` record (`claude-stream-executor.jsonl`, record keys listed by node) carries `tools, agents, skills, plugins, …` but **no memory/CLAUDE.md path list**. The fixture has no CLAUDE.md evidence (`grep -c CLAUDE.md` = 0). Claude loaded-instruction evidence is not available from the stream on this CLI; it may exist in the session transcript, which is **unknown**. Next check: an installed Claude transcript inspection.
- **Generation:**
  - `scripts/gen-codex-shipyard.cjs:1-25` generates Codex skills and agents from the canonical Claude plugin: skills `:268-291`, agent `developer_instructions` `:312`, route block `:320`, per-skill digests `:373-378`.
  - `scripts/install-shipyard-codex.sh:40,613` writes the auto-route block into global `$CODEX_HOME/AGENTS.md`.
  - `scripts/shipyard-doctor.cjs:318-329` checks that block.
  - No target-repository instruction coverage exists anywhere.

**Coverage by existing owners:**
- ADR-019 "Out of scope" excludes "a full instruction-document rewrite" (`ADR-019-…md:50-55`).
- Phase 45 D2 "stage/runtime delivery instruction loading" (`45-…/CONTEXT.md:21`) is the nearest sibling. Phase 45 states that phase 44 owns "mandatory instruction coverage" (`:27`).
- No phase 40–43 ticket covers P44-C. T-43-12 edits both delivery-rules copies (`plugins/delivery-pipeline/skills/delivery-rules/SKILL.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md`). Those are likely inputs to any rule inventory, and edits to them must be ordered after T-43-12.

### P44-D — rotation advice on comparable measurements

**What exists (`session-handoff.cjs`):**
- `recommendRotation` `:148-233`:
  - a phase-boundary path `:150-161`
  - five comparable `ordinary_input` passes, each more than 2× the prospective startup median `:163-232`
  - `comparableKey` `:78-80` and `hasComparableDimensions` `:82-85` use **only role, backend and runtime**. Model, effort, policy and instruction identity are not compared.
- `recommendationResult` `:112-130` sets `advisory: true`, a deterministic `recommendation_id = digest(stable(identity))` (`:119`), and `automatic_transfer` `unsupported/allowed:false` (`:126`). The ID is deterministic, but nothing persists or deduplicates recommendations.
- Status integration `:473-486` runs only with `includeEvidence`, fed by the caller's observations. The CLI consumer is documented at `commands/deliver.md:872-897` (`session-handoff.cjs status … --overhead-file <project>/.planning/graph/orchestration-overhead.jsonl --phase-boundary … --runtime …`).
- `HANDOFF_COST_STAGES` (`:258`, also `orchestration-overhead.cjs:27`) is `checkpoint_collection`, `successor_startup`, `cache_warmup`.
- `runtime-context.cjs:280-350` `reportTransferCapability` always returns `status:'unsupported'`, `confidence:'unproven'`, `automatic_transfer.allowed:false`. Even usable proof is recorded as `'unproven'` (`:311`), and `reviewed_host_adapter_contract` plus `real_proving_ground_run` are always missing (`:321-322`).
- No resume / history-copying fork / compaction / fresh-start classification exists. `grep -n "fork\|compact" session-handoff.cjs` shows only the refusal text.

**Confirmed from the evidence:**
- `IMPLEMENTATION-RESEARCH.md` §3 (`:148`, `:473`, comparison groups role/backend/runtime only) still holds verbatim.
- The count of seven rotation tests still holds (see §1).

**Coverage by existing owners:**
- T-41-02 (REQ-152, merged; `files_modified: session-handoff.cjs, tests/unit/session-handoff.test.cjs, tests/unit/rotation-recommendation.test.cjs`) owns bounded checkpoint, successor and ownership.
- T-41-03 (merged) owns stop and wake.
- ADR-019 `:45` defers automatic threshold-driven rotation.
- Not covered by any owner: comparable cohort identity, advice deduplication, shadow outcome recording, and lifecycle-kind classification. That is P44-D's residual scope.

### P44-E — research fact/source index and selective synthesis

**What exists:**
- `context-packet.cjs`:
  - research role requires `problem_statement` and `source_refs` (`:29`)
  - `DEFAULT_TOKEN_CEILING = 12000` (`:19`)
  - `buildContextPacket` `:385-500`: required refs always carry content and are deduplicated by path (`:398-410`); a ref cannot be both required and optional (`:414`)
  - on overflow, only **optional** content is omitted, with a `content_ref` (`:460-480`); `packet.overflow.required_preserved: true` (`:486-491`); the validator refuses omitted content without overflow (`:520`) and stale overflow markers (`:616-618`)
  - Content selection is file-level. No claim/fact granularity, range digest or provenance per claim exists.
- `workflows/investigation-research.mjs`:
  - `REQUIRED_LINES = ['system-state','alternatives','constraints','risks']` (`:22`)
  - exactly four lines, or one for a verified re-dispatch (`:101-104`, `:161-170`)
  - summary ≤ 500 characters (`:46`, `:215-216`)
  - accepted result keys include `artifact_ref`, `artifact_path`, `artifact_digest`, `artifact_index` and `evidence_index` (`:207`)
  - `claude-dispatch-adapter.cjs:153-211` validates `evidence_index`/`findings_index`/`artifact_index` as **file-level artifact references** that must equal the envelope. They are not a claim index.
- Sealing: `planning-result-sealer.cjs` is shared (T-40-10). Codex research sealing lives in `codex-delivery-host.cjs:597-680` (T-40-12), and single-line re-dispatch at `:626-644` (T-40-13).

**Confirmed from the evidence:**
- `IMPLEMENTATION-RESEARCH.md` §4 (`context-packet.cjs:385`, `investigation-research.mjs:205`) still holds. `:205` is now `:207`.
- "Bounded research handbacks already exist" still holds.

**Coverage by existing owners:**
- Phase 40 (merged) owns sealing and line re-dispatch.
- T-41-01 (REQ-151, merged) owns judgment-launch measurement and governing-ref preservation.
- T-43-15 (pending) adds research and decomposition request builders and edits `deliver-dispatch.cjs`, `commands/decompose.md` and `commands/investigate.md`, so P44-E prose edits to `investigate.md` must be ordered after it.
- Phase 45 P5 "exact-revision INV reuse and stable research reporting" (`45-…/CONTEXT.md:20`) is the nearest sibling. P44-E must not implement whole-INV reuse.
- Phase 45 declares adaptive 1/2/4 fan-out unauthorized (`:29`), which preserves P44-E's four lines.

### P44-F — typed administrative versus technical checkpoint reasons

**Where the checkpoint signal is produced today (all boolean, with no reason):**
- Claude judgment roles: `claude-role-host.cjs:377` `checkpoint: rows.some(row.human_checkpoint === true)`. `:178` requires `human_checkpoint` to be a boolean on graph rows.
- Executor and dispatch builder: `deliver-dispatch.cjs:87-93` `buildSignals`, with `checkpoint = true` when `row.human_checkpoint === true` (`:90`).
- Codex delivery host: the **caller supplies** the signals (`codex-delivery-host.cjs:61-86`). Graph derivation for Codex happens only through `deliver-dispatch` (T-40-15 merged, and T-43-14/15 pending for the other roles).
- Name collision: `failure-signature.cjs:190` emits `checkpoint: exhausted && …` inside `shipyard.resource-state.v1`. That is a budget-exhaustion meaning, separate from the model-policy signal. `run-contract.cjs:20-40` also uses `human_checkpoint` as a run **state**. A typed reason must name which checkpoint it qualifies.

**Where the signal is consumed:** `model-policy-internal.cjs` (`POLICY_VERSION='adr-014.v6'` `:26`):
- `CODEX_ROLE_SIGNAL_RULES` `:155`: `checkpoint:true` promotes decomposition `:160`, integrator `:163`, arch-review `:166` and executor `:178` to `critical`.
- `CLAUDE_ROLE_SIGNAL_RULES` `:183`: arch-review critical on critical/checkpoint/contested `:193`; the other roles share the Codex rules (`:184-192`).
- The same data appears in the authenticated context-packet policy (`runtime_signal_rules`).
- The stale-policy refusal `:888-889` means any rule change changes `POLICY_HASH` and requires the canonical ADR-014 amendment. The evidence's `:156–193` still holds, shifted by one line.

**Graph schema today (`validate-graph.cjs`):**
- `human_checkpoint: delivery.human_checkpoint === true` `:211`. Any non-`true` value, such as `review`, silently becomes false. This is the fail-open that T-43-12 fixes.
- `preauthorized` `:218` (type-checked `:249-251`).
- high risk requires a checkpoint `:520-521`; preauthorized requires a checkpoint `:527-531`
- projections `:658-659` (JSON) and `:702-703` (YAML)
- T-43-12 cites these same checks at `:164/:171/:462-463/:469-473` "at 22ef429b". **Those line numbers are stale on HEAD** and the planner must re-read them.

**F17 checkpoint interface (factual unknown), answered from source and plans:**
- The approval-semantics owner is **T-43-12** (REQ-162, ADR-020 line 31; `43-12-PLAN.md`: `pending`, risk high, `human_checkpoint: true`, wave 13).
- It depends on T-43-08, T-43-11 and phase-40 tickets that are now merged.
- It keeps `human_checkpoint` boolean (true for `review`/`merge`/`true`) and adds a **new projected field `checkpoint: 'merge'|'review'|null`** to `tickets.json`/`tickets.yaml`.
- It edits `validate-graph.cjs`, `front.cjs`, `sentinel.cjs`, `pipeline-stats.cjs`, `commands/decompose.md` and both delivery-rules copies.
- Consequences for P44-F:
  - (a) P44-F's input field must be designed on top of T-43-12's tri-state and ordered after it.
  - (b) The planned graph field name `checkpoint` collides in name with the model-policy signal `signals.checkpoint`. The reason field needs a distinct name.
  - (c) T-43-12 does not touch `model-policy-internal.cjs`, `claude-role-host.cjs:377` or `deliver-dispatch.cjs:90`. Model promotion stays boolean after T-43-12, and P44-F still owns only the signal-to-model contract.
- F18 (remedies) is T-43-18 (pending) and is out of P44-F's scope.

### P44-G — disabled-by-default native effort experiment harness

**What exists:**
- `orchestration-overhead.cjs`:
  - `DEFAULT_MIN_COMPLETED = 20`, `DEFAULT_ATTRIBUTION_TARGET = 0.95` (`:16-17`)
  - `TREATMENT_KEYS = ['wait_events','bounded_context']` with values `baseline|opt-06` and `baseline|opt-07` (`:18-22`)
  - `normalizeTreatment` rejects unknown dimensions (`:98-116`, `:108`)
  - `COHORT_KEYS` include **`effort`** (`:410`). Two arms that differ in effort land in *different cohorts* and can never form a matched pair (`matchedCohorts` `:421-443` requires same cohort and exactly one differing treatment key).
  - The readiness report requires a declared `experiment_boundary` (`:535`), a matched cohort (`:538`), ≥20 completions (`:543-544`) and a seven-day defect window (`:545`); `experiment_id` appears at `:570` and `:617`.
- Effort therefore cannot be expressed as a treatment today. The evidence claim (`IMPLEMENTATION-RESEARCH.md` §7, `:17`) still holds, and more strongly than stated.
- Baselines: Claude executor `sonnet/max` (`model-policy-internal.cjs:120`); Codex executor `luna/max` (packet policy `role_rungs.codex.executor`). The effort vocabulary is `['low','medium','high','xhigh','max']` (`pipeline-config.cjs:126`).
- Supported pairs:
  - Codex: `scripts/gen-codex-shipyard.cjs:38-60` builds them at generation time from `codex debug models` (`supported_reasoning_levels`).
  - Claude: `model-capability.cjs:19,33,126` checks `supported_efforts` from a host snapshot.
  - The **actual supported pairs on the installed hosts are unknown** from source. Next check: installed `codex-capabilities.json` and the Claude host capability snapshot.
- No experiment assignment, arm identity or promotion code exists. `grep -rn -i experiment plugins/delivery-pipeline/scripts/*.cjs` matched only the `orchestration-overhead.cjs` boundary fields and one comment in `pipeline-config.cjs:682`.

**Coverage by existing owners:** ADR-014 owns the grid. Phase 41 and 42 preserve it. No ticket in phases 40–43 adds an effort experiment.

## 3. Factual unknowns from phase-44 RESEARCH.md: status after this line

| Unknown | Status | Evidence / next check |
|---|---|---|
| Final shared-file owners after phases 40/42/43 | **Partly closed.** Phases 40–42 are merged, so their files are free. These pending phase-43 tickets overlap phase-44 seams: T-43-05 (`role-artifact.cjs`); T-43-06 (`claude-role-host.cjs`, `role-artifact.cjs`, `codex-delivery-host.cjs`); T-43-11 (`decompose.md`); T-43-12 (`validate-graph.cjs`, delivery-rules `SKILL.md` ×2, `decompose.md`); T-43-14 (`deliver-dispatch.cjs`, `deliver.md`); T-43-15 (`deliver-dispatch.cjs`, `decompose.md`, `investigate.md`); T-43-16 and T-43-17 (`codex-delivery-host.cjs`). | node scan of `43-*-PLAN.md` frontmatter against the P44 file list, joined with `delivery-state.json`. Re-run after phase 43 merges. The worktree projection is stale for phase 40, so confirm statuses with `git log origin/epic/43-…`. |
| Effective Codex instruction loading on the launched host | **Partly closed.** The AGENTS.md chain is injected and visible in the native transcript (fixture parent `:7`). Role developer instructions are verified exactly (`codex-runtime-host.cjs:876-891`). User config is ignored (`:1007`). The effective byte limit and nested-directory loading are **unknown**. | installed-host run on a fixture repo with an AGENTS.md larger than 32 KiB and a nested AGENTS.md |
| Authenticated Codex rate-limit snapshot availability | **Partly closed.** Snapshots already arrive in `token_count.rate_limits` during subscription `exec` turns (fixtures, Codex 0.157.1). Primary is 10080 min and secondary is null for plan `prolite`. The idle-time `account/rateLimits/read` is **unverified**. | read-only installed app-server call (owner: maintainer, on a real account) |
| Exact review-key completeness | **Partly closed.** Claude input inventory is in §P44-B. Live `contested` and `inputTokens` change the rung, so they must be in the key. Codex has no arch-review preparation seam. | exhaustive review of `makePrompt`/`buildPacket` inputs; decide the Codex arch-review host in coordination with T-43-14 |
| F17 checkpoint reason interface | **Closed as to owner and shape.** T-43-12's `checkpoint: merge\|review\|null` plus boolean `human_checkpoint` (pending). Model promotion stays boolean. | re-read after T-43-12 merges |
| Supported experimental effort pairs and eligibility | **Open.** Baselines and vocabulary are known. Installed supported pairs are not readable from this line. | installed capability snapshots for both hosts |

## 4. Evidence claims rechecked against this revision

- REPORT/IMPLEMENTATION-RESEARCH: "rotation recommendation exists at `session-handoff.cjs:148`" — **holds**.
- "Bounded research handbacks exist at `investigation-research.mjs:222`" — **holds** (now `:207`/`:215`/`:266`).
- "Seam `claude-role-host.cjs:1090`" — **moved** to `:1223-1250`. The logic still holds.
- "`model-policy-internal.cjs:156–193` / `:119`" — **holds**, shifted to `:155-193` / `:120`.
- "`orchestration-overhead.cjs:17` two treatments" — **holds** at `:18`. Overhead tests now number 16, not 8.
- "`codex-runtime-host.cjs:841` exec launch / `:605–720` parent-child" — **moved**: exec args are now at `:1002-1008`. The flags `--ignore-user-config`, `forced_login_method="chatgpt"` and API-key stripping (`:991-999`) hold.
- "`codex-delivery-host.cjs:309–332` finalizes only executors; research sealing absent" — **superseded** by T-40-12 (`:597-680`).
- PLANNING-STATUS "codex-decompose-host lacks sealing" — **superseded** at source level (`:16`, `:137`).
- Addendum "do not assume headless workers call this renderer" — true, but **incomplete**: headless Claude streams carry `rate_limit_event` with fractional utilization.
- Addendum "Codex 0.157.0" — the captured fixtures are **0.157.1**.
- Target-scale "phase 42 F6/F17/F18" — **reconciled**: that work became phase 43 (INV-007, ADR-020). F6 is T-43-13, F17 is T-43-12, F18 is T-43-18 (`43-CONTEXT.md:3`), all pending.

## 5. Known warts relevant to decomposition

1. The worktree `delivery-state.json` shows phase 40 as pending even though it is merged. Graph gating or overlap checks run against it would be wrong.
2. The local `main` ref is stale (`22ef429b`). Phase-43 plans cite line numbers from it.
3. `plugins/shipyard/host/…` mirror copies need refreshing for any source change, and the producer is unknown.
4. The name `checkpoint` is used for four things: the policy signal, T-43-12's planned graph field, the resource-state flag and a run state.
5. Codex arch-review signals come from the caller, not from the graph, so a Codex-side reuse key or reason signal has no trusted source yet.
6. The rate-limit units differ: Claude stream `utilization` is 0–1, the Claude statusline uses `used_percentage`, and Codex uses `used_percent`. Codex `credits.balance` and `plan_type` sit in the same object.

## 6. Spikes recommended (not performed)

- `/gsd-spike "extract rate_limit_event and token_count.rate_limits from captured fixtures into a whitelisted observation envelope"` to confirm field stability across CLI versions.
- `/gsd-spike "Codex exec on a fixture repo with a >32KiB root AGENTS.md and nested AGENTS.md; digest the injected '# AGENTS.md instructions' message"`.

## Commands run (all from the worktree root, read-only)

`git rev-parse HEAD`; `git log --oneline HEAD | grep …`; `git log --oneline HEAD..origin/epic/43-target-project-delivery-at-scale`; `git branch -r | grep epic/43`; `git log -1 --format=… 0ce24f00`; node frontmatter/delivery-state scans of `.planning/phases/4[0-3]-*/4*-PLAN.md`; `grep`/`sed`/Read on each cited file; `node tests/unit/<suite>.test.cjs` for the eleven suites in §1; `diff -q` on the packaged mirror. Two probes were blocked by the sandbox and are recorded above: `claude --version` and an installed-home read.
