# Phase-40 delivery run — conveyor findings

**Source:** delivery of phase 40 (27 tickets, epic `epic/40-build-delivery-seams-and-clean-target-project-prs`) by Claude session 3e6507e1 on 2026-09-26/27, with Shipyard 0.64.0 installed. Board worktree `.wt-claude-shipyard/deliver43`, ticket worktrees under `.wt-claude-shipyard/.wt-deliver43/`. PRs #279–#310 and planning PRs #287, #295, #301, #302, #306 on `serhii-nochevnyi/shipyard`.

**Outcome:** 26 of 27 tickets merged into the epic. T-40-09 was still in execution when this report was written (see R8). Every finding below cost at least one extra launch, CI round or hand step. The IDs (N1–N28) are the run-log IDs; phase-45 work packages cite them.

Status legend: **open** = no owner yet; **covered** = owned by an existing phase-43/ADR-020 decision or a phase-40 ticket; **fixed** = already merged.

## Stacked delivery after a parent merges (open)

- **N1 — static `pr_base` against a merged parent.** `validate-graph.cjs:533` writes `pr_base = <primary parent's branch>` into `tickets.json`. Both `claude-delivery-host.cjs executorCommitInput` (`:497`, `prBase === row.pr_base`) and the Codex host (`snapshot.row.pr_base`) bind to it. After the parent squash-merges, `state-sync` moves the live base to the epic and the sentinel deletes the parent branch. `ticket-worktree.sh create <parent>` then refuses (`run-reachability MISSING_BASE_REF`), and the host refuses the epic base, so the child cannot be launched at all. Workaround used: `git worktree add` from the still-present local parent branch, or re-point the local parent branch at the epic.
- **N16 / N20 — validating an executor artifact after the parent branch is gone.** The artifact records `base` (the parent ref name) and `base_commit`, which is the live ref at finalization (N20: T-40-12 recorded T-40-13's post-fix head, not an ancestor of its own HEAD). Once the branch is deleted, `role-artifact validate` against the epic fails with `STALE_ARTIFACT`. Passing requires recreating the remote-tracking ref locally, then validate → merge the epic → gates → PR into the epic, all by hand.
- **N19 — add/add conflicts after a parent squash.** A child cut from the parent's pre-squash head gets add/add conflicts on the parent's new files when the epic is merged in, even though the epic's content equals the child's base. They were resolved by hand with `--ours` after checking blob identity.
- **N22 — real conflicts have no conveyor owner.** `base-merge.cjs` and fix-round with `needsBaseMerge` refuse (`trusted base reconciliation failed … conflicts remain`) and hand the conflict to the operator. Example: T-40-27 against T-40-18 in `delivery-commit-finalizer.cjs`, plus a semantic test-fixture interaction. A stacked child also keeps its parent's superseded implementation after the parent is reworked (T-40-27 carried T-40-18's replaced `ticketTitle` design).
- **N3 — `base-merge.cjs` does not push.** It merges locally; the sentinel's refusal text says to push, and every caller has to.
- **N7 — inherited red CI.** A stacked child's CI cannot be green while its parent's is red. `duty` still offers ci-fix on the child, which would repair the parent's failure outside the child's scope.

## Merge-order waste (covered in part)

- **N8 — every merge moves every open PR's base.** Each sibling merge, and each epic refresh from `main`, costs N−1 base-merges and CI reruns. Without an own-diff verdict carry it also costs N−1 arch-reviews (covered by ADR-020 own-diff carry, phase 43).
- **N15 — the guard reviews every green PR at once.** `duty` lists arch-review for all green PRs, but only one can merge before the base moves. Three conform verdicts on one base tree were thrown away twice (T-40-19/06/21, then T-40-16/17/21). The guard should review only the PR it will merge next, in priority order. This is open and independent of the carry.

## Gates the hosts skip (open)

- **N9 / N24 — comment policy is not run before a push or finalization.** The fix-round host pushed a commit that failed CI's publish gate (#282, #305); the fixers wrote "publish-gate and comment gate not run: host-owned". An executor's finalized commit (T-40-15) failed comment policy and was caught only by the pre-push hook at publish, costing another executor round. The fix-round result also said `pushed:false` while the commit was already on the PR head.
- **N26 — the pre-push hook only sees Claude tool calls.** A `git push` inside a script is not intercepted. An operator script that chained gates with `&& echo` under `set -e` published a PR that failed comment policy (#310).
- **N13 — comment-scanner false positive.** A regex literal with an escaped slash (`/^(epic|ticket)\//`) is read as a `//` comment (hotfix #293 rewrote the code to avoid it).
- **N23 — an invalid drift verdict has no repair path.** The drift-check model returned `fresh` with moved findings. The host correctly rejected it (`fresh drift verdict cannot contain moved findings`), but the whole Opus/high launch was lost and had to be relaunched by hand.

## Sandbox and host verification (covered)

- **N21 — no gpg in the executor sandbox.** T-40-14 and T-40-11 stopped `blocked` because `codex-delivery-host.test.cjs` crashes at module load (gpg keygen, `EPERM` on the agent socket). `claude-delivery-host.test.cjs` loses 4 cases the same way. Run on the host, the same suites were 34/0 and 94/0. This is ADR-020 host-side verification (phase 43, F7) reproduced on Shipyard itself. Executors also report tests that pass only with `SHIPYARD_GRAPH_DIR` unset or `CLAUDECODE`/`CLAUDE_CODE_*` removed, because the env leaks into tests.
- **N2 — board graph against sandboxed plan reads.** With `SHIPYARD_GRAPH_DIR=<board>` the host requires `planPath` under the board, which the sandboxed agent cannot read (`no-contract`). This is exactly D-43/T-40-28, now merged into the epic; re-verify once installed.

## Plan-promise gaps that review did not catch (open)

- **N11 / N18 / N25 — the T-40-07 capture tool never ran live.** Its plan promised `--json-schema` per variant; the code ignored `--variant`, and arch-review returned conform. A live run exposed more defects:
  - `os.tmpdir()` symlinks failed the SessionStart `cwd` check (`/var` → `/private/var`);
  - the `fable` alias failed the routed-model check;
  - it read `result.transcript`, but the host returns `applicationEvidence.transcript`;
  - the Codex path ran in a non-git directory, which Codex refuses.

  None of its tests launches a real CLI.
- **N10 — T-40-06's CI trailer check never ran against a base-merged branch.** It walked commits a base-merge brought in and crashed on a pin file absent in the parent. Neither the executor nor arch-review exercised that case.
- **N17 — T-40-18 missed a cross-host contract.** Its finalizer required a `ticketTitle` that no delivery host passes, so target-project delivery would always fail closed, and its fixtures reclassified the host tests as target projects (13 failures). It was replanned in #295.

## Codex 0.157.1 capture and relay (open)

- **N27 — encrypted inter-agent relay.** Codex 0.157.1 encrypts the parent's `spawn_agent` `arguments.message` (`gAAAA…`). The child receives its task as `response_item` `agent_message` (author `/root`, recipient `/root/<task_name>`, encrypted content), not as a plaintext user message. T-40-09's new relay check reads `TASK_FILE`/`TASK_SHA256` from the child's first user message, so it refused every real run, although the child did read the file: its first exec is `shasum -a 256 <TASK_FILE> && cat <TASK_FILE>`. The T-40-09 executor was re-dispatched with this evidence to rebuild the proof on signals the stream actually has.
- **N28 — capture scrubbing and setup.** The scrubber does not know 0.157.1's `session_meta.creator_user_id` (`user-…`) and leaked it into fixtures; it was replaced by hand with `<USER-ID>`. A capture also needs a separate `CODEX_HOME` that contains the GSD agent TOMLs and `gsd-core/../scripts`, and the `--dogfood-root` installer copies neither.

- **N29 — arch-review cannot review real captures.** The arch-review context-packet bound (`ARCH_REVIEW_PACKET_TOKENS = 60000`, `claude-role-host.cjs:25`) counts captured fixture bodies in the PR diff and has no measured-window route. T-40-09's 199 KB of 0.157.1 captures pushed its packet to 81 785 tokens (`CONTEXT_PACKET_OVER_BOUND`). The captures had to be trimmed: long embedded instruction strings were replaced by `<ELIDED:sha256=…:bytes=…>`.

## Runtime hygiene (open)

- **N6 — a killed host leaves its child running.** Killing `claude-delivery-host.cjs` does not stop its `claude` child. The orphan kept writing into the T-40-04 worktree while a relaunched executor ran; the second executor reported "an unexplained concurrent writer".
- **N5 / N7 / N14 — three concurrency tests flake on CI runners:**
  - `codex-decompose-host.test.cjs` "production gsd-planner/gsd-plan-checker reaches its native child" (`run-controller: the run lease has expired`) failed four times, including on `main` after #287;
  - `session-handoff.test.cjs` "two successor processes race through acknowledgement";
  - `dispatch-boundary.test.cjs` "file-backed reservation is atomic across concurrent Node processes".

  Each cost a manual rerun.
- **N4 — Shipyard squash subjects.** Squash subjects on the epic read `(T-40-03): finalize scoped changes (#279)` (the finalizer's subject) instead of the PR title.

## Fixed during the run

- **N12:** the marketplace package freshness check failed stacked PRs whose base is `ticket/*`. Hotfix #293 exempts `epic/*` and `ticket/*` bases; `main` and local runs still enforce it.
- **Plan defects replanned on `main`:**
  - #287 — T-40-19 (files-contract test), T-40-08 (capture tool scope), T-40-21 (marketplace installs);
  - #295 — T-40-18 (graph title, host fixtures);
  - #301 — T-40-22 (merge refusal already existed);
  - #302 — T-40-11 (generator test pins the research sandbox);
  - #306 — T-40-09 (two usage tests stay in `migrating`).

## Found at the epic → main step (open)

- **N30 — the integrator cannot judge a large phase.** `claude-role-host.cjs` caps the integrator's combined diff at `DIFF_MAX_BYTES = 1 MiB` and builds it with `--unified=50`. Phase 40's epic diff was 2.46 MB with that context, or 1.2 MB raw including the generated `plugins/shipyard/` copy (323 KB). The host failed with `git preflight failed: <raw diff…>`, which prints the diff instead of naming the bound. The only remedy it offers, splitting the phase, is impossible after delivery. Needed: exclude generated trees (`plugins/shipyard/`, captured fixtures) from the integrator diff, name the bound in the refusal, and integrate per ticket set (per wave or per workstream) once a phase exceeds one packet.
- **N31 — macOS-only smoke failure.** `tests/smoke/claude-hook-smoke.sh` (T-40-21) compared the dogfood launch line with the unresolved `mktemp` path, but the installer prints the realpath (`/var` → `/private/var`). CI on Linux passed; `make test-fast` failed locally on the epic. Fixed on the epic (765b02c1).
- **N32 — the release gate had never run.** `tests/live/live-round.sh` (T-40-23) was merged without one live run; its fixer wrote "Live round not run: needs CLIs". The first real run for 0.67.0 found:
  - `mv .git-info-exclude .git/info/exclude` fails because `git init` does not create `.git/info` here;
  - the fixture project has no `.planning/graph`, and every host refuses `canonical graph directory is unavailable`;
  - the script reads `tickets.json` straight after decompose, but only `validate-graph` (Gate 2) writes it.

  These were fixed on the 0.67.0 release branch. A release gate needs its own live run in the PR that adds it.
- **N33 — Claude GSD agents after the marketplace switch.** `claude-decompose-host.cjs trustedAgent` and `claude-runtime-host.cjs gsdAgentDefinition` read GSD agents only from `<config>/agents/<role>.md`. Once GSD is installed only as the `gsd-core@gsd-core` marketplace plugin, the legacy copies are gone (this happened during the session), and Claude decomposition refuses `ENOENT … ~/.claude/agents/gsd-planner.md`. `/shipyard:decompose` on Claude was therefore broken on `main` on such machines. Fixed for 0.67.0 by `gsd-agent-root.cjs`: the legacy copy wins, otherwise the installed plugin's `installPath` from `installed_plugins.json` is used, trusted only inside `<config>/plugins/cache`.
- **N34 — Claude decomposition cannot find single-digit phases.** `claude-decompose-host.cjs phaseDirectory` matched `${phase}-`, but GSD zero-pads phase directories (`01-…`). Every target project with a phase below 10 was refused `PHASE_DIRECTORY_MISSING` after the planner ran; Shipyard's own phases are all two-digit, so this never surfaced. The Codex host already compared the numeric prefix. Fixed for 0.67.0 the same way, with a regression test.
- **N35 — `deliver-dispatch.cjs` could not launch a Claude executor.** T-40-15 was delivered and reviewed, but its live path was never run. `buildClaudeExecutorRequest` sent no `model`/`effort`, and the host refused ("Claude workflow dispatch requires explicit model and effort"). It also passed `row.phase` raw into the host scope, and a GSD plan whose frontmatter says `phase: 01-greeting-formats` failed `run-contract: phase must be a positive integer`; the Codex path's `Number()` gave `NaN`. Fixed for 0.67.0: the selection is resolved through `pipeline-config.resolveDispatch`, and phase numbers come from the numeric prefix. Regression tests cover both.
- **N36 — the live round skipped the deliver protocol.**
  - It launched the executor from the project checkout instead of a ticket worktree, with no `state-sync`, epic ensure or `ticket-worktree create`.
  - It read the executor result as an object, but `wait` returns an array; it took the PR body from a field that does not exist (the body is in `prBodyPath`); it never pushed the ticket branch; and it opened the PR against `main` instead of the epic.
  - The fixture repository has no CI, so the PR could never leave `waiting: ci` for the sentinel.

  All of these were fixed for 0.67.0, and the fixture gained a `make test` workflow.
- **N37 — Gate 2 does not check the plan shape that later hosts require.** `claude-role-host.cjs parsePlan` needs `## Acceptance criteria` and `## Verification commands` Markdown sections, and arch-review/sentinel refuse a plan without them ("has no acceptance criteria"). The GSD planner's own format writes `<acceptance_criteria>` tags inside `<task>` blocks, and `validate-graph` accepts such plans. So a phase can pass Gate 2 and only fail at the first arch-review, after execution. The live round's minimal planner prompt hit exactly this; the plan shape now travels only in `decompose.md` prose. Gate 2 should refuse a plan whose required sections are missing.
- **N38 — the Claude pr-sentinel guard cannot work inside its sandbox.** A real `claude-role-host` pr-sentinel round (0.67.0 live round) reported that the sandbox blocked every `$SHIPYARD_ROOT/scripts/*.cjs` read (`state-sync`, `sentinel.cjs duty`, `log-event`, `dispatch-record`, `reviewers`, `role-artifact`). It also found `gh` without an auth token and `git fetch` to origin failing, so it returned `awaiting-human` with `head_tree: "unknown"`. The result was then refused for:
  - identity: the packet carried no round `head`/`head_tree`;
  - schema: `performed`/`refused` items were untyped, so the model wrote `"duty": "all (ci-fix/…)"` and a `blocking_count` unequal to its refused list.

  During phase-40 delivery the operator served every sentinel duty by hand, so the guard had never run for real. For 0.67.0 the packet carries `head`/`head_tree`, the schema types each duty (enum, status, reason), and the instructions require `blocking_count` to equal the refused count. The live round uses the existing read-only sentinel smoke (`SHIPYARD_CLAUDE_ROLE_SMOKE=read-only`), which proves the launch boundary and receipt. A working guard needs the sandbox to allow reading the plugin scripts plus GitHub and network access, or the duties moved to the trusted host (phase-45 D1, ADR-020 host-side execution).
- **N39 — the live round had more gaps than its fixture showed.**
  - The live-receipt validator (`live-receipt.cjs receiptFailures`) demanded a model rung on every stage, including the rung-less `push` stage, so no receipt could ever pass. It now checks rungs only on the model stages.
  - Codex investigation research seals its lines without inline receipt fields, so the round now reads rungs from the host's receipt records by `dispatch_id`.
  - `codex-delivery-host` crashed after a successful research run while completing its run controller (`result.receipt.dispatch_id` on a line array or a line-failure object). The crash hid the result.
  - Run from inside a Claude Code session, the Codex host refuses `AMBIGUOUS_RUNTIME` ("claude-session-env: runtime claude conflicts with option.runtime (codex)"), so the operator must clear `CLAUDECODE`/`CLAUDE_CODE_*` for Codex rounds.
- **N40 — the plan contract omits the Codex verification allowlist.** Codex host verification (phase 42) accepts only `node`, `bash`, `make` or an absolute executable as a PLAN verification command. The delivery-rules skill and `decompose.md` never tell the planner this, and Gate 2 does not check it. The 0.67.0 Codex live round lost an executor launch to a planner-written `git diff --check …` (`VERIFICATION_SPEC_UNSUPPORTED`), which a Claude run happens not to write. The live-round prompt now states the rule; the delivery rules and Gate 2 should state and check it too.
- **N41 — provenance calls a clean release checkout dogfood.** `make install-shipyard-claude-hook` run from a clean checkout at tag `v0.67.0` records `install_kind: dogfood`, and `make doctor` warns about it, because `host-provenance.cjs` classifies any git checkout as dogfood. A clean checkout whose HEAD is the tagged release should record `release`.

## Found during phase-44 delivery (open)

- **N42 — Gate 2 accepts Context (Reads) references that launch refuses.** `deliver-dispatch.cjs` (`contextReadPaths`) treats every backticked `name.ext` token in a plan's Context (Reads) section as a required context-packet reference that must resolve from the worktree root. `validate-graph.cjs` never checks this. All seven phase-44 plans passed Gate 2 with files named by basename (`usage-report.cjs`) and with non-file tokens (`settings.json`, `$CODEX_HOME/...`, `report.observations`), and `launch` refused T-44-01 and T-44-07 with `required reference does not exist`. The plans were amended in #325.
- **N43 — in the Shipyard repository, ticket worktrees receive board writes.** A Shipyard ticket worktree tracks `.planning/graph/tickets.json` at HEAD, so `resolveLaunchGraphDir` uses the worktree's own graph and ignores `--graph-dir`. The run then writes `delivery-front.json`, `dispatches.json`, `provenance/` and `runs/` into the ticket worktree. The trusted commit finalizer counts them as out-of-scope changes and refuses the commit (`out-of-scope paths: .planning/graph/delivery-front.json, …`) after the executor has done the work. T-44-07 lost one executor run this way. The workaround is `git update-index --skip-worktree` on the tracked board files in each ticket worktree plus `info/exclude` for `provenance/` and `runs/`.
- **N44 — the integrator result `base` is ambiguous.** The phase-44 integrator judged the phase `passed` with 0 blocking findings, but `claude-role-host` refused 3 of 4 results with "integrator result identity differs from the authenticated phase snapshot". The model wrote the default-branch commit into `base`; the host expects the ref (`origin/main`). Phase 44 was merged without a receipted verdict (#342).
- **N45 — a child of a squash-merged parent cannot finalize.** `deliver-dispatch` takes `prBase` from the decompose-time `pr_base`, while state-sync already moved `state[T].base` to the epic. The commit finalizer then refuses with "expectedBase is not an ancestor of HEAD", and a request that uses the state base is refused as "executor branch or base contradicts the canonical ticket graph". T-44-04 and T-44-08 needed manual ancestry of the dead parent ref.
- **N46 — the Claude arch-review host refuses a draft PR.** "live PR identity differs from the ticket worktree" means `isDraft`, while deliver.md undrafts only after a `conform` verdict.
- **N47 — the live round ignored `CODEX_HOME` in its doctor precondition.** A foreign dogfood cache in `~/.codex` failed the round. Fixed in 0.68.0 (#347).
- **N48 — `usage-report` returns zero observations for a Codex host-stream transcript** that contains `turn.completed.usage` (phase-45 model-routing research), while the native session counter path works.
- **N49 — the executor starts from a very large context.** The Claude executor request carries a context packet of about 640 KB (≈160k tokens), and each turn re-reads about 430k. Phase-44 executors ran 17–93 turns, 35–50M cache-read tokens per ticket; Sonnet executors took about 56% of the phase's child-run consumption.
- **N50 — role scratch files block the next host call.** `.shipyard-evidence.md`, `.shipyard-pr-body.md`, `.shipyard-role-artifact.json`, `.shipyard-repair-evidence.md` and `.shipyard-role-artifacts/` stay in the ticket worktree after a role returns. The next role host then refuses with "worktree has local changes before role dispatch", so every ticket cycle needed a manual move.
- **N51 — the comment-policy amend makes the executor artifact unsealable.** deliver.md says to amend the commit after `comment-policy clean` and to repeat artifact validation, but the amended HEAD makes the artifact `STALE_ARTIFACT`. A reseal then refuses with "artifact manifest already exists with different bytes" until the manifest is moved aside (T-44-03).
- **N52 — a sandboxed fixer cannot read the CI log.** `gh` is blocked in the fixer sandbox, and Linux-only failures do not reproduce on macOS. Two examples: `/bin/sh -c` does not exec its last command (T-44-04), and GNU `stat -f` reports filesystem status and exits 0 (T-44-05). The operator had to pass the failed-log excerpt through `attemptHistory`.
- **N53 — a human precondition is found only after a paid launch.** T-44-04 needed an operator capture before RED. Two executor runs stopped on it, and the capture was then written to the parent's `TMPDIR` instead of the sandbox `TMPDIR` (`/tmp/claude-502`). Three extra Opus executor launches followed.
- **N54 — sibling merges re-judge every sibling.** Each sibling squash-merge moves the epic, so every remaining sibling needs a base merge, a fresh CI run and a full arch-review. Phase 44 ran 9 architecture reviews for 8 PRs, about 11% of child consumption.
- **N55 — an armed session cannot release its Stop gate.** `stop-gate-arm.cjs` has `arm` but no `disarm`. A session that reached its fixpoint kept being blocked by a foreign board (S1) until its marker was moved by hand.
- **N56 — runtime homes and hooks are shared across concurrent sessions.** A dogfood Codex install by the phase-43 session in `~/.codex` failed the doctor and the release precondition for another session. The pre-push hook also checks the cwd worktree, so a foreign session's dirty checkout blocked the v0.68.0 tag push until it was pushed from the release worktree.

Note: #316 (in 0.68.0) lets an explicit `--graph-dir` take precedence over a stale ticket worktree graph. Recheck N43 on 0.68.0 before planning R12.

## Found during phase-43 delivery (open)

- **N57 — a reviewer sandbox failure becomes a blocking verdict.** T-43-03 (PR #338) had green exact-head CI, but its Sol/xhigh architecture review reported `violation` because both test commands hit `EPERM` creating temporary files in the reviewer's read-only sandbox, before any assertion ran. The immutable violation cannot be carried into conform. No supported adjudication exists for environment-only findings, so resolving it costs another full review. See [environment/recovery research](../../../phases/45-close-residual-pipeline-efficiency-gaps/ENVIRONMENT-RECOVERY-RESEARCH.md).
- **N58 — a signed executor commit loses its publication payload.** T-43-14's Luna/max executor finalized a signed commit but did not leave the PR body, evidence and bounded result. A second turn produced them, but the host refused `NO_PUBLISHABLE_DELTA`, and those files cannot be rebound to the first dispatch. Phase-42 recovery restores commit metadata only, and the worktree lifecycle cannot re-cut the unmerged canonical branch. See the same research.
- **N59 — a clean PR must re-push and re-run CI after every epic move.** T-43-10 (PR #346) was `CLEAN` and green, but its `pull_request` CI had tested the merge with an older epic head (`bf89a93f`). After T-43-03 moved the epic, `front.cjs`/`sentinel.cjs` still required `base-merge.cjs`, a new push and fresh CI, even without a conflict. That changes the ticket head and can restart review. An old-run rerun keeps the original `GITHUB_SHA` and cannot certify the new base. See [merge-base research](../../../phases/45-close-residual-pipeline-efficiency-gaps/MERGE-BASE-RESEARCH.md).

