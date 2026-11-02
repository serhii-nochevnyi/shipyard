# Phase 54 — Let an operator grant one more code-review round

Status: operator-approved scope from accepted ADR-035 (INV-021 Gate 1, 2026-11-02); base is `epic/harness-simplification` at `9ba94e7c` (1.0.0-rc.3, released); this phase ships in `1.0.0-rc.5` (rc.4 is released before it, with the arch-review base fix HS-48 only).

## Amendment 2026-11-02 (read first)

`1.0.0-rc.3` was released before this phase started, from the epic tip `9ba94e7c`. Three tickets landed on the baseline this research and these plans were written against (`749604b9`): HS-45 (#654, arch-review sources without commit or approval when `.planning/` is untracked), HS-46 (#655, the host owns `ticket_set` and its digest: new `withoutHostTicketSet`/`withHostTicketSet` in `role-artifact.cjs`, replay and Codex contexts changed, `code-review.md`/`arch-review.md` reworded) and HS-47 (#657, Codex parent parser). Line numbers and call-site descriptions in `54-RESEARCH.md` and the plans are against `749604b9`: every ticket re-verifies them against the current epic tip before editing, with extra care for `role-artifact.cjs` (replay and seal), `claude-role-host.cjs`, `codex-code-review-context.cjs`, `codex-arch-review-context.cjs` and `references/code-review.md` (T-54-13 edits it after HS-46 already did). The version target is `1.0.0-rc.5`: wherever a plan or the research says `1.0.0-rc.3` as the target, read `1.0.0-rc.5`; `1.0.0-rc.4` is released first with the arch-review base fix (HS-48, which changes `role-artifact.cjs` `gitIdentity` and `claude-role-host.cjs`) and without this phase, so the value in the six files when T-54-15 runs is `1.0.0-rc.4`, and HS-48 is one more change on the baseline that every ticket re-verifies.

## Goal

The phase code review can run a round beyond the third only when the operator has written a head-bound record. One record grants one round, the total is capped at 5, the extended round is always a delta that never auto-repairs, and the merging human sees on the PR that the limit was extended.

## Source of truth

- Accepted ADR: `.planning/architecture/ADR-035-human-granted-review-round.md` (decisions R-1…R-15; amends ADR-032 from git history `94d05497`, which is not carried in this branch).
- Evidence: `.planning/investigations/INV-021-human-review-round-extension/` (`RESEARCH.md`, `RISKS.md`, `DECISIONS.md` and the four sealed lines under `research/`).
- Baseline: `epic/harness-simplification` `749604b9`. Line numbers in the research are against it.

## Locked scope (from ADR-035)

An unsigned private record outside the worktree next to the publication record, bound to repository, PR, head and base commit; effective limit = `ROUND_CAP` + valid records, clamped to a total of 5; consumption derived from the countable verdict history (a record counts while its head is current, or while its head is an ancestor of the current head and a countable verdict for that head sealed after the record); void records cost nothing; absolute ceiling 5 in seal validation, normalization and the replay-depth bound; extended round is a delta or refuses; `repairAllowed` stays 1-2; visibility in the sealed verdict, the `<!-- code-review -->` comment and the `code-review` commit status, not the gate trailer; named refusal hints and project-wide `report` wording; `references/code-review.md` edited to rounds 1-5 with an accepted one-time reset; release `1.0.0-rc.5` by the six-file pattern of `749604b9`.

## Planning mode

`--tdd`, granularity `fine`. UI design: none, so `--skip-ui`.

## Where the cap lives (from the research, verify against the source before editing)

- `ROUND_CAP` and `nextRound`: `plugins/delivery-pipeline/scripts/code-review-core.cjs:6,196,338-340`; `repairAllowed` at `:347`.
- Seal and replay: `plugins/delivery-pipeline/scripts/role-artifact.cjs:3146` (`review_round > core.ROUND_CAP`), `:3190` (`lineage.active.size >= ROUND_CAP`), `priorCodeReviewVerdicts` and `currentCodeReviewVerdict`.
- Three round computations: `phase-code-review.cjs:145,154`, `claude-role-host.cjs:596,612-613`, `codex-code-review-context.cjs:141,148-149`.
- Texts: `phase-code-review.cjs:87-90,181,215,275`, `deliver-dispatch.cjs:1209`, `deliver.md`, `refusal-hints.cjs`, host error strings.
- Record precedent: `phase-code-review.cjs:306-391` (`publicationNamespace`, `readPublication`, `persistPublication`).
- Reviewer reference: `plugins/delivery-pipeline/references/code-review.md` ("Integer 1 through 3", "No fourth review is owed"); its digest is part of the contract digest, so any edit resets sealed verdicts.
- Version bump pattern: commit `749604b9` (six files).

## Constraints to carry into every ticket

- Net-negative or justified: each ticket reports net lines including tests and names an offsetting deletion (for example collapsing the three copies of the refusal sentence and the three round computations into one shared lookup); no new contract ids unless the ticket names the unavoidable one; the comment policy stays blocking.
- Do not regenerate `plugins/shipyard` in ticket PRs; it is regenerated once before the epic goes to `main`; never edit the generated `host/` copy by hand.
- Edits to `runtime-adapters` or `claude-dispatch-adapter` need `make refresh-runtime-digests` and the printed trailer; the dispatch boundary resolve → validate → launch → receipt stays.
- The record and its tests never read or write the real `~/.local/state/shipyard`: authority-touching tests override `os.homedir`.
- The first ticket is the S1/S4 spikes and changes no production behaviour; no limit change lands before its findings are recorded.
- The last ticket is the `1.0.0-rc.5` version bump and changes only the six version files; it needs `make test-releases`.
- No plan modifies more than 10 files.
- Verification commands are scoped to the touched test files; the whole unit suite is CI's job.
