# Phase 44 (first pass: P44-A, P44-D, P44-G): Optimize subscription efficiency per runtime - Research

**Researched:** 2026-09-27
**Source revision:** `29803ee329747293ae49a677c187d2064f1b378a` (worktree `plan44-decompose`)
**Domain:** Node.js CommonJS deterministic scripts (no dependencies), bash installers, host transcript parsing, private host state
**Confidence:** HIGH for code seams and file ownership (every seam was read this session); MEDIUM for the statusline wrapper's host contract (the Claude Code statusline input and settings shape could not be read or fetched in this sandbox)
**Scope:** REQ-176..REQ-184 only. P44-B, P44-C, P44-E and P44-F are out of scope for this pass.

## Summary

INV-009 already located every seam at `bc127635`. This pass goes one level deeper at `29803ee3`. The main results:

1. **`usage-report.cjs` does not discover transcripts.** It reads only explicit paths (`parseCli` `:889-906`, `main` `:949`). Quota parsing therefore needs a separate pass over the same `sources` array, not an edit inside the token accumulator. The accumulator deliberately **skips** the Codex `event_msg/token_count` rows that carry `rate_limits` whenever the file also has `token_usage_record` rows (`:484`), and both captured Codex native fixtures have such rows. Parse inside that loop and the Codex quota records are silently dropped.
2. **`usage-report.cjs` is bundled into the Claude Stop hook.** `session-observer.cjs:8` requires it, and `tests/smoke/claude-hook-smoke.sh:61` asserts `usage-report.cjs` is in the bundle. The hook swallows exceptions (`session-observer.cjs:401-404`). So a throw in the new quota code would silently drop the token observations that the hook records. A top-level warning would flip `comparable` to false (`usage-report.cjs:840`). Quota parsing must be total, must report into its own `subscription_usage.warnings`, and any new dependency must be a literal relative `require('./…cjs')` so the hook bundler copies it.
3. **Captured fixtures already carry every worker quota shape** (Claude `claude-stream-executor.jsonl:8`, `claude-stream-research.jsonl:7`; Codex `codex-agent-stream-parent.jsonl:16,23,29`, `codex-agent-stream-child.jsonl:18,22`). They also show two traps. Codex `used_percent: 1.0` means 1 %, while a Claude `utilization` of `0.7` means 70 %, so units can never be inferred from magnitude. And the Codex `resets_at` values jitter by one second between parent and child (`1791047413` vs `1791047414`), so a strict equality check on the reset would invent discontinuities. **No fixture exists for the statusline input**, and `capture-boundary-fixtures.cjs` has no statusline boundary (`:185-188`). The statusline ticket has to start with a human capture step.
4. **Orchestration-overhead observation ids are digests of the whole dimensions object** (`orchestration-overhead.cjs:228-230`). If new dimensions (`instruction_digest`, `lifecycle_class`) are added as keys with `null` values, every existing row gets a new id and idempotent re-recording breaks. They must be added only when present.
5. **No producer of `instruction_digest` exists yet.** After P44-D, `recommendRotation` will correctly return `unknown` for all current evidence. That is the ADR-mandated behaviour, and the plan and tests must state it.
6. **None of the eleven proposed new files or eleven proposed edited files appear in any unmerged plan's `files_modified`.** This was checked programmatically against every `.planning/phases/*/*-PLAN.md` and the statuses in `.planning/graph/delivery-state.json` (already state-synced by `3c9b0bd1`). The CONTEXT avoid-list is broader than the actual phase-43 `files_modified` (for example `install-shipyard-claude-hook.sh` and `runtime-context.cjs` appear only in plan bodies), and it is still honoured.

**Primary recommendation:** Eight tickets in four waves:
- P44-A: an envelope module, `usage-report` integration, a private store, the statusline collector, and the statusline installer.
- P44-D: the comparable key, then shadow decisions with lifecycle costs.
- P44-G: an effort-experiment module.

All are extensions or new files; no runtime host, resolver, policy or pending phase-43 file is touched.

<user_constraints>
## User Constraints (from CONTEXT.md)

The phase CONTEXT.md has no `## Decisions` / `## Claude's Discretion` / `## Deferred Ideas` headings. Its `<decisions>` block and "Out of scope" section are copied verbatim below.

DATA_Kq83vTzn_START

### Locked Decisions

## Locked decisions for this pass (ADR-021 "Decision")

- **D-A1 (REQ-176)** The usage reader parses the quota records the hosts already save: Claude `rate_limit_event` records in the host transcripts (`~/.local/state/shipyard/claude/<key>/transcripts/*.jsonl`; `rate_limit_info.unifiedWindows.five_hour|seven_day`, `utilization` as a fraction 0–1; captured shape in `tests/fixtures/captured/claude-stream-executor.jsonl:8`) and Codex `event_msg/token_count` `rate_limits` in the native transcript (`limit_id`, `primary`/`secondary` with `used_percent`, `window_minutes`, `resets_at`; captured in `tests/fixtures/captured/codex-agent-stream-parent.jsonl:16,23,29`). It produces one whitelisted envelope. `claude-runtime-host.cjs` and `codex-runtime-host.cjs` are NOT changed; no process is started and no call is made.
- **D-A2 (REQ-177)** The interactive Claude parent session is observed by a reversible statusline wrapper with its OWN supported installer entry point (a new script plus a `make` target), not `scripts/install-shipyard-claude-hook.sh` (pending T-43-03 edits it). It buffers stdin once, forwards identical bytes to the preexisting renderer command, never changes the renderer's stdout or exit status (collector failure is invisible), and on uninstall restores only the settings it owns. Tests use isolated homes; the user's active `~/.claude/statusline.sh` and `settings.json` are never edited by development or tests. The statusline input carries `rate_limits.five_hour|seven_day.used_percentage` (percent).
- **D-A3 (REQ-178)** The envelope keeps provider, account label, bucket id, window, reset, used percentage normalized per source (Claude stream fraction → percent; statusline and Codex already percent), source, freshness and a concurrency status. It never maps `primary`/`secondary` to 5 h / 7 d by position (Codex `prolite` reports `primary` = 10080 min, `secondary` = null), never sums across provider, account or bucket, and a reset, a decrease, an account-label change or unknown concurrent usage is a discontinuity or an inconclusive result.
- **D-A4 (REQ-179)** Idle Codex baselines and the Codex parent session are recorded as `unverified`. No app-server client, daemon, model turn, account mutation, API key or limit-reset operation.
- **D-A5 (REQ-180)** Per-account samples live in private host state under `~/.local/state/shipyard/<runtime>/subscription/` (files 0600, directories 0700, bounded retention). Tracked reports carry only derived per-outcome and per-cohort values. No prompt, transcript excerpt or credential is stored. `.planning/` is tracked in this repository, so samples must never be written there.
- **D-A6 (REQ-181)** An account is identified by an operator-declared local label per runtime home (for example `claude-max-1`). A missing label makes the observation `unattributed`. E-mail, user id, Codex `credits` and `plan_type` are never stored (a negative fixture proves it).
- **D-D1 (REQ-182)** Rotation advice stays in `recommendRotation` (`plugins/delivery-pipeline/scripts/session-handoff.cjs:148-233`). `comparableKey` (`:78-80`, today role/backend/runtime) adds model, effort, policy hash and instruction digest; a mismatch yields `unknown`. One shadow decision is recorded per (recommendation id, source-state fingerprint) — no model wake for unchanged advice. Resume, history-copying fork, compaction and fresh start are separate classes whose costs include checkpoint collection, successor startup, rereads and cache warmup (`HANDOFF_COST_STAGES`, `:258`). `automatic_transfer.allowed: false` and T-41-02's ownership invariants are unchanged. Quota columns come from D-A1..A3 when present. Files: `session-handoff.cjs`, `orchestration-overhead.cjs` and their tests only; `runtime-context.cjs` is NOT edited (pending T-43-03 and T-43-07 edit it).
- **D-G1 (REQ-183)** Effort experiments get a versioned schema and report: eligibility rules, metrics that count failed, repair, escalation and abandoned work, and a promotion rule that is always a recorded human decision above the 20-completion / 95 % attribution / seven-day floor. No resolver, policy object, config key or dispatch change; nothing is active. The existing `TREATMENT_KEYS` (`orchestration-overhead.cjs:18`) and report schema are not mutated — a new versioned schema is added. Effort is a cohort key today (`:410`), so arms that differ in effort cannot be treated as a matched treatment pair; the schema must express that explicitly. Claude Sonnet/high vs max is a candidate, not a baseline; Codex arms are defined only after a Luna/max baseline (installed Codex supports `gpt-6-luna` low..max).
- **D-X1 (REQ-184)** Each item records installed, behaviourally verified and efficiency-measured states separately; every report says `inconclusive` until matched cohorts exist; no acceptance criterion contains a savings percentage.

## Planning constraints (INV-009 research, binding)

- Extend `usage-report.cjs` / `usage-attribution.cjs` / `orchestration-overhead.cjs`; do not add another ledger (ADR-019). `usage-report.cjs:836-839` has the `subscription_usage: null` slot; `:479-490` already reads Codex `token_count`.
- New host-facing shapes come from captured fixtures (`make capture-fixtures`), not hand-written shapes; the existing captured files already contain the records above.
- Codex artifacts are generated: if a plan touches the canonical plugin, it notes that `make package-shipyard-codex` runs on the epic, not per ticket.
- Avoid `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs` (runtime-file digest pin).
- No PLAN in this pass may list a file that a pending phase-43 ticket lists in `files_modified` (Gate 2 rejects unordered shared paths across phases). Known pending-43 files to avoid: `install-shipyard-claude-hook.sh`, `runtime-context.cjs`, `tests/smoke/docs-smoke.sh`, `claude-hook-smoke.sh` (T-43-02 merged, but keep the wrapper's smoke separate), `claude-role-host.cjs`, `role-artifact.cjs`, `validate-graph.cjs`, `deliver-dispatch.cjs`, `pipeline-config.cjs`, `commands/*.md`, the delivery-rules skills. The checker must verify every listed file against `.planning/phases/43-*/43-*-PLAN.md`.
- README: a new `make` target named in `README.md` is checked by `tests/smoke/docs-smoke.sh` automatically; the plan edits README only, not the smoke.
- Comment policy: `make test-comment-policy` blocks net-new free comments.
- Verification commands per plan: `node`, `bash` or `make` only (host allowlist), scoped to the plan's files; `make test-fast` belongs to CI, not the plan's verification list.

### Claude's Discretion
No section by that name in CONTEXT.md. Implementation details not fixed above (module names, envelope field names, store layout, retention bounds, ticket slicing) are the planner's, and this research recommends them. ADR-021 scope line: "Implementation details belong to its plans."

### Deferred Ideas (OUT OF SCOPE)

## Out of scope for this pass

P44-B arch-review reuse, P44-C instruction coverage, P44-E research index, P44-F `checkpoint_reason` (second pass, after the phase-43 epic merges; their contracts are fixed in ADR-021). Everything in ADR-021 "Out of scope". Phase-45 work (INV-008).

DATA_Kq83vTzn_END
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md:184-192) | Research support |
|----|-------------|------------------|
| REQ-176 | The usage reader parses Claude `rate_limit_event` and Codex `token_count.rate_limits` into one whitelisted envelope, without changing either host, starting a process or making a call | §P44-A seams: separate pass over `sources` in `report()` (`usage-report.cjs:378`), with the `:484` skip pitfall. Fixture lines are quoted below. Tickets T-44-01 and T-44-02 |
| REQ-177 | A reversible Claude statusline wrapper with its own installer: stdin buffered once and forwarded byte-identical, output and exit unchanged, uninstall restores only owned settings | §Statusline wrapper and installer: mirrors the patterns in `install-shipyard-claude-hook.sh` (`CLAUDE_HOME` `:27`, node-heredoc settings merge `:98-129`, `--remove` `:132-144`) without editing it. Tickets T-44-04 and T-44-05 |
| REQ-178 | Envelope fields; no positional primary/secondary mapping; no cross-provider/account/bucket sums; reset, decrease, label change or unknown concurrency is a discontinuity or inconclusive | §Envelope design: bucket identity, a reset tolerance (from the fixture jitter), per-source units, and the `concurrency: 'unknown'` default. Ticket T-44-01 |
| REQ-179 | Idle Codex baseline and Codex parent recorded as `unverified`; no app-server, daemon, turn, mutation, API key or reset op | Coverage constants in the envelope module, plus a static test that the new modules require no `child_process`, `net`, `http`, `https` or `dgram`. Tickets T-44-01 and T-44-02 |
| REQ-180 | Private samples under `~/.local/state/shipyard/<runtime>/subscription/` (0600/0700, bounded retention); only derived values tracked; no prompt, excerpt or credential | §Private store: explicit modes, because `lock.cjs` `writeAtomic` sets none (`:363-369`); refusal inside any git worktree or `.planning`. Ticket T-44-03 |
| REQ-181 | Operator-declared label per runtime home; missing → `unattributed`; e-mail, user id, `credits`, `plan_type` never stored | Label map keyed by the runtime-home realpath digest. Negative fixture from the Codex parent `session_meta.creator_user_id` and `rate_limits.credits/plan_type`. Tickets T-44-01 and T-44-03 |
| REQ-182 | Rotation compares model, effort, policy hash and instruction digest (mismatch → unknown), one shadow decision per id and fingerprint, lifecycle classes with full costs, automatic transfer disabled | §P44-D: `comparableKey` `:78-80`, `hasComparableDimensions` `:82-85`, the startup filter `:186-187`, and `recordLifecycleCost` `:732-760`, which drops model and effort. Tickets T-44-06 and T-44-07 |
| REQ-183 | Versioned effort-experiment schema and report; eligibility; metrics count failed, repair, escalation and abandoned work; promotion only as a recorded human decision above 20 / 95 % / 7 days; nothing active | §P44-G: a new `effort-experiment.cjs`. The automatic `promote` verdict in `orchestration-overhead.cjs:554-555` and `optimization-report.cjs:242-249` must not be reused. Ticket T-44-08 |
| REQ-184 | Installed, behaviourally verified and efficiency-measured recorded separately; `inconclusive` until matched cohorts; no savings percentage in any acceptance criterion | Reuses the existing tri-state pattern (`orchestration-overhead.cjs:562-568`). Every new report carries `status` and `verdict: 'inconclusive'`. The plan-checker scans acceptance text. All tickets |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Canonical implementation is `plugins/delivery-pipeline/`. Codex artifacts are generated. `plugins/shipyard/host/` is never edited directly; `make package-shipyard-codex` runs once on the epic before epic → main (CLAUDE.md "Architecture"). `package-shipyard-codex.cjs:20-23` copies the whole `plugins/delivery-pipeline` tree, so new modules are mirrored automatically on the epic.
- Shell scripts use `set -euo pipefail` and validate preconditions early.
- Keep generated state and measurements in the existing `.planning` locations. **Exception by ADR-021 / D-A5:** per-account quota samples must NOT go to `.planning` (tracked, D-07).
- Preserve unrelated worktree changes.
- Update `README.md` when a supported command or installation flow changes (the statusline installer does).
- Change the runtime-file digest pin only via `make refresh-runtime-digests`. The pin covers exactly `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs` (`tests/unit/runtime-file-digests.json`, read this session). Neither is edited in this pass. Importing a constant from them read-only does not change their digest.
- "When adding a rule, add a focused unit or fixture test with it." Mode is `--tdd`: every ticket writes its failing test first and shows it failing on base.
- ADR-014 boundary: no change to the resolver, policy, grids or `POLICY_HASH`. No experiment flag becomes launch authority.

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Rationale |
|------------|-------------|----------------|-----------|
| Parse quota records from saved transcripts | Deterministic script layer (`subscription-observation.cjs`, pure) | `usage-report.cjs` (read-only aggregation) | The hosts already save the records; the reader never launches anything (D-A1) |
| Parent-session statusline observation | Host-side Claude config (`$CLAUDE_HOME/settings.json` `statusLine`) | Collector script bundled under `$CLAUDE_HOME/shipyard-statusline/` | Only the interactive parent renders a statusline (R-A5) |
| Per-account sample persistence | Private host state `~/.local/state/shipyard/<runtime>/subscription/` | — | `.planning/` is tracked (D-07) |
| Account labelling | Operator declaration (private state) | — | No provider account identifier is read (D-08) |
| Rotation advice and shadow decisions | `session-handoff.cjs` (advisory) | `orchestration-overhead.cjs` (cost rows) | ADR-019 / C-17: one recommender |
| Effort-experiment protocol | New `effort-experiment.cjs` (schema + report only) | `orchestration-overhead.cjs` rows (read-only input) | D-03: no resolver or policy change; the existing `TREATMENT_KEYS` stay closed |
| Codex parent / idle baseline | none (recorded `unverified`) | — | D-A4 / R-A5 |

## Standard Stack

No external packages. The repository ships no `node_modules` (`tests/unit/assert-harness.cjs:3-4`: "The repo ships no node_modules").

| Component | Version | Purpose | Evidence |
|-----------|---------|---------|----------|
| Node.js built-ins (`node:fs`, `node:path`, `node:crypto`, `node:os`, `node:child_process` for the wrapper only) | Node v24.10.0 on this host | All new modules | `node --version` → `v24.10.0` [VERIFIED: local probe] |
| `lock.cjs` `withLock`, `acquire` | in-repo | Serialize store appends and shadow-decision appends | `lock.cjs:376` exports `{ withLock, acquire, writeAtomic, lockDirFor, sleepSync, DEFAULT_TTL_MS, OWNERLESS_GRACE_MS }` [VERIFIED: lock.cjs:376] |
| bash | 3.2.57 (macOS system bash) | Installer and smoke | `bash --version` → `GNU bash, version 3.2.57(1)-release` [VERIFIED: local probe]. New scripts must be bash-3.2 compatible: no associative arrays, `mapfile` or `${x,,}` |
| Test harnesses | in-repo | `tests/unit/assert-harness.cjs` (`suite/test/done/assert`) or `node:test` (used by `usage-report.test.cjs:2`) | Both styles exist; follow the style of the file being extended |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed in this pass, so no legitimacy check was run.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| — | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Current Seams (read this session at `29803ee3`)

### usage-report.cjs (976 lines)

- `report(sources, options)` `:378-887`. `sources` is `[{ source, rows }]`. It does not read files itself.
- Token accumulator loop `:414-541`. The Codex branch at `:478-484`:

DATA_r4Tn9wQe_START
```js
      } else if (
        (row.type === 'event_msg' && row.payload?.type === 'token_count')
        || row.type === 'token_usage_record'
      ) {
        const rowSession = row.payload?.session_id || row.sessionId || row.session_id || session;
        if (rowSession) session = rowSession;
        if (row.type === 'event_msg' && (hasCurrentCodexUsage || currentCodexSessions.has(rowSession))) continue;
```
DATA_r4Tn9wQe_END
  [VERIFIED: usage-report.cjs:478-484]. The `rate_limits` object sits on those skipped `event_msg` rows (`payload.rate_limits`). `grep -c token_usage_record` gives parent 3 and child 2, so the skip applies to both native fixtures [VERIFIED: local grep].
- The return object `:834-886` includes:

DATA_b8Xp1mVa_START
```js
    schema_version: 2,
    units: 'tokens processed; not subscription quota',
    subscription_usage: null,
    usage_rows: usageRows,
```
DATA_b8Xp1mVa_END
  [VERIFIED: usage-report.cjs:835-838]. `comparable: uniqueWarnings.length === 0` is at `:840`.
- CLI: `parseCli` `:889-906` accepts positional transcript paths plus `--attribution` and `--outcomes`, and rejects any other `--option` (`:901-902`). `main` requires at least one explicit path (`:949`). The help text at `:945` says "Read-only; explicit transcript, attribution and outcome files only. JSON to stdout; no prompts or quota estimates."
- Exports `:976`: `{ report, findAttribution, attributionIndex, findOutcome, outcomeIndex }`.
- Documented consumer: `docs/usage-report.md:78` "`subscription_usage: null`: local transcripts do not prove a subscription". This must be updated when the slot is filled.
- Bundled consumer: `session-observer.cjs:8` `const usageReport = require('./usage-report.cjs');`. `observe()` `:341-351` uses only `report.observations` and maps them through the explicit whitelist in `recordFor` (`:43-94`). New top-level report keys therefore never reach the tracked `session-observations.jsonl`. The hook path `:396-405` swallows exceptions (`try { result = observe(transcript, graph); } catch { return 0; }`).

### usage-attribution.cjs (1788 lines)

- The ledger is `usage-attribution.jsonl` in the graph dir (`:27`), which is tracked. It stores correlation facts only (`:4-9`). **Recommendation: do not edit it in this pass.** No REQ-176..184 behaviour needs a new attribution field. The account label rides on the envelope and on overhead `account_scope` (below). This keeps the ledger out of the private-data path.

### orchestration-overhead.cjs (643 lines)

- `TREATMENT_KEYS = Object.freeze(['wait_events', 'bounded_context'])` [VERIFIED: :18]; `DEFAULT_MIN_COMPLETED = 20`, `DEFAULT_ATTRIBUTION_TARGET = 0.95` [VERIFIED: :16-17]; `REPORT_SCHEMA = 'shipyard.orchestration-overhead-report.v1'` [VERIFIED: :14].
- `HANDOFF_COST_STAGES = new Set(['checkpoint_collection', 'successor_startup', 'cache_warmup'])` [VERIFIED: :27]. `STAGES` `:23-26` also has `'parent_reingestion'`. No stage represents successor **rereads**.
- `COHORT_KEYS = Object.freeze(['runtime', 'model', 'effort', 'role', 'account_scope'])` [VERIFIED: :410]. `matchedCohorts` `:421-443` pairs only arms that differ in exactly one `TREATMENT_KEYS` key inside one cohort. Two effort arms therefore land in different cohorts and are never compared. `COHORT_KEYS` and `matchedCohorts` are **not exported** (`:629-635`).
- `normalizeObservation` `:168-238` builds `dimensions` explicitly, so unknown input fields are dropped. The observation id is:

DATA_c2Wd6yHs_START
```js
  const observationId = raw.observation_id === undefined || raw.observation_id === null
    ? digest({ ...dimensions, sequence: raw.poll_sequence === undefined ? null : safeInteger(raw.poll_sequence, 'poll_sequence') }).slice(0, 48)
    : text(raw.observation_id, 'observation_id');
```
DATA_c2Wd6yHs_END
  [VERIFIED: :228-230]. `account_scope` already exists (`:205-206`); nothing fills it today.
- Stream: `.planning/graph/orchestration-overhead.jsonl` (`STREAM_NAME` `:13`, CLI default graph `:599-600`). It is tracked and may carry labels, but never samples.
- Report tri-state `:562-568` (`status: { implemented, installed, behaviorally_verified, efficiency_measured }`). The verdict becomes `'promote'` automatically when nothing is missing (`:554-555`). P44-G must not inherit this.
- `recordHandoffCost(recorder, value)` `:321-331` refuses any stage outside `HANDOFF_COST_STAGES`.

### session-handoff.cjs (1097 lines)

- `comparableKey` (role, backend, runtime) [VERIFIED: :78-80]:

DATA_h5Jm0pLc_START
```js
function comparableKey(row) {
  return [row.role, row.backend, row.runtime].map((value) => String(value || '')).join('\u001f');
}
```
DATA_h5Jm0pLc_END
- `hasComparableDimensions` `:82-85` requires the same three to be non-empty and not `'unknown'`.
- `recommendationResult` `:112-129`: `recommendation_id: digest(stable(identity))`, where `identity = { state, basis, evidence, comparison }` (`:114,122`); `automatic_transfer: Object.freeze({ status: 'unsupported', confidence: 'unproven', allowed: false, side_effect: 'none' })` (`:126`).
- `recommendRotation` `:148-233`: the phase boundary short-circuits (`:151-161`); it needs ≥ 5 ordinary passes (`:177-178`); startup rows are filtered by `comparableKey` (`:186-187`); the threshold is 2× the startup median (`:203`). Nothing is persisted.
- Callers: `publicScopeState` `:473-480` (only with `includeEvidence`), `controller.recommendRotation` `:811-812`, the CLI `status|inspect` `:1064-1077` (`--measurements-file`/`--overhead-file`), and tests `rotation-recommendation.test.cjs:143-178`, `gen-codex-shipyard.test.cjs:350`.
- `HANDOFF_COST_STAGES` duplicated at `:258`. `recordLifecycleCost` `:732-760` forwards only `run_id, dispatch_id, role, runtime, backend, policy_hash, treatment, stage, bytes, estimated_tokens`. **It does not forward model, effort or instruction digest**, so the handoff cost rows could never satisfy the stricter key.
- Store root is `<git-common-dir>/shipyard/ownership` (`ownershipStorePath` `:319-325`). It is untracked and repository-scoped, so it is a suitable parent for shadow decisions.
- `statusCapability` `:246-256` lazily requires `runtime-context.cjs`. This is read-only use and stays unchanged.

### Where host transcripts live (usage-report never discovers them)

| Producer | Path | Contains quota? | Evidence |
|---------|------|------------------|----------|
| Claude role hosts (arch-review etc.) | `~/.local/state/shipyard/claude/<sha(runId\0worktree)>/transcripts/<run>-<session>.jsonl` | yes, `rate_limit_event` (raw `stream-json` stdout) | `claude-role-host.cjs:951-957,962-964`; `claude-runtime-host.cjs:573-592` (file name `${safeRun}-${safeSession}.jsonl` at `:579`, mode `0o600` at `:582`) [VERIFIED] |
| Claude delivery host | `~/.local/state/shipyard/claude/<identity>/transcripts/` | yes | `claude-delivery-host.cjs:120,135` [VERIFIED: grep + read of path expression] |
| Claude decompose/research host | `~/.local/state/shipyard/claude-decompose/<key>/transcripts/` | yes | `claude-decompose-host.cjs:177,219`. **The runtime directory is `claude-decompose`, not `claude`**; D-A1's glob misses it |
| Claude runtime host default (no `transcriptDir`) | `<worktree>/.planning/graph/transcripts/claude` | yes | `claude-runtime-host.cjs:834-836` (the reader must never write here) |
| Codex exec stdout copies | `~/.local/state/shipyard/codex/<identity>/transcripts/` | **no** (`codex-agent-stream-exec.jsonl` has 0 `rate_limit` matches) | `codex-delivery-host.cjs:574-580,1018`; `codex-runtime-host.cjs:496,1083` |
| Codex native rollout | `$CODEX_HOME/sessions/YYYY/MM/DD/*-<session>.jsonl` | yes, `event_msg/token_count.rate_limits` | `codex-runtime-host.cjs:364-366` (`sessionDirectory`), `:394-396` (`CODEX_HOME` default `~/.codex`, `sessions`) [VERIFIED] |
| Interactive Claude parent | not a Shipyard file; statusline stdin only | percent via statusline | INV-009 host check (`~/.claude/statusline.sh:31-41`); not readable in this sandbox |

**Recommendation:** keep `usage-report`'s explicit-path contract. The operator passes globs (`~/.local/state/shipyard/claude*/*/transcripts/*.jsonl`, `$CODEX_HOME/sessions/**/*.jsonl`). Automatic discovery would widen what a read-only reporter can reach and is not required by REQ-176.

### Captured fixtures with quota records

- `claude-stream-executor.jsonl:8` (and `claude-stream-research.jsonl:7`, same payload, different uuid):

DATA_z1Fk6uBn_START
```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1790884800,"rateLimitType":"seven_day","utilization":0.57,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.7,"resetsAt":1790457600},"seven_day":{"utilization":0.57,"resetsAt":1790884800}}},"uuid":"<SESSION-9>","session_id":"<SESSION-3>"}
```
DATA_z1Fk6uBn_END
  [VERIFIED: fixture line read]. The row has **no timestamp**. The top-level `rateLimitType/utilization/resetsAt` duplicates the `seven_day` unified window, so it must be deduplicated rather than counted as a third bucket.
- `codex-agent-stream-parent.jsonl:16` (`:23`, `:29` identical `rate_limits`; child `:18`, `:22`):

DATA_n6Gv3sYd_START
```json
"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":1.0,"window_minutes":10080,"resets_at":1791047413},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"prolite","rate_limit_reached_type":null}
```
DATA_n6Gv3sYd_END
  [VERIFIED: fixture read]. The child records carry `"resets_at":1791047414` (a 1-second jitter against the parent's `1791047413`) [VERIFIED: grep of both fixtures]. Line 1 of the parent's native body (`session_meta`) carries `"creator_user_id":"<USER-ID>"`. That is the natural negative fixture for REQ-181.
- Boundary registry: `tests/fixtures/captured/boundaries/claude-stream.json` and `codex-agent-stream.json`. `boundary-fixtures.test.cjs:74-103` fails a test file that matches a registered `inline_shapes` regex, unless it is listed in `migrating` or is a registered `consumer` that reads a fixture path. Neither registry has a pattern for `rate_limit_event` or `rate_limits` today, and no unit test mentions `rate_limit` (grep: only `token_count` in `usage-report`/`usage-attribution` tests).
- The capture tool (`scripts/capture-boundary-fixtures.cjs`) has `BOUNDARIES` = `'claude-stream'` and `'codex-agent-stream'` only [VERIFIED: :185-188]. `--dry-run --input <file>` writes a scrubbed fixture for a registered boundary (`:204,224-230`). The scrubber replaces home and tmp paths, tokens and UUIDs (`:20-65`). It does **not** remove `credits` or `plan_type`, so the whitelist, not the scrubber, is the privacy control.

### Installer, doctor and make patterns to mirror (no edits to them)

- `scripts/install-shipyard-claude-hook.sh`:
  - `CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"`, `SETTINGS="$CLAUDE_HOME/settings.json"` (`:27-29`).
  - Argument loop with `--remove` (`:45-54`).
  - `command -v node` precondition (`:56`).
  - Settings edited only through `node - <<'NODE'` heredocs that read, mutate one key and rewrite JSON (`drop_hook` `:98-113`, `add_hook` `:116-129`).
  - `copy_stop_bundle` copies the literal relative-require closure into a temp dir, then `node --check` → smoke-run → `mv` into place (`:180-274`).
  - Removal deletes only its own files (`:132-144`).
- `Makefile:29-33` pairs `install-shipyard-claude-hook` / `remove-shipyard-claude-hook` in `.PHONY` (`:15-18`). `test-fast` is a target list (`:60`). Smokes are `./tests/smoke/<name>.sh` targets (`:88-89`).
- `scripts/shipyard-doctor.cjs:214-240` reads settings and checks exact hook command strings. **Do not extend the doctor in this pass:** its behavioural test lives in `tests/smoke/claude-hook-smoke.sh` (the only file referencing `shipyard-doctor`), which CONTEXT keeps separate. Give the new installer a read-only `--check` mode instead.
- `tests/smoke/docs-smoke.sh:62-63` checks that every `make <target>` in README exists in the Makefile.
- Comment policy covers `.cjs` (c-like) and `.sh` (hash) (`comment-policy.cjs:18,23`). Only `@invariant:`, `@security:` and `@contract:` markers are allowed (`:9`), and shebangs are exempt (`:54`). **New scripts must contain no free comments** (the existing installer's prose comments predate the gate).

### Tests layout

- `tests/unit/run.sh` runs `node --check` on every script (`:14-20`) and then **globs** `tests/unit/*.test.cjs` (`:33-36`). New unit files need no registration.
- Baseline (run this session): usage-report 42/42, orchestration-overhead 16/16, rotation-recommendation 7/7, session-handoff 16/16, boundary-fixtures 19/19, usage-attribution 59/59, all exit 0 [VERIFIED: local run].
- Captured-fixture loader pattern: `capturedLines(rel)` asserts line 1 is `shipyard_fixture` provenance and drops it (`claude-runtime-host.test.cjs:40-44`).
- Smokes are standalone bash files using isolated `CLAUDE_HOME`/`HOME` temp dirs (for example `claude-hook-smoke.sh:124` checks removal).

## Architecture Patterns

### System Architecture Diagram

```
                ┌───────────────────────── saved by hosts (unchanged) ─────────────────────────┐
 Claude worker  │ ~/.local/state/shipyard/claude*/<key>/transcripts/*.jsonl  (rate_limit_event) │
 Codex worker   │ $CODEX_HOME/sessions/Y/M/D/*.jsonl   (event_msg/token_count.rate_limits)      │
                └───────────────┬───────────────────────────────────────────────────────────────┘
                                │ explicit paths (operator)
                                ▼
 usage-report.cjs report(sources, {accountLabels}) ──► token accumulator (unchanged)
                                │
                                └─► subscription-observation.fromTranscriptRows(rows, ctx)  [pure, total]
                                        │  whitelist → envelope v1 (provider, account_label|unattributed,
                                        │  bucket_id, window_minutes, resets_at, used_percent, source,
                                        │  observed_at|freshness, concurrency)
                                        ▼
                                  seriesSummary(envelopes) → subscription_usage (derived only:
                                  per-bucket first/last/delta, discontinuities, verdict 'inconclusive',
                                  coverage {codex_parent:'unverified', codex_idle_baseline:'unverified'})
                                        │
                                        ├─► stdout JSON (no raw rows, no credits/plan_type/user id)
                                        └─► session-handoff recommendRotation(..., quota) [informational only]

 Claude interactive parent:
   Claude Code ──stdin JSON──► statusline-collector.cjs wrap
                                 ├─ read all stdin once (Buffer)
                                 ├─ spawnSync(sh -c <previous command>, input=Buffer, stdout/stderr inherit)
                                 ├─ exit with renderer status (signal → same signal)
                                 └─ after renderer: try { fromStatusline(json) → subscription-store.append } catch {}
                                                              │
                                                              ▼
                                   ~/.local/state/shipyard/claude/subscription/ (0700 dir, 0600 files,
                                   bounded retention, label map per runtime-home digest)

 Rotation:  overhead rows (+model, effort, policy_hash, instruction_digest, lifecycle_class)
            ──► recommendRotation ──► result(recommendation_id) ──► shadow decision
                 (unknown on any key gap)          fingerprint(rows, boundary, blockers) ─► dedupe
                                                   <git-common-dir>/shipyard/rotation/ (untracked)

 Effort experiment: definition v1 (arms differ only in effort, activation.allowed=false)
            + overhead rows + verified completions + recorded human decisions
            ──► effort-experiment report v1 (verdict never auto-'promote'; floor 20/95%/7d)
```

### Recommended file layout (new files marked +)

```
plugins/delivery-pipeline/scripts/
├── subscription-observation.cjs   + pure parsers, whitelist envelope, series/discontinuity
├── subscription-store.cjs         + private sample store + label declaration (no .planning)
├── statusline-collector.cjs       + `wrap` entry point for the Claude statusLine command
├── effort-experiment.cjs          + experiment schema v1 + report v1 (protocol only)
├── usage-report.cjs               ~ fill subscription_usage, --account-label
├── session-handoff.cjs            ~ comparable key, lifecycle classes, shadow decisions
└── orchestration-overhead.cjs     ~ optional dimensions, successor_reread stage, handoff-cost summary v1
scripts/install-shipyard-claude-statusline.sh   + install / --remove / --check
tests/unit/{subscription-observation,subscription-store,statusline-collector,effort-experiment}.test.cjs  +
tests/smoke/claude-statusline-smoke.sh          +
tests/fixtures/captured/claude-statusline.jsonl + (captured, scrubbed)
tests/fixtures/captured/boundaries/claude-statusline.json +
```

### Pattern 1: Envelope (`shipyard.subscription-observation.v1`) — recommended fields

Every field below is a proposal [ASSUMED: design recommendation]. The field *set* is fixed by D-A3.

| Field | Claude stream (`rate_limit_event`) | Codex (`token_count.rate_limits`) | Statusline |
|------|------|------|------|
| `provider` | `anthropic` | `openai` | `anthropic` |
| `runtime` | `claude` | `codex` | `claude` |
| `source` | `claude-stream` | `codex-native` | `claude-statusline` |
| `account_label` | declared label or `null` → `attribution: 'unattributed'` | same | same |
| `bucket_id` | unified window **name** (`five_hour`, `seven_day`) | `${limit_id}:${slot}` (`codex:primary`), never renamed to 5 h / 7 d | window name as keyed in `rate_limits` |
| `window_minutes` | `300` / `10080` derived from the named window [ASSUMED: name-to-minutes table] | `window_minutes` as reported | as the Claude stream |
| `resets_at` | `resetsAt` (epoch s) | `resets_at` (epoch s) | reset field name unknown → spike (Open Q2) |
| `used_percent` | `utilization × 100` (fraction per source) | `used_percent` (percent as is) | `used_percentage` (percent as is) |
| `observed_at` / `freshness` | row has no timestamp → `observed_at: null`, `freshness: 'unknown'` unless the caller supplies file mtime (`freshness_basis: 'file_mtime'`) | row `timestamp` | wrapper clock at render |
| `concurrency` | default `'unknown'` | default `'unknown'` | default `'unknown'` |

- Never copy `credits`, `plan_type`, `individual_limit`, `spend_control_reached`, `rate_limit_reached_type`, `status`, `isUsingOverage`, `session_meta.*`, `uuid` or `session_id` into the envelope. Build the output from an allow-list object literal; never filter a copy with a deny-list.
- `slot === 'secondary'` with value `null` produces no envelope. It is not a zero-percent bucket.

### Pattern 2: Series and discontinuity (REQ-178)

- Series key = `provider, runtime, account_label, bucket_id, window_minutes`. `resets_at` is part of **bucket identity**, but compared with a tolerance. Fixture evidence shows a 1-second jitter. Recommend treating `|Δresets_at| ≤ 60 s` as the same reset [ASSUMED: tolerance value] and any larger change as a `reset` discontinuity.
- Discontinuity reasons (closed set): `reset`, `decrease`, `account_label_change`, `unattributed`, `unknown_concurrency`, `window_change`. A delta is reported only for a continuous segment with `concurrency` explicitly `exclusive` (declared by the caller for a controlled window). Otherwise the segment is `inconclusive`.
- Never sum across series. Group totals are per series only. A report spanning providers, accounts or buckets has no scalar total. This mirrors the `mixed_runtime` → `null` rule in `usage-report.cjs:293-294,349-355`.

### Pattern 3: Statusline wrapper (REQ-177)

1. Read all of stdin into one Buffer before doing anything else. Do not parse before forwarding.
2. `spawnSync(<shell>, ['-c', previousCommand], { input: buf, stdio: ['pipe', 'inherit', 'inherit'], env: process.env })`. With `stdout` inherited, the output is byte-identical by construction and cannot be delayed by the collector.
3. Exit with `result.status`. If the renderer died by a signal, re-raise it (`process.kill(process.pid, result.signal)`). If the spawn itself failed, exit as a shell would for "command not found" (127). The collector must not substitute its own output.
4. Only after the renderer returns: `try { parse(buf) → envelope → store.append } catch {}`. Use no stdout and no stderr, a lock `waitMs` of a few hundred ms, and skip parsing (not forwarding) above an input cap (for example 1 MiB) [ASSUMED: cap value].
5. Write deduplication: append only when (series key, `used_percent`, `resets_at`) changed since the last stored sample. Statusline renders are frequent (Open Q3).

### Pattern 4: Installer ownership (REQ-177)

- Owned state file `$CLAUDE_HOME/shipyard-statusline/owned.json` = `{ schema, previous: <exact prior statusLine JSON value or "absent">, installed: <exact statusLine value we wrote> }`.
- **Install:**
  - Refuse if the current `statusLine` is not a recognised command shape (Open Q1).
  - If the current `statusLine` already deep-equals our `installed` value, do nothing and keep `previous`. This is the idempotency guard against recording our own wrapper as "previous".
  - Otherwise copy the collector's literal-require closure into a temp dir under `$CLAUDE_HOME/shipyard-statusline.XXXX`, `node --check` it, run it once against a trivial renderer, `mv` it into place, and write `owned.json` before settings.
  - Then rewrite only `settings.statusLine`, preserving other keys of the previous object (for example `padding`) [ASSUMED: object shape].
- **Remove:**
  - If the current `statusLine` deep-equals `installed`, restore `previous` (delete the key when it was `absent`).
  - Otherwise leave `settings.json` untouched and report that the user changed it.
  - In both cases delete only `$CLAUDE_HOME/shipyard-statusline/`.
- **`--check`:** read-only report of `installed | foreign | absent`.
- Account label: `ACCOUNT_LABEL=<label>` is passed through to `subscription-store.cjs label --runtime claude --home "$CLAUDE_HOME" --set <label>`. No label → observations are `unattributed`.

### Pattern 5: Rotation comparable key and shadow decision (REQ-182)

- `comparableKey` = `[role, backend, runtime, model, effort, policy_hash, instruction_digest]`. `hasComparableDimensions` requires all seven. A missing field gives `unknown` with a reason naming the field. A mixed field gives `unknown` with a reason naming the dimension (today's single message at `:170` generalised).
- The startup filter `:186-187` inherits the stricter key automatically.
- `recordLifecycleCost` gains pass-through of `model`, `effort`, `instruction_digest` and `lifecycle_class`. The defaults come from `createSessionHandoff` options, like `policy_hash` at `:728`.
- Lifecycle classes: `resume | fork | compaction | fresh_start`. Costs per class = `checkpoint_collection + successor_startup + successor_reread + cache_warmup`. `fork` is `history_copying: true`. On Codex, `fork` is `unsupported` because the host pins `fork_turns: none` (`codex-runtime-host.cjs:581,790`, INV-009). The class and its costs become recommendation **evidence**. They never change `state` or `automatic_transfer`.
- The shadow decision id is `sha256(recommendation_id + '\0' + source_state_fingerprint)`. The fingerprint is a digest of the sorted `(observation_id, revision)` pairs of every consumed row (ordinary, startup, handoff cost), plus the phase boundary id, the blockers and the role/runtime/backend scope.
  - Store: `<git-common-dir>/shipyard/rotation/shadow-decisions.jsonl` (schema `shipyard.session-rotation-shadow-decision.v1`), appended under `lock.cjs` `withLock`.
  - An existing id returns `{ recorded: false, duplicate: true }`.
  - The function is pure apart from that append. It launches nothing.
- Quota columns: an optional `quota` evidence array copied from `subscription_usage` bucket summaries. It is informational only; quota-based scheduling is out of scope (ADR-021).

### Pattern 6: Effort experiment (REQ-183)

- `shipyard.effort-experiment.v1` definition:
  - `experiment_id`, `runtime`, `role`, `model`, `arms[]` (`arm_id`, `effort`, `baseline`), `eligibility`, `activation: { active: false, allowed: false, requires: 'ADR-014 amendment or separate ADR' }`, and `comparison: { arm_key: 'effort', cohort_key_excludes: ['effort'], overhead_matched_pair: false, reason: 'effort is an orchestration-overhead COHORT_KEY (orchestration-overhead.cjs:410); overhead matchedCohorts never pairs effort arms' }`.
  - `normalizeExperiment` refuses `active !== false`, arms that differ in anything but effort, and a baseline arm that is not the ADR-014 base rung. Claude executor base is `sonnet`/`max` [VERIFIED: model-policy-internal.cjs:119-121 `executor: … { name: 'base', model_key: 'sonnet', effort: 'max' }`]. The Codex executor base is Luna/max [CITED: CLAUDE.md "Codex grid"]. Codex definitions whose baseline has no recorded completions are `baseline_pending`.
- `shipyard.effort-experiment-report.v1`:
  - Per-arm metrics per verified completion, with a numerator that includes failed, repair (`ci-fix`/`review-fix` role rows for the same ticket), escalation (rows whose rung ≠ base) and abandoned (`parked`/`interrupted`) work.
  - `floor: { min_completions: 20, attribution: 0.95, window_days: 7 }`.
  - `verdict ∈ { inconclusive, ready_for_human_decision, rollback }`. `promote` is never computed.
  - `decision` is present only when a supplied human decision record (`decided_by`, `decided_at`, `decision: promote|reject`, `evidence_digest` = report digest) matches the current report digest.
  - Even a `promote` decision leaves `activation.allowed: false`.
  - `status` tri-state as in `orchestration-overhead.cjs:563-568`.

### Anti-patterns to avoid

- Parsing `rate_limits` inside the `:414-541` loop, where it would be skipped at `:484`.
- Pushing quota warnings into the top-level `warnings`, which flips `comparable` (`:840`) and breaks the 42 existing tests and the Stop-hook recording.
- Inferring units from magnitude (`1.0` is 1 % on Codex, while Claude `0.7` is 70 %).
- A third `TREATMENT_KEYS` entry for effort (D-G1 forbids it).
- Using `lock.cjs` `writeAtomic` for private samples. It writes with default mode (`:363-369`); use `fs.writeFileSync(tmp, data, { mode: 0o600 })` + `renameSync` as `claude-runtime-host.cjs:582-583` does.
- Reusing `optimization-report.cjs`. It is a separate baseline/treatment report whose verdict auto-promotes (`:242-249`).

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| File locking for appends | a new lock | `lock.cjs` `withLock(dir, name, fn, { waitMs, label })` (`:342-358`) | Token-owned, stale takeover (`:151`) |
| Canonical JSON digest | ad-hoc `JSON.stringify` | the local `stable()` + sha256 pattern (`session-handoff.cjs:53-59`, `orchestration-overhead.cjs:54-64`) | Key order independence; copy the 6-line helper, do not import across modules just for it |
| Sensitive-key rejection on tracked rows | a new scanner | the `rejectSensitive` pattern (`orchestration-overhead.cjs:87-96`) plus an allow-list builder | Existing contract (`METADATA_ONLY`) |
| Fixture scrubbing | manual edits | `node scripts/capture-boundary-fixtures.cjs --boundary <b> --dry-run --input <raw>` (`:224-230`) | Placeholders UUIDs, home paths and tokens consistently |
| Settings JSON edit | `sed`/`jq` on settings.json | the `node - <<'NODE'` read-mutate-write pattern (`install-shipyard-claude-hook.sh:98-129`) | Preserves unrelated keys; jq output differs in formatting |
| Hook bundle copy | a hand list of files | the literal-relative-require closure copy (`install-shipyard-claude-hook.sh:180-222`), re-implemented in the new script, which cannot import from a bash script | Keeps the bundle self-contained |

## Runtime State Inventory

This phase is not a rename or refactor. The runtime state it **creates**, which the plan must account for:

| Category | Items | Action |
|----------|-------|--------|
| Stored data | New: `~/.local/state/shipyard/<runtime>/subscription/` (samples, label map); `<git-common-dir>/shipyard/rotation/shadow-decisions.jsonl` | Code only. Bounded retention in the store. Nothing is migrated |
| Live service config | `$CLAUDE_HOME/settings.json` `statusLine` (only when the operator runs the installer) | Installer or uninstaller, with ownership record |
| OS-registered state | None. No launchd, cron or daemon (ADR-021 excludes daemons) | — |
| Secrets/env vars | None read or written. New optional env: `ACCOUNT_LABEL` (installer), `CLAUDE_HOME` (existing convention) | — |
| Build artifacts | `plugins/shipyard/host/` mirror becomes stale for the new modules until `make package-shipyard-codex` runs on the epic | Epic-level step, not per ticket |

## Common Pitfalls

### Pitfall 1: Codex quota rows are skipped by the token accumulator
**What goes wrong:** Codex envelopes are empty even though fixtures have 5 quota rows.
**Why:** `usage-report.cjs:484` `continue`s `event_msg` rows when `token_usage_record` exists.
**Avoid:** Run a separate pass: `subscription-observation.fromTranscriptRows(source.rows, …)` over `sources` before or after the loop.
**Warning sign:** A test on `codex-agent-stream-parent.jsonl` yields 0 envelopes.

### Pitfall 2: A quota parser fault silently drops token observations in the Stop hook
**Why:** `session-observer.cjs:401-404` catches everything, and `report()` is its only source.
**Avoid:** The parser is total. It skips malformed records with `subscription_usage.warnings`. Top-level `warnings` and `comparable` stay unchanged. Add a test that a malformed `rate_limit_event` leaves `comparable`, `observations` and `groups` identical to the same input without it.

### Pitfall 3: A non-literal or new-directory require breaks the hook bundle
**Avoid:** `require('./subscription-observation.cjs')` at the top of `usage-report.cjs`. `subscription-observation.cjs` requires only `node:` built-ins. Verify with `make test-hooks` (read-only use of the existing smoke).

### Pitfall 4: Reset jitter makes spurious discontinuities
**Evidence:** parent `resets_at` `1791047413`, child `1791047414`.
**Avoid:** Use a tolerance (see Pattern 2) and keep a fixture-backed test that both fixtures form one series.

### Pitfall 5: Units inferred from magnitude
**Avoid:** Normalise by `source` only. Test that Codex `1.0` → `1` and Claude `0.7` → `70`.

### Pitfall 6: Double install records the wrapper as the "previous" renderer
**Result:** infinite recursion, or the user's statusline is lost on uninstall.
**Avoid:** Use the idempotency guard in Pattern 4. The smoke runs install twice, then remove, then asserts the original `statusLine` value is byte-equal (`cmp`).

### Pitfall 7: Uninstall clobbers a statusline the user changed after install
**Avoid:** Restore only when the current value deep-equals `owned.installed`.

### Pitfall 8: Observation ids change for existing overhead rows
**Why:** `digest({ ...dimensions, … })` (`orchestration-overhead.cjs:228-230`).
**Avoid:** Spread `instruction_digest` and `lifecycle_class` into `dimensions` only when non-null. Add a test that a v1 row without them keeps its exact previous `observation_id`.

### Pitfall 9: Stricter comparable key makes all current advice `unknown`
**Why:** No producer of `instruction_digest` exists (INV-009: "Instruction digests are not bound anywhere today"). `recordLifecycleCost` forwards no model or effort (`session-handoff.cjs:741-757`).
**Handle:** This is correct ADR behaviour. Update `rotation-recommendation.test.cjs` fixtures (`observation()` `:36-60` lacks model, effort and instruction_digest) so the recommend/not-recommend tests supply all seven dimensions. Add explicit tests that each missing dimension gives `unknown`.

### Pitfall 10: Private samples land in a tracked tree
**Avoid:**
- The store resolves its root from `os.homedir()` or an explicit `stateRoot` option.
- It refuses when the resolved real path is inside a git worktree (`git rev-parse --show-toplevel` succeeds) or contains a `.planning` segment. The existing `stateRootOutsideWorktree` in `codex-delivery-host.cjs:725` is the precedent; do not import it, because that file is pending-43.
- It `lstat`s every path component and refuses symlinks.
- Tests use `stateRoot` in a temp dir.

### Pitfall 11: Comment policy
**What goes wrong:** Net-new `#` or `//` prose in new files fails `make test-comment-policy`.
**Avoid:** Use `@contract:`/`@invariant:`/`@security:` markers only (≤ 120 chars, `comment-policy.cjs:8-9`).

### Pitfall 12: Freshness for Claude worker samples
**Why:** `rate_limit_event` rows carry no timestamp (fixture line 8).
**Avoid:** Do not invent one. Use `observed_at: null` / `freshness: 'unknown'`, or an explicit caller-supplied `file_mtime` basis.

### Pitfall 13: Automatic promotion
**Why:** `orchestration-overhead.report()` returns `promote` when nothing is missing (`:554-555`).
**Avoid:** The effort report never calls it for its verdict and has no `promote` verdict value.

## Code Examples

### Separate quota pass in `report()` (sketch)

```js
const subscription = require('./subscription-observation.cjs');
// inside report(), after the token loop, before the return object:
const subscriptionUsage = subscription.summarize(
  sources.flatMap((s) => subscription.fromTranscriptRows(Array.isArray(s?.rows) ? s.rows : [], {
    source: s?.source || null, accountLabels: options.accountLabels || {},
  })));
// return { ..., subscription_usage: subscriptionUsage, ... }  // top-level warnings untouched
```
Every name in this sketch except `report`, `sources` and `options` is a proposal [ASSUMED].

### Byte-identical wrapper core (sketch)

```js
const input = fs.readFileSync(0);
const run = spawnSync('/bin/sh', ['-c', previous], { input, stdio: ['pipe', 'inherit', 'inherit'] });
try { collect(input); } catch {}
if (run.signal) process.kill(process.pid, run.signal);
process.exitCode = run.error ? 127 : run.status;
```
The shell `/bin/sh` and exit code `127` are assumptions (Open Q1) [ASSUMED]. The `try {} catch {}` body must carry no free comment.

## State of the Art

| Old approach | Current approach | When | Impact |
|--------------|------------------|------|--------|
| `subscription_usage: null`, "no quota estimates" (`usage-report.cjs:837,945`) | Derived, whitelisted quota series from saved transcripts | This phase | `docs/usage-report.md:78` and the `--help` text at `:945` must change together |
| Rotation key role/backend/runtime (`session-handoff.cjs:78-80`) | Seven-dimension key, unknown on gap | This phase | Current evidence → `unknown` until instruction digests exist (P44-C, second pass) |

## Proposed Ticket Slicing (first pass)

Waves follow real data and file dependencies. Every file below was checked programmatically against all `files_modified` of every `*-PLAN.md` under `.planning/phases/` and the statuses in `.planning/graph/delivery-state.json`. There are **0 unmerged overlaps**; 47 hits are on merged phase-40/41/42 tickets only [VERIFIED: local node check this session]. None of the files is on the CONTEXT avoid-list. `runtime-context.cjs` is only `require`d (read-only) by `session-handoff.cjs:251` and `rotation-recommendation.test.cjs:14-18`, and is not modified.

| Ticket | Scope | depends_on | files_modified | REQs | Risk / checkpoint (recommendation) |
|--------|-------|-----------|----------------|------|------|
| **T-44-01** | Envelope module: Claude-stream and Codex-native parsers, allow-list, per-source units, label → `unattributed`, series/discontinuity summary, Codex `unverified` coverage constants. Register the new test as a `consumer` of both boundaries and add inline-shape patterns for `rate_limit_event` / `"rate_limits"` so future tests must load fixtures | — | `plugins/delivery-pipeline/scripts/subscription-observation.cjs` (new); `tests/unit/subscription-observation.test.cjs` (new); `tests/fixtures/captured/boundaries/claude-stream.json`; `tests/fixtures/captured/boundaries/codex-agent-stream.json` | 176, 178, 179, 181, 184 | medium; no checkpoint |
| **T-44-02** | `usage-report` fills `subscription_usage` (derived only, own warnings); `--account-label <runtime>=<label>` CLI option; help text; docs | T-44-01 | `plugins/delivery-pipeline/scripts/usage-report.cjs`; `tests/unit/usage-report.test.cjs`; `docs/usage-report.md` | 176, 178, 179, 184 | medium; no checkpoint |
| **T-44-03** | Private store: root resolution and refusal (worktree, `.planning`, symlink), 0700/0600, append with dedupe, bounded retention, label declare/read keyed by runtime-home realpath digest, CLI `label`/`list`/`prune` | T-44-01 | `plugins/delivery-pipeline/scripts/subscription-store.cjs` (new); `tests/unit/subscription-store.test.cjs` (new) | 180, 181 | medium; no checkpoint |
| **T-44-04** | **Starts with a human-action capture:** an isolated `CLAUDE_HOME` interactive session with a tee renderer, scrubbed via `--dry-run --input`. Then register the `claude-statusline` boundary, add the statusline parser, and add `statusline-collector.cjs wrap` | T-44-01, T-44-03 | `scripts/capture-boundary-fixtures.cjs`; `tests/fixtures/captured/claude-statusline.jsonl` (new); `tests/fixtures/captured/boundaries/claude-statusline.json` (new); `plugins/delivery-pipeline/scripts/subscription-observation.cjs`; `tests/unit/subscription-observation.test.cjs`; `plugins/delivery-pipeline/scripts/statusline-collector.cjs` (new); `tests/unit/statusline-collector.test.cjs` (new) | 177, 178, 181 | medium; `checkpoint:human-action` for the capture |
| **T-44-05** | Installer `install`/`--remove`/`--check`, ownership record, idempotency guard, bundle copy; `make install-shipyard-claude-statusline` / `remove-shipyard-claude-statusline` / `test-statusline` (added to `test-fast`); README "Usage observability" | T-44-04 | `scripts/install-shipyard-claude-statusline.sh` (new); `tests/smoke/claude-statusline-smoke.sh` (new); `Makefile`; `README.md` | 177, 184 | high (touches the user's Claude config); `human_checkpoint: true` recommended |
| **T-44-06** | Seven-dimension `comparableKey` and `hasComparableDimensions`, with dimension-specific unknown reasons; overhead accepts optional `instruction_digest` (id-stable) | — | `plugins/delivery-pipeline/scripts/session-handoff.cjs`; `plugins/delivery-pipeline/scripts/orchestration-overhead.cjs`; `tests/unit/rotation-recommendation.test.cjs`; `tests/unit/orchestration-overhead.test.cjs` | 182 | medium; no checkpoint |
| **T-44-07** | Lifecycle classes and `successor_reread` stage (both `HANDOFF_COST_STAGES` sets), versioned `handoff-cost-summary.v1`, `recordLifecycleCost` pass-through, shadow decisions with fingerprint dedupe, optional quota evidence; `automatic_transfer` literals unchanged | T-44-06, T-44-01 | `plugins/delivery-pipeline/scripts/session-handoff.cjs`; `plugins/delivery-pipeline/scripts/orchestration-overhead.cjs`; `tests/unit/rotation-recommendation.test.cjs`; `tests/unit/session-handoff.test.cjs`; `tests/unit/orchestration-overhead.test.cjs` | 182, 184 | medium; no checkpoint |
| **T-44-08** | `effort-experiment.cjs` definition v1 + report v1 + human decision validation; reads overhead rows through exported `latestRows`/`readStream` only | T-44-06 | `plugins/delivery-pipeline/scripts/effort-experiment.cjs` (new); `tests/unit/effort-experiment.test.cjs` (new) | 183, 184 | medium; no checkpoint |

**Waves:** W1 `T-44-01`, `T-44-06` · W2 `T-44-02`, `T-44-03`, `T-44-07`, `T-44-08` · W3 `T-44-04` · W4 `T-44-05`.

**Intra-phase shared paths:** every shared path is ordered, so Gate 2 passes.
- `subscription-observation.cjs` and its test are shared by T-44-01 and T-44-04 (04 depends on 01).
- `session-handoff.cjs`, `orchestration-overhead.cjs`, `rotation-recommendation.test.cjs` and `orchestration-overhead.test.cjs` are shared by T-44-06 and T-44-07 (07 depends on 06).
- `Makefile` and `README.md` are touched only by T-44-05.

**Codex packaging note for every plan touching `plugins/delivery-pipeline/`:** `make package-shipyard-codex` runs on the epic, not per ticket.

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | `settings.json` `statusLine` is an object `{ type: 'command', command, padding? }` and Claude runs `command` through a POSIX shell with the JSON on stdin | Patterns 3/4 | Installer shape detection and wrapper spawn are wrong; the T-44-04 capture spike must confirm |
| A2 | The statusline input reset field name (for example `resets_at`) and its unit | Pattern 1 | Wrong or absent reset field → treat as `resets_at: null`, `inconclusive` |
| A3 | Name-to-minutes table `five_hour → 300`, `seven_day → 10080` for Claude named windows | Pattern 1 | Mislabelled window; low risk (names are explicit) |
| A4 | Reset tolerance ≤ 60 s | Pattern 2 | Too small → false discontinuities; too large → merged distinct resets |
| A5 | Retention bound (for example 35 days and a per-file cap) and the statusline input cap (1 MiB) | Patterns 3, store | Disk growth or dropped samples; tunable |
| A6 | Label map keyed by the runtime-home realpath digest in private state (rather than a file inside the runtime home) | T-44-03 | Operator UX; the contract ("per runtime home") holds either way |
| A7 | The shadow-decision store sits under `<git-common-dir>/shipyard/rotation/` and is written on explicit opt-in (`record_shadow`) | Pattern 5 | If ADR-019's "no ledger" is read to cover it, it must move into the session-handoff envelope |
| A8 | The Codex executor base is Luna/max (from CLAUDE.md, not read from `model-policy-internal.cjs` this session) | Pattern 6 | Wrong baseline check; the test should read `model-policy.cjs` exports instead of a literal |
| A9 | The code sketches' function names (`fromTranscriptRows`, `summarize`, `collect`) | Code Examples | None (naming only) |

## Open Questions (RESOLVED)

1. **Statusline host contract (A1, A2).**
   - Known: INV-009's host check says the input has `rate_limits.five_hour/seven_day.used_percentage` and that settings contain `statusLine: bash ~/.claude/statusline.sh`.
   - Unclear: the exact settings JSON shape, the executing shell, the reset field, the render frequency and any timeout. `code.claude.com` was blocked by the sandbox proxy and `~/.claude` is outside the readable set.
   - Recommendation: T-44-04 starts with the human-action capture in an isolated `CLAUDE_HOME`. The installer refuses unrecognised shapes.
2. **Where the account label is declared (A6).**
   - Recommendation: private label map. The installer's `ACCOUNT_LABEL=` and the store CLI are the only writers. `usage-report --account-label` overrides per run.
3. **Statusline write rate.**
   - Recommendation: dedupe per changed (series, percent, reset). Planner confirms that no throttle beyond that is needed.
4. **Shadow-decision persistence trigger (A7).**
   - Options: record on every `status --include-evidence`, or only with an explicit flag.
   - Recommendation: explicit `--record-shadow` / `record_shadow: true`. `inspect` stays read-only.
5. **Rotation advice becomes `unknown` until instruction digests exist (Pitfall 9).**
   - Recommendation: accept, and state it in T-44-06 acceptance. P44-C (second pass) supplies digests. The Codex `agent_instructions_digest` (`codex-runtime-host.cjs:876-891`) cannot be wired now, because runtime hosts are frozen for this pass.
6. **Claude decompose transcripts live under `claude-decompose/` (`claude-decompose-host.cjs:177`), outside D-A1's glob.**
   - Recommendation: the reader is path-agnostic. README and `docs/usage-report.md` name both roots.

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | all | ✓ | v24.10.0 | — |
| bash | installer, smoke | ✓ | 3.2.57 (keep 3.2-compatible) | — |
| jq | not required | ✓ | /usr/bin/jq | use node heredocs (house style) |
| codex CLI | only for re-capture | ✓ | /opt/homebrew/bin/codex (version not probed) | existing captured fixtures suffice |
| claude CLI | statusline capture (T-44-04) | ✗ on this sandbox PATH | — | operator performs the capture on the host (human action) |
| Network (docs) | statusline docs lookup | ✗ (`code.claude.com` denied by proxy) | — | capture spike |

**Missing, no fallback:** none for implementation. The statusline fixture needs an operator session.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | in-repo `tests/unit/assert-harness.cjs` and `node:test` (no deps) |
| Config file | none; `tests/unit/run.sh` globs `*.test.cjs` |
| Quick run | `node tests/unit/<file>.test.cjs` |
| Full suite | `make test-fast` (CI only per CONTEXT) |

### Failing-first tests per requirement (each written first and shown failing on base)

| Req | Behaviour | Type | Command | File exists? |
|-----|-----------|------|---------|--------------|
| REQ-176 | Claude executor fixture → 2 envelopes (`five_hour` 70, `seven_day` 57); the top-level duplicate is not a third bucket | unit | `node tests/unit/subscription-observation.test.cjs` | ❌ new (T-44-01) |
| REQ-176 | Codex parent fixture → 3 `codex:primary` samples despite the `:484` skip; `secondary: null` → none | unit | same | ❌ new |
| REQ-176 | `report()` on the captured fixtures fills `subscription_usage` while `observations`, `groups` and `comparable` equal the pre-change output | unit | `node tests/unit/usage-report.test.cjs` | ✅ extend (T-44-02) |
| REQ-176/179 | Static: `subscription-observation.cjs` and `subscription-store.cjs` require no `child_process`, `net`, `http`, `https` or `dgram`; `usage-report.cjs` still spawns nothing | unit | both test files | ❌ new |
| REQ-176 | The Stop-hook bundle still contains its files after the new require | smoke (existing, read-only) | `make test-hooks` | ✅ |
| REQ-177 | The wrapper forwards identical bytes (binary and UTF-8 input) and returns the renderer's exit code 0/3/signal; a collector throw (unwritable store) changes neither stdout nor exit | unit | `node tests/unit/statusline-collector.test.cjs` | ❌ new (T-44-04) |
| REQ-177 | Install into isolated `CLAUDE_HOME` with a prior `statusLine`; install twice; remove → `settings.json` `cmp`-equal to the original; remove after a user edit → user value kept; `--check` read-only | smoke | `bash tests/smoke/claude-statusline-smoke.sh` | ❌ new (T-44-05) |
| REQ-177 | README make targets exist | smoke (existing) | `make test-docs` | ✅ |
| REQ-178 | Units by source (Codex `1.0` → 1, Claude `0.7` → 70); positional mapping never happens (a `primary` with 10080 stays `codex:primary`); parent/child 1 s jitter → one series; reset / decrease / label change / window change → discontinuity; default concurrency → `inconclusive`; mixed provider/account/bucket → no scalar total | unit | `node tests/unit/subscription-observation.test.cjs` | ❌ new |
| REQ-179 | `subscription_usage.coverage.codex_parent === 'unverified'` and `codex_idle_baseline === 'unverified'` regardless of input | unit | usage-report and subscription-observation tests | ❌/✅ |
| REQ-180 | Store dirs 0700 and files 0600 (`statSync().mode & 0o777`); refuses a root inside a git worktree, under `.planning`, or through a symlink; retention prunes beyond the bound; no sample under the worktree after a run | unit | `node tests/unit/subscription-store.test.cjs` | ❌ new (T-44-03) |
| REQ-181 | Negative fixture: envelopes and store lines built from the Codex parent fixture contain none of `creator_user_id`, `<USER-ID>`, `credits`, `plan_type`, `balance`, `@`; a missing label → `attribution: 'unattributed'` and `account_label: null`; a label containing `@` is refused | unit | subscription-observation and subscription-store tests | ❌ new |
| REQ-182 | Each of model, effort, policy_hash and instruction_digest missing → `unknown`; mixed → `unknown` naming the dimension; seven matching dims keep today's recommend/not-recommend; `automatic_transfer.allowed === false` in every result | unit | `node tests/unit/rotation-recommendation.test.cjs` | ✅ extend (T-44-06) |
| REQ-182 | An overhead row without the new dims keeps its exact prior `observation_id` | unit | `node tests/unit/orchestration-overhead.test.cjs` | ✅ extend (T-44-06) |
| REQ-182 | The same inputs twice → one shadow decision (`duplicate: true`); a changed row revision → a new decision; no launch or recorder call besides the append; four lifecycle classes with cost totals incl. `successor_reread`; Codex `fork` → `unsupported`; ownership state bytes unchanged | unit | rotation-recommendation and session-handoff tests | ✅ extend (T-44-07) |
| REQ-183 | `active: true` refused; arms differing in model refused; Claude baseline ≠ sonnet/max refused; report counts failed, repair, escalation and abandoned in the numerator; below floor → `inconclusive`; above floor → `ready_for_human_decision`, never `promote`; a decision with a stale `evidence_digest` is ignored; `TREATMENT_KEYS` deep-equals `['wait_events','bounded_context']` | unit | `node tests/unit/effort-experiment.test.cjs` | ❌ new (T-44-08) |
| REQ-184 | Every new report has `status.{installed, behaviorally_verified, efficiency_measured}` and `verdict === 'inconclusive'` without matched cohorts | unit | each new test file | ❌ new |
| REQ-184 | No acceptance criterion in `44-0[1-8]-PLAN.md` contains a savings or reduction percentage (the plan-checker scans acceptance text for `%` adjacent to save/saving/reduc/cheaper; the 95 % attribution floor is exempt) | plan check | `node -e` scan by the checker | n/a |

### Sampling rate
- Per task commit: the ticket's own `node tests/unit/…` files, plus `node tests/unit/boundary-fixtures.test.cjs` for T-44-01/04, `make test-hooks` for T-44-02, and `bash tests/smoke/claude-statusline-smoke.sh` for T-44-05.
- Per wave and phase gate: `make test-fast` in CI.

### Wave 0 gaps
- [ ] `tests/fixtures/captured/claude-statusline.jsonl` (human capture, T-44-04)
- [ ] New test files listed above. No framework install is needed.

## Security Domain

`security_enforcement: true`, ASVS level 1 (`.planning/config.json`).

| ASVS category | Applies | Control |
|---------------|---------|---------|
| V2 Authentication | no | No credentials read; no API key (D-A4) |
| V3 Session management | no | — |
| V4 Access control | yes (local files) | 0700/0600 private state; path confinement outside worktrees |
| V5 Input validation | yes | Allow-list envelope builder; label regex (`^[a-z0-9][a-z0-9._-]{0,63}$` recommended, no `@`); statusline JSON parse guarded and capped |
| V6 Cryptography | minimal | sha256 via `node:crypto` for digests only |
| V8 Data protection | yes | No prompt, excerpt, credential, e-mail, user id, `credits` or `plan_type`; tracked outputs derived only |
| V12 Files and resources | yes | Refuse symlinks and `.planning` or worktree roots; atomic writes with explicit mode |
| V14 Configuration | yes | Settings edits limited to the owned `statusLine` key; reversible |

| Threat | STRIDE | Mitigation |
|--------|--------|------------|
| Account identifiers leak into a tracked repo | Information disclosure | Allow-list plus a negative-fixture test; samples only in private state |
| Wrapper alters or blocks the user's statusline | Tampering / DoS | Inherited stdout; exit passthrough; collection after the renderer with a short lock wait |
| Settings clobbered on uninstall | Tampering | Ownership record; restore only when the current value equals the owned value |
| Symlinked state dir redirects writes into a repo | Tampering | lstat-per-component refusal |
| Experiment or advice becomes launch authority | Elevation | `activation.allowed: false` and `automatic_transfer.allowed: false` literals; no resolver import beyond reading constants |

## Sources

### Primary (HIGH, read this session at `29803ee3`)
- `plugins/delivery-pipeline/scripts/usage-report.cjs` (whole file), `orchestration-overhead.cjs` (whole file), `session-handoff.cjs:1-330,462-490,716-760,1034-1097`, `lock.cjs:255-376`, `session-observer.cjs:1-100,341-420`
- `claude-runtime-host.cjs:255-290,570-600,738-752,820-860`, `claude-role-host.cjs:940-970`, `codex-runtime-host.cjs:364-405`, `codex-delivery-host.cjs:205-222,574-580,1005-1020`, `model-policy-internal.cjs:115-125`, `optimization-report.cjs:1-60`
- `scripts/install-shipyard-claude-hook.sh` (whole), `scripts/shipyard-doctor.cjs:200-240`, `scripts/capture-boundary-fixtures.cjs:20-280`, `scripts/package-shipyard-codex.cjs:9-30`, `Makefile:1-106`, `tests/unit/run.sh`, `tests/unit/boundary-fixtures.test.cjs:1-200`, both boundary manifests, all five captured fixtures (rate-limit lines), `tests/unit/runtime-file-digests.json`
- All `.planning/phases/*/*-PLAN.md` frontmatter and `.planning/graph/delivery-state.json` (overlap check)
- ADR-021, phase CONTEXT.md, INV-009 DECISIONS/RESEARCH/risks (context packet and files)

### Secondary
- CLAUDE.md (Codex grid baseline), INV-009 host checks (statusline, capabilities)

### Tertiary / unavailable
- Claude Code statusline documentation: **not fetched** (sandbox proxy denied `code.claude.com`). The research-plan seam was not run because all web providers are disabled in config and the network is filtered. No external claim in this file depends on it; the related items are logged as A1/A2.

## Metadata

**Confidence breakdown:**
- Seams and file ownership: HIGH. Direct reads, local test runs and a programmatic overlap check.
- Envelope and store design: MEDIUM. Fixture-backed shapes, with design values assumed (A3–A6).
- Statusline wrapper and installer: MEDIUM-LOW on the host contract (A1/A2) until the T-44-04 capture.
- P44-D / P44-G: HIGH on seams, MEDIUM on design choices (A7/A8).

**Research date:** 2026-09-27
**Valid until:** until the phase-43 epic merges (line numbers in `session-handoff.cjs`/`orchestration-overhead.cjs` are unaffected by phase 43, but re-check `usage-report.cjs` if T-43 work touches it), or 30 days
