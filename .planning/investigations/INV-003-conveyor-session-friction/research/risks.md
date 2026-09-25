# INV-003 — Research line 4: risks & unknowns

- Line: `risks` (→ RISKS.md + OPEN-QUESTIONS.md drafts)
- Model selection (resolved by caller): `claude-opus-5-5` / `medium`
- Policy signals (preserved verbatim as data): `{"type":"facts"}`
- Source revision: `856456a8c61f907ae360651688dbc31fc7eb6722` (branch `inv/003-conveyor-session-friction`)
  — checked with `git rev-parse HEAD` (output above), working tree clean at start (gitStatus snapshot).
- Repo root for all paths below: `/Volumes/KINGSTON/.wt-claude-shipyard/inv-003`.

## 0. Path correction (applies to every item)

The problem statement's paths (`scripts/…`, `commands/…`, `templates/adr/…`) are
relative to `plugins/delivery-pipeline/`, except `scripts/install-shipyard-claude-hook.sh`
and `scripts/gen-codex-shipyard.cjs`, which are at the repo root.
- Command: `git ls-files | grep -E '(decompose-host|investigation-host|stop-gate|install-shipyard-claude-hook|adr-ingest|jira-project|validate-graph|gsd-tune)'`
  → `plugins/delivery-pipeline/scripts/{adr-ingest,claude-decompose-host,claude-investigation-host,codex-decompose-host,gsd-tune,jira-project,stop-gate,validate-graph}.cjs`, `scripts/install-shipyard-claude-hook.sh`.
- Command: `ls plugins/delivery-pipeline/templates` → only `inv` (so `templates/adr/ADR.md` does not exist — item 5 confirmed).
- Command: `ls .planning/codebase` → `No such file or directory` (no codebase map; this research had no map to rely on).

## 1. Command-backed findings that shape the risks

| # | Finding | Command / evidence |
|---|---------|--------------------|
| F1 | Stop gate selects the newest `generated_at` across `[cwd, ...worktreesOf(cwd)]` unless scoped mode (`run_id` / `SHIPYARD_RUN_CONTROL=scoped` / `SHIPYARD_RUN_STORE_DIR`) is active. | `sed -n 488,540p plugins/delivery-pipeline/scripts/stop-gate.cjs` → lines 494–529 (`candidates.sort(...)`, `candidates[0]`). File is 736 lines (`wc -l`). |
| F2 | The cross-worktree selection was a deliberate fix for a measured failure: the gate was inert when it read the main checkout's stale front; "one of those stops cost 5h46m of silence". The header accepts that "two sessions delivering different phases of one repo would let the busier board answer for the quieter one". | `sed -n 1,140p plugins/delivery-pipeline/scripts/stop-gate.cjs` → comment block "WHICH FRONT (measured, 2026-08-30)", lines ~63–91. |
| F3 | The stop gate and the auto-route hook are installed **by copy** into `~/.claude/hooks/` (`shipyard-auto-route.sh`, `shipyard-stop-gate/stop-gate.cjs` bundle). A previous measurement found the installed copy at 379 lines vs repo at 672 lines. | `grep -n "hooks/shipyard-stop-gate\|..." scripts/install-shipyard-claude-hook.sh` → lines 16, 31, 33, 36, 245; `cat .planning/backlog/the-stop-gate-enforcing-this-session-predates-the-fix-for-this-exact-case.md`. |
| F4 | The auto-route hook body is a static heredoc policy injected on **every** `UserPromptSubmit`; it has no investigate route, no prompt filtering, and only a prose "Skip this entirely for pure questions…" clause. | `sed -n 100,140p scripts/install-shipyard-claude-hook.sh` → lines 109–131. |
| F5 | Host refusals use bare codes with short English detail, e.g. `refuse('REFERENCE_UNAVAILABLE', 'reference escaped its trusted root')`; codes are asserted by `tests/unit/claude-decompose-host.test.cjs`. The Codex twin `codex-decompose-host.cjs` exists. | `grep -n "REFERENCE_UNAVAILABLE\|INVALID_INPUT" plugins/delivery-pipeline/scripts/claude-decompose-host.cjs plugins/delivery-pipeline/scripts/claude-investigation-host.cjs` (15 hits in decompose host, lines 39–241); `grep -rln REFERENCE_UNAVAILABLE tests plugins`. |
| F6 | `claude-investigation-host.cjs` has no dedicated unit test file; it is referenced by `tests/unit/source-contract.test.cjs` and `tests/unit/claude-workflow-host.test.cjs`. | `ls tests/unit \| grep -i investigat` → only `investigation-research.test.cjs`; `grep -rln claude-investigation-host tests plugins`. |
| F7 | `investigate.md` Step 1 precondition: "`.planning/` exists (otherwise suggest `/gsd-new-project` and stop)". Gate 1 (Step 3) runs `validate-inv.cjs` and asks the model to write a Nygard ADR "in a format that `/gsd-plan-phase --ingest` parses" — no `adr-ingest.cjs` call. | `sed -n '55,75p;165,190p' plugins/delivery-pipeline/commands/investigate.md`. |
| F8 | `adr-ingest.cjs` has no check-only mode: `main` requires `--output` or `--output-dir`, and `prepareOutputDir` **deletes** existing `*.ingest.md` in the output dir. Exports `validateAdr`, `normalizeAdr`. Only consumer is `commands/decompose.md:270-278`. | `sed -n 150,215p plugins/delivery-pipeline/scripts/adr-ingest.cjs`; `grep -rln adr-ingest plugins scripts` → only `commands/decompose.md`. |
| F9 | Decompose reads `ROADMAP.md` (line 63), requires `requirements:` ids "from ROADMAP.md" (line 329), and reads/writes `.planning/config.json → pipeline.jira` (lines 499–513). | `grep -n "config.json\|ROADMAP.md\|REQUIREMENTS.md\|gsd-new-project" plugins/delivery-pipeline/commands/decompose.md`. |
| F10 | Jira export is prose instructing MCP use and explicitly forbids hand-rolled REST: "No Jira MCP available → skip with a note; do not hand-roll REST calls." `jira-project.cjs` (862 lines) is a watermark store with no network calls (`fetch`/`https` absent). | `sed -n 530,545p plugins/delivery-pipeline/commands/decompose.md`; `grep -n "fetch\|https\|JIRA_\|token" plugins/delivery-pipeline/scripts/jira-project.cjs` → only comment hits (63, 306, 814). |
| F11 | Linearization prose (`decompose.md:425-432`, `skills/delivery-rules/SKILL.md:108-114`) says "linearize the chain where possible"; the validator warning (`validate-graph.cjs:545-548`) is more precise: cascade bases on the primary parent only, others "land through the epic. Linearize … if <id> needs every parent's code at once." `depends_on` drives PR base (`pr_base`) and cascade. | `sed -n 425,440p …/decompose.md`; `sed -n 108,120p …/SKILL.md`; `sed -n 535,565p …/validate-graph.cjs`. |
| F12 | `gsd-tune.cjs:326` message: `no ${CONFIG} — run this from a GSD project (the conveyor's own project root)`, exit 2. | `sed -n 315,335p plugins/delivery-pipeline/scripts/gsd-tune.cjs`. |
| F13 | No shipyard file mentions a UI gate / Figma / UI-SPEC; the UI gate is therefore invoked from GSD (upstream) rather than shipyard. | `grep -rn -i "ui gate\|ui-phase\|gsd-ui\|figma\|prototype" plugins/delivery-pipeline/{commands,skills,workflows}` → only an unrelated `Object.prototype` hit; `grep -n -i "\-\-skip-ui\|ui_phase\|ui-spec\|skip.*ui" plugins/delivery-pipeline/commands/*.md` → no hits. |
| F14 | In this repo `.planning/` is tracked (`.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`), and `.gitignore` notes "`.planning/graph/` is otherwise tracked". Stop gate and worktree-based delivery rely on tracked `.planning/graph/` in each worktree. | `git ls-files .planning \| head -3`; `grep -rn "\.planning" .gitignore` → lines 10–14. |
| F15 | Codex artifacts are generated, not committed: `gen-codex-shipyard.cjs` stages to `.build/codex-shipyard/`; CLAUDE.md: "Edit the Claude command or shared script first, then run `make install-shipyard-codex`". `make test` = `test-fast test-codex-shipyard test-releases`; `test-codex-shipyard` "installs GSD from the npm registry". | `sed -n 1,30p scripts/gen-codex-shipyard.cjs`; `grep -n "^[a-z-]*:" Makefile` (line 47, 51); `grep -n … CLAUDE.md` lines 44–50, 66–70, 112. |
| F16 | `make doctor` already "compare[s] the source with the installed Claude hook and Codex bundle. It is read-only." | `sed -n 100,121p CLAUDE.md`. |
| F17 | Hook smoke test does not reference `task-notification` or slash prompts. | `grep -n "task-notification\|slash\|^\s*/" tests/smoke/claude-hook-smoke.sh` → no output. |

Not verified (no command could reach it from this sandbox): the MYD-17627 session
3f4c2390 transcript, the pdffiller/proving-ground repository, the installed
`~/.claude/hooks/*` on the operator machine, GSD upstream source (`gsd-new-project`,
`gsd-plan-phase` UI gate), and the Jira project. Tests were **not** run by this
line (read-only research; `make test` also needs npm network per F15).

## 2. RISKS.md draft

Format follows the template (`severity`, `mitigation`).

### R1 — Scoping the stop gate re-opens the "inert gate" failure
severity: high
Item 3 wants the gate to stop blocking sessions that never ran deliver. The
cross-worktree selection (F1) exists precisely because cwd-only selection made the
gate silent for 5h46m on a real run (F2). Any fix that narrows selection to "this
session's" front risks re-creating that silence, and the Stop hook payload carries
no flags/env from the caller (F2 header).
mitigation: Make the discriminator positive evidence of deliver in *this* session
(e.g. session_id recorded by deliver Step 0 into the ledger, or scoped mode already
supported at lines 494–513) rather than narrowing by cwd; keep the existing
fixture tests in `tests/unit/stop-gate.test.cjs` green and add a fixture for
"analysis-only session + fresh foreign front" and one reproducing the 2026-08-30
stale-main-checkout case.

### R2 — Fixes to installed-by-copy hooks do not reach running operators
severity: high
Items 3 and 4 change files that are copied into `~/.claude/hooks/` (F3). A released
fix is inert until the operator reruns `make install-shipyard-claude-hook`; the
backlog note records a 379-vs-672-line drift. The MYD-17627 repeat run could
therefore execute the old gate/router and "fail" the success criterion for a
reason unrelated to the fix.
mitigation: Make the repeat-run procedure include `make install-shipyard-claude-hook`
+ `make doctor` (F16) before starting; consider the backlog's option 1 (stamp the
installed copy with version/commit and warn when behind).

### R3 — Auto-route over-filtering suppresses legitimate routing
severity: medium
Item 4 wants the hook to skip `<task-notification>` and slash prompts and add an
investigate route. The hook is a static heredoc (F4); adding input inspection turns
a no-logic script into a parser of the UserPromptSubmit payload. Mis-detection can
suppress routing for real work requests (silent regression) or keep injecting into
subagent notifications. Hook smoke has no coverage for these inputs (F17).
mitigation: Fixture-test the hook with payload samples (plain request, slash
command, `<task-notification>` wrapper, pure question) in `tests/smoke/claude-hook-smoke.sh`;
fail open (inject) on unparseable payloads.

### R4 — Investigate→decompose bridge fabricates requirements
severity: high
Item 2: generating `ROADMAP.md` / `REQUIREMENTS.md` / `config.json` from the ADR
(F9) is the exact place where the MYD-17627 session "invented requirements". A
bridge that writes these files deterministically from an ADR that lacks
requirement material will institutionalize the invention; overwriting an existing
GSD project's ROADMAP/REQUIREMENTS would destroy user data.
mitigation: Bridge only creates missing files, never rewrites existing ones; every
generated requirement must trace to an ADR decision bullet (id carried from
`adr-ingest` `decisions`); refuse with a plain-language message when the ADR has
no decisions. Fixture test: existing `.planning/ROADMAP.md` is left byte-identical.

### R5 — Coupling to GSD's file formats (upstream drift)
severity: medium
ROADMAP/REQUIREMENTS/config.json formats and the `--ingest` parser belong to
gsd-core (installed `@latest`, CLAUDE.md line 23). A shipyard-generated ROADMAP
may parse today and break on a GSD release; upstream multi-line `**Goal**` parsing
is already a known defect (out of scope per PROBLEM.md).
mitigation: Generate the minimal subset and validate it with GSD's own tooling in
a fixture; pin/record the gsd-core version used by the fixture.

### R6 — Using adr-ingest as a Gate-1 validator has side effects
severity: medium
Item 5: `adr-ingest.cjs` has no check-only mode and `--output-dir` deletes existing
`*.ingest.md` files (F8). Running it at Gate 1 against `.planning/.adr-ingest/`
could delete ingests of other, already-closed ADRs that decompose has not yet
consumed.
mitigation: Add a `--check` mode (or call exported `validateAdr` from
`validate-inv.cjs`) that writes nothing; unit test that `--check` leaves the output
dir untouched. Template `templates/adr/ADR.md` must be validated by the same
function in a test so template and validator cannot drift.

### R7 — Plain-language refusal relay breaks code contracts / Codex parity
severity: medium
Item 1: refusal codes are asserted by tests (F5) and likely matched by callers.
Changing codes or stderr shape breaks them; adding the relay only to Claude
commands leaves Codex (`codex-decompose-host.cjs`, generated skills) behind (F15).
The investigation host has no dedicated test (F6), so its refusals are less
protected.
mitigation: Keep codes stable; add a separate human `hint` field / message map;
put the relay requirement in the canonical command text so the Codex generator
carries it; add `tests/unit/claude-investigation-host.test.cjs`.

### R8 — Deterministic Jira export conflicts with the "no hand-rolled REST" rule and credential boundary
severity: high
Item 6: scripts cannot call MCP tools; `decompose.md` forbids REST (F10). A
script that talks to Jira needs credentials, introduces a new network/security
boundary and a new failure mode (partial creation, duplicate issues). Link
direction errors (a MYD-17627 pain point) become systematic if the mapping is wrong
once.
mitigation: Prefer "deterministic plan, model-executed": a script emits an ordered,
idempotent operation list (create/update/link with explicit inward/outward
direction, keyed by the repo-namespaced identity already required at
`decompose.md:540-545`), and the model executes it via MCP, recording keys through
`jira-project.cjs`-style watermark store. Fixture-test the plan; no live Jira in CI.
This initiative's own tickets are not exported (PROBLEM.md out-of-scope), so there is
no live proving run for item 6 inside this initiative.

### R9 — Linearization rule change alters cascade topology
severity: medium
Item 7: `depends_on` is the cascade backbone and determines `pr_base` (F11).
Reclassifying order-only links (e.g. a separate `after:` / soft-order field) changes
graph schema consumed by `validate-graph.cjs`, the front, deliver, and the Jira
link projection. Dropping a real dependency gives the executor an incomplete base.
mitigation: Treat as schema-additive (new optional field, `depends_on` semantics
unchanged); validator warns on suspected order-only deps rather than rewriting;
graph fixtures under `make test-graph` updated deliberately.

### R10 — `.planning/` untracked preflight: false positives
severity: low
Item 8: some teams deliberately gitignore `.planning/`; worktree-based delivery
needs it tracked (F14). A hard failure would block those teams; a warning that
fires every command becomes noise.
mitigation: Warn once in the preflight of investigate/decompose/deliver (not the
hook), with the exact `git add .planning` / `.gitignore` remedy; no hard stop.

### R11 — UI-gate fix may be out of shipyard's reach
severity: medium
Item 9: no shipyard file invokes a UI gate (F13); the gate is GSD's. A shipyard
fix is limited to passing a skip flag / config key GSD already supports; if none
exists, this becomes an upstream defect (out of scope per PROBLEM.md's GSD rule).
mitigation: Confirm the GSD knob before planning (see OQ5); if absent, report to
gsd-core and document the workaround.

### R12 — Scope breadth: ten items, one release, generated parity
severity: medium
Ten independent fixes touch commands, installers, hooks, three scripts, and the
Codex generator. `make test` depends on npm registry access (F15) — a network
flake can block the release gate. A single phase risks recreating the "strictly
serial 11-wave graph" the investigation complains about.
mitigation: Slice into independent same-phase tickets with no false `depends_on`
(dogfooding R9's rule); run `make test-codex-shipyard` early.

### R13 — Success criterion depends on an unrepeatable external run
severity: medium
"A repeat of MYD-17627 … without manual detours" needs the proving-ground repo,
the same model behaviour and a Jira MCP. Model variance can produce a detour that
is not a shipyard defect; there is no objective pass/fail rubric yet.
mitigation: Define a checklist of observable events (no `/gsd-new-project` call,
no raw refusal code surfaced unexplained, no Stop-hook block in an analysis-only
session, graph waves < N) before the run; record the transcript.

## 3. OPEN-QUESTIONS.md draft

- [ ] Can the stop gate learn "this session ran deliver" from the Stop hook payload (e.g. `session_id` + a ledger entry written by deliver Step 0), or does item 3 require enabling scoped mode (`SHIPYARD_RUN_CONTROL=scoped`) by default? — owner: shipyard maintainer (Serhii Nochevnyi)
- [ ] Is the cross-worktree "busier board answers for the quieter one" trade-off (stop-gate.cjs header) still acceptable, or is it now the higher cost versus the 2026-08-30 inert-gate case? — owner: shipyard maintainer
- [ ] Should the installed hooks carry a version stamp that `state-sync`/`doctor` checks (backlog option 1), and is that in this initiative's scope or a separate backlog item? — owner: shipyard maintainer
- [ ] What does the Claude Code `UserPromptSubmit` payload contain for `<task-notification>` and slash-command prompts (field names, whether the slash command is already expanded)? — owner: Claude Code hook documentation / a `/gsd-spike "log UserPromptSubmit payloads for slash and task-notification prompts"`
- [ ] Does GSD expose a supported knob to skip its UI gate (flag on `/gsd-plan-phase` or a `config.json` key), and which GSD command triggers it in the MYD-17627 flow? — owner: gsd-core maintainers / check gsd-core source
- [ ] Which minimal `ROADMAP.md` / `REQUIREMENTS.md` / `config.json` shape does decompose (and GSD `--ingest`) actually need, and may the bridge create them or must it delegate to a GSD command? — owner: shipyard maintainer + gsd-core docs
- [ ] When an ADR contains no requirement material, should the bridge refuse, derive one REQ per ADR decision bullet, or use the tracker id? (`decompose.md:329-331`, checked with `sed -n 329,331p`: an empty `requirements` array "is a BLOCKER in both the GSD plan-checker and Gate 2 … add a REQ entry to ROADMAP, or use the tracker id".) — owner: shipyard maintainer
- [ ] For deterministic Jira export: script-emitted operation plan executed via MCP, or direct REST with credentials (which reverses decompose.md's "do not hand-roll REST calls")? — owner: shipyard maintainer (product decision)
- [ ] Which Jira link type and direction does the conveyor treat as canonical for `depends_on` ("blocks"/"is blocked by"), and does it vary by Jira instance? — owner: Jira admin of the proving-ground project
- [ ] Should order-only relations get a new graph field, or be removed from the graph entirely? — owner: shipyard maintainer
- [ ] Is a `.planning/`-untracked project a supported configuration (warn) or unsupported (refuse)? — owner: shipyard maintainer
- [ ] Should `adr-ingest` gain a `--check` mode, or should Gate 1 call `validateAdr` via `validate-inv.cjs`? — owner: shipyard maintainer
- [ ] Are refusal codes (`REFERENCE_UNAVAILABLE`, `INVALID_INPUT`) matched by any external consumer beyond tests (e.g. Codex host adapters), constraining their text? — owner: shipyard maintainer / `grep` across `plugins/` and generated Codex bundle
- [ ] Is the proving-ground repository (MYD-17627) and a Jira MCP available for the repeat run, and what objective checklist defines "without manual detours"? — owner: user (Serhii Nochevnyi)
- [ ] What was the actual trigger of the three rejected AskUserQuestion prompts in session 3f4c2390 (which command step asked them)? The transcript is not reachable from this worktree. — owner: user (session transcript holder)
- [ ] Where did the "~17 min of blocker explanations" come from — decompose host, investigation host, or both? — owner: user (session transcript)

## 4. Spike candidates (not executed; per contract)

- `/gsd-spike "log UserPromptSubmit payloads for slash-command and <task-notification> prompts"` — resolves the R3 unknown.
- `/gsd-spike "run stop-gate.cjs with an analysis-only session payload against a repo with a fresh foreign worktree front"` — reproduces item 3 before design.
- `/gsd-spike "generate minimal ROADMAP/REQUIREMENTS from an ADR and run /gsd-plan-phase --ingest on it"` — validates R4/R5.

## 5. Constraints surfaced by this line (seeds for the constraints line)

- Fail-closed receipt verification and ADR-014 grid are out of scope (PROBLEM.md; CLAUDE.md lines 77–88).
- Claude plugin is canonical; Codex outputs are generated and must be regenerated (CLAUDE.md lines 66–70, 112).
- Shell scripts keep `set -euo pipefail` (CLAUDE.md "Editing rules").
- Jira: no hand-rolled REST in current contract (decompose.md:537-538).
- Hooks install by copy with no plugin-path resolution (install-shipyard-claude-hook.sh:15-16).
