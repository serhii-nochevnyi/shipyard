# Phase 45 — Close residual pipeline efficiency gaps: first-pass planning context

Status: first-pass plans materialized (45-01 … 45-14); graph gate, checker and delivery pending.
Authorized: the user moved the phase-44 residual gaps into this phase on 2026-09-26; INV-008 closed with [ADR-023](../../architecture/ADR-023-residual-pipeline-efficiency.md) on 2026-09-28.
Research: [45-RESEARCH.md](45-RESEARCH.md) (worktree revision `c42535f6`). Scope and acceptance cases: [WORK-PACKAGES.md](WORK-PACKAGES.md).

## Goal

Correct the armed Claude Stop gate's cross-session board selection first. Then close the correctness and reliability gaps whose files lie outside the unmerged phase-43 `files_modified`. All of this must keep native receipts, independent review, required instructions, tests, approval and live merge checks intact. S1 is judged by correctness and installed-host behaviour, not by quota savings. P4 and D5 report `inconclusive` until matched cohorts exist, and no plan claims a savings percentage (ADR-023 Consequences).

## Decisions (locked — ADR-023 §Decision and the orchestrator first-pass rules)

- **D-01 Correctness-first.** The first pass holds only packages whose core files lie outside every phase-43 `files_modified`. No cross-phase `depends_on`. A package that needs a phase-43 file drops that part to the second pass.
- **D-02 S1.** The armed marker binds the realpath of the delivery board chosen at arm time. The hook reads only that board, with no newest-wins fallback while a binding exists. An unbound legacy marker has a bounded behaviour. `stop-gate-arm.cjs disarm` removes the session's own marker. S1 is its own high-risk ticket with a human checkpoint, a two-armed-session fixture, and a test of the installed copied hook. `commands/deliver.md` belongs to T-43-14, so the caller line is second pass.
- **D-03 R16.** Dogfood installs target a dedicated runtime home by default. The doctor and the release preconditions classify another session's dogfood cache as foreign, not as a release error. The pre-push part (`scripts/shipyard-pre-push-gate.sh`, T-43-02) is second pass.
- **D-04 D5.** The aggregate admission ledger on `capacity-lease.cjs` is advisory/shadow only, adds no config key, and always reserves verification and checkpoint capacity.
- **D-05 Planning.** P1 is a planning-tree writer lease with a fencing token, implemented in code (a planning module and the decompose hosts), not in `decompose.md` text. P2 recovers a completed judgment role from its durable reservation, authenticated transcript and artifact digest without relaunch, and never synthesizes a receipt. P4 gives decomposition a blocking `dispatch wait` so the parent sleeps without model turns.
- **D-06 Requirements** continue from REQ-184. The first pass uses REQ-185 … REQ-196 in `.planning/ROADMAP.md`.

## Claude's discretion (decided in the plans)

- S1 board resolution at arm time: `--graph-dir`, then `SHIPYARD_GRAPH_DIR`, then `<cwd>/.planning/graph` when it holds a board (the `graph-dir.cjs:46-61` precedence). The legacy bound is one refusal per turn plus expiry `RESYNC_MS` after `armed_at` (research A1; confirmed at the S1 human checkpoint).
- R16 dedicated home: `${XDG_STATE_HOME:-$HOME/.local/state}/shipyard/dogfood/<runtime>/<16-hex digest of the checkout realpath>`. An explicit `CODEX_HOME`/`DOGFOOD_ROOT` still wins (research A3).
- P1 lives in a new `planning-writer-lease.cjs` rather than `capacity-lease.cjs`, so P1 and D5 do not share a file.
- R9 is split into two tickets: the decompose-host lease clock, and the harness-based session-handoff/dispatch-boundary races.
- P2 is split by host (Codex first, because it adds the reservation query to `dispatch-boundary.cjs`).

## First-pass plans

| Plan | Ticket | Package | Wave | Depends on | Requirements |
|---|---|---|---|---|---|
| 45-01 | T-45-01 | S1 bind board, legacy bound, disarm, installed hook test | 1 | — | REQ-185, REQ-186 |
| 45-02 | T-45-02 | R16 provenance owner + doctor foreign classification | 1 | — | REQ-187 |
| 45-03 | T-45-03 | R16 dedicated dogfood home by default + docs | 2 | T-45-02 | REQ-188 |
| 45-04 | T-45-04 | R9 codex-decompose-host lease clock and heartbeat | 1 | — | REQ-189 |
| 45-05 | T-45-05 | R9 session-handoff and dispatch-boundary barriers | 1 | — | REQ-189 |
| 45-06 | T-45-06 | R13/N48 usage-report counts `turn.completed.usage` | 1 | — | REQ-190 |
| 45-07 | T-45-07 | P1 planning writer lease module | 1 | — | REQ-191 |
| 45-08 | T-45-08 | P1 lease wired into both decompose hosts | 2 | T-45-04, T-45-07 | REQ-191 |
| 45-09 | T-45-09 | P2 Codex judgment recovery + reservation query | 3 | T-45-05, T-45-08 | REQ-192 |
| 45-10 | T-45-10 | P2 Claude judgment recovery | 4 | T-45-09 | REQ-192 |
| 45-11 | T-45-11 | P4 waitable Codex decomposition + attribution | 4 | T-45-09 | REQ-193 |
| 45-12 | T-45-12 | D5 advisory aggregate admission ledger | 1 | — | REQ-194 |
| 45-13 | T-45-13 | R6 one bounded drift-check repair (Claude) | 1 | — | REQ-195 |
| 45-14 | T-45-14 | R8 capture scrubber account ids + git-init scratch | 1 | — | REQ-196 |

Ownership check: `for f in .planning/phases/43-*/43-*-PLAN.md; do awk '/^---$/{c++;next} c==1' "$f" | awk '/^files_modified:/{p=1;next} p&&/^[a-z_]+:/{p=0} p'; done | sort -u` printed 76 unique paths on 2026-09-28. No first-pass `files_modified` path is on that list. Re-run it before dispatch if a phase-43 plan is amended.

## Second pass (waits, and why)

| Package / part | Why it waits |
|---|---|
| S1 `deliver.md` caller line (`arm --graph-dir`, `disarm` at fixpoint) | `commands/deliver.md` is T-43-14 |
| R16 pre-push hook checks the pushed worktree | `scripts/shipyard-pre-push-gate.sh`, `tests/unit/pre-push-gate.test.cjs` are T-43-02 |
| R4 (all, incl. N13 scanner) | `comment-policy.cjs` T-43-03; `publish-gate.cjs` T-43-02/03 |
| R6 Codex path and journal event | `codex-delivery-host.cjs` T-43-06/16/17; `log-event.cjs` T-43-07/08/18/19 |
| R8 packet elision, relay contract record, dogfood `CODEX_HOME` recipe | `claude-role-host.cjs` T-43-06; the recipe overlaps the R16 docs |
| R13 N44–N47 | delivery hosts and `deliver-dispatch.cjs` (T-43-06/14/16/17) |
| P1/P4 `decompose.md` caller text; P4 `deliver-dispatch.cjs` changes | T-43-11/12/14/15 |
| D5 enforcement and launch wiring | needs measurement first (ADR-023); `deliver-dispatch.cjs` is T-43-14/15 |
| P3, P5, D1–D4, D6, R1–R3, R5, R7, R10–R12, R14, R15, R17, R18, C1–C4, ADR-022 | either they share phase-43 files (delivery hosts, `deliver.md`, `validate-graph.cjs`, `role-artifact.cjs`, `sentinel.cjs`, `base-merge.cjs`), or they need P1/P2, phase-44 cohorts, an approved experiment, or the phase-43 epic on `main` (ADR-021/022/023) |

## Exclusions (ADR-023)

A global model downgrade, ADR-014 grid changes, cross-provider fallback, automatic session transfer and an always-on sentinel daemon are all excluded. The repair loop may not weaken independent reviewer or CI requirements. The admission ledger may not turn missing quota into a green verdict.
