# Phase 39: Remove conveyor session friction - Research

**Researched:** 2026-09-24
**Domain:** Shipyard deterministic scripts (Node CommonJS, no dependencies), Claude/Codex host hooks and installers, command prose that docs tests pin
**Mode:** `--tdd`, granularity `standard`
**Confidence:** HIGH for in-repo file/function mapping; MEDIUM for Claude Code runtime behaviour (hook payload, `${CLAUDE_SESSION_ID}`); LOW for GSD upstream file formats (sandbox denied `~/.claude/gsd-core`)

## Summary

Phase 39 implements ADR-016 (12 decision bullets, 11 requirements REQ-125..REQ-135). All of the work stays in this repository. It adds no npm packages, no network code and no new external tools. Each requirement maps to one small owning script (new or existing) with a focused `tests/unit/*.test.cjs` or smoke fixture, plus prose edits in three command files (`decompose.md`, `investigate.md`, `deliver.md`). Docs tests pin those command files heavily.

The main planning risk is **file overlap, not technical difficulty**. `plugins/delivery-pipeline/commands/decompose.md` is touched by six requirements (125, 126, 130, 131, 132, 133). `investigate.md` is touched by three (125, 126, 129). `adr-ingest.cjs` is needed by two (126, 129). Gate 2's contested-path rule (`validate-graph.cjs:413-455`) makes any two dependency-unordered same-phase tickets that touch the same path a hard error. So if every requirement edits `decompose.md` in its own ticket, the phase becomes a serial chain. ADR-016 R11 forbids that.

The recommended slicing (see *Ticket Slicing*) puts all command prose into two prose-only tickets, one per command file. Script tickets own only their script and tests, and fixed CLI contracts (defined below) connect the two sides. This yields 10 independent wave-1 tickets and one wave-2 ticket. REQ-126 (bootstrap) depends on REQ-129 (adr-ingest), which is a real code dependency: the bootstrap imports the decision-entry export that REQ-129 adds.

**Primary recommendation:** Slice by owning file rather than by requirement wherever a command file is shared. Pin every prose change with a new, ticket-owned contract test file rather than extending `tests/unit/source-contract.test.cjs`, which would be another shared hot file. Keep every existing pinned literal byte-identical (listed under *Common Pitfalls*).

<user_constraints>
## User Constraints (from ADR-016 / INV-003 DECISIONS — no CONTEXT.md exists for phase 39)

No `39-CONTEXT.md` exists (the phase directory was empty at research time). The locked decisions are ADR-016 `## Decision` (accepted 2026-09-24), copied verbatim from `.planning/architecture/ADR-016-conveyor-session-friction.md`:

### Locked Decisions
- Fix the friction as a hybrid by failure class: deterministic scripts with focused tests where the model could not or did not comply, and prose or templates pinned by docs tests where a pointer suffices.
- Host refusals keep their codes, exit status and fail-closed behaviour, and add a plain-language hint with a remedy from one shared code-to-hint map used by the Claude and Codex hosts; investigate and decompose relay the hint to the user in the user's language and never suggest bypassing a host.
- Decompose bootstraps a minimal GSD project from the accepted ADR when `config.json`, `ROADMAP.md` or `REQUIREMENTS.md` is missing: one phase per ADR, one requirement id per ADR decision bullet parsed by `adr-ingest.cjs`, only missing files are created, and an ADR without decisions is refused in plain language; investigate needs only `.planning/investigations/`.
- The stop gate enforces a front only in a session that deliver armed with a per-session marker keyed by `session_id`; a missing, unreadable or foreign marker allows the stop, and cross-worktree front discovery stays for armed sessions.
- The auto-route hook routes unclear or research-needing work to `/shipyard:investigate` through `/shipyard:route`, reads the prompt from stdin, stays silent for `<task-notification>` turns and expanded slash commands, injects on unparseable input, and the Codex AGENTS.md block and `make doctor` follow it.
- Shipyard ships `templates/adr/ADR.md`, `adr-ingest.cjs` gains a no-write `--check` mode, and Gate 1 fails when the new ADR does not pass it.
- A script builds a deterministic Jira export plan from `tickets.json` with issue content, repo-namespaced labels and explicit `is blocked by` direction, the agent executes it verbatim through MCP, and keys are recorded by script; no network code or credential enters the conveyor.
- Ordering without a code dependency is not a `depends_on`; the decompose and delivery-rules prose adopt the validator's condition, and `validate-graph.cjs` warns when a same-phase dependency shares no `files_modified` with its parent.
- Decompose passes `--skip-ui` to `/gsd-plan-phase` only when the ADR declares `UI design: none`.
- Decompose warns once, without blocking, when `.planning/` is not tracked by git, naming the consequence for delivery worktrees and the remedy.
- `gsd-tune` names the missing configuration file and the command that creates it, keeping exit code 2 and its prefix.
- Research handbacks receive their 500-character bound at launch and are bounded or refused deterministically with a message naming the line and length, before the trusted consumer seals them.

Scope fences from `INV-003/DECISIONS.md` that bind the implementation (verbatim excerpts):
- "Does not change the ADR-014 grid, the dispatch boundary, refusal codes, or fail-closed receipt verification."
- Bootstrap: "Creates only missing files, never rewrites existing ones; one phase per ADR; every requirement id maps 1:1 to an ADR `## Decision` bullet parsed by `adr-ingest.cjs`; refuses in plain language when the ADR has no decisions; adds no launch outside the decompose hosts."
- Stop gate: "The marker is per `session_id` and gitignored; a missing, unreadable or foreign marker means allow; existing stop-gate tests stay green; `--fork-session` yields a new id, so a forked session must re-arm."
- Jira: "No network code in scripts; export never blocks decomposition; this initiative's own tickets are not exported."
- Linearization: "The hint is a warning, never a Gate 2 error; the contested-path rule and diamond warning are unchanged".
- UI: "Without the marker decompose invokes GSD exactly as today; shipyard does not change GSD's UI detection."
- Hints: "Codes, exit status and fail-closed behaviour are unchanged; the hint never suggests bypassing a host; Claude and Codex hosts share the map."
- Route hook: "The hook still only points at `/shipyard:route`; it injects on unparseable input; the Codex AGENTS.md block gets the same route; `make doctor` compares the installed hook."
- ADR check: "`adr-ingest.cjs` gains a no-write `--check` mode; the template is validated by the same function in a test; existing accepted ADRs are not re-validated."
- Untracked planning: "Warning only, with the exact consequence and remedy; never blocks."
- gsd-tune: "Exit code 2 and the `gsd-tune:` prefix are unchanged; only the message text changes."
- Handback: "The bound is passed to the worker and enforced deterministically (declared output schema or host-side bounding with a plain-language refusal naming the line and length); the sealed envelope and receipt checks are unchanged."

### Claude's Discretion
(Not stated in any CONTEXT.md. These are the implementation choices ADR-016 leaves open. Each has a recommendation below.)
- Name and location of the code-to-hint map module, the bootstrap script, the Jira plan script, the route-hook module and the stop-gate marker.
- Whether REQ-135 *bounds* or *refuses* an over-long summary (the ADR allows either).
- Exact user-facing wording of hints, warnings and the gsd-tune message.

### Deferred Ideas (OUT OF SCOPE) — ADR-016 `## Out of scope`, verbatim
- Upstream GSD defects: multi-line `**Goal**` parsing and the `~/.gsd/defaults.json` warning.
- The ADR-014 model/effort grid, the dispatch boundary contract and fail-closed receipt verification.
- A direct Jira REST client or any change to ADR-008 D4.
- A new order-only field in the graph schema.
- Exporting this initiative's own tickets to Jira.
- Planner latency optimisation.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md:137-147) | Research Support |
|----|-------------|------------------|
| REQ-125 | Refusal hints from one shared code→hint map; codes/exit unchanged; commands relay in the user's language | §REQ-125: new `refusal-hints.cjs`; four CLI catch blocks; relay prose in investigate/decompose (prose tickets) |
| REQ-126 | Decompose bootstraps a minimal GSD project from the ADR; investigate needs only `.planning/investigations/` | §REQ-126: new `adr-bootstrap.cjs` importing `adr-ingest.cjs` `decisionEntries`; decompose Step 0 prose; investigate Step 1 precondition |
| REQ-127 | Stop gate enforces only in a deliver-armed session (per-`session_id` marker) | §REQ-127: new `stop-gate-arm.cjs`; guard in the unscoped branch of `stop-gate.cjs:514-524`; `deliver.md` Step 0 arming; test harness arming |
| REQ-128 | Route hook: investigate route, stdin-aware, silent on notifications/slash commands, Codex block and doctor parity | §REQ-128: new `auto-route.cjs` (single source for Claude hook + Codex block); both installers; `shipyard-doctor.cjs` |
| REQ-129 | `templates/adr/ADR.md`, `adr-ingest.cjs --check`, Gate 1 runs it | §REQ-129: `parseArgs`/`main` changes at `adr-ingest.cjs:148-196`; template; investigate Gate 1 prose |
| REQ-130 | Deterministic Jira export plan from `tickets.json`; agent executes via MCP; keys recorded by script | §REQ-130: new `jira-export.cjs plan|record`; network-token sweep like `jira-project.test.cjs:825-837`; decompose Step 5 prose |
| REQ-131 | Order-only ≠ `depends_on`; prose adopts validator condition; validator warns on no shared `files_modified` | §REQ-131: new warning beside `validate-graph.cjs:545-549`; smoke fixture; SKILL.md §7 + projection; decompose.md:425-432 |
| REQ-132 | `--skip-ui` only when ADR declares `UI design: none` | §REQ-132: decompose Step 2 item 3 prose, keeping the pinned literal |
| REQ-133 | One non-blocking warning when `.planning/` is untracked | §REQ-133: decompose Step 0 prose with exact `git` probes |
| REQ-134 | gsd-tune names the missing file and the creating command; exit 2 and prefix kept | §REQ-134: `gsd-tune.cjs:326` message; tighten `gsd-tune.test.cjs:356-361` |
| REQ-135 | Research handback bound stated at launch; over-long summary bounded/refused with line + length | §REQ-135: `investigation-research.mjs` `linePrompt`; `claude-delivery-host.cjs:506-516` `sealPlanningResearch`; `references/inv-research.md` |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- The Claude plugin under `plugins/delivery-pipeline/` is canonical. Codex artifacts are generated by `scripts/gen-codex-shipyard.cjs`. "Edit the Claude command or shared script first, then run `make install-shipyard-codex` and inspect the generated result." [VERIFIED: CLAUDE.md]
- "When adding a rule, add a focused unit or fixture test with it." [VERIFIED: CLAUDE.md]
- "Keep shell scripts on `set -euo pipefail` and validate preconditions early." [VERIFIED: CLAUDE.md]
- "Keep generated state and measurements in the existing `.planning` locations." [VERIFIED: CLAUDE.md]
- "Preserve unrelated worktree changes; this repository is often edited while a delivery session is active." [VERIFIED: CLAUDE.md]
- "Update `README.md` when the supported command or installation flow changes." [VERIFIED: CLAUDE.md]
- "Run `make test-fast` after each edit." `tests/smoke/docs-smoke.sh` is the contract for the documented workflow. [VERIFIED: CLAUDE.md]
- The ADR-014 grid and the mandatory resolve→validate→launch→receipt boundary are frozen for this phase. [VERIFIED: CLAUDE.md "Active routed dispatch policy"]
- No `package.json`, no npm dependencies. Tests use `tests/unit/assert-harness.cjs` and are run by `tests/unit/run.sh`, which also runs `node --check` on every `plugins/delivery-pipeline/scripts/*.cjs`, `scripts/*.cjs` and `bash -n` on every `*.sh`. [VERIFIED: tests/unit/run.sh:14-21]
- Project skill `.shipyard/generated/gsd-delivery-rules/SKILL.md` (planner/executor rules). Relevant here: §4 contested paths, §6 scoped verification commands (never bare `make test`), §7 `depends_on` semantics, and the comment policy. [VERIFIED: file read]

### Comment policy (applies to every added code line)
`plugins/delivery-pipeline/scripts/comment-policy.cjs:8-11,53-66` [VERIFIED], verbatim:
```
const MAX_MARKER_LENGTH = 120;
const MARKER_PATTERN = /^@(invariant|security|contract)\s*:/i;
const HISTORY_PATTERN =
  /(?:\b(?:todo|fixme|hack|workaround|temporary|ticket|issue|pull request|commit|history|legacy|previously|because)\b|#\d+\b|\b(?:adr|myd|pdf)-?\d+\b)/i;
```
Allowed added comments are protected directives (the `protectedComment` regex includes `shipyard(?:[-:]|\s)`, `managed\s+by`, `do\s+not\s+edit`, `#!`, lint pragmas) or a ≤120-char `@invariant:` / `@security:` / `@contract:` marker that does not match `HISTORY_PATTERN`. So: **no narrative comments in new or edited `.cjs/.mjs/.sh` code**, and no `ADR-016`/`MYD-17627` or "because" inside any added comment. Rationale belongs in tests (test names and assertion messages are strings, not comments), in the ADR, or in Markdown (`.md` is skipped as `unsupported-file-type`). The long narrative headers in `stop-gate.cjs` and `validate-graph.cjs` must not be extended. Lines inside a heredoc in a `.sh` file (the route-hook body in `install-shipyard-claude-hook.sh:109-131`) are scanned as shell comments. The existing `# Managed by shipyard:` line passes only because it is a directive. Gate: `make test-comment-policy` (`publish-gate.cjs --base origin/main --working-tree --json`).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Refusal code → hint mapping (REQ-125) | Deterministic script (`scripts/refusal-hints.cjs`) | Host CLIs (stderr / capability JSON) | Deterministic and testable; hosts only print |
| Relaying hints in the user's language | Command prose (investigate.md, decompose.md) | — | Language is the conversation's job; code stays English |
| GSD project bootstrap (REQ-126) | Deterministic script (`adr-bootstrap.cjs`) | adr-ingest parser, decompose Step 0 | Same parser as ingestion; no invented requirements |
| Stop-gate arming (REQ-127) | Hook bundle (`stop-gate.cjs` + `stop-gate-arm.cjs`) | deliver.md Step 0 | The hook gets no flags and no env; only on-disk session evidence |
| Prompt routing (REQ-128) | Hook program (`auto-route.cjs`) installed by `install-shipyard-claude-hook.sh` | Codex AGENTS.md block, doctor | One text source for both runtimes |
| ADR validation (REQ-129) | Deterministic script (`adr-ingest.cjs --check`) | investigate Gate 1, template | Reuse the single ADR parser |
| Jira export plan (REQ-130) | Deterministic script (`jira-export.cjs`) | Agent via MCP (acting half, ADR-008 D4) | Pure data out; no credential in the conveyor |
| Order-only hint (REQ-131) | Gate 2 validator (`validate-graph.cjs`) warning | delivery-rules/decompose prose | Warning, never error |
| UI-gate skip (REQ-132), untracked warning (REQ-133) | Command prose (decompose.md) | — | ADR assigns these to prose pinned by docs tests |
| gsd-tune message (REQ-134) | `gsd-tune.cjs` | — | Text-only change |
| Research handback bound (REQ-135) | Workflow prompt (`investigation-research.mjs`) + trusted consumer (`claude-delivery-host.cjs`) | `references/inv-research.md` (Codex) | Bound is stated at launch and enforced before seal |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js built-ins (`fs`, `path`, `child_process`, `crypto`) | host `v24.10.0`; CI pins `24.15.0` | All scripts | Repo policy: no npm dependencies [VERIFIED: `node --version`; `.github/workflows/test.yml` per INV-003 constraints B1/B7] |
| `tests/unit/assert-harness.cjs` | in-repo | `suite`/`test`/`done`/`assert` | Only test harness in the repo [VERIFIED: tests/unit/adr-ingest.test.cjs:7] |
| bash + `set -euo pipefail` | host bash | Installers, smoke tests | CLAUDE.md rule |
| git | `2.54.0` | `ls-files` / `check-ignore` / `worktree list` / `rev-parse --git-common-dir` | Already used by stop-gate `worktreesOf` [VERIFIED: stop-gate.cjs:285-293] |

### Supporting (in-repo modules to reuse, not re-implement)
| Module | Reuse for | Evidence |
|---------|---------|----------|
| `adr-ingest.cjs` `normalizeAdr`, `sectionNodes`, `canonical` (exported); `directEntries` (NOT exported) | REQ-126, REQ-129 | `adr-ingest.cjs:207-212` exports `canonical, normalizeAdr, sectionNodes, validateAdr` [VERIFIED] |
| `frontmatter.cjs` `parseFrontmatter, stripComment, splitFlow, scalar` | REQ-130 recorder reads plan frontmatter | `frontmatter.cjs:311` [VERIFIED] |
| `lock.cjs` `withLock`, `writeAtomic` | REQ-130 record, REQ-127 marker write | used by `jira-project.cjs` and `session-observer.cjs` [VERIFIED] |
| `path-owner.cjs` `mayIntersect` | REQ-131: "shares no files_modified" must use the ONE ownership matcher | `validate-graph.cjs:31-34` [VERIFIED] |
| `role-artifact.cjs` `capSummary` (internal) / `SUMMARY_MAX_CHARS` (exported, `= 500`) | REQ-135 bounding rule | `role-artifact.cjs:26,90-95,2688` [VERIFIED] |

**Installation:** none. No external packages are installed by this phase.

## Package Legitimacy Audit

No external packages are installed by this phase (no `package.json`; all work uses Node built-ins and in-repo modules). The `package-legitimacy` seam was not run because the package list is empty.

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Per-Requirement Implementation Map

### REQ-125 — Refusal hints from one shared map
**Current state (VERIFIED by Read this session):**
- `claude-decompose-host.cjs:26-30` `refuse(code, message)`. CLI catch at `:250-254`: `process.stderr.write(\`${error.code || 'FAILED'}: ${error.message}\n\`); process.exitCode = 1;`. `--capability-only` failure prints `{ status: 'unavailable', reason: error.code || 'role_unavailable', detail: error.message, live_execution: 'not_run' }` (`:235-237`).
- `claude-investigation-host.cjs:68-72` prints only `error.message` (no code). Its own code is `'INVALID_HOST'` (`:21,32,37,47,61`). The Claude investigation CLI delegates to `runClaudeDeliveryCli`, so errors from `claude-delivery-host.cjs` surface through this catch.
- `codex-decompose-host.cjs:328-333`: `process.stderr.write('codex-decompose-host: ' + (error && error.message ? error.message : error) + '\n'); process.exitCode = 1;`
- `codex-delivery-host.cjs:469-474`: same shape with the prefix `codex-delivery-host: `. It is the Codex research host for investigate (`investigate.md:35-36`).
- `claude-dispatch-adapter.cjs:19` appends the constant `REPAIR` ("Install an ADR-014-capable Claude host with explicit workflow model and effort support; …") to **every** adapter refusal (`:28-30`, `:35-40`). This is the misleading remedy INV-003 observed. The hint map must give a code-specific remedy that is printed *in addition to* this text. Changing `REPAIR` itself touches the dispatch-boundary surface and is not required.
- The code vocabulary is large (a census over the host chain found 100+ distinct codes; the most frequent are `INVALID_INPUT`, `INVALID_ARTIFACT`, `STALE_GENERATED_AGENT`, `RUNTIME_EVIDENCE_INVALID`, `INVALID_CONTEXT_PACKET`, `NONCOMPLIANT_RECEIPT`, `UNSUPPORTED_SELECTION`, `RUNTIME_EVIDENCE_MISSING`, `INVALID_RESULT`, `MISSING_ARTIFACT`, `MISSING_RECEIPT`, `REFERENCE_UNAVAILABLE`, `RUNTIME_UNAVAILABLE`, `INVALID_HOST`) [VERIFIED: grep census over `claude-*`, `codex-*`, `dispatch-boundary`, `runtime-context`, `pipeline-config`, `run-controller`, `context-packet`, `role-artifact` `.cjs`].

**Implementation:**
1. New `plugins/delivery-pipeline/scripts/refusal-hints.cjs`, exporting a frozen `HINTS` map `{ CODE: { hint, remedy } }`, `hintFor(code)` (returns a generic default for unknown or missing codes, never `undefined`), and `formatHint(code)` → one line such as `hint: <plain language>. remedy: <action>`. Cover at least the codes a decompose/investigate session can hit: `REFERENCE_UNAVAILABLE` (reinstall gsd-core: `bash scripts/ensure-gsd-core.sh claude` / `make install-shipyard-claude-hook`), `INVALID_INPUT`, `UNSUPPORTED_ROLE`, `SCOPE_MISMATCH`, `INVALID_SIGNAL`, `CONFLICTING_OVERRIDE`, `NONCOMPLIANT_RECEIPT`, `MISSING_RECEIPT`, `INVALID_HOST`, `INVALID_ARTIFACT`, `INVALID_RESULT`, `RUNTIME_UNAVAILABLE`, `STALE_GENERATED_AGENT` (Codex: `make install-shipyard-codex`), `UNSUPPORTED_SELECTION`. Remedies must never say "skip", "bypass", "run the agent directly", "use the other runtime" or "SHIPYARD_STOP_GATE=off". A unit test enforces this with a token sweep.
2. Append the hint as an **extra stderr line** after the unchanged first line in all four CLI catch blocks (`claude-decompose-host.cjs:250-254`, `claude-investigation-host.cjs:68-72`, `codex-decompose-host.cjs:328-333`, `codex-delivery-host.cjs:469-474`). Keep `process.exitCode = 1` and the first line's exact text. In the capability JSON (`claude-decompose-host.cjs:235-237`) add a `hint` field; do not rename existing keys. The investigation CLI's first line has no code today. Adding a code prefix would change its shape, so add the code only on the hint line (for example `hint[INVALID_HOST]: …`).
3. Relay rule (prose, in the prose tickets): "On a non-zero host exit, read the `hint` line and explain it to the user in their language together with the remedy; never propose bypassing the host or switching runtime."

**Tests:** new `tests/unit/refusal-hints.test.cjs` (every mapped code has non-empty hint and remedy; unknown code → default; no bypass tokens; both Claude and Codex hosts `require('./refusal-hints.cjs')`, checked by a source-token assertion so the map is shared). Extend `tests/unit/claude-decompose-host.test.cjs:127-139` (the `UNSUPPORTED_ROLE` spawn test) to assert the hint line and an unchanged status of 1. New `tests/unit/claude-investigation-host.test.cjs` (RISKS R7: spawn with bad argv, assert status 1, the first stderr line unchanged, and a hint line present). Extend `tests/unit/codex-decompose-host.test.cjs`.
**Existing pins to keep green:** `claude-decompose-host.test.cjs:136` `/UNSUPPORTED_ROLE/`; `claude-workflow-host.test.cjs:170` `/--request-file <json> is required/`; `source-contract.test.cjs:705` `error.code === code` [CITED: INV-003 research/constraints.md C1].

### REQ-126 — Bootstrap a minimal GSD project from the ADR
**Current state:** `investigate.md:65` reads "`.planning/` exists (otherwise suggest `/gsd-new-project` and stop);" [VERIFIED]. `decompose.md` Step 0 (`:60-66`) reads `ROADMAP.md`. Step 0.5.2 (`:80-94`) runs `gsd-tune.cjs --check --runtime "$runtime"`, which exits 2 without `.planning/config.json` (`gsd-tune.cjs:325-326`) [VERIFIED]. The plan template says "requirements: REQUIRED. Requirement ids from ROADMAP.md" (`decompose.md:329`). `docs/gsd_multilevel_delivery_pipeline.md:177` also says "Preconditions: .planning/ is initialized (/gsd-new-project)" [VERIFIED].

**Implementation:**
1. `adr-ingest.cjs` must export decision extraction; `directEntries` is private today. Add and export `decisionEntries(markdown)`, which returns the array of decision texts from `normalizeAdr(markdown).content` using the same `sectionNodes`/`canonical`/`directEntries`/`childEntry` logic that `countDecisionEntries` (`:137-141`) counts. **Assign this edit to the REQ-129 ticket**, which owns `adr-ingest.cjs` (see slicing).
2. New `plugins/delivery-pipeline/scripts/adr-bootstrap.cjs`, run from the project root (`process.cwd()`, like gsd-tune):
   `node adr-bootstrap.cjs --adr <path> [--phase <N>] [--json]`
   - It reads the ADR and calls `decisionEntries`. If there are 0 entries it prints a plain-language refusal to stderr ("<adr> has no bullets under `## Decision`; add one bullet per locked decision (see templates/adr/ADR.md) and re-run") and exits 1.
   - It creates **only missing** files among `.planning/config.json`, `.planning/ROADMAP.md` and `.planning/REQUIREMENTS.md` (use `fs.writeFileSync(file, data, { flag: 'wx' })` so an existing file is never truncated, even in a race).
   - `config.json`: minimal JSON containing the one REQUIRED conveyor key, `{"git":{"branching_strategy":"none"}}` (gsd-tune REQUIRED list, `gsd-tune.cjs:469-472`: `['git.branching_strategy', 'none', …]` [VERIFIED]).
   - `ROADMAP.md`: one phase for the ADR, mirroring the in-repo block shape `### Phase <N>: <ADR title>` / `**Status**:` / `**Requirements**: REQ-01, …` / one-line goal (see `.planning/ROADMAP.md:729-741`). Keep the goal on **one line** (the multi-line `**Goal**` GSD defect is out of scope).
   - `REQUIREMENTS.md`: `- [ ] **REQ-NN**: <decision text>` per decision, in ADR order, plus a traceability table `| REQ-NN | Phase <N> | Pending |` (shape of `.planning/REQUIREMENTS.md:137-147,283-293`).
   - Output: a JSON report `{ created: [...], skipped_existing: [...], requirements: [{id, decision}] }`.
   - Partial state (for example ROADMAP exists but REQUIREMENTS is missing): create only the missing file and report `skipped_existing`. Never merge into an existing ROADMAP. See Open Question 3.
3. Prose: investigate Step 1 precondition becomes "`.planning/investigations/` is created if missing; no GSD project is required". decompose Step 0 gains a bootstrap item **before** Step 0.5 (gsd-tune would otherwise refuse first). docs file line 177 is updated.

**Tests:** new `tests/unit/adr-bootstrap.test.cjs`, covering: an empty project gets all three files with REQ ids 1:1 to the ADR bullets; an existing `ROADMAP.md` stays byte-identical (RISKS R4); an ADR with no decisions gives exit 1 and a plain message without a stack trace; a nested-`###` ADR (reuse the `NESTED` fixture shape from `adr-ingest.test.cjs:10-50`) gives one REQ per `###` decision; the generated config passes `gsd-tune.cjs --check --runtime claude` REQUIRED (spawn gsd-tune in the temp dir; tuning drift may still exit 1, so assert "no REQUIRED drift" from `--json`, not exit 0).
**Dependency:** real code dependency on the REQ-129 ticket (`decisionEntries` export).

### REQ-127 — Stop gate enforces only in deliver-armed sessions
**Current state (VERIFIED):** `stop-gate.cjs:254` kill switch `SHIPYARD_STOP_GATE=off`. `:256-260` reads the stdin payload. `:265-267` `sessionId` from `payload.session_id`. `:489-513` scoped mode (`run_id` / `SHIPYARD_RUN_ID` / `SHIPYARD_RUN_CONTROL=scoped` / `SHIPYARD_RUN_STORE_DIR`). `:514-523` unscoped candidates `[cwd, ...worktreesOf(cwd)]`. `:524` `if (!candidates.length) allow();`. `:528` newest `generated_at` wins. The ledger `LEDGER_NAME = 'stop-gate-ledger.json'` (`:232`) sits in the chosen `graphDir`. The hook is installed as a self-contained bundle: `copy_stop_bundle` copies the relative `require` closure of `stop-gate.cjs` (`install-shipyard-claude-hook.sh:137-181,199`), so a new module required by `stop-gate.cjs` ships automatically. Codex has no stop hook (no `Stop`/stop-gate in `install-shipyard-codex.sh`), so REQ-127 is Claude-only.

**Implementation:**
1. New `plugins/delivery-pipeline/scripts/stop-gate-arm.cjs`, exporting `markerPath(cwd, sessionId)`, `arm(cwd, sessionId)`, `isArmed(cwd, sessionId)` with a CLI `node stop-gate-arm.cjs arm --session-id <id>`.
   - Validate `sessionId` against a strict pattern (for example `/^[A-Za-z0-9_-]{8,128}$/`). Refuse anything else, including an unsubstituted `${CLAUDE_SESSION_ID}` literal (`@security:` marker comment allowed). This prevents path traversal through the id.
   - Marker location, recommended [ASSUMED design]: `<git rev-parse --git-common-dir>/shipyard/stop-gate-armed/<session_id>.json` (shared by all worktrees of the repo, never tracked, no target-project `.gitignore` edit needed). Fallback when cwd is not a git repo: `<cwd>/.planning/graph/stop-gate-armed/<session_id>.json`, with a matching entry added to this repo's `.gitignore` next to `.planning/graph/stop-gate-ledger.json`.
   - The marker body is `{ session_id, armed_at, cwd }`. `isArmed` returns true only for a readable, parseable marker whose `session_id` equals the requested one. It returns false on any error (fail open, `stop-gate.cjs:19-33` principle).
2. `stop-gate.cjs`: in the **unscoped branch only** (`:514-523`), before selecting candidates, `if (!sessionId || !isArmed(cwd, sessionId)) allow();`. Scoped mode keeps its current behaviour (a controller run is already positive evidence). Cross-worktree discovery (`:516`) is unchanged for armed sessions. Hook budget: one extra `git rev-parse` spawn (use a `timeout` like `worktreesOf`).
3. `deliver.md` Step 0 (`:1226-`) gains item "Arm the stop gate (Claude only): `node ${CLAUDE_PLUGIN_ROOT}/scripts/stop-gate-arm.cjs arm --session-id "${CLAUDE_SESSION_ID}"`; Codex has no stop hook, so skip". Update the self-check sentence at `:2656-2657` ("You can also run `stop-gate.cjs` yourself — pipe it `{}`"): after this change `{}` has no session_id and always allows, so the instruction must pipe `{"session_id":"<this session id>"}`.
4. `--fork-session` produces a new id, so a forked session must re-arm (ADR consequence). Document this in deliver.md.

**Tests:** `tests/unit/stop-gate.test.cjs` has 84 `test(`/`suite(` entries. Most assert a **block** with payload `{}` in non-git temp dirs (helpers `project()`, `run()`, `runIn`, `runFull`, lines 58-80+). **All of those would flip to allow.** The helpers must arm by default: inject a fixed `session_id` and write the fallback marker in the temp dir. Keep the dedicated no-session tests (`:707` "a payload with no session_id keeps the old one-block rule") and re-state their intent: without a session id the gate now allows. That is an intended behaviour change and needs a deliberate test rewrite, flagged in the plan. New cases:
- an analysis-only session (no marker) next to a fresh live foreign front → allow;
- a marker for another session_id → allow;
- an unreadable marker → allow;
- an armed session next to a live sibling worktree → block (keeps `:393` and `:417` green);
- an armed session with a stale main checkout (the 2026-08-30 case) → block.

New `tests/unit/stop-gate-arm.test.cjs` covers id validation, the git-common-dir path, the non-git fallback and the `wx`/atomic write. `tests/smoke/claude-hook-smoke.sh` uses a **fake** `stop-gate.cjs` (`:15-24`) and needs no change for REQ-127.

### REQ-128 — Route hook: investigate route, stdin-aware, Codex + doctor parity
**Current state (VERIFIED):** `install-shipyard-claude-hook.sh:109-131` writes `shipyard-auto-route.sh` as a static `cat <<'POLICY'` that ignores stdin. It is registered at `:243` (`add_hook UserPromptSubmit "$ROUTE_CMD"`, `ROUTE_CMD="bash \"$ROUTE_HOOK\""` at `:37`). The policy routes only "large / multi-ticket → /shipyard:decompose → /shipyard:deliver; … /shipyard:bench; … inline". The Codex block `install-shipyard-codex.sh:586-619` is built in a Node heredoc between `<!-- shipyard-auto-route:begin -->` and `<!-- shipyard-auto-route:end -->`, with a phase-aware `largeRoute` (`:592-594`). `route.md:63` already routes "unclear, needs research, decisions not yet made, or a raw problem" → `/shipyard:investigate`. `scripts/shipyard-doctor.cjs` checks the Stop, observer and PreToolUse hooks (`:135-151`) and never checks `UserPromptSubmit` or AGENTS.md. `tests/smoke/claude-hook-smoke.sh` never asserts route text. `codex-shipyard-smoke.sh:250` only greps `shipyard-auto-route:begin`.

**Implementation:**
1. New `plugins/delivery-pipeline/scripts/auto-route.cjs` as the single text source:
   - exports `claudePolicy()` (the Claude text with a new bullet "unclear / needs research / decisions not made → `/shipyard:route` sends it to `/shipyard:investigate`"), `codexBlock(phase)` (the full marker-delimited block with `$shipyard-investigate` in both phases; phase 1 ships investigate, see CLAUDE.md `SHIPYARD_CODEX_PHASE=1`), and `shouldInject(rawStdin)`;
   - its CLI reads stdin, prints `claudePolicy()` when `shouldInject` is true, and **always exits 0** (a UserPromptSubmit exit 2 would block the user's prompt [ASSUMED from Claude Code hook semantics]);
   - `shouldInject` rules: JSON parse failure or no string `prompt`/`prompt_text` → inject; trimmed prompt starting with `<task-notification>` → silent; trimmed prompt starting with `/` or containing `<command-name>` / `<command-message>` → silent (the exact expanded-slash-command shape is an open question, R14); otherwise inject.
   - Keep the module dependency-free, or only `require` relative modules, so `copy_stop_bundle` can bundle it.
2. `install-shipyard-claude-hook.sh`: copy `auto-route.cjs` into `$CLAUDE_HOME/hooks/` (use the `SHIPYARD_PLUGIN_DIR` → `$ROOT/plugins/...` fallback pattern of `:185-192`/`:206-210`; the hook smoke uses a fake plugin dir that lacks it) and make `shipyard-auto-route.sh` a thin wrapper, `exec node "<abs>/shipyard-auto-route.cjs"`. **Keep `ROUTE_HOOK` and `ROUTE_CMD` unchanged** so existing `settings.json` registrations stay valid, with no migration needed. Keep the directive-only comment line. `--remove` (`:83-93`) must also delete the new file.
3. `install-shipyard-codex.sh:586-619`: replace the inline `block` literal with `require(<plugin>/scripts/auto-route.cjs).codexBlock(phase)`. Keep the marker strings, the in-place regex replace (`:615-617`) and the symlink refusal behaviour tested at `codex-shipyard-smoke.sh:253-278`.
4. `scripts/shipyard-doctor.cjs`: add checks `claude-route-hook` (`UserPromptSubmit` contains `bash "<CLAUDE_HOME>/hooks/shipyard-auto-route.sh"`; the installed `.cjs` is byte-identical to the source `plugins/delivery-pipeline/scripts/auto-route.cjs`, else `warn` "reinstall: make install-shipyard-claude-hook") and `codex-route-block` (AGENTS.md block equals `codexBlock(1)` or `codexBlock(2)`). The existing smoke asserts `report.status === 'ok'` after install (`claude-hook-smoke.sh:61-67`), so a fresh install must pass the new checks.
5. README.md `:48-52`: mention that the auto-route hook reads the prompt and stays silent for notifications and slash commands.

**Tests:** new `tests/unit/auto-route.test.cjs`, with fixture payloads for a plain request (inject), `prompt_text` field (inject), a slash command, `<command-name>` (silent), `<task-notification>` (silent), invalid JSON / empty stdin (inject), exit code always 0, the policy containing `/shipyard:investigate` and `/shipyard:route`, and `codexBlock(1)`/`codexBlock(2)` containing `$shipyard-investigate`. Extend `tests/smoke/claude-hook-smoke.sh`: after install, run the installed hook with fixture payloads and assert the `UserPromptSubmit` registration. Doctor stays `ok`. `--remove` deletes the route files. Extend `tests/smoke/codex-shipyard-smoke.sh:250`: grep `\$shipyard-investigate` inside the block. This smoke is network-backed (`make test`), not in `test-fast`.

### REQ-129 — ADR template + `adr-ingest --check` + Gate 1
**Current state (VERIFIED):** `adr-ingest.cjs:148-163` `parseArgs` requires `--input` plus `--output` or `--output-dir`. `:181-189` `prepareOutputDir` **deletes** existing `*.ingest.md`. `:143-146` `validateAdr` throws "`${input}: no decisions were found under an ADR Decision section`". The CLI exits 1 on error (`:198-205`). `plugins/delivery-pipeline/templates/` contains only `inv/`. Gate 1 (`investigate.md:170-184`) runs only `validate-inv.cjs`.

**Implementation:**
1. `adr-ingest.cjs`: add `--check`, which is mutually exclusive with `--output`/`--output-dir` (throw a usage error if combined). In check mode, `main` never calls `prepareOutputDir` or `processInput`'s write path. For each input it runs `normalizeAdr` + `validateAdr` and prints `<input>: OK (<n> decisions)` (or JSON with `--json`). Exit 0 when all inputs pass, else exit 1 with the existing message. Split `processInput` into a pure `checkInput(input)` and the write step. Also add and export `decisionEntries` (REQ-126 needs it; see above).
2. New `plugins/delivery-pipeline/templates/adr/ADR.md`, mirroring ADR-016's shape: a header bullet list (`- **Status:**`, `- **Date:**`, `- **Decision owner:**`, `- **Scope:**`, `- **Supersedes:**`, `- **Related:**`, `- **UI design:** none | <design source>`), then `## Context`, `## Decision` (at least one placeholder bullet so the template itself passes `--check`), `## Consequences`, `## Out of scope`. It must contain no nested `###` under machine-read sections (`investigate.md:176-179`). The generator copies `templates/` into the Codex payload automatically (`scripts/gen-codex-shipyard.cjs:332-336` [VERIFIED]).
3. investigate Gate 1 (prose ticket): step 2 generates the ADR from `${CLAUDE_PLUGIN_ROOT}/templates/adr/ADR.md`, and a new step runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/adr-ingest.cjs --check --input <ADR path>`, which must exit 0 before step 3 closes the INV.

**Tests:** extend `tests/unit/adr-ingest.test.cjs` (113 lines; it imports `normalizeAdr, validateAdr` at `:8` and spawns the CLI at `:94-112`). Cases: `--check` on the FLAT/NESTED fixtures → exit 0 and no file created; `--check` on an ADR with no decisions → exit 1; `--check` with `--output-dir` → usage error; `--check` leaves a pre-existing `*.ingest.md` in a directory untouched (RISKS R6); the shipped template passes `normalizeAdr`+`validateAdr` (the same function, per the scope fence); `decisionEntries` returns the NESTED fixture's two decisions.

### REQ-130 — Deterministic Jira export plan
**Current state (VERIFIED):** `decompose.md:488-613` is prose that drives MCP tools, with "do not hand-roll REST calls" at `:538-539`. The label contract is `shipyard-<owner>-<repo>-T-<phase>-<plan>`, the epic label is `shipyard-epic-<owner>-<repo>-<phase>`, the summary is `<ticket-id>: <title>`, the epic summary is `[<phase>] <phase title>`, and the pointer line is `Source of truth: <owner>/<repo>:<plan path> (this issue is a generated projection)`. Links: "for each `depends_on`, a "is blocked by" issue link to that dependency's issue". Write-back is `delivery.jira: <KEY>`, then re-run `validate-graph.cjs` (`:554-611`). `jira-project.cjs` is a transitions watermark only. Its test sweeps its own source for network tokens (`jira-project.test.cjs:825-837`: `/\bfetch\b/, /https?:/, /\bmcp\b/i, /\bgh\b/, /\bcurl\b/, /\bspawnSync\b/, /\bexecSync\b/, /\bchild_process\b/, /XMLHttpRequest/, /require\(['"](https?|net|tls|dgram)['"]\)/`). `validate-graph.cjs:177` reads `delivery.jira` into `tickets.json` (`:588`).

**Implementation:** new `plugins/delivery-pipeline/scripts/jira-export.cjs` (do not grow `jira-project.cjs`; that would conflict with its purpose and its tests):
- `jira-export.cjs plan --repo <owner>/<repo> --project <KEY> [--issue-type Task] [--epic-issue-type Epic|none] [--graph <dir>] [--json]`. It reads `tickets.json` and each ticket's PLAN body (`## Goal`, `## Scope`, `## Acceptance criteria`) from local files only. It emits a **pure-data, deterministically ordered** plan: epics per phase, then issues in topological order (dependency parents first, ties by id), then links with explicit `{ type: "Blocks", inward: <dependency key-ref>, outward: <dependent key-ref>, phrase: "<dependent> is blocked by <dependency>" }`, with direction taken from `depends_on`. Each step has an idempotency lookup `{ jql: 'project = KEY AND labels = "<label>"' }` and a legacy-label fallback, per the existing lookup order (`decompose.md:556-583`). The owner/repo are passed in by the agent, because the script must not run `gh` (the token sweep forbids `\bgh\b`). The link-type name is left for the agent to resolve via `getIssueLinkTypes` but must be recorded in the plan as a required-semantics field ("the inward description of the chosen type must read `is blocked by`").
- `jira-export.cjs record <ticket> <KEY> [--graph <dir>]`: validates `<KEY>` (`^[A-Z][A-Z0-9]+-\d+$`), inserts or updates `jira: <KEY>` inside the ticket's PLAN frontmatter `delivery:` block (a line edit, preserving all other bytes), and prints the reminder to re-run `validate-graph.cjs`. It refuses when no such ticket exists in `tickets.json`.
- It speaks to no network and writes no credential.
- decompose Step 5 (prose ticket): replace the free-form procedure with "run `jira-export.cjs plan`, execute each step verbatim through the connected MCP, call `jira-export.cjs record` per created or found key, re-run validate-graph". Keep the skip rules (`:497-502`) and the "never blocks decomposition" sentence.

**Tests:** new `tests/unit/jira-export.test.cjs` with a fixture graph (a diamond plus a chain):
- the plan is byte-identical across runs;
- parents come before children;
- every `depends_on` becomes exactly one link with dependent=outward-blocked;
- labels are namespaced and lowercase-sanitized;
- the source-of-truth line is a single line;
- `--epic-issue-type none` produces no epics;
- `record` changes only the `jira:` line (a byte diff of the rest), is idempotent, and refuses an unknown ticket or a malformed key;
- a copy of the network-token sweep runs over `jira-export.cjs`.

This initiative's own tickets are **not** exported, since this repo has `pipeline.jira.enabled: false` (`.planning/config.json` [VERIFIED: `"jira": {"enabled": false}`]).

### REQ-131 — Order-only is not `depends_on`; validator hint
**Current state (VERIFIED):** `validate-graph.cjs:534` `same` = same-phase, same-repo dependencies. `:545-549` diamond warning, verbatim: "`${id}: ${same.length} same-phase parents (${same.join(', ')}) — the cascade bases on ${t.primary_parent} only; the others land through the epic. Linearize the chain if ${id} needs every parent's code at once.`" The contested-path check at `:413-455` uses `mayIntersect` over `a.files.filter(ownable)`. Prose: `decompose.md:432` "linearize the chain where possible"; `skills/delivery-rules/SKILL.md` §7 "linearize when practical" (line ~114). `.shipyard/generated/gsd-delivery-rules/SKILL.md` is the managed projection, byte-identical to the source SKILL.md plus a trailing `<!-- shipyard-managed: gsd-delivery-rules -->` marker [VERIFIED: diff]. gsd-tune reports a `stale-managed` projection as a REQUIRED failure (`gsd-tune.cjs:682`, `gsd-tune.test.cjs:142`), and decompose Step 0.5 blocks on that.

**Implementation:**
1. `validate-graph.cjs`, inside the `for (const id of order)` loop at `:529-555`: for each `d` in `same`, if no pair `(fa ∈ t.files.filter(ownable), fb ∈ tickets[d].files.filter(ownable))` satisfies `mayIntersect(fa, fb)`, push a warning such as "`${id}: depends_on ${d} shares no files_modified with it — if ${id} does not need ${d}'s code, drop the dependency (ordering alone is not a depends_on; it serializes waves and pr_base)`". Use `mayIntersect` (the ONE matcher), not string equality. The check is a warning only; exit status is unchanged.
2. `skills/delivery-rules/SKILL.md` §7 and `decompose.md:425-432` adopt the validator condition: linearize **only if** the child needs every parent's code at once, and an ordering-only relation is not a `depends_on`. Regenerate the projection `.shipyard/generated/gsd-delivery-rules/SKILL.md` (source bytes + `\n<!-- shipyard-managed: gsd-delivery-rules -->\n`), for example with `node plugins/delivery-pipeline/scripts/gsd-tune.cjs --apply --runtime claude`. Check first that `--apply` changes nothing else in `.planning/config.json`, or write the projection by the same rule as `gsd-tune.test.cjs:27-30` `projectionBody`.

**Tests:** `tests/smoke/graph-validator-smoke.sh` (the `plan()` fixture helper at `:26-50`): new cases "same-phase dependency with disjoint files → warning, exit 0", "dependency with overlapping files → no such warning", "cross-repo/cross-phase dependency → not this warning" (those have their own warnings). Existing negative assertions (`:311`, `:609-612`, `:631`) grep specific texts and are unaffected, but re-run the full smoke. A prose pin for SKILL.md goes in the prose/validator ticket's own test. `tests/unit/gen-codex-shipyard.test.cjs:319-320` asserts that the bundle's SKILL.md equals the source; it stays green automatically.

### REQ-132 — `--skip-ui` only on `UI design: none`
**Current state (VERIFIED):** `decompose.md:277-278` "`/gsd-plan-phase <N> --ingest .planning/.adr-ingest/*.ingest.md [--tdd|--mvp]`". `source-contract.test.cjs:918` pins the exact substring `'/gsd-plan-phase <N> --ingest .planning/.adr-ingest/*.ingest.md'`. The ADR-016 header line is `- **UI design:** none` [VERIFIED: ADR-016 line 9]. GSD supports `/gsd-plan-phase <N> --skip-ui` [CITED: INV-003 RESEARCH.md §9, `~/.claude/gsd-core/workflows/plan-phase.md:119,519`; not re-read this session because the sandbox denied `~/.claude`].
**Implementation (prose):** append `[--skip-ui]` after the pinned literal, and add the rule: "Add `--skip-ui` only when a selected ADR's header has the exact line `- **UI design:** none` (case-insensitive on `none`); any other value, or no line at all → invoke exactly as before. With several ADRs, skip only if all declare none." Keep `/gsd-plan-phase` after `adr-ingest.cjs` (`source-contract.test.cjs:2002-2009`).
**Tests:** in the decompose prose ticket's new contract test, assert the pinned literal is still present, `--skip-ui` is present, and the condition sentence names `UI design: none`.

### REQ-133 — Warn once on untracked `.planning/`
**Current state:** no intake check exists. Untracked `.planning/` is a supported mode (`drift-needed.cjs:299`, `graph-dir.cjs:9,74`) [CITED: INV-003 RESEARCH.md §8].
**Implementation (prose, decompose Step 0):** "Run `git ls-files --error-unmatch .planning >/dev/null 2>&1` (or `git check-ignore -q .planning`). If `.planning/` is not tracked, tell the user once, without stopping: delivery worktrees are created from git, so they will not contain the PLAN files or graph and the conveyor falls back to `graph-dir.cjs` resolution; remedy: commit `.planning/` (or keep it untracked deliberately and pass the graph dir explicitly). Never block." Wording must reuse the actual failure path named by `graph-dir.cjs:74`.
**Tests:** a prose pin in the decompose contract test (the warning exists, contains "does not block"/"never block", names the remedy).

### REQ-134 — gsd-tune names the file and the creating command
**Current state (VERIFIED):** `gsd-tune.cjs:322` `function fail(msg, code = 2) { process.stderr.write(\`gsd-tune: ${msg}\n\`); process.exit(code); }`; `:326` `if (!GLOBAL) fail(\`no ${CONFIG} — run this from a GSD project (the conveyor's own project root)\`);`. Test `gsd-tune.test.cjs:356-361` asserts only `notEqual(r.status, 0)` and that no config is conjured.
**Implementation:** change only the template string at `:326`. For example: "`no ${CONFIG} — this directory is not a GSD project yet. Create it with /shipyard:decompose (bootstraps .planning/config.json from an accepted ADR) or /gsd-new-project, then re-run gsd-tune from that project root`". Name commands, not a script path, so there is no file coupling to REQ-126. Keep `fail(...)` with the default code 2, and keep `ROOT = process.cwd()` (walking upward was rejected).
**Tests:** tighten the existing test at `gsd-tune.test.cjs:356-361`: `assert.equal(r.status, 2)`, `assert.match(r.stderr, /^gsd-tune: /)`, stderr includes `path.join(dir, '.planning', 'config.json')` and `decompose`.

### REQ-135 — Research handback bound at launch and before seal
**Current state (VERIFIED):** `workflows/investigation-research.mjs:28-38` declares `OUT` with `summary: { type: 'string', maxLength: 500 }` and passes it only as `agentOptions.schema` (`:270-275`). `linePrompt` (`:197-227`) never states the bound: `:224` says "Return only id, status, summary, and a bounded artifact reference for that exact file." `claude-runtime-host.cjs:733-738` uses `structured_output` only when present. `claude-delivery-host.cjs:506-516` `sealPlanningResearch` rejects with the generic "planning research has invalid scope or result" when `Array.from(result.summary).length > 500` (`:512`). `reject` throws code `'INVALID_HOST'` (`:28-32`), and `claude-dispatch-adapter.cjs:983-989` wraps it as `INVALID_ARTIFACT` "trusted role-artifact consumer failed: …" + the `REPAIR` suffix, which is the misleading "Install an ADR-014-capable Claude host…" text. After a successful seal the adapter returns the envelope's summary (`boundedResultForArtifact`, `:223-`, `:1031-1036`), and `role-artifact.cjs:90-95` `capSummary` already caps summaries to `SUMMARY_MAX_CHARS - 3` + `'...'`. `references/inv-research.md:19` shows `"summary": "short bounded account"` with no number.

**Implementation:**
1. At launch: add a line to `linePrompt`: "`summary` is plain text of at most 500 characters; put everything else in the artifact file; return the JSON object only, with no prose after it." Add "at most 500 characters" to `references/inv-research.md` (this reaches Codex workers through the generated bundle).
2. Before seal, in `sealPlanningResearch`: split the summary-length condition out of the combined `if` at `:508-516` so the scope/receipt checks stay byte-for-byte the same. **Recommended: bound**. If the summary is over 500, replace it with the same cap rule as `capSummary` (497 chars + `...`, counted with `Array.from`) before calling the seal, and write one stderr line such as `claude-delivery-host: research line <id> summary was <n> characters; bounded to 500 (full finding at <artifactPath>)`. Bounding preserves the verified research, which a refusal would discard for the whole fan-out (the INV-003 loss). The alternative (refuse) must throw with a message naming `<id>` and `<n>`, and must not end with the adapter `REPAIR` text. That needs an error the adapter does not wrap (see Open Question 2).
3. The envelope schema, the receipt checks and `validatePlanningArtifact` (`claude-dispatch-adapter.cjs:335-337`, still ≤500) are unchanged.

**Tests:** extend `tests/unit/planning-artifacts.test.cjs` (suite at `:162`, research cases at `:164-226`): a 1,106-character summary (the INV-003 figure) gets sealed with a bounded summary ≤500, the artifact on disk is unchanged, and the stderr/notice names the line and length. A 500-character summary is untouched. Extend `tests/unit/investigation-research.test.cjs`: the `linePrompt` text contains "at most 500 characters". Where the Codex seal path does not go through `sealPlanningResearch`, confirm in the plan that `role-artifact.cjs` `capSummary` already bounds it (not verified end-to-end this session).

## File-Sharing Matrix (the input for disjoint `files_modified`)

| File | REQs touching it | Conflict resolution |
|------|------------------|---------------------|
| `plugins/delivery-pipeline/commands/decompose.md` | 125, 126, 130, 131, 132, 133 | **One prose ticket owns it** (P-D) |
| `plugins/delivery-pipeline/commands/investigate.md` | 125, 126, 129 | **One prose ticket owns it** (P-I) |
| `plugins/delivery-pipeline/scripts/adr-ingest.cjs` | 129 (`--check`), 126 (`decisionEntries` export) | REQ-129 ticket owns both edits; REQ-126 depends on it (a real import) |
| `tests/unit/adr-ingest.test.cjs` | 129, 126 | REQ-129 ticket owns it |
| `plugins/delivery-pipeline/scripts/claude-delivery-host.cjs` | 135 (seal), 125 (only if its CLI catch `:962-967` got a hint) | REQ-125 does **not** touch it (the Claude investigation CLI prints through `claude-investigation-host.cjs:68-72`) |
| `plugins/delivery-pipeline/commands/deliver.md` | 127 only | REQ-127 ticket |
| `tests/smoke/claude-hook-smoke.sh` | 128 (REQ-127 needs no change: the smoke uses a fake stop-gate) | REQ-128 ticket |
| `scripts/install-shipyard-claude-hook.sh` | 128 (127 needs no change: bundle closure is automatic) | REQ-128 ticket |
| `plugins/delivery-pipeline/skills/delivery-rules/SKILL.md` + `.shipyard/generated/gsd-delivery-rules/SKILL.md` | 131 | REQ-131 validator ticket |
| `README.md` | 128 (hook behaviour); 126/127 could also want a sentence | REQ-128 ticket owns README; other tickets do not touch it |
| `docs/gsd_multilevel_delivery_pipeline.md` (`:177` `/gsd-new-project` precondition) | 126 | P-I prose ticket |
| `tests/unit/source-contract.test.cjs` | would be touched by any prose pin | **Do not extend it.** Each prose ticket creates its own contract test file |
| `.gitignore` | 127 (non-git fallback marker path) | REQ-127 ticket |
| `plugins/delivery-pipeline/.claude-plugin/plugin.json` + capability version + release notes | release | Out of the phase tickets, or one final release ticket (see Open Question 6) |

## Ticket Slicing (recommended, disjoint `files_modified`)

| Ticket | REQs | files_modified (complete) | depends_on |
|---|---|---|---|
| A — refusal hints | 125 (code half) | `plugins/delivery-pipeline/scripts/refusal-hints.cjs`, `…/scripts/claude-decompose-host.cjs`, `…/scripts/claude-investigation-host.cjs`, `…/scripts/codex-decompose-host.cjs`, `…/scripts/codex-delivery-host.cjs`, `tests/unit/refusal-hints.test.cjs`, `tests/unit/claude-decompose-host.test.cjs`, `tests/unit/claude-investigation-host.test.cjs`, `tests/unit/codex-decompose-host.test.cjs` | — |
| B — ADR template + check | 129 (code half) + `decisionEntries` for 126 | `…/scripts/adr-ingest.cjs`, `…/templates/adr/ADR.md`, `tests/unit/adr-ingest.test.cjs` | — |
| C — deliver-armed stop gate | 127 | `…/scripts/stop-gate.cjs`, `…/scripts/stop-gate-arm.cjs`, `…/commands/deliver.md`, `tests/unit/stop-gate.test.cjs`, `tests/unit/stop-gate-arm.test.cjs`, `.gitignore` | — |
| D — route hook | 128 | `…/scripts/auto-route.cjs`, `scripts/install-shipyard-claude-hook.sh`, `scripts/install-shipyard-codex.sh`, `scripts/shipyard-doctor.cjs`, `tests/unit/auto-route.test.cjs`, `tests/smoke/claude-hook-smoke.sh`, `tests/smoke/codex-shipyard-smoke.sh`, `README.md` | — |
| E — Jira export plan | 130 (code half) | `…/scripts/jira-export.cjs`, `tests/unit/jira-export.test.cjs` | — |
| F — order-only hint | 131 (validator + skill) | `…/scripts/validate-graph.cjs`, `tests/smoke/graph-validator-smoke.sh`, `…/skills/delivery-rules/SKILL.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md` | — |
| G — gsd-tune message | 134 | `…/scripts/gsd-tune.cjs`, `tests/unit/gsd-tune.test.cjs` | — |
| H — research handback bound | 135 | `…/workflows/investigation-research.mjs`, `…/scripts/claude-delivery-host.cjs`, `…/references/inv-research.md`, `tests/unit/planning-artifacts.test.cjs`, `tests/unit/investigation-research.test.cjs` | — |
| I — ADR bootstrap | 126 (code half) | `…/scripts/adr-bootstrap.cjs`, `tests/unit/adr-bootstrap.test.cjs` | B (imports `decisionEntries`) |
| P-D — decompose prose | 125/126/130/131/132/133 prose | `…/commands/decompose.md`, `tests/unit/decompose-friction-contract.test.cjs` | — (text-only contract; CLI contracts fixed below) |
| P-I — investigate prose | 125/126/129 prose | `…/commands/investigate.md`, `docs/gsd_multilevel_delivery_pipeline.md`, `tests/unit/investigate-friction-contract.test.cjs` | — |

Result: wave 1 = A, B, C, D, E, F, G, H, P-D, P-I; wave 2 = I. B and I share no path. I only imports B's code, so under REQ-131's own new warning I→B would warn "shares no files_modified". That is a **true code dependency**, so the warning is a hint, not an error. The warning text must say "if … does not need …'s code" (see Pitfall 7). If the planner wants P-D/P-I contract tests to assert that referenced scripts exist (`fs.existsSync`), those tickets gain real dependencies on A/B/E/I. That creates a diamond for P-D (I and E): the child bases on one parent only (ADR consequence), so its test would fail in the worktree. **Keep P-D/P-I tests text-only.** Check script existence in the phase verification step (`grep -oE 'scripts/[a-z-]+\.cjs' …/commands/decompose.md | sort -u | xargs -I{} test -f plugins/delivery-pipeline/{}`).

### Fixed CLI contracts (both sides of a prose/script split must match these)
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/adr-ingest.cjs --check --input <adr> [--input …] [--json]` → exit 0 / exit 1.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/adr-bootstrap.cjs --adr <adr> [--phase <N>] [--json]` (run from the project root) → exit 0 plus a report; exit 1 plus a plain refusal when there are no decisions.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/jira-export.cjs plan --repo <owner/repo> --project <KEY> [--issue-type <t>] [--epic-issue-type <t|none>] [--graph <dir>] [--json]`; `… jira-export.cjs record <T-NN-MM> <KEY> [--graph <dir>]`.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/stop-gate-arm.cjs arm --session-id "${CLAUDE_SESSION_ID}"` (Claude only).
- Host refusal stderr: line 1 unchanged; line 2 `hint[<CODE>]: <plain language> — remedy: <action>`.

## Architecture Patterns

### System Architecture Diagram
```
 user prompt ──► UserPromptSubmit ──► auto-route.cjs (stdin JSON)
                                         │ unparseable/plain → print policy (→ /shipyard:route → investigate|decompose|deliver|bench)
                                         │ <task-notification> | slash command → silent
                                         ▼
 /shipyard:investigate ──► .planning/investigations/INV-*/ ──► Gate 1: validate-inv + adr-ingest --check ──► ADR (templates/adr/ADR.md)
                                                                                                     │
 /shipyard:decompose ─► Step 0: find ADR ─► [config/ROADMAP/REQUIREMENTS missing?] ─yes─► adr-bootstrap.cjs (decisionEntries from adr-ingest)
                        │                   [.planning untracked?] ─► warn once
                        ▼
                  Step 0.5 gsd-tune --check (missing config → exit 2 + named file + creating command)
                        ▼
                  Step 2 adr-ingest → /gsd-plan-phase --ingest … [--skip-ui iff "UI design: none"] ─► hosts (refusal → code + hint line)
                        ▼
                  Gate 2 validate-graph (new warning: dependency shares no files_modified)
                        ▼
                  Step 5 jira-export.cjs plan ─► agent executes via MCP ─► jira-export.cjs record → validate-graph
 /shipyard:deliver ─► Step 0: stop-gate-arm arm --session-id ─► marker (git-common-dir/shipyard/stop-gate-armed/<sid>.json)
 Stop hook ─► stop-gate.cjs: scoped? → existing path │ unscoped: session armed? no → allow │ yes → newest front across worktrees → verdict
 investigation research ─► linePrompt states ≤500 ─► agent ─► sealPlanningResearch (bound + notice) ─► role-artifact seal
```

### Pattern: CLI module with exported pure functions + `require.main` guard
Follow `adr-ingest.cjs:191-212` (a pure `main(argv)`, try/catch at `require.main === module`, `process.exitCode = 1`, exported helpers). Tests `require` the module for pure functions and `spawnSync(process.execPath, [SCRIPT, …])` for the CLI surface (`claude-decompose-host.test.cjs:127-139`).

### Pattern: fail-open hook
Every branch of `stop-gate.cjs` and `auto-route.cjs` that meets missing, unreadable or ambiguous input must end in allow (stop) or inject (route), and exit 0. An uncaught throw is a defect (`stop-gate.cjs:19-33,475-487`).

### Anti-Patterns to Avoid
- A second ADR parser in `adr-bootstrap.cjs` (reimplementing `directEntries`). Import `decisionEntries` instead.
- Adding an order-only field to `tickets.json` (explicitly out of scope).
- A Jira client, `gh`, or any `child_process` call in `jira-export.cjs` (the token sweep will fail, and ADR-008 D4 forbids it).
- Editing `.build/` or committing generated Codex output (`.build/` is gitignored).
- Changing `ROUTE_CMD`/`ROUTE_HOOK` names (this forces a settings migration and breaks doctor/smoke expectations).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ADR decision extraction | regex over `## Decision` | `adr-ingest.cjs` `normalizeAdr` + new `decisionEntries` | Nested `###` decisions, fences and heading aliases are already handled (`:6-141`) |
| Path overlap for REQ-131 | string equality / prefix | `path-owner.cjs` `mayIntersect` | "The ONE ownership matcher" (`validate-graph.cjs:31-34`) |
| Frontmatter reading in `record` | ad-hoc YAML | `frontmatter.cjs` `parseFrontmatter` (then a minimal line edit) | Trailing-comment and flow-list edge cases |
| Atomic store writes | `writeFileSync` | `lock.cjs` `withLock` + `writeAtomic` | Concurrent sessions (the store discipline in `jira-project.cjs:37-44`) |
| Summary cap | new truncation | the `capSummary` rule / `SUMMARY_MAX_CHARS` | The same rule the seal already applies |
| Hook bundling | manual file list | `copy_stop_bundle` relative-require closure | Missing siblings break an installed hook |

## Runtime State Inventory

Not a rename phase, but installed-by-copy state matters:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Stop-gate ledger `.planning/graph/stop-gate-ledger.json` (gitignored) is unchanged. New arm markers are created at runtime only. | None (new state, no migration) |
| Live service config | None. Jira is not exported for this initiative (`pipeline.jira.enabled: false`). | None |
| OS-registered state | `~/.claude/settings.json` `UserPromptSubmit`/`Stop` hook entries and `~/.claude/hooks/shipyard-auto-route.sh` / `shipyard-stop-gate/` bundle; `~/.codex/AGENTS.md` managed block | Operators must re-run `make install-shipyard-claude-hook`, `make install-shipyard-codex` and `make doctor` (ADR consequence, RISKS R2). A code edit alone does not reach them. |
| Secrets/env vars | None added. `SHIPYARD_STOP_GATE=off` and `SHIPYARD_STOP_GATE_MAX_BLOCKS` are unchanged. | None |
| Build artifacts | `.build/codex-shipyard/` (gitignored) is regenerated by the installer; `.shipyard/generated/gsd-delivery-rules/SKILL.md` (tracked) must be regenerated when SKILL.md changes | Ticket F regenerates the projection |

## Common Pitfalls

### Pitfall 1: Existing stop-gate tests flip from block to allow
**What goes wrong:** about 80 tests pass payload `{}` in non-git temp dirs and expect a block. With arming required, all of them allow.
**How to avoid:** change the helpers `run`/`runIn`/`runFull` (`stop-gate.test.cjs:77-`) to arm by default with a fixed session id and the non-git fallback marker. Rewrite `:707` deliberately. Keep `:393`/`:417` and add the unarmed cases.
**Warning signs:** a mass of "expected block, got null" failures.

### Pitfall 2: `${CLAUDE_SESSION_ID}` may not be substituted in plugin commands
**What goes wrong:** deliver writes a marker for the literal string, or refuses, so the gate is inert for every delivery session. That re-opens the measured 5h46m inert-gate loss (RISKS R1, high).
**How to avoid:** make the arm CLI refuse unsubstituted values *loudly* (exit 1 with a message, so deliver notices), and verify substitution on the host with a probe command before the plan relies on it (Open Question 1).

### Pitfall 3: Pinned literals in command files
The literals `'/gsd-plan-phase <N> --ingest .planning/.adr-ingest/*.ingest.md'` (`source-contract.test.cjs:918`), the ordering of `adr-ingest.cjs` before `/gsd-plan-phase` (`:2002-2009`), `'each locked decision is one bullet under \`## Decision\`'` and the **line-broken** `'scope fences use\n     \`## Out of scope\`'` in investigate.md (`:2011-2015`, matching `investigate.md:178-179`), the Step 0.5 sentences at `:905-911`, and the Step 2 chain checks at `:913-935` must survive byte-for-byte. Run `node tests/unit/source-contract.test.cjs` after every prose edit.

### Pitfall 4: Bootstrap placed after gsd-tune
gsd-tune (Step 0.5) exits 2 without a config. The bootstrap must be in Step 0, before 0.5, or decompose never reaches it.

### Pitfall 5: The delivery-rules projection goes stale
Editing `skills/delivery-rules/SKILL.md` without regenerating `.shipyard/generated/gsd-delivery-rules/SKILL.md` makes gsd-tune report `stale-managed`, a REQUIRED failure that blocks decompose Step 0.5 in this repo.

### Pitfall 6: Hook exit codes
A `UserPromptSubmit` hook that exits 2 blocks the user's prompt [ASSUMED]. The route hook must `exit 0` on every path, including a `node` crash. The bash wrapper should not rely on `set -e` propagating a non-zero status: use `node … || true` inside a `set -euo pipefail` script.

### Pitfall 7: The REQ-131 warning fires on real contract dependencies
A ticket that imports another's module without touching its files (this phase's I→B) triggers the hint. Phrase it conditionally, keep it a warning, and never escalate it to an error.

### Pitfall 8: The comment policy rejects explanatory comments
Any `// because …` or `# temporary …` added line fails `make test-comment-policy` (a CI gate). Put the reasoning in test names and assertion messages.

### Pitfall 9: Sandbox-red local test runs
In a sandboxed worker, `make test-fast` can fail for environmental reasons: gpg signing and `mktemp` in `/var/folders` (INV-003 constraints B3-B5). Use `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false` and a writable `TMPDIR` for per-file runs. Do not read environmental failures as regressions.

### Pitfall 10: A Codex stale bundle hides parity
Codex output lives in `.build/` and `$CODEX_HOME/shipyard`. It only changes after `make install-shipyard-codex`. `make test-codex-shipyard` needs the network (it installs gsd-core), so it is not part of `test-fast`.

## Code Examples

### adr-ingest `--check` shape (extends `adr-ingest.cjs:148-196`)
```javascript
// Source: plugins/delivery-pipeline/scripts/adr-ingest.cjs (existing parseArgs/main pattern)
function parseArgs(argv) {
  const args = { inputs: [], output: null, outputDir: null, json: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') args.inputs.push(argv[++index] || '');
    else if (arg === '--output') args.output = argv[++index] || '';
    else if (arg === '--output-dir') args.outputDir = argv[++index] || '';
    else if (arg === '--json') args.json = true;
    else if (arg === '--check') args.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.inputs.length === 0) throw new Error('Missing required --input <path>');
  if (args.check && (args.output || args.outputDir)) throw new Error('--check writes nothing; drop --output/--output-dir');
  if (args.check) return args;
  // …existing output checks unchanged…
  return args;
}
```

### Stop-gate guard placement (unscoped branch only; `stop-gate.cjs:514-524`)
```javascript
} else {
  if (!sessionId || !arming.isArmed(cwd, sessionId)) allow();
  const seen = new Set();
  for (const dir of [cwd, ...worktreesOf(cwd)]) { /* unchanged */ }
}
```

### Route decision (auto-route.cjs)
```javascript
function shouldInject(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return true; }
  const prompt = payload && (typeof payload.prompt === 'string' ? payload.prompt
    : typeof payload.prompt_text === 'string' ? payload.prompt_text : null);
  if (prompt === null) return true;
  const text = prompt.trimStart();
  if (text.startsWith('<task-notification>')) return false;
  if (text.startsWith('/') || text.includes('<command-name>') || text.includes('<command-message>')) return false;
  return true;
}
```

## State of the Art

| Old Approach | Current Approach (this phase) | Impact |
|--------------|------------------|--------|
| Static heredoc route policy on every prompt | stdin-aware Node hook with a shared Claude/Codex text source | No injection on notifications or slash commands; investigate route |
| Stop gate enforces the newest front for any session | enforces only for deliver-armed sessions | Analysis/investigate sessions are no longer blocked |
| Model-by-hand Jira export (~22 MCP calls) | script plan + verbatim MCP execution + script record | Deterministic link direction |
| `/gsd-new-project` detour | ADR-derived bootstrap | Requirements are 1:1 with ADR decisions |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Claude Code substitutes `${CLAUDE_SESSION_ID}` in plugin command bodies | REQ-127 | Deliver cannot arm, so the gate is inert (high); needs another arming path (for example a hook observing the `/shipyard:deliver` prompt) |
| A2 | The Stop-hook payload `session_id` equals the id the command sees, and stays stable across `--resume` (INV-003 cites docs: preserved on resume, new on fork, compaction undocumented) | REQ-127 | A resumed session would be unarmed, which fails open |
| A3 | A `UserPromptSubmit` hook's stdout at exit 0 is injected as context, and exit 2 blocks the prompt | REQ-128 | Wrong exit handling could block user prompts |
| A4 | The UserPromptSubmit payload names the field `prompt` (or `prompt_text`, per the docs cited in INV-003) and slash commands arrive raw (`/name …`) or with `<command-name>` tags | REQ-128 | Slash commands still get injection; low harm |
| A5 | GSD `/gsd-plan-phase` accepts a ROADMAP/REQUIREMENTS subset shaped like this repo's phase-39 block | REQ-126 | Bootstrap output rejected by GSD; needs a fixture targeting a gsd-core version (RISKS R5) |
| A6 | `--skip-ui` exists in the installed gsd-core `plan-phase` (cited from INV-003; not re-read this session because `~/.claude` read was denied) | REQ-132 | The flag is ignored or refused by GSD |
| A7 | git-common-dir is writable from the deliver session's sandbox | REQ-127 | Arm fails; the fallback to `.planning/graph/` is needed |
| A8 | Codex research summaries are capped by `role-artifact.cjs` `capSummary` rather than refused | REQ-135 | Codex has the same loss; needs the same fix in the Codex seal path |

## Open Questions

1. **How does deliver learn its `session_id`?**
   - Known: the hook payload carries `session_id` (`stop-gate.cjs:265-267`). No command in the repo uses `${CLAUDE_SESSION_ID}` today (grep: no match in commands/skills).
   - Recommendation: add a `checkpoint:human-verify` probe task in ticket C: a scratch command that echoes `${CLAUDE_SESSION_ID}`, compared with the `session_id` in `~/.claude/hooks` observer output. Fallback design: arm from a hook that sees the deliver prompt (couples to D's hook; avoid unless needed).
2. **REQ-135: bound or refuse?** The ADR allows both. Recommendation: bound plus a notice, because refusing kills all four lines (the parallel fan-out throws). If the user prefers refusal, the thrown error must bypass the adapter `REPAIR` suffix (`claude-dispatch-adapter.cjs:983-989` rethrows only `DispatchBoundaryError`/`DispatchPolicyError` unwrapped).
3. **Bootstrap with a partial project** (ROADMAP present, REQUIREMENTS missing, or a ROADMAP without the ADR phase): create the missing file only and report, or refuse? Recommendation: create only the missing files and report `skipped_existing`. Never edit an existing ROADMAP.
4. **Should decompose run `gsd-tune --apply` right after a fresh bootstrap** (to create the delivery-rules projection that Step 0.5 requires)? Step 0.5 says "Do not apply tuning automatically." Recommendation: allow `--apply` only for a config the bootstrap created in the same run, and state it in prose (ticket P-D).
5. **Hint wording and the set of mapped codes.** Recommendation: map the ~15 codes a decompose/investigate session can hit, plus a default.
6. **Version bump and release entry.** A new version needs a release entry (`release-notes-smoke.sh`, network). Is it a phase ticket or a post-phase release step? Recommendation: keep it out of the phase tickets (it touches `plugin.json`, `capability.json` and release notes, shared by nothing else).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | all scripts/tests | ✓ | v24.10.0 (CI 24.15.0) | — |
| git | stop-gate arm, REQ-133 probe, worktree tests | ✓ | 2.54.0 | — |
| bash | installers, smoke | ✓ | host | — |
| gsd-core under `~/.claude` | REQ-126/132 format verification, `make test-codex-shipyard` | not readable from this sandbox (permission denied) | — | Verify on the host; plan checkpoints |
| network + `gh` | `make test-codex-shipyard`, `make test-releases` | not in sandboxed workers | — | Host-only; not in `test-fast` |
| Jira MCP | REQ-130 live run | not used (jira disabled for this repo) | — | Fixture tests only |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | in-repo `tests/unit/assert-harness.cjs` + bash smoke scripts |
| Config file | none. `tests/unit/run.sh` discovers `tests/unit/*.test.cjs` |
| Quick run command | `node tests/unit/<file>.test.cjs` (per touched file) |
| Full suite command | `make test-fast` (CI gate); `make test` on the host (adds network smokes) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-125 | code→hint map; host stderr hint line; codes/exit unchanged | unit | `node tests/unit/refusal-hints.test.cjs && node tests/unit/claude-decompose-host.test.cjs && node tests/unit/claude-investigation-host.test.cjs && node tests/unit/codex-decompose-host.test.cjs` | ❌ refusal-hints, ❌ claude-investigation-host (Wave 0); ✅ others |
| REQ-125/126/130/131/132/133 (prose) | decompose.md contract | unit (text) | `node tests/unit/decompose-friction-contract.test.cjs && node tests/unit/source-contract.test.cjs` | ❌ Wave 0 |
| REQ-125/126/129 (prose) | investigate.md contract | unit (text) | `node tests/unit/investigate-friction-contract.test.cjs && node tests/unit/source-contract.test.cjs` | ❌ Wave 0 |
| REQ-126 | bootstrap creates only missing files; 1:1 REQs; refusal | unit | `node tests/unit/adr-bootstrap.test.cjs` | ❌ Wave 0 |
| REQ-127 | armed/unarmed/foreign/unreadable marker; cross-worktree kept | unit | `node tests/unit/stop-gate.test.cjs && node tests/unit/stop-gate-arm.test.cjs` | ✅ / ❌ Wave 0 |
| REQ-128 | stdin filtering; policy text; install/doctor/remove | unit + smoke | `node tests/unit/auto-route.test.cjs && bash tests/smoke/claude-hook-smoke.sh` (Codex: `bash tests/smoke/codex-shipyard-smoke.sh`, host/network) | ❌ auto-route; ✅ smokes |
| REQ-129 | `--check` no-write; template passes | unit | `node tests/unit/adr-ingest.test.cjs` | ✅ |
| REQ-130 | deterministic plan; link direction; record; no-network sweep | unit | `node tests/unit/jira-export.test.cjs` | ❌ Wave 0 |
| REQ-131 | disjoint-files warning; exit 0 | smoke | `bash tests/smoke/graph-validator-smoke.sh` | ✅ |
| REQ-134 | exit 2, prefix, names file and command | unit | `node tests/unit/gsd-tune.test.cjs` | ✅ |
| REQ-135 | prompt states bound; over-long summary bounded with notice | unit | `node tests/unit/planning-artifacts.test.cjs && node tests/unit/investigation-research.test.cjs` | ✅ |

Every ticket also runs `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json` (comment policy) and `node --check` / `bash -n` on touched scripts.

### Sampling Rate
- **Per task commit:** the ticket's quick commands above plus the comment-policy gate.
- **Per wave merge:** `make test-fast`.
- **Phase gate:** `make test-fast` green; on the host `make test`; reinstall hooks and run `make doctor`; the script-existence check over decompose/investigate prose.

### Wave 0 Gaps
- [ ] `tests/unit/refusal-hints.test.cjs`, `tests/unit/claude-investigation-host.test.cjs`: REQ-125
- [ ] `tests/unit/adr-bootstrap.test.cjs`: REQ-126
- [ ] `tests/unit/stop-gate-arm.test.cjs` plus arming-by-default helpers in `tests/unit/stop-gate.test.cjs`: REQ-127
- [ ] `tests/unit/auto-route.test.cjs`: REQ-128
- [ ] `tests/unit/jira-export.test.cjs`: REQ-130
- [ ] `tests/unit/decompose-friction-contract.test.cjs`, `tests/unit/investigate-friction-contract.test.cjs`: prose pins
- No framework install is needed.

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No credential enters the conveyor (the Jira acting half stays with the agent/MCP) |
| V3 Session Management | partial | Stop-gate marker keyed by `session_id`: strict id validation, fail-open on mismatch |
| V4 Access Control | no | — |
| V5 Input Validation | yes | Validate `session_id` (path segment), Jira key `^[A-Z][A-Z0-9]+-\d+$`, ticket id `^T-\d{2}-\d{2}$`, hook stdin parsed defensively |
| V6 Cryptography | no | — |
| V12 Files/Resources | yes | `wx` create-only writes (bootstrap), atomic writes (`lock.cjs`), containment of marker and plan paths |

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal through `session_id` in the marker filename | Tampering | allow-list regex; refuse otherwise |
| Clobbering the user's `ROADMAP.md`/`config.json` | Tampering | `flag: 'wx'`; byte-identical fixture |
| Prompt text in the hook treated as instructions | Spoofing | The hook only classifies; it never echoes prompt content |
| Credential or network creep in the Jira script | Info disclosure | source-token sweep test (copy of `jira-project.test.cjs:825-837`) |
| Hint suggesting a host bypass | Elevation | token sweep over the hint map (no "bypass", "skip", "SHIPYARD_STOP_GATE=off", "other runtime") |

## Sources

### Primary (HIGH confidence, read this session)
- `plugins/delivery-pipeline/scripts/{claude-decompose-host,claude-investigation-host,codex-decompose-host,codex-delivery-host,claude-delivery-host,claude-dispatch-adapter,claude-runtime-host,role-artifact,adr-ingest,gsd-tune,stop-gate,validate-graph,jira-project,comment-policy}.cjs` (line ranges cited inline)
- `plugins/delivery-pipeline/workflows/investigation-research.mjs`, `references/inv-research.md`, `commands/{investigate,decompose,deliver,route}.md`, `skills/delivery-rules/SKILL.md`
- `scripts/install-shipyard-claude-hook.sh`, `scripts/install-shipyard-codex.sh:570-630`, `scripts/shipyard-doctor.cjs`, `scripts/gen-codex-shipyard.cjs` (grep)
- `tests/unit/{adr-ingest,gsd-tune,stop-gate,source-contract,claude-decompose-host,jira-project,planning-artifacts}.test.cjs`, `tests/smoke/{claude-hook-smoke,graph-validator-smoke,docs-smoke}.sh`, `tests/unit/run.sh`, `Makefile`
- `.planning/architecture/ADR-016-conveyor-session-friction.md`, `.planning/.adr-ingest/ADR-016-…ingest.md`, `.planning/REQUIREMENTS.md:135-147`, `.planning/ROADMAP.md:729-741`, `CLAUDE.md`, `.planning/config.json`

### Secondary (MEDIUM, INV-003 artifacts with file:line evidence)
- `.planning/investigations/INV-003-conveyor-session-friction/{RESEARCH,DECISIONS,RISKS,OPEN-QUESTIONS}.md`, `research/{system-state,constraints,alternatives}.md`

### Tertiary (LOW, not verifiable here)
- Claude Code hook payload fields, `${CLAUDE_SESSION_ID}` substitution, UserPromptSubmit exit semantics (training knowledge / docs cited by INV-003)
- gsd-core `plan-phase.md` `--skip-ui` and ROADMAP parser (`~/.claude/gsd-core` read denied by the session permission layer)

## Metadata

**Confidence breakdown:**
- File/function mapping and file-sharing matrix: HIGH (every cited line read this session)
- Slicing: HIGH for overlap facts, MEDIUM for the choice (a planner judgement)
- Runtime (hooks, session id): MEDIUM/LOW (assumptions A1-A4 need host probes)
- GSD formats: LOW (A5-A6)

**Research date:** 2026-09-24
**Valid until:** 2026-10-24 (in-repo facts can change with any merge to the files above; re-check line numbers before execution)
