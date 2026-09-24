# INV-003 — Research line 3: Constraints

- Line id: `constraints`
- Investigation: INV-003-conveyor-session-friction
- Source revision: `856456a8c61f907ae360651688dbc31fc7eb6722` (`git rev-parse HEAD`), branch
  `inv/003-conveyor-session-friction`, based on origin/main `befc970c`
  (`git branch -r --contains befc970c` → `origin/main`).
- Research selection (caller-resolved, recorded as DATA): `claude-opus-5-5/medium`; policy signals
  `{"type":"facts"}`.
- Scope: hard technical, product, and delivery constraints that any fix to friction items 1–10 must
  respect. No recommendation between options is made here.

All paths below are relative to the worktree root
`/Volumes/KINGSTON/.wt-claude-shipyard/inv-003`. `P=plugins/delivery-pipeline`.

Confidence scale: **high** = read directly in source/test at this revision; **medium** = inferred from
source plus documented intent; **low** = assumption, next check named.

---

## 0. Baseline: the test gates today (delivery constraint)

| # | Finding | Command | Result |
|---|---|---|---|
| B1 | `make test-fast` is the CI gate; CI runs only it plus the publish gate, Node `24.15.0`, no network, no npm install. | `cat .github/workflows/test.yml` | jobs `publish gate` + `make test-fast`, `timeout-minutes: 10`, `node-version: '24.15.0'` |
| B2 | `make test` = `test-fast` + `test-codex-shipyard` (network: installs gsd-core) + `test-releases` (network + authenticated `gh`). | `sed -n 80,200p Makefile`; `sed -n 1,25p tests/smoke/release-notes-smoke.sh` | targets confirmed; release smoke header: "Needs the network and an authenticated `gh`, so it is NOT part of `make test-fast`" |
| B3 | In THIS sandbox `make test-fast` is red for environmental reasons only. | `make test-fast > $TMPDIR/tf.log 2>&1; echo exit=$?` | `exit=2`, 7m00s wall; failing files (awk over log): comment-policy 13, degenerate-green 1, files-contract 11, gen-codex-shipyard 5, rotation-recommendation 4, session-handoff 9, stop-gate 6, trailer 15 |
| B4 | Root cause of 7 of 8 files: host `commit.gpgsign=true` and sandbox denies `~/.gnupg`. | `git config --get commit.gpgsign` → `true`; `grep -c "gpg failed to sign" $TMPDIR/tf.log` → `114` | re-run with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false node tests/unit/<f>.test.cjs`: stop-gate 72/0, rotation-recommendation 7/0, degenerate-green 60/0, comment-policy 13/0, files-contract 18/0, session-handoff 9/0, trailer 73/0 |
| B5 | Remaining gen-codex-shipyard 5 failures are sandbox `mktemp` denial on `/var/folders/...`. | same override on `tests/unit/gen-codex-shipyard.test.cjs` | `89 passed, 5 failed`; message `mktemp: mkdtemp failed on /var/folders/.../T/tmp.*: Operation not permitted` |
| B6 | Publish gate is green on the current tree. | `node $P/scripts/publish-gate.cjs --base origin/main --working-tree --json` | `exit=0`, `"ok": true`, `violations: []` |
| B7 | Local Node is `v24.10.0`, CI pins `24.15.0`. | `node --version` | `v24.10.0` |

Constraint C-DEL-0 (confidence high): "`make test-fast` stays green" must be verified outside this
sandbox (or with signing disabled and a writable TMPDIR); a local red run here is not evidence of a
regression. `make test` additionally needs network and `gh` auth, so it cannot be verified from a
sandboxed research or executor worker at all — **unknown until run on the host**.

---

## 1. Cross-cutting hard constraints

### C-X1 — Claude plugin is canonical; Codex is generated (high)
- Source: `CLAUDE.md` ("Keep the Claude plugin canonical and regenerate Codex outputs after shared
  changes"); `scripts/gen-codex-shipyard.cjs:1-25` (converts via gsd-core's
  `runtime-artifact-conversion.cjs`, stages into `.build/codex-shipyard/`).
- Check: `git ls-files .build | wc -l` → `0`; `.gitignore` contains `.build/`.
- Consequence: "Codex outputs are regenerated" means re-running `make install-shipyard-codex` /
  the generator, NOT committing generated files. Every edit lands in `$P/commands`, `$P/scripts`,
  `$P/templates`, `$P/skills`. The generator copies `scripts`, `references`, `templates`, `workflows`
  into the Codex payload (`scripts/gen-codex-shipyard.cjs:332-336`, read via `grep -n templates`),
  so a new `templates/adr/ADR.md` (item 5) ships to Codex automatically.
- The Codex auto-route block is a separate, hand-maintained copy in
  `scripts/install-shipyard-codex.sh:586-620` (markers `shipyard-auto-route:begin/end`). Item 4 has
  **two** sources to keep in parity, not one; the generator does not derive it from the Claude hook.

### C-X2 — Deterministic rules need a focused test (high)
- Source: `CLAUDE.md` ("When adding a rule, add a focused unit or fixture test with it"); problem
  statement success criterion. Unit tests are plain `node` files run by `tests/unit/run.sh`; no
  package.json / no npm deps (`.github/workflows/test.yml` comment: "this repo has no package.json").
- Consequence: no test framework or dependency may be introduced; new tests use
  `tests/unit/assert-harness.cjs` style.

### C-X3 — Comment policy on added code lines (high)
- Source: `$P/scripts/comment-policy.cjs:6-9,55-67,383,432`; wired into CI through `publish-gate.cjs`.
- Rule: on ADDED lines in supported code/config files (`.cjs`, `.sh`, `.yml`, `.toml`, …) a comment is
  allowed only if it is a directive (`shipyard…`, `managed by`, `do not edit`, lint pragmas, …) or a
  marker `@invariant:|@security:|@contract:` ≤120 chars that does not match
  `HISTORY_PATTERN` (`todo|ticket|issue|commit|history|legacy|previously|because|#\d+|adr-\d+|myd-\d+`).
- Consequence: the long narrative comment style of `stop-gate.cjs`, `validate-graph.cjs`,
  `jira-project.cjs` cannot be extended in new diffs. Fix rationale must go into tests, ADR text, or
  Markdown (`.md` is `unsupported-file-type`, i.e. skipped — see `skipped` array in B6 output).
  Note: the generated route hook body (item 4) is a heredoc inside a `.sh` file; its `#` lines are
  scanned as shell comments. Existing lines carry `Managed by shipyard` (a directive), which is why
  they pass. Any new comment line inside that heredoc must also be directive/marker shaped.
  Confidence medium for the heredoc case — next check: add a probe line in a scratch branch and run
  `publish-gate.cjs --working-tree` (a `/gsd-spike`, not done here).

### C-X4 — ADR-014 dispatch boundary and grid are frozen (high)
- Source: `CLAUDE.md` "Active routed dispatch policy (ADR-014, accepted)"; problem statement
  out-of-scope ("Changes to the ADR-014 model/effort grid or the dispatch boundary contract",
  "Removing the fail-closed receipt verification closed by phase 38").
- Consequence for item 1: plain-language relay must be ADDED on top of refusals; the refusal itself,
  its code, and its fail-closed exit must not change. Consequence for item 2: a bridge that creates
  `ROADMAP.md`/`REQUIREMENTS.md` must not add a model launch outside `claude-decompose-host.cjs` /
  `codex-decompose-host.cjs`; any GSD agent it needs crosses the boundary with a receipt
  (`$P/commands/decompose.md` Step 0.5 items 3–5).

### C-X5 — Artifact language and user language (high)
- Source: `$P/commands/investigate.md:22-26`, `$P/commands/decompose.md:24-28`, `$P/commands/route.md`
  "Communication language".
- Consequence for items 1, 10: the relay to the user is in the user's language; script output,
  artifacts, Jira content stay English (`decompose.md` Step 5: "All Jira content … is written in
  ENGLISH").

### C-X6 — Host hooks must never trap a session (high)
- Source: `$P/scripts/stop-gate.cjs:19-33,46-58,195-198,474-487` ("it always exits 0",
  `SHIPYARD_STOP_GATE=off`, ledger fallback "the one outcome this hook must never produce").
- Consequence for items 3, 4: any new selection or filter must fail open (allow the stop / emit no
  route text) on missing, unreadable, or ambiguous input; an uncaught throw is a defect.

### C-X7 — Docs contract (high)
- Source: `CLAUDE.md` Tests section: `tests/smoke/docs-smoke.sh` "checks the documented commands
  against `plugin.json`, verifies every `make` target named by the README"; `docs-smoke.sh:34`
  iterates `route investigate decompose deliver bench`.
- Consequence: a new command (e.g. a dedicated bridge or export command) must be added to
  `$P/.claude-plugin/plugin.json` `commands` (currently exactly those five — `cat plugin.json`) and
  documented in `README.md`, or docs-smoke fails. A new `make` target named in README must exist.

### C-X8 — Version/release (medium)
- Source: `$P/.claude-plugin/plugin.json` `"version": "0.61.0"`; `tests/smoke/release-notes-smoke.sh`
  ("Every published tag must carry a release entry").
- Consequence: the fix set ships as a new version with a GitHub release entry; "repeat of MYD-17627
  on the released version" requires a tag + release, checkable only with network `gh`.

---

## 2. Per-item constraints

### Item 1 — Host refusals surface only internal codes
Evidence (`grep -n "REFERENCE_UNAVAILABLE\|INVALID_INPUT" $P/scripts/*.cjs`; `sed` on hosts):
- `claude-decompose-host.cjs:26-30` `refuse(code, message)`; CLI prints
  `` `${error.code || 'FAILED'}: ${error.message}` `` to stderr, `exitCode = 1` (`:248-253`).
- `claude-investigation-host.cjs:66-71` prints `error.message` only — **no code** — inconsistent with
  the decompose host; its own codes are `INVALID_HOST`.
- Tests pin the stderr shape: `tests/unit/claude-decompose-host.test.cjs:136`
  `assert.match(result.stderr, /UNSUPPORTED_ROLE/)`; `tests/unit/claude-workflow-host.test.cjs:170`
  `assert.match(result.stderr, /--request-file <json> is required/)`;
  `tests/unit/source-contract.test.cjs:705` matches `error.code === code`.

Constraints:
- C1.1 (high) Error `code` values and the non-zero exit are part of the tested contract; they must be
  preserved. A plain-language message can be added (extra field/line), not substituted.
- C1.2 (high) Refusal is fail-closed with no fallback (`decompose.md`: "Missing or failed evidence is a
  refusal, not a fallback"; `investigate.md`: "An unavailable or refused host cannot switch to the
  peer"). The relay may explain and name a remedy; it must not suggest bypassing the host.
- C1.3 (medium) Any code→explanation mapping lives in a script (deterministic-rules principle,
  `CLAUDE.md`) with a unit test; the command prose then requires relaying it. Message strings must
  not leak secrets/paths outside the worktree — no explicit rule found; **assumption**, next check:
  ask owner whether absolute paths in user-facing relay are acceptable.

### Item 2 — No investigate → decompose bridge
Evidence: `investigate.md:64-65` (`.planning/` exists "otherwise suggest `/gsd-new-project` and
stop"); Gate 1 ends with "Tell the user the next step: `/shipyard:decompose`" (`investigate.md`
Step 3.4). `decompose.md` Step 0 reads `ROADMAP.md`; plan frontmatter comment:
"requirements: REQUIRED. Requirement ids from ROADMAP.md; an empty array is a BLOCKER in both the GSD
plan-checker and Gate 2" (`decompose.md:327-331`). Gate 2 errors on empty requirements
(`validate-graph.cjs:317`). `gsd-tune.cjs:324-326` fails when `.planning/config.json` is absent.

Constraints:
- C2.1 (high) Gate 2 requires non-empty `requirements[]` per ticket (`validate-graph.cjs:317`), and
  the decompose template ties them to ROADMAP requirement ids — so a bridge must produce REQ ids
  traceable to ADR decisions; inventing requirements is exactly the pain being removed.
- C2.2 (high) `validate-graph.cjs` also accepts "the external tracker id for imported plans"
  (`:317` message) — requirements need not be ROADMAP ids strictly; the constraint is non-empty.
- C2.3 (high) `.planning/config.json` must exist before `gsd-tune.cjs --check` (decompose Step 0.5.2)
  can run; `git.branching_strategy: none` is the only REQUIRED key (`gsd-tune.cjs:469-471`).
- C2.4 (medium) `ROADMAP.md` / `REQUIREMENTS.md` / `PROJECT.md` / `STATE.md` are GSD-owned formats
  (upstream gsd-core). Their parser is out of scope (multi-line `**Goal**` defect is out of scope by
  the problem statement), so a generated ROADMAP must stay inside the subset GSD parses today.
  Exact subset is **unknown** — next check: read gsd-core's roadmap parser in the installed
  `~/.claude/gsd-core` (not readable from this sandbox: the `ls ~/.claude/gsd-core` probe was denied
  by the permission layer).
- C2.5 (high) Investigation is read-only w.r.t. code except artifacts (`investigate.md` Rules). Writing
  `.planning/ROADMAP.md` etc. is an artifact write, allowed, but it must not clobber an existing
  project's files (`CLAUDE.md` "Preserve unrelated worktree changes"; decompose Step 5 "merge, don't
  clobber other keys" precedent for config.json).
- C2.6 (high) `adr-ingest.cjs` is already the ADR normalizer for decompose
  (`decompose.md:270-276`); a bridge reading ADR decisions should reuse it rather than a second
  parser (single-parser principle, cf. `validate-graph.cjs:31` "The ONE ownership matcher").

### Item 3 — Stop gate blocks sessions that never ran deliver
Evidence: `stop-gate.cjs:62-91` (rationale: session cwd is not the run's worktree; pdffiller incident,
5h46m silence); code `stop-gate.cjs:489-525` — unscoped mode iterates `[cwd, ...worktreesOf(cwd)]`
and picks newest `generated_at`; scoped mode (`run_id` in payload or `SHIPYARD_RUN_ID`,
`SHIPYARD_RUN_CONTROL=scoped`, `SHIPYARD_RUN_STORE_DIR`) reads only the controller-owned worktree.
Tests pin cross-worktree behaviour: `tests/unit/stop-gate.test.cjs:393`
("a stale all-clear in the session cwd does not answer for a live sibling worktree"), `:417`
("the newest board wins even when the nearest one is the live-looking fake"), `:340` (scoped run).

Constraints:
- C3.1 (high) Cross-worktree newest-board selection is a deliberate fix for a measured failure; a
  fix for item 3 must keep tests `:393` and `:417` green. The comment at `:88-91` already names the
  accepted cost ("Two sessions delivering different phases of one repo would let the busier board
  answer for the quieter one … bounded to a single block per turn").
- C3.2 (high) The hook receives no flags and no caller env (`stop-gate.cjs:81-82`); the only per-session
  signal is the Stop payload (`session_id`, `stop_hook_active`, optional `run_id`/`worktree`) and the
  per-session ledger `stop-gate-ledger.json` (gitignored — `.gitignore`). Any "this session never
  delivered" discrimination must be derived from those or from session-owned evidence
  (e.g. `session-observations.jsonl`, also gitignored), not from prose.
- C3.3 (high) Fail-open requirement C-X6 applies: uncertainty ⇒ allow.
- C3.4 (medium) `SHIPYARD_STOP_GATE=off` exists as the manual escape; it is not a fix (the problem
  requires no manual detours).

### Item 4 — Auto-route hook has no investigate route; fires on notifications and slash prompts
Evidence: `scripts/install-shipyard-claude-hook.sh:108-131` writes a static heredoc hook that prints
the policy unconditionally (`cat <<'POLICY'`); route text names only decompose/deliver/bench/inline;
`install-shipyard-claude-hook.sh:243` registers it on `UserPromptSubmit`. Codex copy at
`scripts/install-shipyard-codex.sh:592-610` has the same routes (phase-aware).
`grep -c route tests/smoke/claude-hook-smoke.sh` → `0`: the Claude route hook body has **no test**.
`$P/commands/route.md` already lists `.planning/investigations/` as a routing signal (Step 1).

Constraints:
- C4.1 (high) Hook is installed into `$CLAUDE_HOME/hooks/shipyard-auto-route.sh` by the installer;
  changes reach users only after `make install-shipyard-claude-hook`; `make doctor`
  (`scripts/shipyard-doctor.cjs`) compares source vs installed — a new hook body must stay
  comparable by doctor. (medium — doctor comparison logic for the route hook not read; next check:
  `grep -n auto-route scripts/shipyard-doctor.cjs` returned nothing in the combined grep, so doctor
  may not check the route hook at all.)
- C4.2 (medium, external) Claude Code `UserPromptSubmit` hooks have no matcher; filtering
  `<task-notification>` or leading-`/` prompts must be done inside the hook by reading the stdin JSON
  `prompt` field. Source: Claude Code hooks documentation (model knowledge, not verified in this
  sandbox) — next check: confirm against current Claude Code hooks docs.
- C4.3 (high) Shell hook must keep `set -euo pipefail` (`CLAUDE.md` editing rules); parsing stdin
  JSON in bash without `jq` means using `node` (installer already requires node:
  `install-shipyard-claude-hook.sh:46`).
- C4.4 (high) `route.md` states decompose/deliver "must NOT fire from idle conversation"; the route
  hook may only point at `/shipyard:route`, which is advisory; an added investigate route must go
  through the router, not auto-invoke `/shipyard:investigate`.
- C4.5 (high) Codex parity (C-X1): same change mirrored in `install-shipyard-codex.sh`, covered by
  `tests/smoke/codex-shipyard-smoke.sh` (the only test grepping `shipyard-auto-route`, per
  `grep -rln shipyard-auto-route tests`).

### Item 5 — No ADR template; Gate 1 does not run adr-ingest
Evidence: `ls -R $P/templates` → only `inv/` (DECISIONS, OPEN-QUESTIONS, OPTIONS, PROBLEM,
RESEARCH, RISKS). Gate 1 (`investigate.md:170-184`) runs only `validate-inv.cjs` and prose-specifies
Nygard format. `adr-ingest.cjs:148-165` requires `--input` plus `--output` or `--output-dir`; no
check-only mode; `validateAdr` throws "no decisions were found under an ADR Decision section"
(`:142-145`); exit 1 on error (`:198-204`). `.gitignore` ignores `/.planning/.adr-ingest/`.

Constraints:
- C5.1 (high) Using adr-ingest as a Gate 1 validator today requires writing to a staging dir
  (`.planning/.adr-ingest/`, gitignored) or adding a check-only flag with a unit test in
  `tests/unit/adr-ingest.test.cjs`. `prepareOutputDir` deletes existing `*.ingest.md` in the output
  dir (`:180-188`) — Gate 1 reuse of the same staging dir would erase decompose staging; a separate
  dir or a no-write mode is needed.
- C5.2 (high) The format consumer is `/gsd-plan-phase --ingest` (upstream). The template must match
  what adr-ingest normalizes (`## Decision` bullets, `## Consequences`, `## Out of scope`,
  `## Update`, `## Plan` — `adr-ingest.cjs:100-112`) and what investigate.md already prescribes.
- C5.3 (medium) Existing ADRs in `.planning/architecture/` use varied shapes (e.g. ADR-008 uses
  `- **D1 — …**` bullets); a stricter Gate 1 validator must not retro-fail decomposition of existing
  accepted ADRs — apply at Gate 1 for new ADRs only. Unknown whether any existing ADR fails
  adr-ingest today — next check: run adr-ingest over `.planning/architecture/ADR-0*.md` into
  `$TMPDIR`.

### Item 6 — Jira export done by hand
Evidence: `decompose.md` Step 5 (`:500-600`, tooling at `:535-539`: "Use whatever Jira/Atlassian MCP
is connected … do not hand-roll REST calls"). `jira-project.cjs:1-50` header: "Nothing in this file
speaks to a tracker: no socket, no client, no credential. The acting half is an agent's, by
ADR-008 D4." Test `tests/unit/jira-project.test.cjs:827-837` sweeps for `fetch`, `https?:`, `mcp`,
`gh`, `curl`, `require('https'|'net'|'tls'|'dgram')`. ADR-008 (accepted 2026-09-09) D3/D4/D5 and
"Considered and NOT chosen: A script calling Jira's REST API directly, with a token" (rejected:
credential inside the conveyor, two clients, reverses "do not hand-roll REST").

Constraints:
- C6.1 (high) A script-side Jira client contradicts accepted ADR-008 and a pinned test. A deterministic
  export within the current architecture = a script that computes the full export plan (epics, issues,
  labels, descriptions, link direction `is blocked by` per `depends_on`, dependency order) from
  `tickets.json` as pure data, plus a recorder that refuses unevidenced writes; the agent performs the
  MCP calls. Replacing D4 with a REST client requires a superseding ADR (ADR-008 names that as the
  "upgrade path … Only D4 is replaced").
- C6.2 (high) Export must never block or fail decomposition (`decompose.md` Step 5: "A Jira error never
  blocks or fails decomposition"); ADR-008 D6: tracker projection is invisible to the stop gate.
- C6.3 (high) Idempotency contract is fixed: repo-namespaced labels
  `shipyard-<owner>-<repo>-T-<phase>-<plan>`, legacy-label migration, "Source of truth:
  <owner>/<repo>:<plan path>" single line (`decompose.md` Step 5). A deterministic plan must reproduce
  it exactly.
- C6.4 (high) Scope fence from the problem statement: this initiative's own tickets are NOT exported;
  this repo has `pipeline.jira.enabled: false` (ADR-008 D7). The capability cannot be witnessed live
  here — acceptance needs fixture tests + a proving-ground run.
- C6.5 (medium) MCP variants differ in shape (ADR-008 Context: "Two connected MCP variants, two
  incompatible shapes"); the plan format should be MCP-agnostic.

### Item 7 — Linearization prose vaguer than the validator; order-only links become `depends_on`
Evidence: `decompose.md:430-432` and `skills/delivery-rules/SKILL.md:107-114` say "linearize the chain
where possible/when practical". Validator `validate-graph.cjs:541-545` warns only for >1 same-phase
parents and states the concrete meaning ("the cascade bases on <primary> only; the others land
through the epic. Linearize the chain if <id> needs every parent's code at once"). The graph has one
edge type: `depends_on` — no order-only field (`grep -n "after\b\|order_after\|soft" validate-graph.cjs`
→ no match). Contested-path rule `validate-graph.cjs:378-458`: dependency-unordered tickets touching
an intersecting path in the same repo are a hard ERROR with remedy "add a dependency between them, or
re-slice".

Constraints:
- C7.1 (high) `depends_on` is structural: it drives `wave`, `primary_parent`, `pr_base` and cascade
  (`validate-graph.cjs:521-535`) and is consumed by state-sync/deliver via `tickets.json`. Adding an
  order-only edge kind is a graph-schema change touching every consumer of `tickets.json`
  (state-sync, front, sentinel, deliver). Confidence high that consumers exist; exact list — next
  check: `grep -rn "depends_on" $P/scripts`.
- C7.2 (high) The file-overlap error forces a `depends_on` for any shared file between two same-phase
  tickets. This is a primary mechanical source of serial graphs (11 waves): the fix space is slicing
  guidance and/or overlap rules, and the overlap guarantee itself ("independent tickets do not
  conflict") must not be weakened silently.
- C7.3 (high) Prose must be brought to the validator's semantics, not vice versa, unless the validator
  changes with fixture tests in `tests/smoke/graph-validator-smoke.sh`.
- C7.4 (high) Gate 2 = exit 0 of `validate-graph.cjs` only (`decompose.md` header); warnings do not
  block.

### Item 8 — No preflight warning when `.planning/` is untracked
Evidence: in this repo `.planning` is tracked (`git ls-files .planning | wc -l` → `457`) and
`.planning/graph/` is tracked except the ledger/observations (`.gitignore`). Stop gate reasoning
depends on per-branch tracked `.planning/graph/` (`stop-gate.cjs:62-67`). GSD config has
`commit_docs: true` (`.planning/config.json`).

Constraints:
- C8.1 (high) Must be a warning, not a block (problem statement says "warning"); `gsd-tune --check`
  already separates tuning drift (non-blocking) from REQUIRED/blockers (`decompose.md` Step 0.5.2),
  so a new check must be classified non-blocking or it would stop decompose.
- C8.2 (medium) Worktree-based delivery relies on `.planning/` content reaching ticket worktrees via
  git; untracked `.planning/` means worktrees lack PLAN files. This is the reason the warning
  matters; exact failure path in deliver not traced here — next check: `grep -n "\.planning" $P/scripts/ticket-worktree.sh`.
- C8.3 (medium) Candidate hosts for the check: `gsd-tune.cjs --check` (run in decompose preflight),
  `shipyard-doctor.cjs` (read-only, run from this checkout, not the target project — `CLAUDE.md`), or
  investigate Step 1 preconditions. Doctor runs against the shipyard checkout, so it is the wrong
  scope for a target-project check.

### Item 9 — GSD UI gate invoked for prototype / no-Figma scopes
Evidence: shipyard source never references the UI gate — `Grep "ui_phase|ui_safety_gate|ui_review|figma"`
across the repo excluding `.planning/` → only an unrelated fixture line. The gate is GSD-owned config
`workflow.ui_phase: true`, `workflow.ui_safety_gate: true`, `workflow.ui_review: true` (this repo's
`.planning/config.json`). `gsd-tune.cjs` REQUIRED list is only `git.branching_strategy`
(`:469-471`); TUNING list does not include ui keys (`sed -n 575,600p`).

Constraints:
- C9.1 (high) The UI gate lives in upstream GSD; fixing its internals is out of scope (upstream
  defects are out of scope). Shipyard can only (a) set/recommend `workflow.ui_*` via gsd-tune tuning
  (non-blocking category) or (b) pass flags/context to `/gsd-plan-phase` that GSD already supports.
- C9.2 (low) Which GSD flag/config skips the UI gate per phase, and how GSD decides a phase "has UI",
  is **unknown** — gsd-core sources are outside the sandbox allowlist (probe denied). Next check: read
  gsd-core `plan-phase` workflow for `ui_phase` handling on the host.
- C9.3 (medium) A project-wide `ui_phase: false` would also silence the gate for real UI work; a
  scope-level signal (ADR/phase declares "prototype, no Figma") is the narrower constraint-compatible
  shape.

### Item 10 — gsd-tune reports "the conveyor's own project root"
Evidence: `gsd-tune.cjs:322-326`:
`fail(\`no ${CONFIG} — run this from a GSD project (the conveyor's own project root)\`)`, exit code 2
(`fail(msg, code = 2)`). The installer calls gsd-tune with `--global` (`install-shipyard-claude-hook.sh:271`),
which never hits this path.

Constraints:
- C10.1 (high) Exit code 2 and the `gsd-tune: ` stderr prefix are the interface; decompose Step 0.5.2
  treats hard preflight refusals as fail-closed. Only the message text may change. Existing
  assertions — next check: `grep -n "own project root\|no .*config.json" tests/unit/gsd-tune.test.cjs`
  (the combined grep matched only the script, so no test pins the current wording; confidence medium).
- C10.2 (high) `--global` path must keep creating `~/.gsd/defaults.json` (`:327` "the global defaults
  file is ours to create; a project's config is not") — the fix must not auto-create a project
  config silently; an actionable instruction (which command creates it — tied to item 2's bridge) is
  the compatible shape.

---

## 3. Product constraints (flows that must not change)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| P1 | PLAN files are the single source of truth; Jira is a projection; deliver never reads Jira. | `decompose.md:30-36`, Step 5; ADR-008 | high |
| P2 | Gate 2 is exclusively `validate-graph.cjs` exit 0 + fresh `tickets.json`. | `decompose.md` Step 4 | high |
| P3 | Decomposition stops at PLAN files + validated graph for THIS initiative; no Jira export of its tickets. | problem statement, user decision 2026-09-24 | high |
| P4 | Decisions belong to the human; agents prepare options (`investigate.md` Rules). A bridge must not decide requirements on the user's behalf beyond what the ADR states. | `investigate.md` Rules | high |
| P5 | Pre-authorization defaults to none; silence is not consent. Unchanged by any item. | `decompose.md` Step 4.3 | high |
| P6 | `/shipyard:route` is advisory and side-effect-free; decompose/deliver are invoked deliberately. | `route.md` | high |
| P7 | Runtime fixed per command; no cross-provider fallback. | `investigate.md`, `decompose.md` runtime sections | high |
| P8 | Codex phase-1 install (`SHIPYARD_CODEX_PHASE=1`) ships only investigate/decompose; routes must stay phase-aware. | `CLAUDE.md`; `install-shipyard-codex.sh:593-595` | high |

## 4. Delivery constraints (process)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| D1 | PR CI = publish gate + `make test-fast` on Node 24.15.0, ≤10 min. | `.github/workflows/test.yml` | high |
| D2 | New added comments in code must be marker/directive shaped (C-X3). | `comment-policy.cjs` | high |
| D3 | README update required when supported command/install flow changes; docs-smoke enforces command surface. | `CLAUDE.md`, `tests/smoke/docs-smoke.sh` | high |
| D4 | Shell scripts keep `set -euo pipefail` and validate preconditions early. | `CLAUDE.md` editing rules | high |
| D5 | Hook/installer changes reach users only on reinstall (`make install-shipyard-claude-hook`, `make install-shipyard-codex`); a repeat proving-ground run must reinstall first. | installer echo `install-shipyard-claude-hook.sh:274` | high |
| D6 | Release requires a tag + GitHub release entry (`make test-releases`, network). | `release-notes-smoke.sh` | medium |
| D7 | Work happens while delivery sessions may be active: preserve unrelated worktree changes; never bare `git stash`. | `CLAUDE.md`; environment rules | high |
| D8 | Branch/PR conventions: releases via `release/*` branches merged by PR (`git log`: "Merge pull request #201 from …/release/version-0.61.0"). Exact PR template/review requirements — **unknown**, next check: `gh pr view 201 --json reviews,body`. | `git log --oneline -5` | medium |

## 5. Uncertainties / unknowns (for OPEN-QUESTIONS)

- [ ] Which GSD config/flag skips the UI gate per phase, and how GSD detects UI scope — owner: gsd-core maintainer / host read of `~/.claude/gsd-core` (blocked in this sandbox).
- [ ] Exact ROADMAP/REQUIREMENTS subset GSD `plan-phase --ingest` and plan-checker parse (for a generated bridge) — owner: gsd-core source on host.
- [ ] Does `shipyard-doctor.cjs` compare the installed route hook to source? — owner: repo maintainer; check `grep -n route scripts/shipyard-doctor.cjs`.
- [ ] Do all existing accepted ADRs pass `adr-ingest.cjs` (so a stricter Gate 1 does not retro-fail them)? — owner: researcher; run adr-ingest into `$TMPDIR`.
- [ ] Is a superseding ADR for ADR-008 D4 acceptable, or must item 6 stay "script plans, agent performs"? — owner: user (product decision).
- [ ] Is an order-only edge kind in `tickets.json` acceptable (schema change across state-sync/front/sentinel/deliver), or only prose + slicing guidance? — owner: user.
- [ ] Is the stop-gate "busier board answers for the quieter session" trade-off (`stop-gate.cjs:88-91`) still accepted, or should analysis-only sessions be exempt by session evidence? — owner: user.
- [ ] Confirm Claude Code `UserPromptSubmit` has no matcher and exposes `prompt` on stdin — owner: Claude Code docs.
- [ ] `make test` (network + `gh`) cannot run in sandboxed workers — who runs it before release? — owner: user.

## 6. Spike candidates (not executed)

- `/gsd-spike "publish-gate treatment of new comment lines inside the heredoc of install-shipyard-claude-hook.sh"`
- `/gsd-spike "generate ROADMAP.md + REQUIREMENTS.md from an ADR's Decision bullets and run gsd plan-phase --ingest over it"`

## 7. Commands run for this line (exact)

```
git rev-parse HEAD
cat CLAUDE.md; sed -n 80,200p Makefile
cat .github/workflows/test.yml; cat .claude-plugin/marketplace.json; cat $P/.claude-plugin/plugin.json
sed -n 1,260p $P/commands/investigate.md
sed -n 1,634p $P/commands/decompose.md
sed -n 100,125p $P/skills/delivery-rules/SKILL.md
sed -n 1,30p / 378-460 / 520-580p $P/scripts/validate-graph.cjs; grep -n "conflict|overlap|errors.push" …
sed -n 1,230p / 470-560p $P/scripts/stop-gate.cjs; grep -n worktree tests/unit/stop-gate.test.cjs
sed -n 95,135p scripts/install-shipyard-claude-hook.sh; grep -n … scripts/install-shipyard-claude-hook.sh
sed -n 586,620p scripts/install-shipyard-codex.sh; grep -c route tests/smoke/claude-hook-smoke.sh → 0
grep -n "REFERENCE_UNAVAILABLE|INVALID_INPUT" $P/scripts/*.cjs; sed on claude-decompose-host.cjs, claude-investigation-host.cjs
sed -n 1,60p $P/scripts/jira-project.cjs; sed -n 120,185p .planning/architecture/ADR-008-*.md
sed -n 310,340p / 469-480 / 575-600p $P/scripts/gsd-tune.cjs
sed -n 1,205p $P/scripts/adr-ingest.cjs; ls -R $P/templates
Grep "ui_phase|ui_safety_gate|ui_review|figma" (excluding .planning)
git ls-files .build | wc -l → 0; git ls-files .planning | wc -l → 457
make test-fast → exit 2 (environmental, see §0)
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false node tests/unit/<f>.test.cjs (8 files)
node $P/scripts/publish-gate.cjs --base origin/main --working-tree --json → exit 0, ok true
```

Blocked probe: `ls ~/.claude/gsd-core`, `ls ~/.claude/skills` — denied by the session permission layer
(no approval surface); GSD-internal constraints (items 2, 9) are therefore marked unknown.
