# Research

Synthesis of the four research lines (all sealed with verified receipts, claude-opus-5-5/medium,
policy `30e71fb4…`, source revision `d8a7146e`) plus orchestrator checks on 2026-09-25. Full
evidence, commands and timestamps: `research/system-state.md`, `research/alternatives.md`,
`research/constraints.md`, `research/risks.md`. Transcript times are UTC (`intake/transcript-timeline.txt`).

Deployment check: the runtime code on this revision equals v0.63.0, the release the pdffiller session
ran (`git diff --stat v0.63.0 HEAD -- plugins scripts tests` is empty; system-state §0). Every phase-40
and phase-41 ticket is still pending on this branch, and T-41-08 has merged into the phase-41 epic
(PR #236: `state-sync.cjs`, `scripts/shipyard-pre-push-gate.sh` and their tests — `publish-gate.cjs`
is not touched).

## Current system state

| F | Behaviour today (file:line) | Evidence in the run (UTC) | Covered by 40/41? |
|---|---|---|---|
| F2 | `publish-gate.cjs:24-40` `baseFor` tries `--base`, env, `origin/$GITHUB_BASE_REF`, then literal `origin/main`, `main`; otherwise `cannot resolve a base ref`. The hook `scripts/shipyard-pre-push-gate.sh:35` calls it without `--base`. | 14:00:48, 14:10:42 refusals in pdffiller (`master`) and jsfiller (`develop`); a wrapper calling the gate with `--base` was used from 14:11 on. | No. T-41-08 changed only the hook's worktree resolution. |
| F5 | `claude-role-host.cjs:131-132` refuses on any porcelain line, untracked included, with a 256 KiB buffer; introduced in `57b97a79` with no recorded rationale; the judge binds to `HEAD^{tree}` (`:140`). `codex-delivery-host.cjs:20` `SCRATCH_STATUS` and `delivery-commit-finalizer.cjs:8` `SCRATCH` define the scratch set separately; `base-merge.cjs:141-167` already uses `--untracked-files=no`. | 15:07:49, 15:12:43 refusals on `.shipyard-role-artifact.json` / `.shipyard-pr-body.md`; `.shipyard-*` and `.planning/` then added to `info/exclude` of six repositories. | No (backlog `base-merge-refuses-on-the-scratch-files…` names base-merge only). |
| F6 | `gate-trailer.cjs carry` (only caller `base-merge.cjs:213-226`) carries a verdict only when the head tree and recorded base tree are unchanged. A base-merge bringing a sibling's squash changes the head tree. | "No verdict carried — the head tree MOVED" at 15:28:54, 16:14:53, 16:49:44 (×2), 16:50:34, 18:35:08, 19:20:21; ≈23 arch-review launches for 13 tickets. | No; backlog entries untriaged. T-40-19 rewrites the carrier (commit status). |
| F7 | Claude executor: `--restricted`, write-only-worktree sandbox, `blockReadsOutsideWorkingDirectories`, no network allow-list, no excluded commands (`claude-runtime-host.cjs:649-690`). `sentinel.cjs mergeOne` (`:891-1080`) checks config, ticket, `AUTO_MERGE`, `pr-open`, checkpoint, gate, CI, threads, freshness — no receipt or finalization check (`grep receipt\|finaliz` → comments at 673, 795 only). | 8/13 tickets `blocked` on docker/php/deps after editing; orchestrator ran checks via `docker run`, committed with `-S` (twice `--no-verify`, 16:19:34, 16:42:29) and published; all merged. | No. T-42-01 (split from T-41-04) is a Codex-only resume of an authenticated candidate; D-43 (T-40-28) delivers the plan, not verification. |
| F8 | `run-reachability.cjs:58-59` `spawnSync('git', …)` without `maxBuffer` (1 MiB); `sentinel.cjs:202-229` reads `git/trees/<ref>?recursive=1` for head and epic, turning any error into `ok: null`. | 14:00:22 `epic-branch.sh ensure` failed with 1.1 MB of `ls-tree` in the error; cache patched at 14:01:08; 15:47:04 and 16:46:47 `epic reachability UNKNOWN: … ENOBUFS`. | No. |
| F9 | `reviewers.cjs:154-170` requires an approval on the current head whenever `reviewDecision === 'APPROVED'`, bot or human; `sentinel.cjs:1052-1054` blocks. Bot detection is hard-coded (`:142`). | T-02-10 refused at 16:22:11, 16:40:08, 16:46:47, 17:36:48; escalated to a human at 17:41. The epic branches of all six repositories have no rules (`gh api …/rules/branches/epic%2F02-…` → `[]`), so GitHub required nothing. | No. |
| F10 | T-40-15 `deliver-dispatch.cjs` builds executor and pr-sentinel requests only. Research, decompose, arch-review and fix-round requests are assembled by the model from host source. | 12:28:11–12:29:08 three failed research launches (`files_modified`, `invId`, reference allow-list); 13:04–13:05 decompose requests; `mkexec`, `mkfix`, `archrun`, `finalize` scripts. | No. |
| F11 | `state-sync.cjs:459-473` runs `gh pr list --state all --limit <pr_fetch_limit>` (default 1000, `pipeline-config.cjs:537`) per repository and re-derives every ticket, merged ones included. | Limit hit in pdffiller, jsfiller, front-mobile-web (13:58:38); 25 syncs, median 128 s (≈58 min). | No. T-40-03's ledger changes matching, not fetch cost. |
| F12 | `ci-wait.cjs:123-125` window 15 min default, 60 min ceiling; `check-state.cjs:95-100` counts `cancel` as failing. The Claude Bash tool caps a call at 600 000 ms (harness tool contract). | 17:45:07, 18:49:34 ci-wait moved to background after 600 s and was polled with `until … sleep`; `publish` job CANCELLED by concurrency sent to ci-fix three times (17:25:58, 19:26:26, 19:30:54). | No. |
| F13 | `comment-policy.cjs:9,382` markers hard-coded (`@invariant:`, `@security:`, `@contract:`); a modified comment line scores as added. | 14:20:03 block on `@ai-generated` required by pdffiller's agents; 40 min waiting for a user decision; 16:52:21 ADR-required removal of a stale comment blocked → ADR scope reduced. | No. |
| F14 | `role-artifact.cjs:1260-1277` fails the whole arch-review artifact on one finding type outside the known set. | 16:19:52 T-02-12 arch-review lost; relaunched. | No. |
| F15 | `jira-export.cjs:102-124,213-254` looks up by shipyard label only, `on_no_match: 'create'`; `record` stores a key that `plan` never reads; summaries are `${id}: ${title}` (`:244`). | 13:44:57 keys bound by `record`, Jira disabled; 19:31 statuses being moved by hand. | No. |
| F16 | `pipeline-config.cjs:927-933` deletes `pipeline.gsd_sync` when `delivery_pipeline.gsd_sync` is absent and emits a warning that the state-sync output buries; `gsd-sync.cjs:616` blocks per plan when a phase is not in ROADMAP. | 13:56:40 blocked by phase-01 plans; key moved by hand at 13:54:46 and 13:56:46; projections off for the run. | No. |
| F17 | `sentinel.cjs:690-701,905-911` blocks a `human_checkpoint` merge even into the epic unless `preauthorized: true`; `AUTO_MERGE` only for `auto_merge: epic` + `epic-stacked` (`:131`). | 16:42–19:15 three tickets waited; user: "you will merge into the epic branch, right? → then pre-authorize" (19:14:50). | No. |
| F18 | Escalation is `escalation-record.cjs mark`; no notion of a repository remedy. | 16:15:33 T-02-06 parked for a screenshot baseline; 18:22 the repository's `pw-debug-tests.yml` (`regenerateScreenshot`) fixed it after a user nudge. | No. |

## Constraints

### Technical

- ADR-014 boundary (`ADR-014-mandatory-runtime-model-ladder.md:119-143,196-200`): a merge gate that refuses unreceipted heads strengthens the boundary and is allowed; giving the agent docker, network or wider reads widens launch authority and needs an explicit ADR-014 decision. The receipt shape is out of scope, so host-side verification evidence must live in finalization evidence or a sealed artifact referenced by digest (constraints K1).
- Codex parity: every host or builder change lands on both runtimes or records why one is unaffected; Codex host tests replay captured streams, and T-40-09 is the last editor of the Codex host tests (K2).
- Shipyard backward compatibility: with `main`, tracked `.planning/`, one repository and no new keys, behaviour stays identical; target-only behaviour switches on `prHygiene.applies` (T-40-17), from the committed base (K3). New keys follow the D-45 pattern (registered in `pipeline-config.cjs`, `delivery_pipeline.*` wins, bad shape warns and falls back).
- Fail-closed gates: every relaxation (F8, F9, F12, F14) replaces a refusal with positive evidence, never with absence (K4, ADR-004).
- Comment policy and per-repository allow-lists are read from trusted configuration, never from the ticket worktree (K5).

### Product

- Success is measured on a rerun of a comparable multi-repository target-project phase: no orchestrator commits, graph copies, `info/exclude` edits, cache patches or hook wrappers; before/after state-sync time and arch-review launches per ticket (PROBLEM.md).
- Target-repository conventions (commit/PR formats, annotations, CI workflows) are respected where they do not conflict with conveyor safety.

### Delivery

- File ownership (constraints §3): free now — `publish-gate.cjs`, `run-reachability.cjs`, `reviewers.cjs`, `ci-wait.cjs`, `check-state.cjs`, `comment-policy.cjs`, `jira-export.cjs`, `references/*.md`. Gated — `sentinel.cjs` (after T-40-19, T-40-22), `claude-role-host.cjs` (after T-41-01 → T-40-16 → T-40-22), `state-sync.cjs` (after T-41-08, T-40-03, T-40-19, T-40-27), `gate-trailer.cjs` (after T-40-19), `role-artifact.cjs` (after T-40-18), `pipeline-config.cjs` (after T-40-17), `gsd-sync.cjs` (after T-41-05), `deliver-dispatch.cjs` (after T-40-15), delivery hosts (after T-40-28 / T-40-09), `commands/*.md` (after T-40-24/25).
- Phase 41 releases first; a phase-43 ticket that shares a file with phase 40 waits for that ticket and for the phase-40 epic to reach `main` (cross-phase parents cannot cascade through an epic).
- The phase-40 amendment now lives on `plan/40-target-project-amendments` (D-43..D-45, new T-40-28); the diff in `intake/phase40-amendment.diff` predates the split of plan delivery into T-40-28.

## Unknowns

- Whether the operator will run the proving-ground rerun that the success criteria need (OPEN-QUESTIONS).
- The Codex tool timeout for long waits (only the Claude 600 s cap is known).
- GitHub API rate cost at pdffiller scale for state-sync and merge-time reads (`gh api rate_limit` before/after a sync).
