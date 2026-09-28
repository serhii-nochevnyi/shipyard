# Research contract — INV-008 (residual pipeline efficiency → phase 45)

Read-only research. Do not edit code or any file except your own artifact.

## Inputs
- `PROBLEM.md`, `PREFLIGHT.md`, `SCOPING-NOTES.md` and `intake/phase40-delivery-findings.md` (findings N1–N59) in this directory.
- Phase 45:
  - `.planning/phases/45-close-residual-pipeline-efficiency-gaps/WORK-PACKAGES.md` (packages S1, P1–P5, D1–D6, R1–R18, C1–C4), `CONTEXT.md` and `PLANNING-STATUS.md`;
  - the three research notes `MODEL-ROUTING-RESEARCH.md`, `ENVIRONMENT-RECOVERY-RESEARCH.md` and `MERGE-BASE-RESEARCH.md`.
- Accepted designs, which are inputs and are not re-decided: ADR-014 (model grids), ADR-020 (host verification, own-diff carry), ADR-021 (C1–C4 contracts), ADR-022 (review launch timing).
- Owners that must not be duplicated: the phase-43 plans `.planning/phases/43-*/43-*-PLAN.md` (phase 43 is being delivered now) and the delivered phases 40–42 and 44.
- The backlog note `.planning/backlog/stop-gate-selects-foreign-session-board.md`.
- Source: `plugins/delivery-pipeline/scripts/`, `plugins/delivery-pipeline/workflows/`, `plugins/delivery-pipeline/commands/`, `plugins/delivery-pipeline/references/`, the installers under `scripts/`, and `tests/unit/`.
- Everything you need is inside this worktree (release 0.68.0 plus phase-45 planning). Do not read paths outside it and do not call any provider account API.

## Questions to answer
1. **State on 0.68.0.** For each package, is the gap still present at this revision, or already fixed? Known candidates: N43 partly by #316, and N47 fixed in 0.68.0. Give file:line evidence.
2. **Independence from phase 43.** Which packages can be delivered now, and which must wait for the phase-43 epic? A package waits when it touches a file declared in `files_modified` of a phase-43 ticket that is not yet merged; read those declarations from the phase-43 PLAN files. List the blocking tickets per package.
3. **Contracts for the open design packages.** For S1 (session-to-board binding and `disarm`), R10 (environment-only adjudication), R14, R16, R17, R18, D1, D5, D6 and P1–P5, give the smallest safe contract and its refusal cases, with alternatives where they are real.
4. **Priority.** Order the packages by expected reduction of wasted model work, using the measured evidence:
   - phase 44: Sonnet executors took 56% of child consumption, the orchestrator session about 29%, reviews about 11%;
   - phase 43: outer Codex coordination took 84.6% of measured Codex input;
   - the replays recorded in N42–N58.
   
   Separate correctness fixes (S1, R12, R13, R17) from efficiency treatments that need matched-cohort measurement.
5. **Risks.** Which packages could lose a gate, ownership or a required instruction if implemented naively? Which share files and need one serialized owner?

Every claim about the codebase carries a file path; every number carries its source.
