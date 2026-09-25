# INV-006 — risks for phase 41

## Scope and evidence

Pinned HEAD `68e3a158f9224709caa32665726355d4f4127b1b` (`git rev-parse HEAD`). `rg --files .planning/codebase` found no map. No logs, tests or pipeline were run. Claims refer to this checkout unless marked audit, supplied, hypothesis or unknown; E1–E11 are exact read commands.

Evidence commands (all read-only; line ranges below are their outputs):

- **E1:** `nl -ba docs/audits/2026-09-25-claude-session-efficiency.md | sed -n '1,185p'` — usage `:9-25`, packet `:41-70`, continuation/wake/replay `:72-97`, review `:99-128`.
- **E2:** `nl -ba docs/audits/2026-09-25-pipeline-subscription-efficiency.md | sed -n '1,240p'` — older revision `:1-7`, outcome/readiness `:62-68`.
- **E3:** `cat .planning/phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md` — P41-A–F `:47-152`, ownership `:154-175`.
- **E4:** `nl -ba plugins/delivery-pipeline/scripts/context-packet.cjs | sed -n '235,285p;435,495p'`; `nl -ba plugins/delivery-pipeline/scripts/claude-role-host.cjs | sed -n '20,29p;595,650p'` — selection `:240-285`, overflow `:445-493`, role-host bounds and prompt `:20-24,598-643`.
- **E5:** `nl -ba plugins/delivery-pipeline/scripts/session-handoff.cjs | sed -n '539,620p;752,770p;799,870p'` — checkpoint, validation, ownership and transfer state.
- **E6:** `nl -ba plugins/delivery-pipeline/scripts/stop-gate.cjs | sed -n '395,435p;500,545p'`; `nl -ba plugins/delivery-pipeline/scripts/run-waker.cjs | sed -n '150,235p'` — arm/front selection and wake claim.
- **E7:** `nl -ba plugins/delivery-pipeline/scripts/codex-delivery-host.cjs | sed -n '220,250p;291,335p;430,455p'` — executor/finalizer/host-error flow.
- **E8:** `nl -ba plugins/delivery-pipeline/scripts/gsd-sync.cjs | sed -n '1081,1130p;1150,1180p'` — fingerprint, check and publication.
- **E9:** `nl -ba plugins/delivery-pipeline/scripts/usage-report.cjs | sed -n '293,330p;645,680p'`; `nl -ba plugins/delivery-pipeline/scripts/orchestration-overhead.cjs | sed -n '405,465p'` — usage accounting and readiness.
- **E10:** `sed -n '1,35p;80,110p;141,180p;212,220p' .planning/phases/39-remove-conveyor-session-friction/39-17-PLAN.md`; `sed -n '1,75p' .planning/phases/39-remove-conveyor-session-friction/39-03-PLAN.md` — T-39-17/T-39-03 ownership.
- **E11:** `for f in .planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-{08,11,15,18,21,22}-PLAN.md; do sed -n '1,18p' "$f"; done` — phase-40 ownership.

**Audit measurement (E1):** 861 responses, 252,061,225 processed input (245,666,703 cache reads); six false wakes: 5,097,592 input; six judgment prompts: all 203 backlog sections; T-39-16 second pass: 4,822,956 input (`:9-25,41-53,80-97`). Avoidability and subscription credits remain unknown. E2 is an older static audit.

**Supplied, unverified observation:** `gh pr view` showed PR #231 merged at 2026-09-25T10:27:34Z and epic #215 merged to main at 10:35:19Z. This pinned checkout is not proof of integration or installation. Before planning, run `git fetch`, `git branch --contains <implementation-commit>`, `gh pr view 231 --json state,mergedAt,mergeCommit,baseRefName`, the same for 215, then installed host/hook digest or doctor. These are next checks. Kickoff status in `.planning/investigations/INV-006-pipeline-subscription-overhead/PROBLEM.md` and E3 is dated.

## Six priority risks and narrow plan scenarios

### P41-A — full prompt and installed packet

**Failure:** a source fixture passes while the installed arch-review, sentinel or integrator still receives the entire backlog; duplicated inventory/source content and packet-only bytes/4 hide full launch input. E4 shows that behavior is possible at this HEAD. E1:55-70 pairs integrator packet estimates 340,318/356,878 with observed first-response input 587,880/617,209. T-39-17's proposed whole-record supersession exclusion (E10, plan lines 81–110) could drop still-governing clauses or transitive references; this is a **design risk**, not a finding about merged code.

**Mitigate / accept:** T-39-17 owns selection/bounds (E10). Plan selected, empty and partially superseded fixtures: preserve governing/transitive references and refuse mandatory oversize before launch with a remedy. Observe each installed role path; record host/policy digest, selected IDs, full prompt bytes/estimate, first-response input and cache/output by matched runtime/model/effort. Require zero fallback, duplicate body or omitted constraint. Fixtures do not prove installation/savings (E3:47-66).

### P41-B — bounded continuation

**Failure:** checkpoint loses a decision, gate, attempt or active dispatch, or a stale successor duplicates execution. E5:539-564 shows required metadata; `:568-613,799-869` checks references, changed head/base, pending launch and live ownership. Automatic transfer is unsupported at this HEAD (`:752-759`). **Hypothesis:** frequent restarts fragment provider cache and increase cold-prefix creation, so shorter parent transcripts may cost more overall (E1:72-78).

**Mitigate / accept:** reuse E5 store; retain decisions, findings, digests, attempts, gates, ownership and next action. Scenario: completed ticket + active child + pending gate; successor resumes once with no repeat/orphan or attempt reset. Changed digest/head/base/epoch must refuse or revalidate. Compare matched boundaries including collection, startup, warmup and cache read/create; shorter parent transcript alone is insufficient (E3:68-82).

### P41-C — foreign and unchanged wait wake

**Failure:** foreign newest front wakes a waiting session, or unchanged waits produce repeated model replies; over-filtering can miss the owner's real CI/review/dependency transition. E6 shows current sibling-front selection and existing waker claim logic; E1:80-86 supplies the six-reply baseline but explicitly says installed-hook cause was transcript-reported rather than freshly reproduced. T-39-03 owns arming (E10).

**Mitigate / accept:** inspect installed hook and arming first. Six audit regressions: foreign board yields **zero model replies** to unarmed/waiting session; unchanged wait yields **zero additional replies**; owner state change resumes **once**. Count polls apart from model turns. Preserve scoped behavior; only a demonstrated residual enters P41 (E3:84-98).

### P41-D — safe finalization reuse

**Failure:** code work completed but signing/host/base error triggers full executor replay; a stale candidate reused after tree/base/plan/policy/evidence change turns old green into a new commit. E7:314-331 has direct launch then finalization, `:220-250` checks receipt, graph, delta and signature, and `:443-454` records failure. E1:88-97 measures T-39-16 replay but says some revalidation may have been necessary.

**Mitigate / accept:** persist pre-finalization candidate bound to repository/ticket/worktree, tree/head/base, plan/policy/graph, verification and receipt. Scenario: finished uncommitted work, signer failure, host recovery, then **zero second executor launches**, one signed commit and idempotent retry. Change each identity: revalidate affected checks or refuse; retain pending/failed gates. Reuse finalizer; T-40-18 owns formatting, T-40-21/22 provenance (E11; E3:100-116,154-165).

### P41-E — local GSD fingerprints

**Failure:** E8:1089-1125 supplies one source fingerprint containing all plans to every generated output, so a local plan change can rewrite unrelated artifacts. Over-narrowing can miss dependency-edge or aggregate invalidation. `--check` and identical-file skip exist at E8:1159-1180.

**Mitigate / accept:** define governing-input sets per projection and explicit aggregate/edge dependencies. Plan one plan-content change: only its summary and genuinely dependent aggregate outputs change; unrelated phase files remain byte-identical. Then change a dependency edge: all affected outputs invalidate and read-only `--check` reports stale files. Record changed file count and diff bytes; neither is a direct quota measure (E3:118-131).

### P41-F — comparable outcome-linked evidence

**Failure:** streamed/replayed response rows or nested iteration/thinking/cache subsets are summed twice; failure, interruption, parking and recovery are dropped; unknown attribution is treated as zero. E9 shows existing Claude deduplication but no completed-outcome join and explicit `subscription_usage: null` (`usage-report.cjs:293-325,653-671`). E9's overhead report requires comparable arms, 20 completions, 95% attribution and quality checks (`orchestration-overhead.cjs:405-454`).

**Mitigate / accept:** join parent/child usage to verified outcomes; keep missing values **unknown**. Scenarios: duplicate stream IDs, cache/thinking subsets, nested calls, failed/parked/recovery work, missing attribution. Report cache categories, output, turns/retries, cohort total, median/p90 per verified completion and quality failures. Compare one treatment at a time. Below **20 completions / 95% attribution**, say **inconclusive**; functional fixes may ship. No subscription percentage follows from tokens (E3:133-152; E2:62-68).

## Cross-phase risks

- **Duplicate phase-39 fixes or circular ownership.** E10 assigns packet selection to T-39-17 and arming to T-39-03; E11 and E3:154-165 show phase-40 shared-file ownership. Reconcile current main after the supplied merges, map each P41 `files_modified`, order shared contract changes explicitly, and validate the dependency graph. Acceptance: no second packet/arming implementation, no phase-41 ↔ phase-40 cycle, phase 41 deliverable before phase 40.
- **Bootstrap mistaken for release.** The local host bridge enabled this research only; installed and integration states remain **unknown**. E7 demonstrates only this checkout's host path. Release evidence must separately name implemented, integrated, installed, behaviorally verified and efficiency-measured states, with a command and output for each (E3:154-187).
- **Safety regression from shorter inputs.** E1:99-111 reports substantive integrator and checker findings. Preserve independent planner/checker and integrator judgment, trusted receipt and merge gates; any false green, skipped gate, lost constraint or duplicate dispatch invalidates an efficiency treatment (E3:133-175; E9:429-441).

## Open questions

### Researchable facts — no human choice required yet

- [ ] Which T-39-03/T-39-17 code is on current main and in installed hook/host copies? — owner: runtime operator; next check: supplied PR queries, `git branch --contains`, installed digest/doctor and actual role launch.
- [ ] What is full first-response input by selected role/runtime/model/effort after installation? — owner: measurement implementer; next check: receipt-linked provider usage and assembled-prompt observation.
- [ ] Can a successor preserve active dispatches and lower *total* input after cache warmup? — owner: handoff implementer; next check: controlled baseline/treatment with dispatch lineage.
- [ ] Does any foreign/unchanged wait still cause a model wake after installed T-39-03, without suppressing owner wake? — owner: runtime operator; next check: installed hook provenance and the seven narrow scenarios above.
- [ ] Which current phase-40 files/contracts overlap the finalization ticket? — owner: phase-41 planner and phase-40 owner; next check: current-main plans, file ownership and dependency validation.
- [ ] Can usage reach 95% receipt/outcome attribution without turning unknown into zero? — owner: telemetry implementer; next check: comparable live cohort report.

### Human choices — keep separate from research

- [ ] What phase-boundary/long-wait trigger justifies a new session after startup and cache-warmup cost? — owner: maintainer; choose after matched measurements.
- [ ] For a changed finalization base, which affected gates permit bounded revalidation versus refusal? — owner: maintainer and review/security owner; decide before implementation.
- [ ] Which comparable cohort/window should host the first treatment beyond the 20-completion/95%-attribution floor? — owner: maintainer; that floor is readiness, not statistical proof.

If a decision needs throwaway empirical code, propose a focused `$gsd-spike` with its expected observation.
