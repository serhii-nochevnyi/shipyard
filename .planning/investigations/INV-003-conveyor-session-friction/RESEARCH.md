# Research

Sources: the four research lines under `research/` (`system-state.md`,
`alternatives.md`, `constraints.md`, `risks.md`), all run through
`claude-investigation-host.cjs` at `856456a8` (origin/main `befc970c` + the
INV-open commit) as `claude-opus-5-5/medium` with verified boundary receipts,
plus orchestrator checks recorded below. Paths are relative to the repository
root; `P = plugins/delivery-pipeline`.

**Research-run deviation (item 11).** The trusted research consumer refused to
seal the four line artifacts: `claude-delivery-host.cjs:508-516`
(`sealPlanningResearch`) rejects a line whose `summary` exceeds 500 characters,
and the `risks` line returned a 1,106-character summary while the
`alternatives` line appended prose after its JSON. The launch passed no output
schema (`claude-runtime-host.cjs:736-737` reads `structured_output` only when
present), so the limit was never visible to the worker. The whole fan-out
failed with a misleading remedy ("Install an ADR-014-capable Claude host…").
All four boundary receipts are `compliance: verified` with applied
`claude-opus-5-5/medium`; the complete artifacts are on disk and, by the
user's decision of 2026-09-24, are used as research input without a sealed
`shipyard.research-result.v1` envelope.

## Current system state

1. **Host refusals.** `P/scripts/claude-decompose-host.cjs:26-30` `refuse(code,
   message)`; CLI prints `CODE: message` to stderr and exits 1 (`:248-254`);
   `--capability-only` prints `{status:'unavailable', reason, detail}`
   (`:234-236`). `P/scripts/claude-investigation-host.cjs:66-72` prints only
   `error.message` (no code), so the two CLIs have different error shapes.
   Codes (`INVALID_INPUT`, `REFERENCE_UNAVAILABLE`, `UNSUPPORTED_ROLE`,
   `SCOPE_MISMATCH`, `INVALID_SIGNAL`, `CONFLICTING_OVERRIDE`,
   `NONCOMPLIANT_RECEIPT`, `INVALID_HOST`) are a shared vocabulary across
   33 files. Commands say only "refuse"/"stop with a BLOCK"
   (`P/commands/decompose.md:56-58,99-100,156,282-284,315`,
   `P/commands/investigate.md:47-49`); no rule requires a plain-language
   relay. Tests pin codes (`tests/unit/claude-decompose-host.test.cjs:46-64,136`).
2. **No investigate → decompose bridge.** `P/commands/investigate.md:65`
   requires `.planning/` or sends the user to `/gsd-new-project`; Gate 1 ends
   with "next step `/shipyard:decompose`" (`:184`). Decompose reads
   `ROADMAP.md` (`P/commands/decompose.md:63`), requires `requirements[]`
   from ROADMAP (`:329-331`), runs `gsd-tune.cjs --check` which exits 2 without
   `.planning/config.json` (`P/scripts/gsd-tune.cjs:325-326`). Gate 2 errors on
   empty `requirements[]` but also accepts a tracker id
   (`P/scripts/validate-graph.cjs:317`). Nothing derives these files from an ADR.
3. **Stop gate.** Unscoped selection over `[cwd, ...worktreesOf(cwd)]`, newest
   `generated_at` wins (`P/scripts/stop-gate.cjs:285-293,514-529`); the design
   note accepts "the busier board answer[ing] for the quieter one" (`:88-91`)
   after a measured 5h46m inert-gate loss (`:62-82`). `session_id` is used only
   for the anti-loop ledger (`:412-439`). Scoped mode exists (`:490-513`) when
   `run_id`/`SHIPYARD_RUN_ID`/`SHIPYARD_RUN_CONTROL=scoped` is set. Installed
   globally by `scripts/install-shipyard-claude-hook.sh:246`. Tests pin the
   cross-worktree behaviour (`tests/unit/stop-gate.test.cjs:393,417`); no test
   covers a session that never delivered.
4. **Auto-route hook.** `scripts/install-shipyard-claude-hook.sh:109-131`
   writes a static `cat <<'POLICY'` hook that ignores stdin, registered on
   every `UserPromptSubmit` (`:243`). No investigate route although
   `P/commands/route.md:63` routes "unclear, needs research" to investigate.
   Codex copy `scripts/install-shipyard-codex.sh:592-610` has the same gap
   (`largeRoute` names only decompose/deliver). No test asserts hook text
   (`grep -c route tests/smoke/claude-hook-smoke.sh` → 0); `make doctor`
   (`scripts/shipyard-doctor.cjs`) does not compare the route hook (grep
   `route` → no match). Observed in this session: the hook fired on a
   `<task-notification>` turn.
5. **ADR template / Gate 1.** `P/templates/` has only `inv/`. Gate 1
   (`P/commands/investigate.md:170-184`) runs `validate-inv.cjs` and describes
   the ADR format in prose; `P/scripts/adr-ingest.cjs` runs first in decompose
   (`P/commands/decompose.md:269-276`). adr-ingest has no check-only mode and
   `--output-dir` deletes existing `*.ingest.md` (`adr-ingest.cjs:148-188`).
   Orchestrator check: every `ADR-0NN-*.md` decision record in
   `.planning/architecture/` passes adr-ingest today; only companion files
   (`ADR-011-BACKLOG/ROLLOUT`, `ADR-014-DATA-MODEL/INTERFACES/ROLLOUT`) fail,
   as expected for non-ADR documents.
6. **Jira export.** `P/commands/decompose.md:488-613` is prose driving MCP
   tools; "do not hand-roll REST calls" (`:538-539`). `P/scripts/jira-project.cjs`
   is a watermark store for transitions only; its test sweeps for network use
   (`tests/unit/jira-project.test.cjs:827-837`); ADR-008 D4 assigns the acting
   half to an agent and rejected a script-side REST client.
7. **Linearization.** Prose "linearize where possible / when practical"
   (`P/commands/decompose.md:432`, `P/skills/delivery-rules/SKILL.md:113-114`)
   vs the validator's conditional "Linearize the chain if <id> needs every
   parent's code at once" (`P/scripts/validate-graph.cjs:545-549`). The only
   edge is `depends_on`, which drives wave, `primary_parent`, `pr_base`, cascade
   and Jira links (`validate-graph.cjs:521-535`). The contested-path rule makes
   file-overlapping same-phase tickets without an order a hard error
   (`:378-458`), a mechanical source of serial graphs.
8. **Untracked `.planning/`.** Supported mode (the proving ground uses it:
   `P/scripts/drift-needed.cjs:299`, `P/scripts/graph-dir.cjs:9,74`); no intake
   preflight checks `git ls-files`/`check-ignore`.
9. **UI gate.** Shipyard has no UI-gate code. GSD's
   `~/.claude/gsd-core/workflows/plan-phase.md:119,519` supports a per-phase
   `--skip-ui` flag ("Skip silently"); config keys `workflow.ui_phase`,
   `workflow.ui_safety_gate` gate generation/blocking (`:480`). Decompose
   invokes `/gsd-plan-phase <N> --ingest …` (`P/commands/decompose.md:277-278`)
   without `--skip-ui`.
10. **gsd-tune message.** `P/scripts/gsd-tune.cjs:326` "run this from a GSD
    project (the conveyor's own project root)", exit 2, `ROOT = process.cwd()`
    (`:317`); no test pins the wording.
11. **Research handback limit invisible to the worker** — see the deviation
    note above (`P/scripts/claude-delivery-host.cjs:506-516`,
    `P/workflows/investigation-research.mjs:27-37` declares `maxLength: 500`
    only in a schema passed as `agentOptions.schema`, which the Claude runtime
    host does not forward as an output schema).

## Constraints

### Technical

- Claude plugin is canonical; Codex is generated (`scripts/gen-codex-shipyard.cjs`);
  the Codex auto-route block is a separate hand-maintained copy
  (`scripts/install-shipyard-codex.sh:586-620`).
- ADR-014 grid, dispatch boundary and fail-closed receipt verification are
  frozen (PROBLEM.md out of scope). Refusal codes and exit status stay; a
  human-readable hint may only be added.
- Every new rule gets a focused unit/fixture test; no npm dependencies
  (`.github/workflows/test.yml`).
- Comment policy: added code comments must be directive/marker shaped
  (`P/scripts/comment-policy.cjs:6-9,55-67`).
- Hooks must fail open and never trap a session (`P/scripts/stop-gate.cjs:19-33`).
  Shell scripts keep `set -euo pipefail`; the hook may use `node` (installer
  already requires it, `install-shipyard-claude-hook.sh:46`).
- A script-side Jira client contradicts accepted ADR-008 D4 and a pinned test;
  a deterministic export within the architecture is a pure-data plan executed
  by the agent through MCP.
- `depends_on` semantics are structural; an order-only edge would be a schema
  change across state-sync/front/sentinel/deliver.
- adr-ingest reuse at Gate 1 needs a no-write mode (output dir is destructive).
- GSD file formats are upstream-owned; a generated ROADMAP must stay within
  what `/gsd-plan-phase --ingest` parses today.

### Product

- PLAN files are the single source of truth; Jira is a projection that never
  blocks decomposition (`P/commands/decompose.md:30-36,501`).
- Gate 2 is exit 0 of `validate-graph.cjs` only.
- Decisions belong to the human; a bridge must not invent requirements beyond
  the ADR's decisions (`P/commands/investigate.md` Rules).
- `/shipyard:route` is advisory; the hook may only point at it.
- Untracked `.planning/` is supported → warn, never refuse.
- This initiative's own tickets are not exported to Jira (user decision).

### Delivery

- CI = publish gate + `make test-fast` on Node 24.15.0 (`.github/workflows/test.yml`);
  `make test` needs network + `gh` and runs on the host.
- Hook/installer changes reach users only after reinstall; the MYD-17627 repeat
  must reinstall and run `make doctor` first.
- README and `tests/smoke/docs-smoke.sh` must follow any new command or make
  target; a new version needs a release entry.
- Local sandboxed test runs can be red for environment reasons (gpg signing,
  mktemp); verify on the host.

## Unknowns

- Whether Claude Code's `UserPromptSubmit` stdin `prompt` for a slash command is
  the raw `/name args` text (mirrored in OPEN-QUESTIONS).
- Whether `session_id` is stable across resume and compaction (mirrored).
- Exact ROADMAP/REQUIREMENTS subset GSD needs for an ADR-born phase (mirrored).
