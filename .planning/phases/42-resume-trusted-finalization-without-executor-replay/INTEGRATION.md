# Phase 42 — Integration: resume trusted finalization without executor replay

- **Verdict:** `passed`
- **Blocking findings:** 0
- **Combined head:** `dfcfdce647a9fae9ea464fe5270cae79a60ba42f` (tree `dae53f5b0f1cd75ddfb96de358809f0663dac05d`), branch `epic/42-resume-trusted-finalization-without-executor-replay`
- **Base:** `origin/main` = `8c8e923245bb2709849a253219953f5c4b0f072e` (tree `6050f4fdc8eacd55396cc9cd65be6f05da678cdf`); merge-base `39c1a8f150bc8f3583bfc9409642786ba4dafeb6`
- **Ticket set digest:** `6082868f80e2de868b424ef847ca86c76ed1e070366b2a89caaa14e52a1f3287` (recomputed with `node -e` as `sha256(JSON.stringify(ticket_set))`; it matches the authenticated subject)
- **Date:** 2026-09-26

| Ticket | PR | PR head | Merged as |
|---|---|---|---|
| T-42-01 | #255 | `d8d2f937a1d0a80ebe1759e94a4acac2b15b852b` | squash `6cb4b51a` |
| T-42-02 | #270 | `4df51fd54c136e5bfeb9c83f9daa2a7037b998e1` | squash `dfcfdce6` |

## 0. Revision and delivery-identity checks

| Check | Command | Result |
|---|---|---|
| Combined head/tree and base/tree | `git rev-parse HEAD HEAD^{tree} origin/main origin/main^{tree}` | `dfcfdce6…/dae53f5b…`, `8c8e9232…/6050f4fd…` |
| Squash commits carry exactly the PR heads' code | `git diff 6cb4b51a d8d2f937 --stat -- . ':!.planning'` and `git diff dfcfdce6 4df51fd5 --stat -- . ':!.planning'` | both empty, so the PR head trees equal the merged trees outside `.planning/` |
| Phase code diff scope | `git diff --stat 39c1a8f1 HEAD -- . ':!.planning'` | 15 files and +2155/−75. Every file is in the declared `files_modified` of T-42-01 ∪ T-42-02 |
| Epic merges cleanly into current main | `git merge-tree --write-tree origin/main HEAD` | exit 0, tree `0edbde80de351e29644b4d08e187f0d974237ea8` |
| Main drift since merge-base | `git log --oneline 39c1a8f1..origin/main` | #268 (package freshness only on PRs into main), #269 (untrack archive). Neither touches phase files |
| Marketplace package fresh on epic head | `node scripts/package-shipyard-codex.cjs $TMPDIR/pkgout42b && diff -r plugins/shipyard $TMPDIR/pkgout42b` | no diff ("epic head package FRESH") |
| Marketplace package fresh on epic⊕main merge | `git archive 0edbde80 \| tar -x`, then `node scripts/package-shipyard-codex.cjs …` and `diff -r` | no diff. `GITHUB_BASE_REF=main node tests/unit/marketplace-install.test.cjs` exit 0 |

## 1. Verification commands (both tickets)

| Command | Result in this worktree |
|---|---|
| `node --check` on `codex-delivery-host.cjs`, `codex-runtime-host.cjs`, `command-runner.cjs`, `delivery-commit-finalizer.cjs` | all ok |
| `node tests/unit/command-runner.test.cjs` | exit 0. 6 pass and 2 skipped: `sandbox-exec: sandbox_apply: Operation not permitted` because this integrator runs inside a Seatbelt sandbox, and nested sandboxes are refused |
| `node tests/unit/codex-runtime-host.test.cjs` | 13/14 with the Claude session env set. The one failure is `claude-session-env: runtime claude conflicts with option.runtime (codex)`, an environment leak. With `env -u CLAUDECODE -u CLAUDE_CODE_* …` the result is **14 passed, 0 failed**, including `host-owned additional protected paths deny the finalization state root and cannot be overridden by a launch request` |
| `node tests/unit/codex-delivery-host.test.cjs` | **not runnable here**: gpg-agent cannot bind its unix socket (`error binding socket to '…/S.gpg-agent': Operation not permitted`). Key generation fails at module load before any test runs |
| `node tests/unit/delivery-commit-finalizer.test.cjs` | **not runnable here** for the same reason (`gpg: agent_genkey failed: No agent running`) |

**Unknown:** the gpg-backed suites and the real `bwrap` denial tests could not be run from this sandbox. GitHub checks for #255/#270 could not be read either: `gh` config read was denied and `api.github.com` egress was denied. The next check is the `test-fast` job on the epic → `main` PR. That job installs bubblewrap and sets `SHIPYARD_REQUIRE_OS_SANDBOX=1` (`.github/workflows/test.yml:57,65`). Under that variable a missing backend is a failure, not a skip (`tests/unit/command-runner.test.cjs:57`). `tests/unit/run.sh` runs every `tests/unit/*.test.cjs`, so both gpg suites run in that job too.

## 2. Cross-ticket coherence

**Seam T-42-01 → T-42-02: the finalization state root is denied to the executor. Coherent.**
- One derivation of the state root serves writer, reader and deny list. `hostStateRoot` (`codex-delivery-host.cjs:153`) is used by preflight (`:584`), recovery (`:641`), the resume CLI (`:904`) and the delivery-host constructor (`:762`). The constructor passes `additionalProtectedPaths: [stateRoot]` to the runtime host (`:777`).
- The HMAC key (`hostKey`, `:200`), candidates, verification records and finalization records all live under that root, so the executor profile denies all four.
- The directory is created (`privateDirectory` inside `hostStateRoot`) before the launcher is built. The realpath resolution in `normalizeProtectedPaths` (`codex-runtime-host.cjs:759`) therefore resolves the real path, and the test asserts the realpath form.
- Launch-time request fields cannot change the set. `hostProtectedPaths` is fixed at launcher construction (`codex-runtime-host.cjs:802-805`) and merged at `:836`. `createCodexRuntimeHost` forwards only the host option (`:1040`).
- The verification sandbox deny list still contains `prepared.stateRoot` (`codex-delivery-host.cjs:333`), which was unchanged by T-42-02 as its plan requires.

**Seam finalizer ↔ host: exact tree. Coherent.**
- `finalizeDeliveryCommit` refuses when `expectedTree` differs (`delivery-commit-finalizer.cjs:184-185`) and returns `tree`.
- `scopedTree` (`:233`) computes the candidate tree with the same private-index method.
- The host passes `expectedTree: candidate.scoped_tree` and rechecks parent/tree/signer in `verifySignedCommit`.

**No duplicated or contradictory solutions between the two tickets.** T-42-02 did the refactor its plan asked for ("one deny-path normalizer"): `signerProtectionPaths` and `signerPermissionProfileArgs` now share `normalizeProtectedPaths`. Non-blocking duplication that remains is listed as I2 and I3.

## 3. Emergent architecture check (ADRs)

- **ADR-014 (dispatch boundary / policy):** recovery authenticates the original receipt through `getVerifiedRecord` (`authenticatedReceipt`, `codex-delivery-host.cjs:237`). The policy hash check in recovery calls `resolveDispatch` without signals. I confirmed that the hash does not depend on the rung: `node -e` comparing base and `critical` executor resolutions gave `true`, with `gpt-6-luna max` vs `gpt-6-sol high`. Recovery resolves no model and launches nothing: `createFinalizationRecoveryHost` has no runtime host.
- **ADR-004 (positive evidence before mutation):** a candidate is admitted only after the verified receipt, a non-empty delta, a stable graph and passing sealed verification records (`:590-612`). Changed identity refuses with named invalidated checks and keeps the gates pending.
- **ADR-007 (connected mechanisms):** the recovery entry is reachable from the production CLI (`runCli` → `runResumeCli`). The refusal on finalization failure names the candidate and `--resume-finalization` (`:619`). The receipt store the recovery path reconstructs (`:661`) matches the CLI's default recorder location (`storageDirectory` with canonical worktree).
- **ADR-020 (accepted, phase 43):** it requires host verification to match a *project allow-list*. Phase 42 has no allow-list and admits only `node`/absolute executables. The allow-list is explicitly owned by T-43-01 (`43-01-PLAN.md:4`), so this is not a phase-42 violation. See I1 for the interaction.
- No layering or error-policy contradictions were found. New codes follow the existing `fail(code, message)` pattern and fall back to the default entry in `refusal-hints.cjs`, as many pre-existing codes do (for example `GRAPH_UNAVAILABLE`).

## 4. Acceptance sweep

### T-42-01
1. *Candidate survives each finalization failure, is authenticated against the original durable dispatch, remains visible with failed/pending gates, and downstream completion is never inferred from the signed commit.*
   **Satisfied in code.** `finalizedArtifact` admits the candidate before `finalizeCandidate` and wraps any failure in `candidateRefusal` carrying `candidate_id` and gates (`codex-delivery-host.cjs:612-621`). Artifacts always report `downstream: {ci: pending, review: pending}`. Tests `completed executor work persists a private authenticated candidate…` and `changed tree, graph, base, plan, verification or receipt refuses…` cover it. Their execution is **unknown here** (gpg).
2. *Real OS sandbox backends deny protected read, outside-temp write and network in CI.*
   **Wired.** The CI step installs bubblewrap, relaxes the AppArmor userns restriction, smoke-tests `bwrap`, and sets `SHIPYARD_REQUIRE_OS_SANDBOX=1` (`.github/workflows/test.yml:55-65`). The hostile fixture test throws, rather than skips, under that variable. Actual CI outcome: **unknown** (GitHub unreachable from this sandbox).
3. *Human checkpoint reviews candidate/tree/gate binding before recovery is authorized; changed identity refuses explicitly; the T-39-16 scenario separates executor, finalizer and revalidation.*
   Refusal matrix and executor launch count: satisfied in code and tests (`f.calls.length` stays 1, and 0 new launches via the CLI). **Human approval record: assumption.** The graph marks `human_checkpoint: true, preauthorized: false` for T-42-01 (`.planning/graph/tickets.json`), and the operator merged #255 (`delivery-log.jsonl:1414`). No in-repo approval artifact was found (`Grep T-42-0[12]` over `.planning/`). The next check is the #255 review/approval on GitHub. See I5.

### T-42-02
1. *The Codex executor permission profile denies the host state root that contains the finalization HMAC key.* **Satisfied.** `codex-delivery-host.cjs:777` → `codex-runtime-host.cjs:836`. Test `production runtime host receives the scoped prompt…` asserts `JSON.stringify(stateRoot(f)) + '="deny"'` in the filesystem arg. The runtime-host test passes 14/14 (see §1).
2. *Executor requests cannot alter the protected path set.* **Satisfied.** The set is fixed at construction. The runtime-host test passes `additionalProtectedPaths`/`protectedPaths` in launch options and asserts the attacker path is absent. It passed.

## 5. Findings (all non-blocking)

- **I1 — PLAN-derived verification refuses 19 of 47 open repository tickets on the Codex path (note, phase-level).**
  `planVerification` admits only `node` or absolute executables (`codex-delivery-host.cjs:271-287`). Running the same parse over every open graph ticket's PLAN (inline `node -e` simulation) gave: 28 accepted, **19 refused** with `VERIFICATION_SPEC_UNSUPPORTED`, all because of bare `bash …`. The refused set includes T-40-01, T-40-27, T-43-06 and others, several of which depend on T-42-01. This is the contract's intended fail-closed behavior ("Missing/unsupported specifications refuse with a named remedy"), and it happens before launch. The Claude runtime is unaffected. However, those tickets cannot be delivered through the Codex host until their plans use absolute executables or the T-43-01 verification allow-list maps `bash`.
  **Related unknown:** plan commands that need gpg-agent, such as `node tests/unit/codex-delivery-host.test.cjs`, may fail inside the macOS verification profile, which is `deny default` with no network/unix-socket allowance (`command-runner.cjs:142-147`). If so, pre-commit verification would refuse them. This is untested here.
- **I2 — Two deny lists for signer material (informational).** The executor profile uses `signerProtectionPaths` (`codex-runtime-host.cjs:763`), which reads `options.env` GNUPGHOME and an absolute `user.signingkey` path. The verification sandbox builds its own list from `process.env` only (`codex-delivery-host.cjs:333`). Signing is GPG-only (`signerFingerprint`), and verification denies network and outside-temp writes, so impact is low. A shared helper would keep the two in step.
- **I3 — Repeated defaults and normalizers (informational).** The default storage root literal appears three times (`codex-delivery-host.cjs:155,161,506`). `realOrResolved` (`command-runner.cjs:115`) duplicates `resolveProtectedPath`/`normalizeProtectedPaths` (`codex-runtime-host.cjs:759`).
- **I4 — Recovery trust inputs outside the executor deny set (informational, pre-existing).** The durable dispatch authority key sits at `<storageRoot>/<sha(run,worktree)>/.shipyard-dispatch-authority-*.key` (`dispatch-boundary.cjs:208-209`). Sibling worktrees' `finalization/<sha>` roots are also outside the set. Only this worktree's state root is denied (`codex-delivery-host.cjs:777`). The executor can read these files but cannot write host state under the `:workspace` profile. A forged recovery would also need a candidate sealed with the denied finalization key. Recommended follow-up: deny `<storageRoot>` as a whole in the executor profile.
- **I5 — Human checkpoint evidence not in repo (informational, T-42-01).** See §4 T-42-01.3.
- **I6 — Planning projections are stale (informational).** `delivery-state.json` still shows T-42-02 `pending`, and the VERIFICATION/UAT projections say "1/2 merged". The authenticated ticket set and commit `dfcfdce6` show #270 merged. These files are generated and the host refreshes them after this artifact.

## Verdict

`passed`. The two tickets meet at their intended seam: the state-root deny. Every acceptance criterion is implemented in merged code, the package mirror is fresh, and the epic merges cleanly into current `main`. Unknowns that remain for the epic → `main` PR's CI: the gpg-backed suites and the real `bwrap` denial run. The human checkpoint record for T-42-01 should be confirmed on #255.
