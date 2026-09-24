# Phase 39 — Plan check (goal-backward, convergence review)

**Date:** 2026-09-24
**Plans:** 39-01 .. 39-11 (T-39-01 .. T-39-11)
**Sources:** ADR-016, 39-CONTEXT.md, 39-RESEARCH.md, REQUIREMENTS.md REQ-125..REQ-135, CLAUDE.md
**Gate 2:** already passed upstream; I did not rerun it and it is not the basis of this verdict.
**Cycles:** 2 (cycle 1 found issues and fixed them; cycle 2 re-check found no BLOCKER or WARNING)

## Verdict

**PASSED after revision.** The revised plans cover every requirement and every
ADR-016 decision (D-01..D-12), and they respect the scope fences. `files_modified`
lists are complete and disjoint across the phase. The only `depends_on` is
T-39-09 → T-39-02, and it is a real import. Each plan writes its test first,
and the verification commands are scoped and runnable.

Residual risk: the plans have no remaining defects, but REQ-127 depends on a host
fact that no plan can prove in advance. It is gated by the T-39-03 human
checkpoint on `${CLAUDE_SESSION_ID}` substitution (Assumption A1).

## Requirement coverage

| Req | Tickets | Status |
|---|---|---|
| REQ-125 hints | T-39-01 (map + 4 hosts, Claude + Codex), T-39-10, T-39-11 (relay prose) | Covered |
| REQ-126 bootstrap | T-39-02 (`decisionEntries`), T-39-09 (script), T-39-10 (Step 0), T-39-11 (intake), T-39-04 (README text) | Covered |
| REQ-127 stop gate | T-39-03 (+ README sentence in T-39-04) | Covered (host checkpoint) |
| REQ-128 route hook | T-39-04 (hook, Claude + Codex installers, doctor, smokes, README) | Covered |
| REQ-129 ADR template/check | T-39-02, T-39-11 (Gate 1) | Covered |
| REQ-130 Jira plan | T-39-05, T-39-10 (Step 5) | Covered |
| REQ-131 order-only | T-39-06 (validator warning + skill + projection), T-39-10 (prose) | Covered |
| REQ-132 `--skip-ui` | T-39-10 | Covered |
| REQ-133 untracked warning | T-39-10 | Covered |
| REQ-134 gsd-tune | T-39-07 | Covered |
| REQ-135 handback bound | T-39-08 | Covered |

## Scope fences

- Codes and exit status are unchanged: T-39-01 keeps line 1 and `exitCode = 1` byte-identical, adds a line-2 hint only, and leaves `REPAIR` untouched. OK
- No Jira network code: T-39-05 has a token sweep and no `child_process` or `gh`. OK
- No graph schema change: T-39-06 adds a warning only, and the contested-path rule and diamond warning stay byte-identical. OK
- Bootstrap creates missing files only (`wx`), refuses an ADR without decisions, and uses one parser. OK
- Hooks fail open: the stop gate allows on a missing, unreadable or foreign marker, and the route hook exits 0 and injects on any error. OK
- Codex parity: the AGENTS block is generated from `auto-route.cjs` through `install-shipyard-codex.sh`, and the Codex hosts share the hint map. `inv-research.md` reaches Codex through regeneration. OK

## Issues found in cycle 1 (all fixed)

```yaml
issues:
  - plan: "39-03"
    dimension: requirement_coverage / files_modified completeness
    severity: blocker
    required_property: "Every test whose outcome REQ-127 changes is in the owning ticket's files_modified and verification"
    description: "tests/unit/dispatch-record.test.cjs:907-957 spawns the real stop-gate.cjs with payload '{}' and asserts decision=block at :919 and :956. After arming is required these flip to allow, so make test-fast goes red, and T-39-03 did not list or run the file."
    fix_hint: "Add the file to T-39-03, arm its gate helper, and add it to the verification commands"
  - plan: "39-03"
    dimension: task_completeness
    severity: warning
    required_property: "Test helpers arm at the location isArmed reads"
    description: "The helpers were told to write the non-git fallback marker. The :393/:417 sibling-worktree fixtures are git repos, where isArmed reads git-common-dir, so those block tests would flip to allow."
    fix_hint: "Arm through the module's arm(cwd, id)"
  - plan: "39-03"
    dimension: verification_derivation
    severity: warning
    required_property: "Every acceptance criterion is checked by a command"
    description: "'Installed bundle includes stop-gate-arm.cjs' had no check: claude-hook-smoke uses a fake stop-gate."
    fix_hint: "Source assertion that stop-gate.cjs requires ./stop-gate-arm.cjs by relative path"
  - plan: "39-01, 39-03, 39-04, 39-08"
    dimension: verify_command_format
    severity: warning
    required_property: "Syntax-check commands check every file they name"
    description: "'node --check a b ...' and 'bash -n a b ...' check only the first file and pass the rest as arguments (measured: a syntax error in file 2 exits 0)."
    fix_hint: "Use one file per invocation"
  - plan: "39-01"
    dimension: verification_derivation
    severity: warning
    required_property: "Each edited host's hint line is covered by a test"
    description: "codex-delivery-host.cjs (the Codex research host for investigate) gained a hint line, but no test asserted it."
    fix_hint: "Extend tests/unit/codex-delivery-host.test.cjs"
  - plan: "39-04"
    dimension: claude_md_compliance
    severity: warning
    required_property: "README describes the supported flow after the phase (CLAUDE.md: update README when the flow changes)"
    description: "README:85-86 still requires an initialized .planning/ (contradicts REQ-126), README:136-140 says the stop gate holds any Claude session (contradicts REQ-127), and README:269-272 omits the new doctor checks. T-39-04 is the only README owner, so another ticket cannot take the file without a same-wave conflict."
    fix_hint: "T-39-04 carries all README sentences (text only) and avoids the docs-smoke retired word 'compose'"
  - plan: "39-07"
    dimension: context_compliance (Codex parity)
    severity: warning
    required_property: "The creating command named by gsd-tune is usable on both runtimes"
    description: "The message named only /shipyard:decompose, but gsd-tune also runs with --runtime codex."
    fix_hint: "Also name $shipyard-decompose and assert it"
  - plan: "39-08"
    dimension: scope_reduction
    severity: warning
    required_property: "REQ-135 is not silently narrowed to Claude"
    description: "If the Codex seal refuses over-long summaries, the plan said to 'report it as a gap rather than widening scope'."
    fix_hint: "Escalate instead of marking done (role-artifact.cjs:384 capSummary is the expected bound)"
  - plan: "39-11"
    dimension: requirement_coverage
    severity: warning
    required_property: "Docs no longer make /gsd-new-project mandatory"
    description: "docs/gsd_multilevel_delivery_pipeline.md:947-950 still lists /gsd-new-project as the mandatory init step."
    fix_hint: "Mark it optional in the operational flow"
  - plan: null
    dimension: research_resolution
    severity: warning
    required_property: "RESEARCH.md carries no unresolved open question"
    description: "39-RESEARCH.md '## Open Questions' lacked resolutions, although CONTEXT and T-39-03 resolve all six."
    fix_hint: "Mark (RESOLVED) with inline resolutions"
```

## Changes made (only under this phase directory)

- **39-01-PLAN.md:** added `tests/unit/codex-delivery-host.test.cjs` to files_modified, acceptance, test strategy and verification; `node --check` now runs once per file.
- **39-03-PLAN.md:** added `tests/unit/dispatch-record.test.cjs` (Reads, Scope, acceptance, test strategy, verification). Helpers now arm through `arm(cwd, id)`. Added a source assertion for the bundle closure. `node --check` is split per file.
- **39-04-PLAN.md:** README scope now covers the route hook, doctor checks, REQ-126 intake/bootstrap and the REQ-127 deliver-armed stop gate, and avoids the retired word `compose`. Added README acceptance. `node --check` and `bash -n` now run once per file.
- **39-07-PLAN.md:** the message and test also name `$shipyard-decompose`.
- **39-08-PLAN.md:** a Codex seal refusal now means escalate, not "report a gap". `node --check` is split per file.
- **39-11-PLAN.md:** the docs operational flow (`:947-950`) marks `/gsd-new-project` as optional, with an acceptance criterion.
- **39-RESEARCH.md:** `## Open Questions (RESOLVED)` with an inline resolution for each question.
- **39-CONTEXT.md:** added a note that README (T-39-04) and dispatch-record.test (T-39-03) each have a single owner.

## Cycle 2 re-check

- files_modified stay disjoint across all 11 plans (README → 04 only; dispatch-record.test → 03 only; codex-delivery-host.test → 01 only). Scope is unchanged for 02, 05, 06, 09 and 10.
- No new `depends_on`. T-39-09 → T-39-02 is still the only one, and it is an import.
- No BLOCKER or WARNING remains. Advisory: the phase gate's `make test-fast`, and on the host `make test`, reinstall and `make doctor`, stay the merge-time checks listed in CONTEXT.
