# Research

Synthesis of the four INV-009 research lines. All four were sealed with verified receipts
(Claude, `claude-opus-5-5`/medium, policy `adr-014.v6` / `30e71fb4…`, source revision
`bc127635`). The complete line artifacts are in `research/` (`system-state.md` digest `1fab2faf…`,
`alternatives.md` `597691d9…`, `constraints.md` `b837ba8e…`, `risks.md` `25e248ef…`); this file
keeps every command-backed finding and constraint they report. Items marked **host check** were
verified by the orchestrating session after the fan-out, outside the research sandbox (the lines
were not allowed to read installed homes).

## Current system state

### Deployment
- Phases 40 (all 28 tickets, release 0.67.0 `0ce24f00`), 41 (T-41-01..09) and 42 (T-42-01..03) are
  merged on HEAD. `plugins/delivery-pipeline/.claude-plugin/plugin.json:4` is `0.67.0`.
- Phase 43 is mostly undelivered: T-43-02 merged into the epic (`5c0d251f`), T-43-07 `pr-open`
  (#266), the other 17 `pending`; epic 43 is not on main.
- The committed `.planning/graph/delivery-state.json` (last commit `0872b22d`, 2026-09-26) still
  lists every T-40 ticket `pending`, and `delivery-front.json` lists them as `parked.blocked`,
  although git history has all of them merged. Readiness must not be read from this projection.
- **Host check:** the installed hosts equal the source. SHA-256 prefixes of
  `codex-decompose-host.cjs` (`b1f981fb`), `planning-result-sealer.cjs` (`e09d0fd5`),
  `codex-delivery-host.cjs` (`1ce5bde9`) and `claude-role-host.cjs` (`f94d1402`) are identical in
  the worktree, `~/.codex/shipyard/scripts/` and the Claude 0.67.0 plugin cache. Installed CLIs:
  Claude Code 2.1.283, codex-cli 0.157.1.
- The `PLANNING-STATUS.md` blocker ("Codex decompose host has no planning artifact contract") is
  superseded: `codex-decompose-host.cjs:16` imports the shared sealer and `:137-153` seals research
  artifacts (T-40-10/11/12/13).
- `plugins/shipyard/host/…` is a generated mirror produced by `scripts/package-shipyard-codex.cjs`
  (`make package-shipyard-codex`, `Makefile:6-7`); it is regenerated on the epic, not per ticket.

### Baseline tests (existing primitives only)
rotation-recommendation 7/7, orchestration-overhead 16/16 (the preparation recorded 8),
usage-attribution 59/59, usage-report 42/42, context-packet 11/11, session-handoff 16/16,
model-policy 26/26, investigation-research 11/11, claude-role-host 44/44, role-artifact 11/11.
gen-codex-shipyard 89 pass / 5 fail, all five installer cases failing on `mktemp` inside the
research sandbox; re-run outside the sandbox before treating it as a regression.

### P44-A — subscription observation
- No source parses quota. `usage-report.cjs:4` says totals are "processing units, never quota";
  `:836-839` has `subscription_usage: null`. `usage-attribution.cjs` stores no token totals
  (`:1-17`). `orchestration-overhead.cjs:410` already has `account_scope` as a cohort key, but
  nothing fills it.
- **New fact that corrects the evidence:** the existing launch paths already receive quota data.
  - Claude headless (`claude --print --output-format stream-json`, CLI 2.1.283):
    `tests/fixtures/captured/claude-stream-executor.jsonl:8` and `claude-stream-research.jsonl:7`
    contain `rate_limit_event` records with `rate_limit_info.unifiedWindows.five_hour|seven_day`
    and `utilization` as a **fraction 0–1**. `claude-runtime-host.cjs:263-280` drops them.
  - Codex exec (0.157.1): `codex-agent-stream-parent.jsonl:16,23,29` and `…-child.jsonl:18,22`
    `event_msg/token_count` records carry `rate_limits` with `limit_id: codex`,
    `primary.used_percent`, `primary.window_minutes: 10080` (7-day), `secondary: null`,
    `resets_at`, plus `credits` and `plan_type` (account data). No code reads them
    (`codex-runtime-host.cjs:250`, `usage-report.cjs:479`).
  - `primary`/`secondary` therefore cannot be hard-coded as 5 h / 7 d.
- **Host check:** the maintainer's `~/.claude/statusline.sh:31-41` reads
  `rate_limits.five_hour/seven_day.used_percentage` (percent), and `~/.claude/settings.json`
  configures `statusLine: bash ~/.claude/statusline.sh`. So the interactive parent session sees
  percentages through the statusline and workers see fractions in their stream.
- Codex `account/rateLimits/read` / `account/rateLimits/updated` (app-server) are known only from
  the 0.157.0 generated schema in the evidence; no idle read was made. Transcript snapshots arrive
  only during model turns.
- No installer manages `statusLine`; the only settings writer is
  `scripts/install-shipyard-claude-hook.sh:29`, and the only reader is
  `scripts/shipyard-doctor.cjs:214`.

### P44-B — architecture-review reuse
- Claude flow (`claude-role-host.cjs`): `prepareArch` `:437-470` gathers the PR, the
  base/merge-base trees, the exact diff, plan/ADR refs and `reference_digest`. `observedSignals`
  `:371-387` derives `risk`, `critical`, `checkpoint` (`:377`) and live `contested` (`:378`), and
  refuses mismatching caller signals. `run()` `:1223-1318` mints ids (`:1228-1230`), records
  in-flight (`:1245`), calls `prepareRoleArtifact` (`:1250`, which unlinks evidence,
  `role-artifact.cjs:927`), dispatches (`:1254`), asserts exactly one launch (`:1265`), then
  revalidates, validates and seals (`:1268-1270`).
- Sealed judgments are archived per dispatch id (`role-artifact.cjs:35,947,1821`). Nothing looks
  them up by input identity. A reuse hit needs a new result variant, because `:1265` refuses
  anything but one launch.
- Inputs that affect the verdict or its rung: PR number, head and head tree, base name and commit,
  merge-base and its tree, integration-base tree, exact diff, plan content and acceptance, ADR refs
  (including excluded and unresolved), `reference_digest`, packet digest and selected backlog ids,
  signals including live `contested` and `inputTokens` (the Claude arch-review `ceiling` rung is
  at `inputTokens > 250000`, `model-policy-internal.cjs:193-195`), `policy_hash`, applied
  model/effort and `HOST_IDENTITY` (`:1294`). Instruction digests are not bound anywhere today.
- Codex has no arch-review role host: `grep -c arch-review codex-*.cjs` → 0.
  `codex-delivery-host.cjs:61-96` takes signals from the caller. `commands/deliver.md:1183` routes
  Codex arch-review through `codex-delivery-host.cjs`. Pending T-43-14 adds
  `deliver-dispatch build arch-review` and requires a named Codex refusal (`43-14-PLAN.md:40`).
- The audit's proved duplicate (`evidence/REPORT.md:53`): T-02-12 was reviewed twice with the
  same head `b3ae2079…` and base tree `2cfb6a0b…`, and both gave the same violation. Whether the
  two ran concurrently is not recorded.
- `lock.cjs` provides mkdir locks with an owner.json random token that `release()` must present
  (`:26-37`) and stale takeover (`:151`). It is built for short critical sections; a single-flight
  reservation that outlives a model run needs its own state record.
- Owners: T-43-13 (pending, high) owns changed-base carry in `gate-trailer.cjs`/`base-merge.cjs`.
  T-43-05 and T-43-06 (pending) edit `role-artifact.cjs` and `claude-role-host.cjs`. Phase-45 D4
  (drift-scan reuse) consumes "only a proven identity primitive"
  (`45-…/WORK-PACKAGES.md:38`).

### P44-C — instruction coverage
- No rule-ID or coverage manifest exists. `context-packet.cjs` has no instruction handling.
- Codex children: `codex-runtime-host.cjs:876-891` refuses unless the installed GSD agent
  instructions appear exactly once, and records `agent_file_digest`/`agent_instructions_digest`.
  That covers role instructions only. The project AGENTS.md chain is visible in the native
  transcript (`codex-agent-stream-parent.jsonl:7`, "# AGENTS.md instructions"), but nothing
  digests it. The launch uses `--ignore-user-config` (`:1007`), so `project_doc_max_bytes` from
  the global config does not apply; the effective default budget and nested loading are
  unverified.
- Claude headless: the `system/init` record lists tools, agents, skills and plugins, but no
  memory/CLAUDE.md paths. Whether the session transcript records loaded memory files is unknown.
- Generation: `scripts/gen-codex-shipyard.cjs:268-291` (skills), `:312`
  (`developer_instructions`), `:320` (route block), `:373-378` (digests);
  `scripts/install-shipyard-codex.sh:40,613` writes the global AGENTS.md block;
  `shipyard-doctor.cjs:318-329` checks it.
- Owners: ADR-019 excludes a full instruction rewrite. Phase-45 D2 (stage loading) consumes P44-C
  rule ids. T-43-12 edits both delivery-rules `SKILL.md` copies; T-43-18/19 edit
  `references/ci-fix.md` and `pr-sentinel.md`.

### P44-D — rotation advice
- `session-handoff.cjs`: `recommendRotation` `:148-233` (phase boundary `:150-161`; five
  comparable passes over 2× the startup median `:163-232`). `comparableKey` `:78-80` compares
  only role, backend and runtime. `recommendationResult` `:112-130` is advisory with a
  deterministic id and `automatic_transfer.allowed: false`, but nothing persists or deduplicates
  advice. `HANDOFF_COST_STAGES` `:258`.
- `runtime-context.cjs:280-350` always reports transfer capability `unsupported`/`unproven`.
- No resume / fork / compaction / fresh-start classification exists. Codex requires
  `fork_turns: none` (`codex-runtime-host.cjs:581,790`).
- Owners: T-41-02 (merged) owns checkpoint and successor safety; ADR-019 defers automatic
  rotation.

### P44-E — research index
- `context-packet.cjs`: research needs `problem_statement` and `source_refs` (`:29`),
  `DEFAULT_TOKEN_CEILING = 12000` (`:19`), required refs always embedded (`:398-410`), only
  optional content can be omitted on overflow (`:460-491`), omitted content without overflow is
  refused (`:520`). Selection is file-level.
- `workflows/investigation-research.mjs`: exactly four lines (`:22,101-104`), summary ≤ 500
  characters (`:46,215`), file-level artifact indexes (`:207`, `claude-dispatch-adapter.cjs:153-211`).
- Observed in this INV (risks line F18): the files a contract names but that sit only in
  `source_refs` are neither embedded nor flagged. Nothing checks that contract-mandated sources
  are present.
- Owners: phase 40 owns sealing and re-dispatch; T-43-15 (pending) adds research/decomposition
  request builders and edits `investigate.md`/`decompose.md`; phase-45 P5 owns exact-revision
  whole-INV reuse and must align with P44-E's identities (`45-…/WORK-PACKAGES.md:29`).

### P44-F — checkpoint reasons
- Producers (boolean, no reason): `claude-role-host.cjs:377` and `deliver-dispatch.cjs:90`, with
  `checkpoint = true` when `row.human_checkpoint === true`. Codex takes caller signals.
- Consumers: `model-policy-internal.cjs:155-193` promote on `checkpoint: true` for decomposition,
  integrator, arch-review and executor (Codex and Claude rules), applied at `:635-643`. Any rule
  change changes `POLICY_HASH` (`:300`), which is embedded in generated Codex agents
  (`gen-codex-shipyard.cjs:365`) and refused when stale (`:888-889`).
- Graph: `validate-graph.cjs:211` coerces `human_checkpoint` to a strict boolean, `:218`
  `preauthorized`, `:520-531` high risk and preauthorized both require a checkpoint.
- F17 owner is pending **T-43-12** (REQ-162). It keeps `human_checkpoint` boolean-compatible,
  accepts `review|merge`, and adds a projected field **named `checkpoint`** (`merge|review|null`)
  to `tickets.json`/`tickets.yaml`. It does not touch the model-signal seams. The name
  `checkpoint` is now used for four things: the policy signal, T-43-12's graph field,
  `failure-signature.cjs:190` (resource exhaustion) and `run-contract.cjs:20-40` (run state).

### P44-G — effort experiments
- `orchestration-overhead.cjs:16-22`: min 20 completions, 95 % attribution, a closed treatment set
  `wait_events|bounded_context`, and `COHORT_KEYS` including `effort` (`:410`). Two arms that
  differ in effort can never be a matched pair (`:421-443`), so effort cannot be a treatment today.
- Baselines: Claude executor `sonnet/max` (`model-policy-internal.cjs:120`), Codex executor
  `luna/max`.
- **Host check:** `~/.codex/shipyard/codex-capabilities.json` lists `gpt-6-luna` low, medium,
  high, xhigh and max, and `gpt-6-sol` low, medium, high, xhigh, max and ultra. The Claude supported
  pairs come from the host capability snapshot (`model-capability.cjs:19,33,126`).
- No experiment assignment, arm identity or promotion code exists.

## Constraints

The constraints line (`research/constraints.md` §2–§9) lists them with ids C-01…C-28, P-01…P-08,
V-01…V-05, G-01…G-05, B-01…B-06 and D-01…D-07. The binding ones:

### Technical
- ADR-014: two independent native grids with no cross-grid aliasing or effort translation (C-01).
  Every launch goes resolve → validate → launch → receipt. A reused verdict is not a launch and
  must return the original receipt with a distinct `reused` outcome (C-02). No override or
  experiment flag becomes launch authority (C-03).
- Any policy-object change changes `POLICY_HASH`. P44-F activation, and any P44-G data placed in
  the policy, need an ADR-014 amendment, a version bump from `adr-014.v6`, regenerated Codex
  agents and the generated mirror (C-04). Unknown or legacy checkpoints stay conservative (C-05,
  C-28). New fields go outside `ApplicationReceipt` or through the amendment (C-07).
- Codex runs `codex exec --json` with `forced_login_method="chatgpt"` and `--ignore-user-config`,
  and strips API keys (`codex-runtime-host.cjs:993-1007`). An observer must not replace that
  backend or add API keys (C-10, V-04). `fork_turns: none` stays (C-11).
- Claude statusline collection is net-new and must go through the supported installer, restoring
  a preexisting custom command (C-12, B-05).
- Extend `usage-attribution.cjs`/`usage-report.cjs`/`orchestration-overhead.cjs` instead of adding
  a ledger (C-23). Version the overhead report schema, do not mutate it (B-04). The four
  research lines and the `planning.v1` / `shipyard.research-result.v1` contracts stay (C-19, B-03).
- Runtime-file digest pin covers `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs`; changing
  them needs `make refresh-runtime-digests` and its trailer (G-03). New host-facing shapes are
  captured through `make capture-fixtures`, not hand-written (G-04). A missing Codex host is a
  named gap, never a silent one (G-05).
- Gate 2 (`validate-graph.cjs:470-512`) makes two dependency-unordered, unmerged tickets that
  touch the same path an error; across phases the remedy is re-slicing or a real dependency.
  Cross-phase `depends_on` is supported and leaves the child blocked until the parent's phase
  lands on the default branch (`:628`; phase 40 used it, e.g. `40-01-PLAN.md:7`).

### Product
- Same acceptance contracts, tests, CI and independent reviews; missing evidence never becomes
  green (P-01). A reused violation still blocks; no carry across a changed base; a verdict never
  satisfies a separately required other-provider review; live gates are re-checked on a hit
  (P-02). No silent truncation or omission of required instructions; target repositories are
  fixtures only (P-03). Four independent research lines (P-04). Rotation stays advisory (P-05).
  Experiments are disabled by default and need their own recorded gate (P-06). Excluded: blanket
  downgrade, mandatory double-provider review, provider fallback, quota scheduler, daemon,
  limit-reset/credit operations, account mutation (P-07). Target-project PR hygiene (P-08).
- Measurement: no price or token-to-quota conversion, no summing across provider/account/bucket
  (C-21). Concurrency, account switch, reset or decrease produce a discontinuity or an
  inconclusive result (C-22). 20 / 95 % / 7 days is a floor, not proof (C-24). Installed,
  verified and measured states are recorded separately (C-25).
- Privacy: a strict field whitelist, no prompts, transcripts or credentials (V-01). Account
  identity is an opaque scope, not an e-mail or user id; `creator_user_id` already leaked into
  captures once (phase-45 R8) (V-02). `.planning/` is tracked in this repository, so per-account
  samples written there would be pushed (V-03). No network call beyond the provider's own read,
  no model turn, no account mutation (V-05).

### Delivery
- No PLAN, ticket or global REQ id before an accepted ADR and the typed
  researcher/planner/checker receipts plus Gate 2 (D-01). Policy and authorization changes are
  human checkpoints (D-02). One post-merge integrator (D-03). Rollout: collection and coverage,
  then reuse/observation/index, then typed policy and experiments (D-04). Comment policy gate
  (D-05). Phase 45 may consume phase-44 primitives but its items are not implemented here (D-06).
- File ownership against pending phase-43 plans (constraints §5):
  - P44-B: after T-43-05, T-43-06, T-43-13 and T-43-14.
  - P44-C: after T-43-12, T-43-14, T-43-18 and T-43-19.
  - P44-E: after T-43-11, T-43-12, T-43-15, T-43-16 and T-43-17.
  - P44-F: strictly after T-43-12, plus T-43-06, T-43-14 and T-43-15.
  - P44-G: after T-43-01 and T-43-10, if it adds a config key.
  - P44-A and P44-D touch no pending phase-43 file.

## Unknowns

Every unknown has a mirror in OPEN-QUESTIONS.md, or has moved to RISKS.md with a mitigation.
- Idle-time Codex `account/rateLimits/read` under the ChatGPT login.
- Effective Codex AGENTS.md budget and nested loading under `--ignore-user-config`.
- Whether the Claude session transcript records loaded CLAUDE.md/memory files.
- An exhaustive list of every input `makePrompt`/`buildPacket` feeds the arch-review prompt.
- Whether the T-02-12 duplicate reviews were concurrent.
- The final landed shape of T-43-12's `checkpoint` field.
