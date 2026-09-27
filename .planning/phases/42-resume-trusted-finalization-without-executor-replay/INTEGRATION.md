# Phase 42 — Integration: resume trusted finalization without executor replay

- **Verdict:** `passed`
- **Blocking findings:** 0
- **Combined head:** `36cd1d3d2e0df492c0e0d9a526b8cc536582f06f` (tree `86f1ceb0678680e11062c40b2b32d9a68bc05feb`), branch `epic/42-resume-trusted-finalization-without-executor-replay`
- **Base:** `origin/main` = `bb79b90a826cc1b20cbe4476ff1bdd70f45211a3` (tree `3e13d6654ff417217c2d56de22872b902fb10128`); merge-base `0e80b740128e83e772ec9de9805b525d8917975c`
- **Ticket set:** T-42-01 (#255), T-42-02 (#270), T-42-03 (#274)
- **Ticket-set digest:** `82e2fea090a4b5870f94c8f706aedef2169c31a5d90c43385a8702cdbf4688da`. I recomputed it with `node -e` as `sha256(JSON.stringify(ticket_set))` and it matches the authenticated subject.
- **Date:** 2026-09-26

This file replaces the earlier phase-42 integration record (head `dfcfdce6`, two tickets). It is fresh evidence for the three-ticket set. The earlier record is quoted only for context and is never cited as evidence.

## 0. Revision and delivery-identity checks

| Check | Command | Result |
|---|---|---|
| Head, tree, base | `git rev-parse HEAD HEAD^{tree} origin/main origin/main^{tree}` | `36cd1d3d…`, `86f1ceb0…`, `bb79b90a…`, `3e13d665…` (matches the packet) |
| Merge-base | `git merge-base HEAD origin/main` | `0e80b740…` |
| Epic-only commits | `git log --oneline origin/main..HEAD` | a single commit, `36cd1d3d (T-42-03): finalize scoped changes (#274)` |
| T-42-01 and T-42-02 already on main | `git log --oneline -12 origin/main` | `5d3b7328 Merge pull request #263` (epic to main) contains `6cb4b51a` (#255) and `dfcfdce6` (#270) |
| Each squash commit equals its PR head (excluding `.planning`) | `git diff --quiet <squash> <pr-head> -- . ':!.planning'` | `6cb4b51a`=`d8d2f937`: y. `dfcfdce6`=`4df51fd5`: y. `36cd1d3d`=`613ade3e`: y. All three squash commits are ancestors of HEAD (`git merge-base --is-ancestor`). |
| Main-only changes since the merge-base | `git diff --name-only 0e80b740 origin/main \| grep -vc '^\.planning/'` | `0`: main-only drift is planning-only (33 `.planning` files, phase 43) |
| Epic merges cleanly into main | `git merge-tree --write-tree origin/main HEAD` | exit 0, tree `24a7a318…` |
| Combined diff excluding `.planning` | `git diff --stat origin/main...HEAD -- . ':!.planning'` | 5 files, +62/−9: `codex-delivery-host.cjs` and its mirror, `plugin.json`, `package-build.json`, `tests/unit/codex-delivery-host.test.cjs` |

Because #263 already carried T-42-01 and T-42-02 onto main, the combined epic-vs-main code diff is exactly T-42-03. The cross-ticket judgement below still covers all three tickets as merged at HEAD.

## 1. Verification commands

| Command (from ticket PLANs) | Exit | Notes |
|---|---|---|
| `node --check plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` | 0 | T-42-01/02/03 |
| `node --check plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs` | 0 | T-42-01 |
| `node --check plugins/delivery-pipeline/scripts/codex-runtime-host.cjs` | 0 | T-42-02 (also checked `command-runner.cjs`: 0) |
| `node tests/unit/command-runner.test.cjs` | 0 | The 2 real-OS-backend denial tests **skipped**. Both skip sites (`command-runner.test.cjs:112,138`) apply only when `SHIPYARD_REQUIRE_OS_SANDBOX` is unset. I could not run nested `sandbox-exec` because the tool approval was refused in this session. |
| `node tests/unit/codex-runtime-host.test.cjs` | 1, then **0** | The first run failed 1/14 with `claude-session-env: runtime claude conflicts with option.runtime (codex)`. That is environmental: `runtime-context.cjs:214` detects the `CLAUDE_CODE_ENTRYPOINT` of this Claude session. Re-run with `env -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_PLUGIN_ROOT`: 14 passed, 0 failed. |
| `node tests/unit/codex-delivery-host.test.cjs` | 1 (**not run to completion**) | The fixture setup fails at `gpg --quick-generate-key` with `can't connect to the agent: IPC connect call failed`. A standalone probe (`GNUPGHOME=$d gpg --batch … --quick-generate-key`, exit 2, and `gpgconf --launch gpg-agent`, error) shows this sandbox refuses the gpg-agent Unix socket. This is environmental and unrelated to the diff. |
| `node tests/unit/delivery-commit-finalizer.test.cjs` | 1 (**not run to completion**) | Same gpg-agent refusal. |

**CI state: unknown.** `gh pr view` / `gh pr checks` for #255/#270/#274 fail with `open /Users/serhii/.config/gh/config.yml: operation not permitted`. **Next check:** `gh pr checks 274` and the `test` workflow on `epic/42-…` at `36cd1d3d`, both on a host where the GnuPG-backed suites and `SHIPYARD_REQUIRE_OS_SANDBOX=1` run. That CI step is wired at `.github/workflows/test.yml:54-66`: it installs bubblewrap, relaxes the AppArmor userns restriction, smoke-tests `bwrap`, then runs `make test-fast` with `SHIPYARD_REQUIRE_OS_SANDBOX: "1"`.

**Substitute evidence for T-42-03 without GnuPG.** I loaded the merged `PLAN_EXECUTABLE_ALLOWLIST`, `fail`, `resolveVerificationExecutable` and `planVerification` source text from HEAD into a `vm` context (`$TMPDIR/pv.cjs`) and ran fixtures through it:

```
OK     node --version          -> [[process.execPath, ["--version"]]]
OK     bash tests/smoke/x.sh   -> [["/bin/bash", ["tests/smoke/x.sh"]]]
OK     bash -n x.sh            -> [["/bin/bash", ["-n","x.sh"]]]
OK     make test-docs          -> [["/usr/bin/make", ["test-docs"]]]
REFUSE sh test.sh              -> VERIFICATION_SPEC_UNSUPPORTED "must start with node, bash, make or an absolute executable"
REFUSE npm test                -> VERIFICATION_SPEC_UNSUPPORTED (same)
REFUSE bash -c "true"          -> VERIFICATION_SPEC_UNSUPPORTED "plain argv without shell syntax … split it into separate bullets"
REFUSE node a.cjs && rm -rf x  -> VERIFICATION_SPEC_UNSUPPORTED (shell syntax)
OK     /usr/bin/true           -> [["/usr/bin/true", []]]
```

**Repository-wide sweep.** I ran the same harness over every tracked PLAN (`git ls-files '.planning/phases/*-PLAN.md'`): `{"ok":174,"refuse":30,"none":17}`. All 30 refusals are shell syntax, such as `grep … ;`, `! grep`, `{ echo …; }`, `&&`, and `<scratch-worktree>` placeholders. None of them is a bare-program refusal.

**Open-ticket sweep.** I took the 45 open tickets other than T-42-03 (`.planning/graph/tickets.json` joined with `delivery-state.json`, status not `merged`) and read their PLANs from `origin/main` (`git show origin/main:<plan>`): `{"ok":45,"refuse":0,"none":0}`. The earlier record's finding I1 (19 of 47 open tickets refused) is resolved.

**Package mirror.** `node scripts/package-shipyard-codex.cjs $TMPDIR/pkg/shipyard` followed by `diff -r $TMPDIR/pkg/shipyard plugins/shipyard` exits 0. `package-build.json` is identical. `cmp` shows the canonical and mirrored `codex-delivery-host.cjs`, `codex-runtime-host.cjs`, `command-runner.cjs` and `delivery-commit-finalizer.cjs` are byte-identical.

## 2. Cross-ticket coherence

- **T-42-01 → T-42-02 seam (state-root deny).** `createCodexDeliveryHost` computes `stateRoot = hostStateRoot(options, scope)` (`codex-delivery-host.cjs:780`) and passes `additionalProtectedPaths: [stateRoot]` to `createCodexRuntimeHost` (`:795`). The runtime host validates the value as a host-only array (`codex-runtime-host.cjs:802-805`), threads it through (`:1040`), and merges it with the signer paths in a single normalizer before building the profile (`:836`, `:855`; `signerPermissionProfileArgs` at `:778-782`). The same `prepared.stateRoot` is the verification sandbox's first denied path (`codex-delivery-host.cjs:351`). Tests assert it at `tests/unit/codex-delivery-host.test.cjs:308` and `tests/unit/codex-runtime-host.test.cjs:249`; the latter passed in the re-run above. **Connected, no dead seam.**
- **T-42-01 → T-42-03 seam (PLAN-pinned spec → sandboxed runner).** `planVerification` (`codex-delivery-host.cjs:289-311`) now calls one resolver, `resolveVerificationExecutable` (`:275-287`), backed by the frozen in-code `PLAN_EXECUTABLE_ALLOWLIST` (`:33-36`). The result still flows through `pinnedVerification` (`:313-337`), which requires an absolute executable, and then through `createVerificationRunner` (`command-runner.cjs:195-254`), which checks the absolute executable again (`:179`).
  - The Linux backend always ro-binds `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64` and `/etc` (`command-runner.cjs:102,158-162`), so `/bin/bash` and `/usr/bin/make` are present inside `bwrap`.
  - The macOS profile allows `file-read*` apart from the denied paths (`command-runner.cjs:147-148`).
  - The environment allowlist (`PATH`, `LANG`, `LC_ALL`, plus `HOME`/`TMPDIR` set to the temp directory, `command-runner.cjs:214-217`) keeps out `BASH_ENV` and `MAKEFLAGS`, so neither interpreter picks up host configuration.
  - **Coherent.** The earlier ticket's refusal/remedy style (`VERIFICATION_SPEC_UNSUPPORTED` plus a named remedy) is kept: the missing-executable message is at `:283-284` and the non-allowlisted message at `:305`.
- **Duplicated or contradictory helpers.** None new. T-42-03 replaced the single `node` special case rather than adding a second resolver (diff `-const executable = program === 'node' ? … : program;` → `resolveVerificationExecutable(program)`). The earlier record's I2/I3 remain: two deny-list builders, and `realOrResolved` (`command-runner.cjs:115`) alongside `normalizeProtectedPaths` in the runtime host. T-42-03 does not touch them and they are not re-raised as new findings.
- **Recovery never launches.** `createFinalizationRecoveryHost` (`codex-delivery-host.cjs:762-769`) exposes only `resumeFinalization` (`:653-760`). The only `launchAgent` call is at `:835`, inside `createCodexDeliveryHost`. The CLI routes `--resume-finalization` to `runResumeCli` (`:954`) with strict four-token parsing (`:889-892`).

## 3. Emergent architecture check (ADRs)

- **ADR-014 (dispatch boundary).** Recovery still authenticates the original receipt through `getVerifiedRecord` (`authenticatedReceipt`, `codex-delivery-host.cjs:241-259`). T-42-03 changes nothing in receipts or policy.
- **ADR-004 (positive evidence before mutation).** The finalizer still compares the private-index tree with the candidate's `expectedTree` (`codex-delivery-host.cjs:490` → `delivery-commit-finalizer.cjs:184-185`). T-42-03 widens only which PLAN bullets can produce evidence. It does not widen what counts as passing evidence.
- **ADR-007 (connected mechanisms).** The new resolver sits on the production path (`planVerification` ← `pinnedVerification` ← delivery prepare), which the T-42-03 test (`tests/unit/codex-delivery-host.test.cjs:753`) and the harness above both exercise.
- **ADR-020 (project allow-list for host verification, phase 43).** ADR-020 line 28 requires plan-declared commands to match a *project* allow-list. T-42-03's list only maps a program name to an absolute path, and it is not a project authority list. T-43-16 owns the project allow-list and already lists `T-42-03` in its `depends_on` (`git show origin/main:.planning/phases/43-target-project-delivery-at-scale/43-16-PLAN.md`, line 7). **Not a violation, and the ordering is correct.** See N1 for what T-43-16 should close.

## 4. Acceptance sweep

### T-42-01 (#255, squash `6cb4b51a`, already on main via #263)

1. *The candidate survives finalization failure, is authenticated against the original dispatch, and keeps failed/pending gates visible.* In code: `DOWNSTREAM_GATES` (`codex-delivery-host.cjs:29`), the sealed candidate write (`:449`), the refusal naming `--resume-finalization` (`:637`), and HMAC-verified reads (`readSealed`, `:220-239`). The test suite that asserts this could not run here because of gpg-agent (§1). **Status: satisfied in code; test run unknown here.** Next check: CI on #255/#263.
2. *Real OS sandbox backends deny the hostile fixture in CI.* The CI step is wired (`.github/workflows/test.yml:54-66`) and the test throws rather than skips under `SHIPYARD_REQUIRE_OS_SANDBOX=1` (`tests/unit/command-runner.test.cjs:57`). **The actual CI result is unknown** (gh unavailable).
3. *Human checkpoint.* I grepped `.planning/` for `T-42-01.*(approv|checkpoint)` and found no in-repo approval artifact. #255 was merged by the operator and shipped to main through #263. **Assumption**, recorded as I2. Next check: the #255 review/approval on GitHub.

### T-42-02 (#270, squash `dfcfdce6`, already on main via #263)

1. *The executor profile denies the host state root.* `codex-delivery-host.cjs:795`, `codex-runtime-host.cjs:836,855`. The test `codex-runtime-host.test.cjs:249` passed (14/14 re-run), plus the assertion at `codex-delivery-host.test.cjs:308`. **Satisfied.**
2. *Executor requests cannot alter the protected set.* Paths come only from host options (`codex-runtime-host.cjs:802-805`), and `requestValue` allows only `role`, `signals`, `context`, `dispatch_id` and `gsd_role` (`codex-delivery-host.cjs:55-60`). The same passing test name covers this: "…cannot be overridden by a launch request". **Satisfied.**

### T-42-03 (#274, squash `36cd1d3d`, the epic's only commit beyond main)

1. *`bash …` and `make …` bullets resolve to fixed absolute executables with unchanged argv.* The resolver is at `codex-delivery-host.cjs:33-36,275-287,303`. The harness output in §1 shows `/bin/bash` and `/usr/bin/make` with argv unchanged. The test is at `tests/unit/codex-delivery-host.test.cjs:753-768`, but its run was blocked by gpg here. **Satisfied (harness evidence).**
2. *Shell syntax and non-allowlisted bare programs still refuse with a named remedy.* `sh`, `npm`, `bash -c "true"` and `&&` all refuse with `VERIFICATION_SPEC_UNSUPPORTED` (harness, §1). The test's fixture list is extended at `tests/unit/codex-delivery-host.test.cjs:741-751`. **Satisfied.** A missing allowlisted binary refuses with the "install … or change the PLAN" remedy (`:283-284`). I did not execute that branch here because both binaries exist on this host.
3. *Done: open tickets using bash/make verification are no longer refused.* The open-ticket sweep gave 45/45 ok. **Satisfied.**
4. *Package mirror regenerated.* The regeneration diff is empty (§1). **Satisfied.**

## 5. Findings (all non-blocking)

- **N1 — `bash -c <word>` and `make -f <path>` pass the shape check (note, T-42-03).** The harness shows that `bash -c npm` resolves to `["/bin/bash",["-c","npm"]]`, and `make -f /etc/hosts` is also accepted (`$TMPDIR/pv2.cjs`). A PLAN can therefore reach PATH lookup of a non-allowlisted program through the interpreter. T-42-03's threat-model row "A PLAN names an arbitrary program through PATH lookup — mitigate" holds only for the first argv token. This is by design: bash and make are general interpreters, `bash script.sh` already runs arbitrary repository content, PLANs are checker/operator-approved and pinned before launch, and the OS sandbox (`command-runner.cjs:142-174`) is the real boundary: no network, read-only repository, denied state root and keys. Recommendation: when T-43-16 adds the ADR-020 project allow-list, match on the full argv (or at least forbid `-c`/`-f` forms) instead of on the program alone. It needs no phase-42 fix.
- **N2 — Resolver checks `isFile()` but not the exec bit (informational, T-42-03).** `codex-delivery-host.cjs:279` uses `fs.statSync(candidate).isFile()`. A non-executable `/bin/bash` would be pinned and then fail at spawn as a verification failure instead of the named `VERIFICATION_SPEC_UNSUPPORTED` remedy. `selectSandboxBackend` checks `(stat.mode & 0o111)` for the same kind of lookup (`command-runner.cjs:131`). The impact is cosmetic.
- **N3 — Runtime fit of bash/make targets under the read-only sandbox is not proven (informational, T-42-03).** Most open-ticket bullets are `bash -n …` / `make -n …` (read-only). Smoke scripts such as `tests/smoke/worktree-smoke.sh` and `make -C tests/fixtures/live-project test` must write only under the sandbox temp directory: the worktree is `--ro-bind` on Linux (`command-runner.cjs:158-162`), and on macOS writes outside `writable` are denied (`:149`). The macOS `/usr/bin/make` is an `xcrun` shim, which may also try to write caches. I could not check this here because nested `sandbox-exec` approval was denied. Next check: run one `bash tests/smoke/*.sh` and one `make -C …` spec through `createVerificationRunner` on a CI or operator host.
- **I2 — T-42-01 human-checkpoint evidence is not in the repo (informational, T-42-01).** See §4 T-42-01.3.
- **I3 — Stale planning projection (informational).** `.planning/graph/delivery-state.json` at HEAD still shows `T-42-03` `status: "pending"`, `pr: null`, while the authenticated ticket set and commit `36cd1d3d` show #274 merged. This is a generated projection that the host refreshes after this artifact.

## Verdict

**`passed`.** All three tickets' acceptance criteria are met in merged code, and the T-42-01 → T-42-02 and T-42-01 → T-42-03 seams connect. No duplicated or contradictory mechanisms were introduced, and nothing in the combination violates an ADR. The earlier finding I1 (bash/make refusals) is resolved (45/45 open PLANs accepted). The remaining unknowns are the GnuPG-backed test suites, real-backend denial tests and CI status, all of which this sandbox blocked. They are named in §1 with their next checks and are not code defects found in the combined diff.
