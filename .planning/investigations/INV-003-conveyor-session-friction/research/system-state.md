# INV-003 — Research line: system state

Line id: `system-state` · Target section: RESEARCH.md "Current system state"
Selection: claude-opus-5-5 / medium · Policy signals (DATA, preserved verbatim): `{"type":"facts"}`
Worktree: `/Volumes/KINGSTON/.wt-claude-shipyard/inv-003` · Written 2026-09-24

All paths below are relative to the worktree root. Note: the problem statement
cites `scripts/…`, `commands/…`, `skills/…`; these live under
`plugins/delivery-pipeline/` (only `scripts/install-shipyard-claude-hook.sh` is
at repo-root `scripts/`). Checked with
`wc -l scripts/claude-decompose-host.cjs …` → "No such file or directory" for
every plugin file, then `wc -l plugins/delivery-pipeline/scripts/…` succeeded
(line counts: decompose-host 256, investigation-host 73, stop-gate 736,
adr-ingest 212, jira-project 862, validate-graph 637, gsd-tune 1124,
investigate.md 190, decompose.md 634, delivery-rules SKILL.md 165;
install-shipyard-claude-hook.sh 274).

## 0. Deployment state (hypothesis #1 check)

This INV is about friction in *shipped* behaviour, not "X does not happen";
still, the code examined must be the released code.

| Claim | Command | Evidence |
|---|---|---|
| Worktree HEAD is `856456a8`, origin/main is `befc970c` | `git rev-parse HEAD origin/main` | `856456a8c61f…`, `befc970c4b9c…` |
| HEAD = main + one INV-open commit (no product-code delta) | `git log --oneline -3 origin/main`; gitStatus snapshot at session start | `856456a8 inv(003): open …` atop `befc970c Merge PR #201 … release/version-0.61.0` |
| `befc970c` is on `main` | `git branch --contains befc970c` | `* inv/003-conveyor-session-friction`, `+ main` |
| Release merged 2026-09-24T13:33:32+03:00 | `git log -1 --format='%H %cI' befc970c` | as stated |
| Plugin source declares 0.61.0 | Grep `"version"` in `plugins/delivery-pipeline/.claude-plugin/plugin.json` | line 4: `"version": "0.61.0"` |
| **Unknown:** which version is installed in the user's `~/.claude` (plugin + hooks) | attempted grep of `~/.claude/plugins/installed_plugins.json` — **denied by sandbox/permission policy** | Next check: `cat ~/.claude/hooks/shipyard-stop-gate/version.json` and `/plugin` list, run by the user |

Conclusion: every friction item below is present in the released 0.61.0 source
(nothing is "absent because unmerged"). Whether the proving-ground session
3f4c2390 ran 0.61.0 or an earlier install is unknown (session predates or
straddles the release — assumption; next check: session transcript header /
installed `version.json`).

No `.planning/codebase/` map exists (Glob `.planning/codebase/*` → "No files
found"), so this line re-discovered the relevant structure directly.

## 1. Host refusals surface only internal codes

**Entry points**
- `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs`
  - `refuse(code, message)` (l.26-30) throws `Error("claude-decompose-host: <message>")` with `.code`.
  - Codes emitted: `INVALID_INPUT` (l.39, 95, 97, 102, 111, 213, 241), `UNSUPPORTED_ROLE` (l.99),
    `SCOPE_MISMATCH` (l.106), `INVALID_SIGNAL` (l.115, 118, 121), `REFERENCE_UNAVAILABLE`
    (l.47, 50, 61, 63, 71, 79, 82 — all about reading `~/.claude/agents/<role>.md` and inlined
    `@gsd-core/…` references), `CONFLICTING_OVERRIDE` (l.144), `NONCOMPLIANT_RECEIPT` (l.193).
  - CLI prints `${error.code || 'FAILED'}: ${error.message}` to stderr, exit 1 (l.249-254).
  - `--capability-only` prints JSON `{status:'unavailable', reason: error.code, detail, live_execution:'not_run'}` (l.234-236).
  - Messages are developer-facing (e.g. "reference is not a bounded regular file", "GSD agent identity is invalid") and name no remedy (e.g. "reinstall gsd-core / run ensure-gsd-core.sh").
- `plugins/delivery-pipeline/scripts/claude-investigation-host.cjs` (73 lines) — thin wrapper;
  its own refusals all use `INVALID_HOST` (l.21, 32, 37, 47, 61); runtime errors come from
  `claude-workflow-host.cjs` / `claude-delivery-host.cjs`; CLI prints only `error.message` (l.69-72), no code.
- Code census: Grep `REFERENCE_UNAVAILABLE|INVALID_INPUT` (count mode) → 270 occurrences in 33 files,
  incl. `dispatch-boundary.cjs` 13, `run-controller.cjs` 15, `run-store.cjs` 24, `codex-delivery-host.cjs` 21,
  `codex-decompose-host.cjs` 18 — the codes are a shared vocabulary across hosts, not local to two files.

**Command prose**
- `commands/investigate.md:47-49` "if the selected host is unavailable, stop that research line and report the runtime status";
  `commands/decompose.md:56-58, 99-100, 156, 282-284, 315` — "refuse before launch", "stop with a BLOCK".
- No instruction to translate a code into plain language / remedy for the user. Checked:
  `grep -rniE "plain[- ]language|explain .*refus|relay|in the user's language" commands/investigate.md commands/decompose.md`
  → only generic "reply in the user's language" (investigate.md:26, decompose.md:27, 455, 511).

**Tests**: `tests/unit/claude-decompose-host.test.cjs` asserts codes only (l.46-51 `INVALID_INPUT`, l.61/64 `REFERENCE_UNAVAILABLE`, via `grep -nE … | head -6`). No test asserts message readability or a remedy field. Also `tests/unit/codex-decompose-host.test.cjs`, `tests/unit/investigation-research.test.cjs` exist (`ls tests/unit`).

**Wart**: two different error shapes (`CODE: message` vs bare message) between the decompose and investigation CLIs.

## 2. No investigate → decompose bridge

- `commands/investigate.md:64-67` Step 1 precondition: "`.planning/` exists (otherwise suggest `/gsd-new-project` and stop)". Line 65 confirmed by Read.
- Gate 1 end (`investigate.md:184`) says next step is `/shipyard:decompose`; nothing creates `config.json`, `ROADMAP.md`, `REQUIREMENTS.md`.
- `commands/decompose.md` consumers of those files:
  - Step 0 l.63: "check ROADMAP.md and the existing `phases/*/`*-PLAN.md for mentions of ADRs".
  - Step 0.5 l.80-94: `gsd-tune.cjs --check --runtime` preflight, which fails with exit 2 when `.planning/config.json` is absent (`gsd-tune.cjs:325-326`).
  - PLAN frontmatter l.329-331: `requirements` REQUIRED, "Requirement ids from ROADMAP.md".
  - Step 2 l.277-278: `/gsd-plan-phase <N> --ingest …` (GSD upstream; its own need for ROADMAP/REQUIREMENTS/config is upstream behaviour — **unknown/not readable here**: `~/.claude/gsd-core` is outside the sandbox read allow-list; Grep on `/Users/serhii/.claude` was refused).
- decompose.md never mentions `/gsd-new-project` (Grep for `gsd-new-project` in decompose.md → no match) and has no step that derives ROADMAP/REQUIREMENTS from the ADR.
- The repo itself has `.planning/config.json` (Grep hit at `.planning/config.json:28-29`), so this repo's own dogfooding does not exercise the missing-bootstrap path.

## 3. Stop gate blocks non-deliver sessions

- `plugins/delivery-pipeline/scripts/stop-gate.cjs`:
  - Design note l.83-91: "every worktree of the cwd's repository is a candidate, and the front with the newest `generated_at` is the one describing a run that is actually happening"; l.89-91 explicitly accepts "the busier board answer[ing] for the quieter one".
  - `worktreesOf(cwd)` l.285-293 (`git worktree list --porcelain`).
  - Non-scoped selection l.514-523 over `[cwd, ...worktreesOf(cwd)]`; newest `generated_at` wins l.526-529.
  - Scoped mode (l.490-513) only when `payload.run_id`, `SHIPYARD_RUN_ID`, `SHIPYARD_RUN_CONTROL=scoped` or `SHIPYARD_RUN_STORE_DIR` is set — a plain investigate/decompose session sets none (assumption based on the commands not setting them; next check: grep investigate/decompose for `SHIPYARD_RUN_ID`).
  - Session identity (`payload.session_id`, l.265-267) is used only for the anti-loop ledger (l.412-439), never to ask "did this session run deliver / touch this front".
  - Kill switch: `SHIPYARD_STOP_GATE=off` (l.254). Cap: `SHIPYARD_STOP_GATE_MAX_BLOCKS` 12 (l.59-61).
- Installed globally as a Stop hook by `scripts/install-shipyard-claude-hook.sh:246` (`add_hook Stop "$STOP_CMD"`), plus `session-observer.cjs hook` (l.247) — so it fires in every Claude session in every repository.
- Tests: `tests/unit/stop-gate.test.cjs` exists (`ls tests/unit`); smoke `tests/smoke/claude-hook-smoke.sh` (78 lines) via `make test-hooks` (Makefile l.77-78). Whether any test covers "session never ran deliver" — **unknown**; next check: grep stop-gate.test.cjs for `session_id` / multi-worktree fixtures.

## 4. Auto-route hook

- `scripts/install-shipyard-claude-hook.sh:109-131` writes `~/.claude/hooks/shipyard-auto-route.sh` as a static `cat <<'POLICY'` — it does **not** read stdin, so it cannot inspect the prompt; it injects the policy on every `UserPromptSubmit` (registered l.243), including `<task-notification>` messages and slash-command prompts.
- Policy text routes only "large / multi-ticket → /shipyard:decompose → /shipyard:deliver", "/shipyard:bench", inline (l.118-120); no `/shipyard:investigate` route and no trigger list. The only exclusion is prose: "Skip this entirely for pure questions…" (l.129).
- Contrast: `commands/route.md:63` does route "unclear, needs research, decisions not yet made, or a raw problem" → `/shipyard:investigate`; the hook text is out of sync with the router it points to.
- Codex parity: `scripts/install-shipyard-codex.sh:578-610` writes an equivalent block into global `AGENTS.md` between `<!-- shipyard-auto-route:begin/end -->` markers, with `${largeRoute}` interpolation (phase flag `SHIPYARD_CODEX_PHASE`, l.20). Whether `${largeRoute}` includes investigate — **unknown**; next check: `sed -n 570,600p scripts/install-shipyard-codex.sh`.
- Test coverage of the policy text: `grep -nE "ROUTE|route" tests/smoke/claude-hook-smoke.sh` → no matches (hook smoke does not assert route content). `grep -rlE "auto-route|install-shipyard-claude-hook" tests` → `tests/smoke/claude-hook-smoke.sh`, `docs-smoke.sh`, `codex-shipyard-smoke.sh`.

## 5. No ADR template; Gate 1 does not validate with adr-ingest

- Templates present: Glob `plugins/delivery-pipeline/templates/**` → only `templates/inv/{DECISIONS,OPEN-QUESTIONS,OPTIONS,PROBLEM,RESEARCH,RISKS}.md`. No `templates/adr/`.
- Gate 1 (`investigate.md:170-184`): runs `validate-inv.cjs <INV-dir>` (l.174), then describes the ADR format in prose (Nygard, one bullet per decision under `## Decision`, `## Out of scope`, no nested `###`, l.175-180). `adr-ingest.cjs` is not invoked.
- `adr-ingest.cjs` is first run in decompose Step 2 (`decompose.md:269-276`), which says it "exits non-zero when an ADR has no decisions. Stop on that error" — i.e. a malformed ADR is discovered one loop late.
- `adr-ingest.cjs` CLI (`parseArgs` l.148-161): requires `--input` and one of `--output`/`--output-dir`; no check-only mode; throws "no decisions were found under an ADR Decision section" (l.145); exit code 1 on error (l.203). So using it as a Gate-1 validator needs either a temp output dir or a new `--check` flag.
- Tests: `tests/unit/adr-ingest.test.cjs` exists.

## 6. Jira export is model-driven

- `commands/decompose.md:488-613` (Step 5) is entirely prose: project auto-resolution (l.504-518), MCP tool list (l.535-539: `getVisibleJiraProjects`, `getJiraProjectIssueTypesMetadata`, `searchJiraIssuesUsingJql`, `createJiraIssue`, `editJiraIssue`, `createIssueLink`, `getIssueLinkTypes`), namespaced-label idempotency and legacy migration (l.541-583), procedure incl. "for each `depends_on`, a 'is blocked by' issue link … pick the link type via `getIssueLinkTypes`" (l.606-607), write-back `delivery.jira` + rerun validate-graph (l.608-611). "do not hand-roll REST calls" (l.538-539).
- `plugins/delivery-pipeline/scripts/jira-project.cjs` header (l.4-9): "the WATERMARK for the tracker projection (ADR-008 D1)" with subcommands `read`, `plan`, `record … --transition-id`, `record --unreachable` — status transitions only. `grep -nE "createJiraIssue|createIssueLink" jira-project.cjs` → no match.
- So there is no deterministic producer of a create/link plan (labels, summaries, link direction); link direction is left to the model each run (problem statement: 22 MCP calls, manual direction).
- Tests: `tests/unit/jira-project.test.cjs` exists (watermark behaviour).
- Constraint noted: deliver never reads Jira; Jira is a projection (`decompose.md:490-492`, §5.35). A script can only produce a plan/manifest; MCP calls remain model-executed unless a REST client is added (which l.538-539 currently forbids).

## 7. Linearization prose vs validator; order-only links

- Validator (`validate-graph.cjs`):
  - `primaryParent` l.524-528: deepest same-phase, same-repo dependency (ties by id).
  - `pr_base` l.533: primary parent's branch or the epic.
  - Diamond warning l.545-549: "`N` same-phase parents … the cascade bases on `<primary>` only; the others land through the epic. Linearize the chain if `<id>` needs every parent's code at once." — i.e. linearize **only when** every parent's code is needed.
  - Cross-repo (l.537-544) and cross-phase (l.550-554) warnings.
- Prose: `decompose.md:432` "multiple dependencies of the same phase (diamond) it will flag as a warning — linearize the chain where possible"; `skills/delivery-rules/SKILL.md:113-114` "a diamond get[s] a warning — linearize when practical". Both omit the "only if it needs every parent's code" condition, which pushes the planner toward a serial chain (field: 11-wave serial graph).
- Order-only relations: `grep -rnE "order_after|soft_dep|after:|ordering_only|order-only"` over validate-graph.cjs, decompose.md, SKILL.md → exit 1 (no match). The only relation field is `depends_on`, which drives wave, `pr_base` and Jira "is blocked by" links (decompose.md:425-431, 606-607). An "A should land before B but B does not need A's code" relation has no representation.
- Tests: `make test-graph` → `tests/smoke/graph-validator-smoke.sh` (Makefile l.56-57).

## 8. No preflight for untracked `.planning/`

- `grep -rnE "\.planning.*(untracked|ignored|not tracked)|(untracked|ignored).*\.planning" plugins/delivery-pipeline` → only delivery-time code comments: `graph-dir.cjs:74` (error hint for a worktree with no `.planning/` "when the project keeps it untracked"), `log-event.cjs:37`, `drift-needed.cjs:299` ("project that keeps `.planning/` untracked (the proving ground does)").
- No check in `commands/investigate.md` Step 1 preconditions (l.64-67) or `decompose.md` Step 0/0.5. The system knows the proving ground keeps `.planning/` untracked (drift-needed.cjs:299) but does not warn at intake.
- In this repo `.planning/` is tracked: `git ls-files .planning | wc -l` → 457; `.gitignore` ignores only `.planning/graph/stop-gate-ledger.json`, `.planning/graph/session-observations.jsonl`, `/.planning/.adr-ingest/` (l.12-14).

## 9. GSD UI gate on prototype / no-Figma scopes

- Shipyard has no UI-gate logic of its own: `grep -rniE "ui[-_ ]?(gate|phase|spec)|gsd-ui|figma|prototype"` over plugin commands, skills and `gsd-tune.cjs` → no output.
- The gate is GSD config: this repo's `.planning/config.json:28-29` has `"ui_phase": true`, `"ui_safety_gate": true` (Grep `ui_phase|ui_safety_gate|ui-phase|UI-SPEC`).
- `gsd-tune.cjs` manages `workflow.use_worktrees` (l.589) and other conveyor keys but not `workflow.ui_*` (`grep -nE "workflow\.|'ui|\"ui" gsd-tune.cjs` → only l.14, 561, 589).
- `decompose.md:246` recommends `--mvp` "vertical slices UI→API→DB (recommend for new features with UI)"; no guidance to disable/skip the UI gate for prototype/no-Figma scopes.
- **Unknown:** how GSD's `/gsd-plan-phase` decides to invoke the UI gate (keyword heuristic vs config) — GSD source is outside the sandbox read allow-list. Next check: grep `ui_safety_gate` in `~/.claude/gsd-core/workflows/plan-phase.md` (owner: user / gsd-core).

## 10. gsd-tune "conveyor's own project root" message

- `gsd-tune.cjs:325-326`: `if (!GLOBAL) fail(\`no ${CONFIG} — run this from a GSD project (the conveyor's own project root)\`)`; `fail` exits 2 (l.322). Problem statement cites l.326 — confirmed.
- Message gives no actionable step (e.g. "run `/gsd-new-project` or create `.planning/config.json`, then `gsd-tune --apply --runtime <r>`"), and it is exactly the preflight decompose Step 0.5 runs (`decompose.md:81`), so item 2 and item 10 compound: a project with no config hits this opaque message first.
- `ROOT = process.cwd()` (l.317) — invoked from a subdirectory or a different worktree also yields this message (assumption from code; next check: unit test in `tests/unit/gsd-tune.test.cjs`).
- Tests: `tests/unit/gsd-tune.test.cjs` exists; `make gsd-tune` / `gsd-tune-apply` targets (Makefile l.37-41).

## Cross-cutting: build, tests, Codex parity

- `make test-fast` = test-unit test-graph test-worktree test-worktree-gates test-gsd-sync test-sentinel test-docs test-hooks test-comment-policy test-model-ladder-runtime; `make test` = test-fast + test-codex-shipyard + test-releases (Makefile l.47, 51; targets l.53-87). Unit runner `tests/unit/run.sh`.
- Codex outputs are generated by `scripts/gen-codex-shipyard.cjs` from canonical `plugins/delivery-pipeline/` commands/references into `.build/codex-shipyard/` (header l.3-23); conversion delegates to installed gsd-core's `runtime-artifact-conversion.cjs`. Any change to `commands/*.md` / `skills/*` must be regenerated and checked by `make test-codex-shipyard` (`tests/smoke/codex-shipyard-smoke.sh`). Codex auto-route policy is separate text in `scripts/install-shipyard-codex.sh:578-610` and must be edited in parallel for item 4.
- Existing unit tests relevant to the ten items (`ls tests/unit | grep …`): adr-ingest, claude-decompose-host, codex-decompose-host, gsd-tune, investigation-research, jira-project, stop-gate. None found for the auto-route hook text.
- None of the tests were executed by this line (read-only research); green status of `make test-fast` / `make test` on HEAD is **not verified here**. Next check: `make test-fast` in the worktree.

## Unknowns / next checks (for OPEN-QUESTIONS)

- [ ] Installed shipyard version (plugin + `~/.claude/hooks/shipyard-stop-gate/version.json`) during session 3f4c2390 — owner: user (sandbox denied read).
- [ ] What GSD `/gsd-plan-phase` requires from `config.json`/`ROADMAP.md`/`REQUIREMENTS.md` and how it triggers the UI gate — owner: user / gsd-core (source not readable here).
- [ ] Does `stop-gate.test.cjs` cover a session that never touched any front? — owner: research (grep test file).
- [ ] Does Codex `${largeRoute}` include `$shipyard-investigate`? — owner: research (`scripts/install-shipyard-codex.sh` ~l.570-600).
- [ ] Is `make test-fast` green on HEAD `856456a8`? — owner: executor (run it).
- Possible spike: `/gsd-spike "stop-gate: scope front selection to fronts this session_id touched (session-observer evidence)"`.
