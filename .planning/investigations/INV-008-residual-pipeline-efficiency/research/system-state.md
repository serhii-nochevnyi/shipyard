# INV-008 research line 1 — current system state

- Line: `system-state` (→ RESEARCH.md "Current system state")
- Subject: `INV-008-residual-pipeline-efficiency:system-state`
- Source revision: `705eb23328e166bf373701790f1768c90446f503` (`git rev-parse HEAD`)
- Policy hash: `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968` (ADR-014 `adr-014.v6`); policy signals for this dispatch: `{}`
- Runtime selection: Claude `claude-opus-5-5` / medium (research base rung), resolved by the caller
- Scope: read-only. Only this file was written. No source code, planning scaffolding or graph file was modified.

## 0. Method, limits and the deployment check

**Release identity of the code under study.**
- `plugins/delivery-pipeline/.claude-plugin/plugin.json` reports `"version": "0.68.0"`. Checked with `cat plugins/delivery-pipeline/.claude-plugin/plugin.json | head -5`.
- `git merge-base --is-ancestor v0.68.0 HEAD` succeeded.
- `git diff --stat v0.68.0 HEAD -- plugins scripts tests` printed nothing. So at this revision, the plugin source, installers and tests are byte-identical to the v0.68.0 tag. Every "present on 0.68.0" claim below is therefore a claim about the released source.
- `git merge-base --is-ancestor origin/main HEAD` succeeded. `origin/main` is `8f1b6418` (#353). HEAD adds only planning docs (commit 705eb233).

**Installed copies were not inspected.**
- The research contract says: "Do not read paths outside [the worktree]". So `~/.claude/hooks/shipyard-stop-gate/`, the Claude plugin cache and `~/.codex` were **not** read.
- Installed-host equivalence is an **unknown**. The backlog note records one earlier data point: at the 0.66.0 reproduction, the installed hook, the plugin cache and the source `stop-gate.cjs` had identical SHA-256 `a41aea77…c06`.
- `shasum -a 256 plugins/delivery-pipeline/scripts/stop-gate.cjs` at this revision prints the **same** `a41aea770ee9a812fb41e3098f20907eca9413ac7ab17d9d147e23de5f926c06`. So `stop-gate.cjs` has not changed since the defect was reproduced. The arming helper's hash is `3a2703c3ab1898b571c580d57f248e7740425d53d78612ff4df42714b5be1b06`.
- Next check (operator, outside this sandbox): `shasum -a 256 ~/.claude/hooks/shipyard-stop-gate/stop-gate.cjs` and compare it with the hash above; then run `make doctor`.

**Phase-43 delivery state comes from remote-tracking refs, which may be stale.**
- `git branch -r` shows `origin/epic/43-target-project-delivery-at-scale` at `7552b655` (2026-09-28 17:45:51 +0300).
- The time of the last fetch is unknown. No `gh` call was made. Next check: `git fetch && gh pr list --base epic/43-target-project-delivery-at-scale --state all`.

**Codebase map.** `.planning/codebase/` is absent (`ls .planning/codebase` → "No such file or directory"). Everything below was discovered from source with Grep/Read.

**Tool limitations in this session.** Two compound shell commands (a `cd … && grep/ls …` chain and a `head` chain) were auto-denied by the permission layer. The same facts were then read with the Grep and Read tools. No evidence depends on the denied commands.

## 1. Headline findings

1. **S1 is still present on 0.68.0 and is unchanged since 0.66.0.**
   - The unscoped armed path scans every linked worktree and picks the newest `generated_at`, without any owner check (`stop-gate.cjs:515-531`).
   - `stop-gate-arm.cjs` exposes only `arm`. There is no `disarm` (N55).
   - No test covers two armed, unscoped sessions.
2. **Phase 43 is not on `main`.**
   - Five tickets have ticket PRs merged into the epic: T-43-01, 02, 03, 05, 09.
   - Fourteen tickets are not merged: T-43-04, 06, 07, 08, 10–19. T-43-14 appears on the epic only through plan amendments (#322, #339).
   - Because the epic has not reached `main`, even the "merged" five are **not in 0.68.0**.
3. **Shared files with pending phase-43 tickets.** Most R and D packages touch at least one of: `sentinel.cjs`, `deliver-dispatch.cjs`, `commands/deliver.md`, the delivery hosts, `claude-role-host.cjs`, `validate-graph.cjs`, `base-merge.cjs` or `delivery-commit-finalizer.cjs`. Each of these is declared in a pending phase-43 PLAN.
4. **Packages whose core files are independent of phase 43:**
   - S1 (except any `deliver.md` caller text);
   - P1, P2 and P4;
   - R5 (runtime hosts);
   - R9 (tests);
   - the `usage-report.cjs` part of R13 (N48).
5. **Already fixed on 0.68.0:**
   - N47 (`tests/live/live-round.sh:140`).
   - N43 partly: #316, commit `0f7d9ba9`, makes an explicit `--graph-dir` win (`deliver-dispatch.cjs:74-80`). The worktree-tracked graph still wins when no flag is passed (`:81-83`), and the finalizer still counts board files as out of scope (`delivery-commit-finalizer.cjs:11`, `:212`).
   - The PREFLIGHT research-host blocker: the Codex host now seals research lines through `planning-result-sealer.cjs` (`codex-delivery-host.cjs:12`, `:583-656`).

## 2. S1 — armed Stop-gate session-to-board binding (current behaviour)

**Entry points.**
- Installer: `scripts/install-shipyard-claude-hook.sh:34-35` copies `stop-gate.cjs` and its dependency bundle into `$CLAUDE_HOME/hooks/shipyard-stop-gate/`. It registers the hook at `:296` and removes it at `:139`. Checked with Grep "stop-gate" on the installer.
- Arming: `commands/deliver.md:1233` tells the session to run `node ${CLAUDE_PLUGIN_ROOT}/scripts/stop-gate-arm.cjs arm` (Grep "stop-gate-arm" in `commands/`). No other command, workflow or reference file calls it.
- The pre-push gate and the doctor also reference the stop-gate bundle (`scripts/shipyard-pre-push-gate.sh:13` and `scripts/shipyard-doctor.cjs`; Grep "stop-gate" in `scripts/`).

**Arming data (`stop-gate-arm.cjs`, 69 lines; `wc -l`).**
- The marker path is `<git-common-dir>/shipyard/stop-gate-armed/<session_id>.json`. Outside git it falls back to `<cwd>/.planning/graph/stop-gate-armed` (`:23-29`).
- `arm()` writes `{session_id, armed_at, cwd}` (`:32-34`).
- `isArmed()` compares only `marker.session_id === sessionId` (`:39-42`).
- The CLI accepts only `argv[0] === 'arm'` (`:54`). The exports are `markerPath, arm, isArmed, validSessionId` (`:48`).
- There is **no `disarm`, no board, run or worktree binding, and no expiry**.

**Selection (`stop-gate.cjs`, 738 lines).**
- `scopedMode` is set by a payload `run_id`, `SHIPYARD_RUN_ID`, `SHIPYARD_RUN_CONTROL=scoped` or `SHIPYARD_RUN_STORE_DIR` (`:490-494`).
- In scoped mode, `runWaker.readRun` selects the run's own worktree front and refuses a front whose `run_id` differs (`:496-514`). That path is owned by the run.
- Otherwise (`:515-525`), an unarmed session is allowed. An armed session collects `frontFileIn(dir)` for `[cwd, ...worktreesOf(cwd)]`.
- Then `candidates.sort(...)` by `generated_at`, and `candidates[0]` wins (`:530-531`).
- **The arming `cwd` stored in the marker is never read by the gate.** Nothing ties the chosen front to the arming session.
- The "wrong cwd" note (`:541-547`) names the winning board's directory, but it does not question whether that board belongs to this session.

**Tests.**
- `tests/unit/stop-gate.test.cjs` covers:
  - the stale-main regression (`:402` "a stale all-clear in the session cwd does not answer for a live sibling worktree"; `:749` "an armed session with a stale main checkout and a live worktree front blocks");
  - foreign **markers** (`:729`, `:741-743`);
  - unarmed sessions (`:716-726`);
  - in-flight host liveness (`:1150-1164`).
- A Grep for "two armed|both armed|foreign board|other session" in `tests/unit/*stop*` found only `:729` (a marker test). **There is no two-armed-session board test.**
- `tests/unit/stop-gate-arm.test.cjs` (`:38-154`) covers id validation, marker location and the deliver.md arm step. It has no disarm test.
- `node --test tests/unit/stop-gate.test.cjs tests/unit/stop-gate-arm.test.cjs` → `tests 2, pass 2, fail 0`. The node runner counts one test per file, so this proves only that the existing suites pass. It proves nothing about the missing case.

**Phase-43 overlap.**
- `stop-gate.cjs`, `stop-gate-arm.cjs` and `install-shipyard-claude-hook.sh` are in no phase-43 `files_modified` (§5 extraction).
- Caller text in `commands/deliver.md` is owned by the pending T-43-14.

**Conclusion.**
- The gap is present, and it is exactly the backlog cause.
- The core S1 fix can be delivered now.
- Any `deliver.md` change (disarm step, binding instructions) must either wait for T-43-14 or take a declared cross-phase dependency. Alternatively, the instructions can live in the arm helper's own usage text or in a reference file that no phase-43 PLAN owns.

**Primitives the S1 design can reuse, all observed and none a finished binding:**
- `runWaker.readRun` in scoped mode;
- the `run-controller.cjs` lease, owner epoch and fencing (SCOPING-NOTES);
- the `session-handoff.cjs` ownership lock (SCOPING-NOTES);
- the `front.run_id` field that the scoped branch already checks (`stop-gate.cjs:512`).

## 3. Per-package state on 0.68.0

"Present" means the gap reproduces in source at this revision. The evidence is the command-backed file:line reference. "Phase-43 blockers" lists pending (unmerged) phase-43 tickets whose `files_modified` share a file, taken from the extraction in §5.

| Pkg | State on 0.68.0 | Evidence (file:line; command) | Phase-43 blockers |
|---|---|---|---|
| S1 | present | §2 | T-43-14 only if `deliver.md` is edited |
| P1 planning writer lease | present: no planning-tree writer lease | Grep "planning.*(lease\|lock\|writer)" in scripts found only `lock.cjs:69` (the generic graph lock dir) and `gsd-sync.cjs:1291`. `capacity-lease.cjs` is a concurrency-slot store, not a writer lease. | none in scripts; T-43-11/12/15 if `decompose.md` changes |
| P2 judgment-role timeout recovery | present | `--resume-finalization` exists only in `codex-delivery-host.cjs:865-1192` and covers the executor only (Grep "resume-finalization" over the plugin → 1 file). `codex-decompose-host.cjs` has no recovery path (Grep "timeout\|wait" → `:115,234,253,381` only). `claude-delivery-host.cjs` has no "resume" match. | none (decompose hosts and `dispatch-boundary.cjs` are not in phase 43) |
| P3 bounded checker revision | present: the contract is one checker | `commands/decompose.md:434-443`: convergence goes inside the single checker receipt, "exactly three typed callbacks, exactly three verified receipts", and a second `gsd-plan-checker` is forbidden. | T-43-11, T-43-12, T-43-15 (`decompose.md`) |
| P4 Codex parent/wait | present: measurement only | `orchestration-overhead.cjs:25,31,157,420-441` separates `wait_poll` from `model_turn` counts. There is no decomposition `dispatch wait` treatment. | none for the host; T-43-14 if `deliver.md` |
| P5 INV reuse | present | Grep "reuse\|source_revision\|original receipt" in `workflows/investigation-research.mjs` → no match. Four-line enforcement: `codex-delivery-host.cjs:614,634`. | T-43-15 (`investigate.md`); logically after C3 |
| D1 sentinel duty scheduling | present | Duty is computed in `sentinel.cjs` (actions at `:677,719`; ACTIONABLE at `:812`). The model still runs the duty loop. | T-43-04, T-43-07, T-43-08, T-43-12, T-43-19 (`sentinel.cjs`), T-43-10 (`state-sync.cjs`), T-43-12 (`front.cjs`) |
| D2 instruction loading | present | `wc -l commands/deliver.md` → **3,017 lines**; SCOPING-NOTES recorded 2,913, so the file grew. | T-43-14 (`deliver.md`); also needs C2 |
| D3 repair grouping | present | `review-signature.cjs` exists; the repair loops live in `deliver.md` | T-43-14 |
| D4 drift-scan reuse | present | `drift-needed.cjs` bases on `delivery-state.base` or else `tickets.pr_base` (`:263`); no reuse identity found | none directly; logically after C1's identity primitive |
| D5 aggregate admission | present, with a primitive not listed in SCOPING-NOTES | `capacity-lease.cjs` defines `createCapacityCoordinator` (per-provider/account concurrency, default `max = 4`, TTL 30 min, local fallback marked `degraded`; `:39-69`). It is **not wired into any launch path**: Grep "createCapacityCoordinator" → only its own file, and `state-sync.cjs:73` only reads a snapshot. `run-controller.cjs:428,530,567` is a per-run retry budget. No run/phase aggregate ledger exists. | T-43-14, T-43-15 if `deliver-dispatch.cjs` is the reservation seam |
| D6 outer Codex coordination | present; no code owner | MODEL-ROUTING-RESEARCH; no source file | none; needs C2 + an approved experiment |
| R1 child base after parent merge (N1/N16/N20) | present | `validate-graph.cjs:600` `t.pr_base = primary_parent ? parent.branch : epic`. `deliver-dispatch.cjs:172` `prBase: row.pr_base`. `claude-delivery-host.cjs:515` refuses `entry.prBase !== row.pr_base`. Codex host `:814,953` resolves `snapshot.row.pr_base`. | T-43-06 (`ticket-worktree.sh`, `codex-delivery-host.cjs`), T-43-14/15 (`deliver-dispatch.cjs`), T-43-16/17 (both hosts), T-43-12 (`validate-graph.cjs`) |
| R2 squash survival (N19/N22/N7/N3) | present | `base-merge.cjs:52-56` and `:304` ("this script does not push"; "Push without --force"). Conflicts go to `real.push(p)` for the operator (`:258-271`). | T-43-06, T-43-13, T-43-17 (`base-merge.cjs`); sentinel tickets for N7 |
| R3 review only the next candidate | present | Grep "wait-turn\|merge_candidate" over scripts → 0. `sentinel.cjs:672-683` offers `arch-review` to every green draft and `:718-722` to every green non-draft. ADR-022 decides the contract. | T-43-04/07/08/12/19 (`sentinel.cjs`), T-43-12 (`front.cjs`) |
| R4 hosts run publish gates (N9/N24/N26/N13) | present | Grep "comment-policy\|publish-gate" in `delivery-commit-finalizer.cjs`, both delivery hosts and fix-round → no match | T-43-06/17 (finalizer); `comment-policy.cjs`, `publish-gate.cjs` and the pre-push gate are T-43-02/03, merged to the epic but **not to main** |
| R5 children die with host (N6) | present | `claude-runtime-host.cjs:694-726` spawns the child without `detached`/process group and has no signal handler (Grep "process.kill(-\|killpg" → none). `deliver-dispatch.cjs:238-251` spawns the host `detached:true` and `unref()`s it; the in-flight record has only the host `pid` (`:252-254`). | none for the runtime hosts; T-43-14/15 if the in-flight record in `deliver-dispatch.cjs` changes |
| R6 bounded invalid-verdict repair (N23) | present | `role-artifact.cjs:1118` fails `INVALID_RESULT` 'fresh drift verdict cannot contain moved findings'; no re-ask path was found | T-43-05 (epic, not main), T-43-06 (`role-artifact.cjs`) |
| R7 live-boundary verification | process/contract gap | plan and review instructions | T-43-12 (delivery-rules SKILL, `decompose.md`) |
| R8 Codex capture/relay (N27–N29) | present | `claude-role-host.cjs:26` `ARCH_REVIEW_PACKET_TOKENS = 60000`, `:708` | T-43-06 (`claude-role-host.cjs`) |
| R9 flaky concurrency tests | not re-measured (no 50-run loop was executed; it would be a spike) | — | none (test files not in phase 43) |
| R10 environment-only adjudication | present; no adjudication path | ENVIRONMENT-RECOVERY-RESEARCH; merge gate trailer semantics | T-43-16 (host verification), T-43-06, T-43-14 |
| R11 integrator scale (N30) | present | `claude-role-host.cjs:23` `DIFF_MAX_BYTES = 1 MiB`; `:421-422` `--unified=50` and reject 'role diff exceeds the bounded context packet' (the bound is not named; no generated-tree exclusion) | T-43-06 |
| R12 board state and Gate 2 (N42/N43/N50/N51) | N43 **partly fixed** by #316 (`0f7d9ba9`); the rest present | Explicit flag wins at `deliver-dispatch.cjs:74-80`; tracked worktree graph wins without a flag at `:81-83`; `deliver.md:1728-1735` documents the flag. The finalizer SCRATCH set is only pr-body/evidence (`delivery-commit-finalizer.cjs:11`), and out-of-scope refusals are at `:212,228,237,312`. `validate-graph.cjs` has no Context (Reads) check (Grep "Context \\(Reads\\)\|contextRead" → none). `claude-role-host.cjs:145-146` rejects any porcelain status (N50). | T-43-12 (`validate-graph.cjs`), T-43-14/15 (`deliver-dispatch.cjs`), T-43-06/17 (finalizer), T-43-06 (`role-artifact.cjs`, role host) |
| R13 host contracts (N44–N48) | present | N44: `claude-role-host.cjs:911-916` rejects on an exact `base` mismatch without naming the field. N45: `deliver-dispatch.cjs:172`. N46: `claude-role-host.cjs:442-444` rejects `isDraft`, while `sentinel.cjs:672` sends drafts to arch-review. N48: `usage-report.cjs:480` reads only `event_msg`/`token_count`, and Grep "turn\\.completed" finds none. | usage-report part: none. Rest: T-43-06, T-43-14, T-43-16/17 |
| R14 human preconditions before launch (N53) | present | Grep "human_action\|precondition" in `deliver-dispatch.cjs` → none | T-43-14, T-43-15 |
| R15 executor context budget (N49) | present (measurement gap) | intake N49 figures; no budget code found | T-43-14/15; after C3 |
| R16 concurrent session homes/hooks (N56) | partly mitigated | `shipyard-pre-push-gate.sh:21-52` uses a `git -C <target>` when named, else payload cwd, and its refusal text tells the operator to retry with `git -C`. The doctor warns "dogfood" (`shipyard-doctor.cjs:131,175`) but does not classify it as foreign. | T-43-02 (pre-push gate; epic, not main) |
| R17 executor payload durability (N58) | present | `codex-delivery-host.cjs:848` `NO_PUBLISHABLE_DELTA` when no worktree delta. Recovery (`:865-1177`) restores only the signed commit. | T-43-06, T-43-16, T-43-17 (codex/claude hosts, finalizer) |
| R18 merge-result attestation (N59) | present | MERGE-BASE-RESEARCH; `front.cjs`/`sentinel.cjs` `behind_by` path | T-43-12 (`front.cjs`), sentinel tickets, T-43-13 |
| C1–C4 | not started; wait by ADR-021 amendment | ADR-021 amendment 2026-09-28 | the whole epic (by decision) |

## 4. Other current-state facts that matter to the design

**Claude vs Codex asymmetry in recovery.** Phase-42 `--resume-finalization` is implemented only in `codex-delivery-host.cjs`, and no command document names it (Grep "resume-finalization" across `plugins/delivery-pipeline` → 1 file). Whether the Claude executor path has an equivalent under another name is an **unknown**. Next check: Grep `candidate` and `finaliz` in `claude-delivery-host.cjs` and `delivery-commit-finalizer.cjs`, and read the phase-42 PLAN.

**The draft conflict is internal.** The sentinel certifies before readying (`sentinel.cjs:672-683`, comment "Certify BEFORE readying"). The Claude role host refuses drafts (`claude-role-host.cjs:442`, and again at `:1054` and `:1100`). So N46 is two owners contradicting each other, not model behaviour. ADR-022 already decides that the host accepts drafts.

**Two authoritative bases disagree after a squash.**
- The decompose-time `tickets.pr_base` (`validate-graph.cjs:600`) is consumed by `deliver-dispatch.cjs:172`, `claude-delivery-host.cjs:346,515-518` and `codex-delivery-host.cjs:814,953`.
- `state-sync.cjs:139,588` and `sentinel.cjs:519` prefer the live `state.base` / `pr_base` read from GitHub.
- `deliver-dispatch.cjs:127` already prefers `s.pr_base || s.base || row.pr_base` in one place (the request build), while `:172` uses `row.pr_base`. That is two policies in one file. R1 and R13/N45 are one defect across these seams.

**The role-host clean-worktree check is strict and small-buffered.** `claude-role-host.cjs:145` reads `git status --porcelain=v1 --untracked-files=all` with a 256 KiB buffer and rejects any output. The shared scratch definition and the large-output status read belong to T-43-06 (ADR-020 bullet 8). N50 therefore overlaps T-43-06 directly; R12's scratch part must wait for it or build on it.

**Concurrency primitives.** Four already exist:
- `lock.cjs` (`withLock`, `writeAtomic`, used by `capacity-lease.cjs:6`);
- `dispatch-boundary.cjs` per-dispatch reservations;
- `run-controller.cjs` leases and retry budgets;
- `capacity-lease.cjs` slot leases (unwired).

A D5 ledger and a P1 writer lease can compose these instead of adding a fifth store. This is an observation, not a decision.

## 5. Phase-43 ownership extraction (evidence for "independent vs wait")

Command: a shell loop over `.planning/phases/43-*/43-*-PLAN.md` printing the `files_modified:` block. The loop's `tr -d ' -'` stripped hyphens from the printed names; the names below have them restored.

Merged state: `git log --first-parent --format='%h %ci %s' origin/main..origin/epic/43-target-project-delivery-at-scale`. It shows ticket merges for T-43-02 (#264), T-43-01 (#323), T-43-09 (#326), T-43-03 (#338) and T-43-05 (#328), plus plan-only PRs #322, #327, #333, #339 and #345. The local `.planning/graph/delivery-state.json` (a working-copy modification, possibly stale) shows T-43-06 and T-43-08 with `pr: null`, T-43-04 with PR 319 and T-43-07 with PR 266.

| Ticket | Status on epic | files_modified (plugin scripts unless noted) |
|---|---|---|
| T-43-01 | merged (epic only) | pipeline-config.cjs |
| T-43-02 | merged (epic only) | publish-gate.cjs, scripts/shipyard-pre-push-gate.sh |
| T-43-03 | merged (epic only) | comment-policy.cjs, publish-gate.cjs |
| T-43-04 | pending | run-reachability.cjs, sentinel.cjs |
| T-43-05 | merged (epic only) | role-artifact.cjs |
| T-43-06 | pending | conveyor-scratch.cjs, claude-role-host.cjs, delivery-commit-finalizer.cjs, codex-delivery-host.cjs, base-merge.cjs, ticket-worktree.sh, role-artifact.cjs |
| T-43-07 | pending | check-state.cjs, ci-wait.cjs, log-event.cjs, tests/unit/sentinel.test.cjs |
| T-43-08 | pending | reviewers.cjs, sentinel.cjs, log-event.cjs |
| T-43-09 | merged (epic only) | state-sync.cjs |
| T-43-10 | pending | pipeline-config.cjs, capabilities/…/gsd-sync-gate.cjs, gsd-sync.cjs, state-sync.cjs, adr-bootstrap.cjs |
| T-43-11 | pending | jira-export.cjs, commands/decompose.md |
| T-43-12 | pending | validate-graph.cjs, front.cjs, sentinel.cjs, pipeline-stats.cjs, commands/decompose.md, skills/delivery-rules/SKILL.md, .shipyard/generated/gsd-delivery-rules/SKILL.md |
| T-43-13 | pending | gate-trailer.cjs, base-merge.cjs |
| T-43-14 | pending (plan amendments only) | deliver-dispatch.cjs, commands/deliver.md |
| T-43-15 | pending | deliver-dispatch.cjs, commands/investigate.md, commands/decompose.md |
| T-43-16 | pending | host-verification.cjs, claude-delivery-host.cjs, codex-delivery-host.cjs, command-runner.cjs |
| T-43-17 | pending | conveyor-coverage.cjs, delivery-commit-finalizer.cjs, base-merge.cjs, claude-delivery-host.cjs, codex-delivery-host.cjs |
| T-43-18 | pending | repo-remedy.cjs, escalation-record.cjs, log-event.cjs, conveyor-coverage.cjs, references/ci-fix.md, references/pr-sentinel.md |
| T-43-19 | pending | sentinel.cjs, conveyor-coverage.cjs, log-event.cjs, references/pr-sentinel.md |

(Test files are omitted from this table except where one is the only shared file.)

**Files that are in no phase-43 PLAN and that phase-45 packages touch:**
- `stop-gate.cjs`, `stop-gate-arm.cjs`, `install-shipyard-claude-hook.sh`;
- `claude-runtime-host.cjs`, `codex-runtime-host.cjs`;
- `claude-decompose-host.cjs`, `codex-decompose-host.cjs`;
- `dispatch-boundary.cjs`, `run-controller.cjs`, `session-handoff.cjs`;
- `orchestration-overhead.cjs`, `usage-report.cjs`, `capacity-lease.cjs`;
- `drift-needed.cjs`, `drift-record.cjs`, `workflows/drift-gate.mjs`, `workflows/investigation-research.mjs`, `context-packet.cjs`.

Conservative reading of the contract rule (a file owned by an unmerged phase-43 ticket means wait):
- **Deliverable now:**
  - S1 (without `deliver.md`);
  - P1 and P2;
  - P4 (host and measurement side);
  - R5 (runtime-host side);
  - R9;
  - R13 (N48 `usage-report.cjs` only).
- **Wait for the epic:** P3, D1, D2, D3, R1, R2, R3, R4, R6, R7, R8, R10, R11, R12, R14, R17, R18, and C1–C4 (by decision).
- **Partial:**
  - P5, which also depends on C3;
  - D4, which needs C1's identity primitive;
  - D5, whose seam choice decides it;
  - R15 (C3, `deliver-dispatch`);
  - R16 (the pre-push gate is T-43-02 on the epic only).
- **D6** has no code owner yet and is gated by C2 and the experiment protocol.

The "merged (epic only)" tickets also block files on `main`, until the epic lands, for any package that would branch from `main`. Whether a phase-45 package may branch from the phase-43 epic instead is an **open question** for the constraints and risks lines.

## 6. Measured evidence available for prioritization (sources, not new measurements)

- **Phase 44 (Claude):**
  - Sonnet executors took ≈56% of child-run consumption, and the executor packet is ≈640 KB (≈160k tokens) with ≈430k re-read per turn (intake N49);
  - reviews took ≈11% (N54: 9 reviews for 8 PRs);
  - the orchestrator took ≈29% (the RESEARCH-CONTRACT question 4). This line did not recompute any of these.
- **Phase 43 (Codex):** outer coordination took 354.06M of 418.74M measured input tokens (84.6%), 99.1% of it cached. These are token counters, not quota debits (MODEL-ROUTING-RESEARCH table).
- **Replays and costs per finding:**
  - one lost executor run (N43);
  - two plus three extra executor launches (N53);
  - 2.73M input tokens for one Sol/xhigh review (N57);
  - 5.61M + 0.46M input tokens (N58);
  - one lost Opus/high drift launch (N23);
  - one CI and branch-update cycle per sibling merge (N59).

These are the inputs for question 4. The ordering itself belongs to the options, constraints and risks lines and the ADR. From the system-state side:
- Correctness fixes (S1, R12, R13, R17) remove whole lost launches or false blocks.
- The largest measured pools are the Codex outer coordination (D6, P4) and the Claude executor context (R15). Both need matched cohorts.

## 7. Known warts observed in passing

- The SCOPING-NOTES `deliver.md` line count (2,913) is stale: it is now 3,017.
- `capacity-lease.cjs` is present but not wired into any launch path. Its semantics (default max 4, local fallback marked `degraded`) are not documented in the phase-45 inputs.
- There are two base policies inside `deliver-dispatch.cjs` (`:127` vs `:172`).
- The integrator identity refusal (`claude-role-host.cjs:916`) does not say which field mismatched. That made N44 costly to diagnose.
- The diff-bound refusal (`claude-role-host.cjs:422`) does not name `DIFF_MAX_BYTES` or the measured size.

## 8. Assumptions, unknowns and next checks

- [ ] Installed 0.68.0 Claude hook and Codex cache equal source (unverified; contract forbids reading outside the worktree). Next: `shasum -a 256 ~/.claude/hooks/shipyard-stop-gate/stop-gate.cjs`, then `make doctor`. Owner: the operator.
- [ ] Remote phase-43 state is current. Next: `git fetch && git log --first-parent origin/main..origin/epic/43-target-project-delivery-at-scale`. Owner: the operator.
- [ ] Whether the Claude executor path has phase-42 recovery parity (§4). Next: read the phase-42 PLAN and `claude-delivery-host.cjs` finalization. Owner: the phase-42 plan author.
- [ ] Whether R9's three tests still flake on 0.68.0. Needs a 50-run loop, so recommend `/gsd-spike "50× CI-equivalent runs of the three concurrency suites on 0.68.0"`.
- [ ] Whether S1 can reuse `run-controller` fencing for a session binding without launching a run. Recommend `/gsd-spike "two armed Claude sessions in sibling worktrees against the installed hook with a candidate binding"` before planning. The reproduction procedure is in the backlog note.
- [ ] Whether phase-45 tickets may base on the phase-43 epic rather than `main` (§5). Owner: the maintainer, via the constraints line and the ADR.
