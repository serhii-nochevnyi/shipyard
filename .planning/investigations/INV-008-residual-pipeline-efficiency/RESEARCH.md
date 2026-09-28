# Research

Four sealed research lines at source revision `705eb233` (0.68.0 plus phase-45 planning): [system state](research/system-state.md), [alternatives](research/alternatives.md), [constraints](research/constraints.md), [risks](research/risks.md). All four ran on Claude Opus/medium and their receipts are verified. The research did not inspect the installed hosts under `~/.claude` or `~/.codex`, because the sandbox blocked those reads.

## Current system state

- **S1 is still present on 0.68.0, unchanged since 0.66.0.** The unscoped armed path scans every linked worktree and takes the newest `generated_at` without an owner check (`plugins/delivery-pipeline/scripts/stop-gate.cjs:515-531`). `stop-gate-arm.cjs` exposes only `arm`, with no `disarm` (N55). No test covers two armed, unscoped sessions. The marker is written atomically to `<git-common-dir>/shipyard/stop-gate-armed/<session>.json` (`stop-gate-arm.cjs:25-35`).
- **Phase 43 is not on `main`.** Five tickets (T-43-01, 02, 03, 05, 09) are merged only into the epic, and fourteen are unmerged (T-43-04, 06, 07, 08, 10–19). Nothing from phase 43 is in 0.68.0, so independence has to be judged against the unmerged `files_modified` and the epic → `main` merge.
- **Already fixed on 0.68.0:**
  - N47: `tests/live/live-round.sh:140`.
  - N43, partly: #316 (`deliver-dispatch.cjs:74-80`) makes an explicit `--graph-dir` win. The worktree graph still wins when no flag is passed (`:81-83`), and the finalizer still counts board files as out of scope (`delivery-commit-finalizer.cjs:11`, `:212`).
  - The PREFLIGHT research-host blocker: the Codex host seals research lines through `planning-result-sealer.cjs` (`codex-delivery-host.cjs:12`, `:583-656`).
- **Unwired primitives.** `capacity-lease.cjs` exists but is not wired into launches (D5). `orchestration-overhead.cjs` already separates `wait_poll` from `model_turn` (P4). `base-merge.cjs` never pushes (N3), and the workflow has no `merge_group` trigger (R18).
- **Evidence for priorities.**
  - Phase 44: Sonnet executors took 56% of child consumption, the orchestrator session about 29% and reviews about 11%.
  - Phase 43: outer Codex coordination took 84.6% of measured Codex input (MODEL-ROUTING-RESEARCH).
  - The replays in N42–N58 are individually documented.

## Independence from phase 43 (constraints §4.2)

- **Deliverable now** (core files outside unmerged phase-43 `files_modified`):
  - S1: `stop-gate.cjs`, `stop-gate-arm.cjs`, tests and the installer bundle. The one caller line in `deliver.md` is owned by T-43-14 and must wait, or be ordered after it.
  - P1 core, P2, P4.
  - R9 (flaky tests), R16 (doctor, provenance, dogfood installer; the pre-push hook came with the already merged T-43-02), and R13's `usage-report.cjs` part (N48).
  - D5 as an advisory or enforcing ledger on `capacity-lease.cjs`, without its config key.
  - The R4 scanner fix, R6, the R8 capture scrubber, and the D3 signature core.
- **Wait for the phase-43 epic:**

  | Package | Waits for |
  |---|---|
  | P3 | T-43-11, 12, 15 |
  | P5 | C3 and T-43-15 |
  | D1 | T-43-04, 08, 10, 12, 18, 19, and S1 installed |
  | D2 | T-43-14, and C2 |
  | R1, R13 base (N45) | T-43-06, 14, 15, 16, 17 |
  | R2 | T-43-06, 13, 17 |
  | R3 | ADR-022 gating: T-43-04, 08, 12, 19 |
  | R5 | T-43-06, 16, 17 |
  | R7 | T-43-12 |
  | R10 | T-43-06, 16 |
  | R11 | T-43-06 |
  | R12 | T-43-06, 12, 17 |
  | R14 | T-43-14, 15 |
  | R15 | T-43-16, 17, and C3 |
  | R17 | T-43-06, 16, 17 |
  | R18 | T-43-04, 06, 08, 12, 13, 17, 19 |
  | C1–C4 | the phase-43 epic (ADR-021) |
- **Hot files inside phase 45**, each needing one serialized owner:

  | File | Packages |
  |---|---|
  | `sentinel.cjs` / `front.cjs` | R3, R18, D1, ADR-022 |
  | `claude-role-host.cjs` | R8, R10, R11, R12, R13, C1 |
  | finalizer and delivery hosts | R1, R4, R5, R12, R17 |
  | `deliver.md` | S1, D2, D3 |
  | `decompose.md` | P1, P3 |
  | `dispatch-boundary.cjs` | P2, D5 |

## Constraints

### Technical
- **Hard constraints.** The constraints line lists 21 (constraints §1). Among them:
  - ADR-014 grids are unchanged, a missing signal never promotes, and routing never crosses providers;
  - a receipt is not an artifact, and no synthetic receipt is ever created;
  - sandboxes are not widened to network or out-of-worktree reads (ADR-020);
  - packet and diff bounds apply (`ARCH_REVIEW_PACKET_TOKENS = 60000`, `DIFF_MAX_BYTES = 1 MiB`).
- **Package-specific constraints** (constraints §5):
  - **S1:** compare paths after realpath; no newest-wins fallback while a binding exists; a bounded behaviour for an unbound legacy marker.
  - **R10:** exact-head, same-command evidence.
  - **R14:** refuse before any model turn, with the artifact path in the sandbox `TMPDIR` or the worktree.
  - **R17:** private bounded host state, keyed by dispatch id.
  - **D5:** atomic reservations across processes, which depends on R9 for trustworthy CI.
  - **D6:** needs the phase-44 effort-experiment protocol and a human decision.

### Product
- Correctness fixes are judged by refusal and fixture tests, with no cohort needed: S1, R1, R2, R4, R5, R9, R12, R13, R16 and R17.
- Efficiency treatments need matched-cohort, one-at-a-time measurement: P3, P4, P5, D1–D6, R15 and R18.
- Hybrids: R3, R6, R10 and R14.

### Delivery
- Gate 2 rejects unordered shared paths. Cross-phase `depends_on` is allowed, as phase 43 did with phases 40 and 42. Phase-45 tickets on phase-43 files therefore depend on the owning T-43 ticket, or wait for the epic.

## Unknowns
- Whether the installed hook and bundles match 0.68.0 (not inspected).
- Whether a GitHub merge queue is available for this repository's plan and for ephemeral `epic/*` branches (R18-c).
- Whether a worktree-local writable `TMPDIR` for the reviewer is admissible under ADR-020 (R10-d).
