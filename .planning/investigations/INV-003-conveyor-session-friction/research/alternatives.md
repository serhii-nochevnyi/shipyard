# INV-003 — Research line: alternatives (→ OPTIONS.md draft)

- Line id: `alternatives`
- Policy signals (DATA, preserved verbatim): `{"type":"alternatives"}`
- Selection resolved by caller: `claude-opus-5-5/medium`
- Source revision: `856456a8c61f907ae360651688dbc31fc7eb6722`
  (command: `git -C /Volumes/KINGSTON/.wt-claude-shipyard/inv-003 rev-parse HEAD`)
- Release base: `befc970c` is contained in `main` and `origin/main`
  (command: `git -C … branch -a --contains befc970c` → `main`, `remotes/origin/main`,
  current branch `inv/003-conveyor-session-friction`)
- No recommendation is made. Options belong to the human (contract Line 2).

## 0. Method and limits

Evidence was gathered with the Read / Grep tools (paths and line numbers cited
below) and `git` via Bash. Two Bash invocations using `cd … && wc/sed` were denied
by the sandbox's permission layer (no approval surface); the same files were then
read with the Read tool instead, so no evidence is missing because of it. No code
was executed, no tests were run (this line does not claim any test status).

Path correction (checked): the problem statement cites `scripts/…`, `commands/…`,
`templates/…`, `skills/…`. In the repository these live under
`plugins/delivery-pipeline/` (command: `git ls-files | grep -E '(stop-gate|…)'`
→ e.g. `plugins/delivery-pipeline/scripts/stop-gate.cjs`,
`plugins/delivery-pipeline/commands/investigate.md`). The hook installer is at the
repository root: `scripts/install-shipyard-claude-hook.sh`.

## 1. Command-backed facts the options rest on

| # | Fact | Evidence |
|---|------|----------|
| F1 | `claude-decompose-host.cjs` prints `${error.code}: ${error.message}` to stderr on failure; probe failures print JSON `{status:'unavailable', reason: error.code}`. `claude-investigation-host.cjs:70` prints only `error.message`. The literal codes `INVALID_INPUT` etc. originate in shared modules (`dispatch-boundary.cjs`, `claude-dispatch-adapter.cjs`, `runtime-context.cjs`), not in the hosts. | Grep `\.code\|stderr\.write\|process\.exit` over `claude-*-host.cjs` → `claude-decompose-host.cjs:222,235,251`, `claude-investigation-host.cjs:70`; Grep `REFERENCE_UNAVAILABLE\|INVALID_INPUT` over `scripts/` → `dispatch-boundary.cjs:71,278,…`, `claude-dispatch-adapter.cjs:406,…`, `runtime-context.cjs:247,…` |
| F2 | investigate Step 1 precondition: "`.planning/` exists (otherwise suggest `/gsd-new-project` and stop)". Gate 1 ends with "Tell the user the next step: `/shipyard:decompose`" — no artifact bridge. | Read `commands/investigate.md:64-65`, `:170-184` |
| F3 | decompose reads `ROADMAP.md` to find undecomposed ADRs and requires `requirements:` ids "from ROADMAP.md". | Grep `commands/decompose.md` → `:63`, `:329` |
| F4 | stop-gate candidates are every worktree from `git worktree list --porcelain`; the newest `generated_at` wins. Lines 83-91 cited in the problem are the *design comment*; the code is `worktreesOf()` at `:285-293` and selection near `:526`. A per-session ledger keyed on `session_id` already exists (`:43-56`, `:265`, `:412-430`) but governs block *count*, not front *ownership*. The comment at `:89-91` explicitly accepts "the busier board answer[s] for the quieter one". | Read `stop-gate.cjs:60-110`, `:278-302`; Grep `session_id\|generated_at` → `:45,265,376,414-417,485,526` |
| F5 | The auto-route hook is a heredoc `cat <<'POLICY'` that ignores stdin, so it injects on every UserPromptSubmit (incl. `<task-notification>` and slash prompts). Its routes list decompose/deliver/bench/inline — no investigate. | Read `scripts/install-shipyard-claude-hook.sh:109-131` |
| F6 | `templates/` contains only `inv/` (DECISIONS, OPEN-QUESTIONS, OPTIONS, PROBLEM, RESEARCH, RISKS); no `adr/`. `adr-ingest.cjs` already throws "no decisions were found under an ADR Decision section" (`:145`) and sets `process.exitCode = 1` (`:203`); it normalises `## Decision` / `## Out of scope` (`:104,112`). | `git ls-files` → `plugins/delivery-pipeline/templates/inv/*`; Grep `adr-ingest.cjs` |
| F7 | decompose Step 5 prescribes the model call Jira MCP tools by hand: `getVisibleJiraProjects`, `createJiraIssue`, `createIssueLink`, `getIssueLinkTypes` …; "No Jira MCP available → skip". `jira-project.cjs` exposes `record <ticket> <key> --to … --transition-id …` — a watermark/journal store only. | Grep `commands/decompose.md` → `:488-612` (esp. `:535-538`); Grep `jira-project.cjs` → `:8`, `:137-293` |
| F8 | Linearization prose: `decompose.md:432` "flag as a warning — linearize the chain where possible"; `SKILL.md:114` "a diamond get[s] a warning — linearize when practical". The validator text (`validate-graph.cjs:545-548`) is more precise: "the cascade bases on <primary_parent> only; the others land through the epic. Linearize the chain if <id> needs every parent's code at once." No field distinguishes order-only from code dependency. | Read the three ranges |
| F9 | The project intentionally keeps `.planning/` untracked in the proving ground (comments in `drift-needed.cjs:299`, `graph-dir.cjs:9,74`, `log-event.cjs:37`). No existing preflight uses `git check-ignore` / `ls-files` on `.planning/`. | Grep `check-ignore\|ls-files.*\.planning\|untracked` over the plugin |
| F10 | The UI gate is not implemented in shipyard; it is GSD config: `.planning/config.json:28-29` → `"ui_phase": true, "ui_safety_gate": true`. No shipyard script or command mentions `ui_phase`. | Grep `ui_phase\|ui-phase\|ui_safety\|UI-SPEC` over the repo |
| F11 | `gsd-tune.cjs:326`: `fail("no <CONFIG> — run this from a GSD project (the conveyor's own project root)")`, exit 2. `ROOT = process.cwd()` (`:317`). | Read `gsd-tune.cjs:300-331` |
| F12 | Test surfaces: `make test-fast` = unit+graph+worktree+gates+gsd-sync+sentinel+docs+hooks+comment-policy+model-ladder; `make test` adds `test-codex-shipyard` and `test-releases`; hook smoke is `tests/smoke/claude-hook-smoke.sh`; Codex parity is generated by `scripts/gen-codex-shipyard.cjs`. Existing unit tests: `tests/unit/{adr-ingest,claude-decompose-host,codex-decompose-host,gsd-tune,jira-project,stop-gate}.test.cjs`. | Grep `Makefile` `:47,51,53,77,83`; `git ls-files` |

## 2. Strategic (cross-cutting) alternatives

These are genuinely different ways to attack the ten items as a set. Per-item
options follow in §3; a strategic option is a *policy* for choosing among them.

### S0 — Do nothing / document the detours
- Sketch: ship a "known friction" section in README / command docs; leave code.
- Cost: ~0.5 day. Risk: repeat of MYD-17627 reproduces the same ~17 + ~11 min
  loss (problem statement). Forecloses: nothing; fails success criterion 2 by
  definition.

### S1 — Prose-first: tighten command/skill text, no new scripts
- Sketch: edit `investigate.md`, `decompose.md`, `SKILL.md`, the hook POLICY
  heredoc; the model is instructed to relay refusals, draft ROADMAP from ADR,
  linearize, skip UI gate, etc.
- Cost: low (docs + `test-docs`/codex regeneration). Risk: violates the success
  criterion "deterministic fix with a focused unit or fixture test" for items
  whose failure was the model ignoring prose (1, 2, 6, 7); prose is exactly what
  failed in session 3f4c2390. Forecloses: little; cheapest to reverse.

### S2 — Deterministic-scripts-first: one small script/flag per item + tests
- Sketch: every item gets a code change in the owning script (host error
  mapper, `adr-to-roadmap` bridge, session-bound stop-gate, stdin-aware hook,
  ADR template + validator step, `jira-export.cjs`, validator `order_only`
  kind, preflight check, UI-gate tuning, gsd-tune message). Prose updated to
  *call* the scripts.
- Cost: highest (≈10 PR-sized tickets, each with unit/fixture test, Codex
  regeneration). Risk: new script surface area; Jira export needs a transport
  decision (see 6). Forecloses: model discretion on those steps (intended).

### S3 — Hybrid by failure class
- Sketch: deterministic code where the session showed the model *could not* or
  *did not* comply (1, 2, 3, 4, 6, 7-validator), prose/template-only where a
  pointer suffices (5-template, 8, 9, 10 text).
- Cost: medium. Risk: the split is a judgement; items left as prose still need
  "a focused unit or fixture test" (docs tests can pin required phrases).
  Forecloses: less than S2.

### S4 — Buy/delegate: push work upstream or to external tools
- Sketch: have GSD (`/gsd-new-project --from-adr`, UI-gate auto-skip) and the
  Atlassian MCP / `acli` own items 2, 6, 9; shipyard only wires them.
- Cost: low locally, unbounded calendar time upstream. Risk: problem statement
  puts upstream GSD defects out of scope and gives no gsd-core commitment;
  unknown whether gsd-core accepts such features (open question). Forecloses:
  local control over timing.

### Strategic comparison

| Option | Local cost | Meets "deterministic + test" | Meets "repeat MYD-17627 clean" | Main risk | Reversibility |
|---|---|---|---|---|---|
| S0 do nothing | ~0 | No | No | same losses recur | trivial |
| S1 prose-first | Low | Partly (docs tests only) | Unlikely for 1/2/6/7 | model ignores prose again | high |
| S2 scripts-first | High | Yes | Likely | surface area, Jira transport | medium |
| S3 hybrid | Medium | Yes if docs-pinned tests count | Likely | split judgement | medium |
| S4 upstream/buy | Low local, high calendar | Depends on upstream | Unknown timing | out-of-scope dependency | high |

## 3. Per-item alternatives

Each table is a comparison, not a ranking.

### Item 1 — Plain-language relay of host refusals
Facts: F1.
- 1A Prose rule in `investigate.md`/`decompose.md`: "on non-zero exit, explain
  code in plain language". Cheap; untestable except by docs test.
- 1B Host-side message catalogue: the hosts map `error.code` → a `hint` line
  (what happened, what the user can do) appended to stderr / the `unavailable`
  JSON (`claude-decompose-host.cjs:222,235,251`, `claude-investigation-host.cjs:70`).
  Unit-testable per code. Must not change the code itself (consumers parse it).
- 1C Shared catalogue module consumed by all hosts (incl. Codex hosts and
  `claude-delivery-host.cjs:964`, `claude-role-host.cjs:1047`). Wider parity,
  larger diff.
- 1D Structured JSON error envelope on stdout for every failure (`{status,
  code, message, hint}`) + command rule to relay `hint`. Changes an output
  contract — check consumers (unknown; see Q1).

| | Cost | Deterministic test | Contract change | Codex parity |
|---|---|---|---|---|
| 1A | XS | docs only | none | via regeneration |
| 1B | S | yes | additive stderr line | per host |
| 1C | M | yes | additive | yes |
| 1D | M | yes | stdout shape | yes, but consumers must update |

### Item 2 — investigate → decompose bridge
Facts: F2, F3.
- 2A Keep `/gsd-new-project` but pass the ADR as seed input (prose). Still the
  GSD interview that invented requirements; relies on upstream behaviour.
- 2B New deterministic `adr-bootstrap` step (script) run at Gate 1 or at
  decompose Step 0: when `.planning/config.json` / `ROADMAP.md` /
  `REQUIREMENTS.md` are missing, generate minimal files whose requirement ids are
  derived 1:1 from the ADR `## Decision` bullets (reusing `adr-ingest.cjs`
  section parsing, F6). Fixture-testable; no invented requirements by
  construction. Risk: must emit a format GSD parses (upstream parser defects are
  out of scope, e.g. multi-line `**Goal**`).
- 2C Relax decompose: allow `requirements:` to reference ADR decision ids
  directly and treat missing ROADMAP as "one phase per ADR". Smaller file
  footprint; diverges from GSD's own data model, may break `/gsd-plan-phase`
  consumers.
- 2D Relax investigate's precondition only (create bare `.planning/` instead of
  stopping) and leave decompose's needs to the user. Fixes the first stop, not
  the second.

| | Cost | Invented reqs eliminated | GSD compatibility risk | Forecloses |
|---|---|---|---|---|
| 2A | XS | No | low | nothing |
| 2B | M | Yes | medium (format) | GSD interview for ADR-born projects |
| 2C | M | Yes | high | ROADMAP as single source |
| 2D | XS | No | low | nothing |

### Item 3 — stop-gate blocks non-delivering sessions
Facts: F4. Current design deliberately trades cross-session leakage for catching
the "parked checkout" case (comment `:89-91`, measured 5h46m / 6h losses).
- 3A Session ownership: deliver writes `session_id` (or run id) into the front
  / ledger; stop-gate only enforces fronts whose owner equals the payload's
  `session_id`; unowned fronts → allow. Test: fixture with two worktrees, two
  sessions. Risk: resumed/compacted sessions change id? (unknown, Q3).
- 3B Transcript evidence: enforce only if this session's transcript
  (`transcript_path` in the hook payload) contains a deliver invocation.
  Risk: parsing transcripts in a ~75 ms budget (`stop-gate.cjs:295-297`).
- 3C Marker file: `/shipyard:deliver` touches a per-session "armed" marker;
  gate is inert without it. Simple; same session-id question as 3A.
- 3D Narrow candidates by recency window only (e.g. ignore fronts older than N
  min). Rejected previously as "age is the wrong instrument" (`:107-110`) —
  listed for completeness.

| | Cost | Keeps parked-checkout catch | False block on analysis sessions | Hook budget |
|---|---|---|---|---|
| 3A | M | Yes (owner still found across worktrees) | eliminated if id stable | OK |
| 3B | M | Yes | eliminated | at risk |
| 3C | S | Yes | eliminated if id stable | OK |
| 3D | XS | partially | reduced only | OK |

### Item 4 — auto-route hook scope
Facts: F5.
- 4A Edit POLICY text only: add investigate route + triggers; add "ignore if
  message is a task-notification or starts with `/`". Model-side filter.
- 4B Make the hook read stdin JSON (`prompt`) and emit nothing for
  `<task-notification>` / leading `/` prompts; add investigate route to text.
  Deterministic, testable in `tests/smoke/claude-hook-smoke.sh`. Needs a JSON
  read without extra deps (bash + `node -e` or `jq`, dependency unknown, Q4).
- 4C Replace the heredoc with a Node hook bundled like stop-gate
  (`copy_stop_bundle`, installer `:137`). More robust parsing; larger install.
- 4D Remove the hook; rely on skills/router descriptions. Loses auto-routing.

| | Cost | Deterministic | Install impact |
|---|---|---|---|
| 4A | XS | No | none |
| 4B | S | Yes | none |
| 4C | M | Yes | new bundled file |
| 4D | XS | n/a | removes feature |

### Item 5 — ADR template + Gate 1 validation
Facts: F6, F2 (Gate 1 steps 1-4).
- 5A Add `templates/adr/ADR.md` only (Nygard sections as prose already
  specifies at `investigate.md:176-179`).
- 5B 5A + Gate 1 step: run `adr-ingest.cjs --input <ADR>` and require exit 0
  (it already fails on zero decisions, `adr-ingest.cjs:145,203`). Unit test
  exists for adr-ingest.
- 5C Dedicated `validate-adr.cjs` with stricter schema (Status value, Out of
  scope present, no nested `###` in machine sections). More coverage, new
  script; overlaps `adr-ingest`.

| | Cost | Deterministic | New surface |
|---|---|---|---|
| 5A | XS | No | template |
| 5B | S | Yes (decisions present) | none |
| 5C | M | Yes (full shape) | script |

### Item 6 — Deterministic Jira export (conveyor feature)
Facts: F7. Scope note: this INV's own tickets are NOT exported (problem
statement, user decision 2026-09-24); the capability is in scope.
- 6A Plan-then-apply via MCP: new script computes an idempotent export plan
  (issues, epic, links with explicit direction from `depends_on`, labels) from
  `tickets.json`; the model executes the plan's MCP calls verbatim and feeds
  keys back to a `record` step (extends `jira-project.cjs`). Deterministic plan,
  fixture-testable; execution still through the model but without judgement.
- 6B Direct REST client in a script (Jira Cloud REST v3, API token from env).
  Fully deterministic; introduces credential handling and a network surface the
  plugin does not have today (security boundary — Line 3 should confirm).
- 6C Atlassian CLI (`acli`) wrapper. Buy-not-build; adds an external binary
  dependency and version coupling (availability on user machines unknown, Q6).
- 6D Keep model-by-hand, add a post-hoc verifier that reads back links and
  flags wrong direction. Cheapest; still ~22 calls.

| | Cost | Deterministic | New dependency/secret | Link-direction errors |
|---|---|---|---|---|
| 6A | M | plan yes, execution scripted | none | eliminated by plan |
| 6B | L | yes | API token, network | eliminated |
| 6C | M | yes | `acli` binary | eliminated |
| 6D | S | verify only | none | detected, not prevented |

### Item 7 — Linearization semantics / order-only links
Facts: F8.
- 7A Align prose in `decompose.md:432` and `SKILL.md:114` to the validator's
  sentence (`validate-graph.cjs:547`), plus a rule "an order-only relation is not
  a `depends_on`". Docs test.
- 7B Add an explicit frontmatter field (e.g. `after:` / `order_only`) that the
  validator records but excludes from cascade/`pr_base`; Jira export maps it to
  a "relates"/"is blocked by" link as decided. Unit tests in validate-graph.
- 7C Validator heuristic: warn when a dependency shares no `files_modified`
  with its parent (likely order-only). Deterministic hint, may false-positive.

| | Cost | Schema change | Unblocks parallel waves |
|---|---|---|---|
| 7A | XS | none | only if the model complies |
| 7B | M | yes (additive) | yes |
| 7C | S | none | indirectly |

### Item 8 — `.planning/` untracked preflight
Facts: F9 — untracked `.planning/` is a supported configuration, so a hard
refusal would break the proving ground.
- 8A Warning in investigate/decompose preflight (prose) using
  `git ls-files`/`check-ignore`.
- 8B Script check (e.g. in `shipyard-doctor.cjs` or a new preflight helper)
  that prints a one-time warning with consequences (worktrees won't see it;
  `graph-dir.cjs` needs an explicit dir). Testable.
- 8C Do nothing; rely on existing `graph-dir.cjs:74` error when it bites.

| | Cost | Deterministic | Breaks untracked mode |
|---|---|---|---|
| 8A | XS | No | No |
| 8B | S | Yes | No (warn only) |
| 8C | 0 | n/a | No |

### Item 9 — GSD UI gate on prototype / no-Figma scopes
Facts: F10 — gate is GSD config (`workflow.ui_phase`, `ui_safety_gate`), not
shipyard code.
- 9A Tune: have `gsd-tune.cjs` (or the bridge in 2B) set `ui_phase:false` when
  the ADR/PROBLEM declares no design source; testable via gsd-tune unit test.
- 9B Pass a per-phase skip signal into GSD plan-phase invocation from decompose
  (depends on GSD supporting it — unknown, Q9).
- 9C Upstream: ask gsd-core to auto-skip without Figma (S4-style; timing unknown).
- 9D Prose: tell the model to decline the UI gate for such scopes.

| | Cost | Deterministic | Upstream dependency |
|---|---|---|---|
| 9A | S | Yes | none (config GSD already reads) |
| 9B | S–M | Yes | GSD flag support |
| 9C | XS local | n/a | yes |
| 9D | XS | No | none |

### Item 10 — `gsd-tune.cjs:326` message
Facts: F11.
- 10A Rewrite message: state cwd, the missing path, and the concrete next
  command (e.g. run from the project root that holds `.planning/config.json`,
  or `--global`, or run the bridge from 2B). Unit test on stderr text.
- 10B Walk up from cwd to find the nearest `.planning/config.json` (git
  toplevel bound) and use it, printing which. Behaviour change; risk of tuning
  the wrong project in nested repos/worktrees.
- 10C Offer to create a minimal config (only if 2B exists).

| | Cost | Behaviour change | Risk |
|---|---|---|---|
| 10A | XS | none | none |
| 10B | S | yes | wrong target |
| 10C | S | yes | overlaps 2B |

## 4. Cross-item coupling (affects option choice)

- 2B ↔ 9A ↔ 10C: a single ADR bootstrap could also write `config.json` with the
  UI gate tuned and remove the gsd-tune dead end. Choosing 2B makes 9A/10C cheap.
- 6A/6B ↔ 7B: Jira link direction and order-only links need the same dependency
  semantics; deciding 7 first avoids re-work in 6.
- 1B/1C ↔ Codex parity: Codex hosts (`codex-decompose-host.cjs`,
  `codex-delivery-host.cjs`) must get the same hints; `make test` runs
  `test-codex-shipyard` (F12).
- 3A/3C ↔ 4B: both need reliable fields from the Claude hook payload
  (`session_id`, `prompt`).

## 5. Constraints observed (for Line 3 cross-check)

- Out of scope (problem statement): upstream GSD defects; ADR-014 model/effort
  grid; dispatch boundary contract; removing fail-closed receipt verification
  (phase 38); planner latency; exporting INV-003's own tickets to Jira.
  → 1D must not alter `dispatch-boundary.cjs` error semantics; S4/9C/2A lean on
  upstream and may collide with this fence.
- Untracked `.planning/` is a supported mode (F9) → item 8 options are warn-only.
- Hook time budget ~75 ms (`stop-gate.cjs:295`) → constrains 3B.
- Deliver never reads Jira; Jira is a projection (`decompose.md:491-492`) →
  any item-6 option must stay non-blocking ("A Jira error never blocks",
  `decompose.md:501`).
- Success criteria require focused unit/fixture tests, green `make test-fast`
  and `make test`, regenerated Codex outputs (problem statement; F12).

## 6. Uncertainties / open questions (→ OPEN-QUESTIONS.md candidates)

- [ ] Q1 Do any consumers parse host stderr/stdout error shapes such that a
  hint line (1B) or envelope (1D) would break them? — owner: maintainer (grep of
  consumers not done in this line; next check: Grep callers of the hosts).
- [ ] Q2 Is a generated ROADMAP/REQUIREMENTS acceptable to `/gsd-plan-phase`
  given known upstream parser defects? — owner: maintainer; suggest
  `/gsd-spike "generate ROADMAP.md+REQUIREMENTS.md from an ADR and run gsd-plan-phase on it"`.
- [ ] Q3 Is Claude Code's hook `session_id` stable across resume/compaction?
  Determines 3A/3C viability. — owner: maintainer; suggest
  `/gsd-spike "log session_id across resume and compaction in Stop hook"`.
- [ ] Q4 May the route hook depend on `node` (already required for stop-gate) or
  `jq` to read stdin? — owner: maintainer.
- [ ] Q5 Which link type/direction should order-only vs code dependencies map to
  in Jira? — owner: user / Jira project admin.
- [ ] Q6 Is adding a Jira API token (6B) or `acli` (6C) acceptable to the
  security/distribution posture? — owner: user.
- [ ] Q7 Should the ADR validator be `adr-ingest.cjs` reuse (5B) or a stricter
  standalone validator (5C)? — owner: user.
- [ ] Q8 Is the "busier board answers for the quieter one" trade-off
  (`stop-gate.cjs:89-91`) still accepted once ownership exists? — owner: user.
- [ ] Q9 Does GSD accept a per-phase UI-gate skip signal (9B), or only config?
  — owner: gsd-core maintainers.
- [ ] Q10 Does the problem's "no preflight warning" item 8 target investigate,
  decompose, deliver, or doctor? — owner: user.

## 7. Spikes recommended (not executed)

- `/gsd-spike "ADR → ROADMAP/REQUIREMENTS bootstrap consumed by gsd-plan-phase"` (Q2)
- `/gsd-spike "Stop-hook session_id stability across resume/compact"` (Q3)
- `/gsd-spike "Jira export plan from tickets.json replayed through Atlassian MCP, idempotent on rerun"` (6A)

## 8. Sources

- `plugins/delivery-pipeline/commands/investigate.md:50-189`
- `plugins/delivery-pipeline/commands/decompose.md:3,31,63,71,322-432,488-612`
- `plugins/delivery-pipeline/skills/delivery-rules/SKILL.md:106-119`
- `plugins/delivery-pipeline/scripts/stop-gate.cjs:43-110,215-302,358-430,475-535`
- `plugins/delivery-pipeline/scripts/validate-graph.cjs:530-564`
- `plugins/delivery-pipeline/scripts/gsd-tune.cjs:300-331`
- `plugins/delivery-pipeline/scripts/adr-ingest.cjs:104-203`
- `plugins/delivery-pipeline/scripts/jira-project.cjs:8-325`
- `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs:28,222-252`
- `plugins/delivery-pipeline/scripts/claude-investigation-host.cjs:21-70`
- `plugins/delivery-pipeline/scripts/{dispatch-boundary,claude-dispatch-adapter,runtime-context}.cjs` (error code origins)
- `plugins/delivery-pipeline/scripts/{drift-needed.cjs:299,graph-dir.cjs:9,74,log-event.cjs:37}`
- `scripts/install-shipyard-claude-hook.sh:7-31,100-137,274`
- `.planning/config.json:28-29`
- `Makefile:5-9,47-85`
- External claims (Jira REST v3, `acli`) are general knowledge, not verified in
  this session — label: assumption; next check: vendor docs.
