# Phase 45 integration judgment

**Verdict: `needs-fix`.** This judgment is for combined commit `e6d1393c173d18d7085a25651e41cd1849d8360b` (tree `f92ca2753f88481ade184660f3ebc551c4c794be`) against `origin/main` (tree `a0c9f0753af878e2d63eab025cb1a432fee6fe39`). There are **five blocking findings**: four source defects covered by two non-overlapping fix tickets, and one explicit installed-hook checkpoint. Release publication remains gated by final-tree live evidence and remote checks. The full production parent portion of REQ-193 belongs to Phase 47; Phase 45 is judged against its approved first-pass contract.

## Scope and command evidence

The following are the exact commands used in this worktree. `T` in the acceptance table refers to the targeted commands listed here; their per-command stdout/stderr was captured in `/private/tmp/phase45-<id>.log` by the command runner. Exit 0 means the stated suite passed, not that untested acceptance criteria passed.

| ID | Exact command | Result / relevant path or output |
| --- | --- | --- |
| I1 | `git rev-parse HEAD 'HEAD^{tree}' origin/main 'origin/main^{tree}'` | exit 0; `e6d1393c173d18d7085a25651e41cd1849d8360b`, `f92ca2753f88481ade184660f3ebc551c4c794be`, `4592df4f0f22cb840f742aed02b54b689521f535`, `a0c9f0753af878e2d63eab025cb1a432fee6fe39` |
| I2 | `shasum -a 256 .shipyard-integration45-diff.patch` | exit 0; `da888f64b8000872416b126a9ff70aa8cc62a7ac6013c28eaa35ee623bf449ef`, matching the supplied combined patch identity |
| I3 | `git diff --name-only origin/main...HEAD -- . ':(exclude).planning'` | exit 0; 58 source, test, documentation, manifest and generated-package paths; excludes `.planning/` |
| I4 | `git log --first-parent --oneline origin/main..HEAD` | exit 0; lists all fifteen `T-45-*` merges, including terminal `T-45-15` at `e6d1393c`, plus base-refresh/documentation merges |
| I5 | `rg --files .planning/architecture` | exit 0; ADR-001 through ADR-017 (except no ADR-018 file), ADR-019 through ADR-023 and the ADR-011/013/014 companions |
| I6 | `rg -n -e '^# ADR-' -e '^# Data model' -e '^# Interfaces' -e '^# Rollout' -e '^[-] \*\*Status:' -e '^status:' .planning/architecture` | exit 0; confirms accepted ADR-014/019/020/021/022/023 and superseded ADR-012 status; corpus paths listed by I5 |
| I7 | `git show --stat --oneline 731a340bac40f605fe52f51f9e836f62a2430ccb` | exit 0; T-45-15 source head changes the two canonical manifests, `docs/releases/v0.70.0.md`, and generated `plugins/shipyard/**` only |
| I8 | `GITHUB_BASE_REF=main node tests/unit/marketplace-install.test.cjs` | exit 0, `marketplace installation tests passed`; checked-in `plugins/shipyard/**` matches fresh package under main-base comparison |
| I9 | `node tests/unit/release-gate.test.cjs` | exit 0, 10 passed; fixture gate contract only, not a live final-tree receipt |
| I10 | `node scripts/shipyard-doctor.cjs` | exit 0; source-version `0.70.0` ok, installed Claude bundle warns `0.69.0` versus source `0.70.0`; Codex bundle manifest skipped |
| I11 | `shasum -a 256 plugins/delivery-pipeline/scripts/stop-gate.cjs /Users/serhii/.claude/hooks/shipyard-stop-gate/stop-gate.cjs` | exit 0; source `80f885bc84f219741fee7323363491556c8a3a68a542fcd88315d52cb4e26243`, installed `a41aea770ee9a812fb41e3098f20907eca9413ac7ab17d9d147e23de5f926c06` |
| I12 | `git tag -l v0.70.0` | exit 0, no local tag |
| I13 | `git ls-remote --tags origin refs/tags/v0.70.0` | exit 128, `Could not resolve hostname github.com`; remote tag availability is **unknown** |
| I14 | `gh release view v0.70.0 --repo serhii-nochevnyi/shipyard --json tagName` | exit 1, `error connecting to api.github.com`; remote Release availability is **unknown** |
| I15 | `/bin/test -f docs/releases/v0.70.0.md` and `/bin/test -s docs/releases/v0.70.0.md` | both exit 0; source release notes exist and are nonempty |
| I16 | `bash -n scripts/install-shipyard-codex.sh` | exit 0; shell syntax only |
| I17 | `rg -n 'REQ-193\|Phase 47\|production parent\|wait_poll' .planning/ROADMAP.md .planning/phases/45-close-residual-pipeline-efficiency-gaps/CONTEXT.md` | exit 0; `.planning/ROADMAP.md:911,953-965` reserves full production caller acceptance to Phase 47 |
| I18 | `make test-fast` | interrupted, exit 130 after ambient `SHIPYARD_GRAPH_DIR` and GPG-agent failures; **no full-suite pass is claimed**. Next check: `env -u SHIPYARD_GRAPH_DIR -u SHIPYARD_CODEX_CAPABILITIES_FILE make test-fast` in a host with the required signer agent. |

Targeted verification runner invoked each exact command below with `SHIPYARD_GRAPH_DIR` unset and captured its exit status. `codex-runtime-host` was rerun with the additional ambient capability-file variable unset because `tests/unit/codex-runtime-host.test.cjs:482-486` expects missing explicit capability evidence; `plugins/delivery-pipeline/scripts/codex-runtime-host.cjs:166-182` otherwise consumes `SHIPYARD_CODEX_CAPABILITIES_FILE` from the host environment. The first run failed 15 passed/1 failed with `runtime_missing` versus expected `capability_evidence_missing`; the clean-env rerun passed 16/0.

| T | Exact command | Exit |
| --- | --- | --- |
| 01a | `env -u SHIPYARD_GRAPH_DIR node tests/unit/stop-gate.test.cjs` | 0 |
| 01b | `env -u SHIPYARD_GRAPH_DIR node tests/unit/stop-gate-arm.test.cjs` | 0 |
| 01c | `env -u SHIPYARD_GRAPH_DIR node tests/unit/stop-gate-installed.test.cjs` | 0 |
| 02a | `env -u SHIPYARD_GRAPH_DIR node --test tests/unit/host-provenance.test.cjs` | 0 |
| 02b | `env -u SHIPYARD_GRAPH_DIR bash tests/smoke/claude-hook-smoke.sh` | 0 |
| 03a | `env -u SHIPYARD_GRAPH_DIR node --test tests/unit/marketplace-installer.test.cjs` | 0 |
| 03b | `env -u SHIPYARD_GRAPH_DIR bash tests/smoke/docs-smoke.sh` | 0 |
| 04 | `env -u SHIPYARD_GRAPH_DIR node tests/unit/codex-decompose-host.test.cjs` | 0 |
| 05a | `env -u SHIPYARD_GRAPH_DIR node tests/unit/session-handoff.test.cjs` | 0 |
| 05b | `env -u SHIPYARD_GRAPH_DIR node tests/unit/dispatch-boundary.test.cjs` | 0 |
| 06 | `env -u SHIPYARD_GRAPH_DIR node --test tests/unit/usage-report.test.cjs` | 0 |
| 07 | `env -u SHIPYARD_GRAPH_DIR node --test tests/unit/planning-writer-lease.test.cjs` | 0 |
| 08a | `env -u SHIPYARD_GRAPH_DIR node --test tests/unit/claude-decompose-host.test.cjs` | 0 |
| 09-first | `env -u SHIPYARD_GRAPH_DIR node --test tests/unit/codex-runtime-host.test.cjs` | 1; ambient capability file affected one probe assertion |
| 09-clean | `env -u SHIPYARD_GRAPH_DIR -u SHIPYARD_CODEX_CAPABILITIES_FILE node --test tests/unit/codex-runtime-host.test.cjs` | 0; 16 passed |
| 10 | `env -u SHIPYARD_GRAPH_DIR node tests/unit/claude-runtime-host.test.cjs` | 0 |
| 11a | `env -u SHIPYARD_GRAPH_DIR node tests/unit/decompose-dispatch-wait-contract.test.cjs` | 0 |
| 11b | `env -u SHIPYARD_GRAPH_DIR node tests/unit/orchestration-overhead.test.cjs` | 0 |
| 12 | `env -u SHIPYARD_GRAPH_DIR node --test tests/unit/capacity-lease.test.cjs` | 0 |
| 13 | `env -u SHIPYARD_GRAPH_DIR node tests/unit/workflows-args.test.cjs` | 0 |
| 14 | `env -u SHIPYARD_GRAPH_DIR node tests/unit/boundary-fixtures.test.cjs` | 0 |

## Complete merged ticket set

The coordinator supplied this authoritative GitHub admission set and digest; I4 independently confirms fifteen matching phase merge subjects in the combined Git history. Current live GitHub status is **unknown** because I13/I14 could not connect; the coordinator's supplied successful admission governs merged-ticket input, as instructed. The array below preserves the supplied order and fields exactly. Its digest is `831b14f0995fc50d9188697cd3217449563decd9490bef105abf0a7442705f37`.

The following exact digest check exited 0 and printed `15 831b14f0995fc50d9188697cd3217449563decd9490bef105abf0a7442705f37`:

```bash
node - <<'NODE'
const fs=require('fs'), crypto=require('crypto'); const s=fs.readFileSync('.planning/phases/45-close-residual-pipeline-efficiency-gaps/INTEGRATION.md','utf8'); const m=s.match(/```json\n(\[.*\])\n```/); if(!m)process.exit(2); const v=JSON.parse(m[1]); console.log(v.length,crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'));
NODE
```

```json
[{"id":"T-45-01","pr":361,"head":"bf2201a9ed1a627a3ac5186cd9b1260651e9f58c","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-01-armed-stop-gate-binds-the-realpath-of-it"},{"id":"T-45-02","pr":359,"head":"a2ea9ac06f4aeade233eab4b355a030d0238893e","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-02-doctor-classifies-another-checkout-s-dog"},{"id":"T-45-03","pr":367,"head":"eec5378087f6bd2f98a954228ddba8226a40f990","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-03-dogfood-installs-default-to-a-dedicated"},{"id":"T-45-04","pr":360,"head":"cc7e89c21301ac07498256fff659a79131e00f9d","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-04-codex-decompose-host-run-lease-uses-an-i"},{"id":"T-45-05","pr":363,"head":"9c29785f35695510de5263736dc102f2a5100eb0","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-05-session-handoff-successor-race-and-dispa"},{"id":"T-45-06","pr":362,"head":"abe9a2ec343fe073c402673fe03a8f596419a220","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-06-usage-report-counts-codex-host-stream-tu"},{"id":"T-45-07","pr":357,"head":"20abb62066ce11b2963581aa1948dacbd1f9812b","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-07-planning-tree-writer-lease-with-owner-ba"},{"id":"T-45-08","pr":366,"head":"e8736f288d5de09ab1ae4373562491441bd54f2a","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-08-both-decompose-hosts-hold-the-planning-w"},{"id":"T-45-09","pr":369,"head":"3ed637eab38aafda937e0e535715b92300746b96","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-09-codex-decompose-host-recovers-a-complete"},{"id":"T-45-10","pr":383,"head":"c236ddce0649be854922a2bdebee4d080d546a05","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-10-claude-decompose-host-recovers-a-complet"},{"id":"T-45-11","pr":382,"head":"beffc6966701310b3132071ccdac0d9423591c14","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-11-codex-decomposition-runs-detached-so-the"},{"id":"T-45-12","pr":364,"head":"2cae6b1bad17ffb642e40ad56c64b2c04c831e3c","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-12-advisory-run-phase-aggregate-admission-l"},{"id":"T-45-13","pr":368,"head":"01da58bf72a125c558d7ef9cf54c0d2442673935","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-13-drift-gate-re-asks-a-self-contradictory"},{"id":"T-45-14","pr":365,"head":"b24e654113f922abb9e038bf79c3130101d02fb3","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-14-capture-scrubber-replaces-codex-account"},{"id":"T-45-15","pr":390,"head":"731a340bac40f605fe52f51f9e836f62a2430ccb","base":"epic/45-close-residual-pipeline-efficiency-gaps","branch":"ticket/T-45-15-prepare-the-0-70-0-release-from-the-full"}]
```

## Cross-ticket and ADR judgment

The combined diff (I2/I3) joins T-45-07's lease with T-45-08's two hosts and T-45-09/10's recovery; the defects in F1, F2 and F4 are at those seams. T-45-02's provenance reaches T-45-03's installer, but the home is selected after `installCodexMarketplace` mutates the marketplace (F3). T-45-15's generated package passes I8 against this exact source but necessarily includes those defects; rebuild it after the fixes.

The complete corpus inventory is I5/I6. For the changed concerns, ADR-004, ADR-013 with its data/interface/rollout companions, ADR-014 with its data/interface/rollout companions, ADR-015/016/017/019/020/021/022/023, and ADR-011 with its backlog/evaluation/rollout companions were compared to the combined paths in I3 and the source inspections named in F1–F4. ADR-005/012 are superseded for model selection by ADR-014 (`I6`; `.planning/architecture/ADR-012-task-level-model-ladder.md:3`); no model ladder alteration appears in I3. No new interaction is identified in the untouched ADR-001–003/006–010 concerns by I3; this is a bounded diff observation, not proof of every historical invariant. F1/F2 conflict with ADR-004/015/023's authenticated recovery and stopped-process evidence; F4 conflicts with ADR-013/014/015/023's pre-seal fence and receipt sequencing; F3 conflicts with ADR-017/023's isolated dogfood state. ADR-019/021/022/023 require inconclusive efficiency reporting without matched cohorts; I17 and `docs/releases/v0.70.0.md:15` leave full REQ-193 open, as required.

## Acceptance sweep

Each row applies the corresponding `45-XX-PLAN.md` in this directory. “Observed” covers only commands and source lines named here. “Unknown” is retained where the final-tree run or operator action has not been checked.

| Ticket | Acceptance observation at combined tree |
| --- | --- |
| T-45-01 | **Partial.** Bound/unbound two-session, stale-main, disarm, invalid-board and installed-copy fixtures passed T-01a/b/c (exit 0); bound-only selection is at `plugins/delivery-pipeline/scripts/stop-gate.cjs:523-548`. Actual installed hook checkpoint fails I11 (different SHA-256) and I10 warns installed 0.69.0; F5. Legacy-bound operator confirmation remains **unknown**; next check is F5's operator sequence. |
| T-45-02 | **Observed pass for scoped fixtures.** Provenance round-trip/foreign doctor smoke passed T-02a/b (exit 0); own/foreign classification is in `plugins/delivery-pipeline/scripts/host-provenance.cjs:32-75` and `scripts/shipyard-doctor.cjs` (I10). Release mismatch refusal remains covered by T-02b. |
| T-45-03 | **Fail.** Unit/docs suites T-03a/b and shell syntax I16 pass, but `scripts/install-shipyard-marketplace.cjs:176-180` calls `installCodexMarketplace` before `setupCodexHost`; `:65-89` mutates the marketplace first, and `:150-165` chooses or refuses the dogfood home only later. Default install therefore can write to the ambient shared Codex home before dedicated selection; F3. Source-root writer is present at `plugins/delivery-pipeline/scripts/host-provenance.cjs:71-75`. |
| T-45-04 | **Partial.** Injected-clock host suite passed T-04 (exit 0); `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:1226-1279` carries the injected clock/heartbeat. Fifty consecutive final-tree runs, including CPU load, were **not checked**; F7 gives next commands. |
| T-45-05 | **Partial.** Handoff and reservation suites passed T-05a/b (exit 0); the 50-run acceptance and guard-removal checks were **not independently replayed** on this tree. F7 gives next commands. |
| T-45-06 | **Observed pass for scoped fixture.** T-06 exit 0 covers captured host-stream per-turn sum, mixed-schema warning, untimed rows and missing-thread warning in `plugins/delivery-pipeline/scripts/usage-report.cjs` (changed in I3). No live usage report is claimed. |
| T-45-07 | **Partial.** Lease unit suite T-07 exit 0 covers owner/epoch/snapshot cases; `plugins/delivery-pipeline/scripts/planning-writer-lease.cjs:225-227` can treat a non-`ESRCH` probe error as dead (helper at `:43-47`), violating the live-owner recovery precondition; F2. |
| T-45-08 | **Fail.** Both host suites T-04/T-08a passed, but Claude fences only decomposition (`plugins/delivery-pipeline/scripts/claude-decompose-host.cjs:390-417`), Codex checker returns directly (`plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:827-836`), and Codex post-acquire setup occurs before the `try/finally` (`:1236-1281`). F4. |
| T-45-09 | **Fail.** Boundary and host suites T-05b/T-04 pass; native runtime suite passes only with clean capability environment T-09-clean. Codex recovery accepts missing `completed` and reconstructs completion/digests at recovery (`plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:1080-1141`), and permits missing original PID (`:662-681`, `:1089-1092`). F1/F2. Its test at `tests/unit/codex-decompose-host.test.cjs:1171` explicitly expects the forbidden pre-checkpoint success. |
| T-45-10 | **Partial.** Claude host/runtime suites T-08a/T-10 pass and require a completed record at `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs:501-517`; a positive PID is required there. But `pidAlive` at `:250-253` treats probe errors other than `EPERM` as stopped, while contract requires unknown liveness to refuse; F2. The human receipt comparison from this ticket is **unknown** in this integration; next check is operator comparison of one recovered and one live receipt after F2. |
| T-45-11 | **Observed first-pass only.** Detached wait and actor-report suites T-11a/b plus host T-04 exit 0. Child row is written at `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:981-1014`; the production parent caller is absent from this phase by `.planning/ROADMAP.md:911,953-965` (I17). No full REQ-193 or savings claim is made; F8. |
| T-45-12 | **Observed pass for advisory contract.** T-12 exit 0 covers reservation concurrency, verification/checkpoint admission, shadow verdict, quota unknown and snapshot compatibility in `plugins/delivery-pipeline/scripts/capacity-lease.cjs` (I3). No production admission enforcement is claimed. |
| T-45-13 | **Observed pass for scoped workflow.** T-13 exit 0 covers exact contradictory-verdict repair, one retry, second refusal and other-error propagation in `plugins/delivery-pipeline/workflows/drift-gate.mjs` (I3). |
| T-45-14 | **Observed pass for captured-fixture contract.** T-14 exit 0 covers account scrub, placeholder scan and initialized Git scratch in `scripts/capture-boundary-fixtures.cjs`; I3 shows committed fixtures unchanged. |
| T-45-15 | **Partial.** I7 shows scoped source head; I8 passes generated-package freshness, I10 says source manifests 0.70.0, I15 confirms nonempty notes, I9 passes fixture release gate. `docs/releases/v0.70.0.md:15` explicitly defers full REQ-193. Final-tree real Claude/Codex live receipts were **not run**; I13/I14 cannot establish current remote availability. F6. After F1–F4, package freshness must be rerun on repaired source. |

## Findings and required actions

### F1 — blocking `fix-ticket` — Codex recovery synthesizes a missing completion checkpoint (T-45-09)

**Evidence command:** `nl -ba plugins/delivery-pipeline/scripts/codex-decompose-host.cjs | sed -n '1065,1150p'` (exit 0). `:1085-1087` accepts absent `completed`; `:1112-1125` constructs one from native evidence; `:1139-1141` calculates artifact digests from current files. `rg -n 'recover rebuilds a completed dispatch when the host dies before its completion callback' tests/unit/codex-decompose-host.test.cjs` (exit 0) points to `tests/unit/codex-decompose-host.test.cjs:1171`, a test asserting the opposite of the contract. The T-45-09 plan requires `RECOVERY_EVIDENCE_INCOMPLETE` before the durable completion checkpoint, even if current files match. Current bytes cannot prove completion-time bytes. ADR-004 and ADR-023 retain positive evidence before a receipt mutation.

**Fix ticket (covers F1, F2 and F4 so shared host paths have one owner):** title “Close judgment recovery and writer-fence gaps”; scope “Remove the recovery-time `completed` and digest construction. Require the original launch-bound completion record, declared changed set and artifact hashes before native verification or receipt recording. Make pre-checkpoint crash refuse with `RECOVERY_EVIDENCE_INCOMPLETE` and zero receipts; retain successful post-checkpoint recovery and test same-path tampering. Require a positive original Codex PID before native work or refuse; classify only `ESRCH` as stopped in both runtime recovery paths and writer-lease recovery, while preserving expired-lease semantics. Move fence and foreign-edit checks for researcher, planner and checker before boundary record/seal, including recovery; assert zero durable receipts on takeover or foreign edit. Put every Codex post-acquire operation inside `finally`. Rebuild the generated Codex package after source fixes and rerun main-base freshness.” Files: `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs`, `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs`, `plugins/delivery-pipeline/scripts/planning-writer-lease.cjs`, `tests/unit/codex-decompose-host.test.cjs`, `tests/unit/claude-decompose-host.test.cjs`, `tests/unit/planning-writer-lease.test.cjs`, `plugins/shipyard/**`.

### F2 — blocking `violation` — missing or unknown process liveness can authorize recovery (T-45-07/09/10)

**Evidence commands:** `nl -ba plugins/delivery-pipeline/scripts/codex-decompose-host.cjs | sed -n '530,550p;650,690p;1065,1150p'` (exit 0) shows `:665` allows null PID and `:1089-1092` only probes safe integers. `nl -ba plugins/delivery-pipeline/scripts/codex-runtime-host.cjs | sed -n '1180,1235p'` (exit 0) shows the session-start PID callback is driven by stdout, while stdin is sent at `:1215-1218`, so the original PID is not durably required before child work starts. `nl -ba plugins/delivery-pipeline/scripts/claude-decompose-host.cjs | sed -n '250,253p;498,517p'` (exit 0) shows its positive-PID check but `pidAlive` treats non-`EPERM` errors as false. `nl -ba plugins/delivery-pipeline/scripts/planning-writer-lease.cjs | sed -n '43,48p;216,230p'` (exit 0) shows the same fail-open probe in dead-owner recovery. Only `ESRCH` proves a process absent; any other probe error is unknown. The plans require absent/invalid PID and unknown liveness to refuse without a receipt.

**Action:** covered by F1's fix ticket; it owns all affected host, lease and test paths. Add missing, invalid, live and injected probe-error cases with zero receipts.

### F3 — blocking `fix-ticket` — dogfood marketplace writes before target-home selection (T-45-03)

**Evidence command:** `nl -ba scripts/install-shipyard-marketplace.cjs | sed -n '60,100p;130,190p'` (exit 0). `:177` invokes `installCodexMarketplace` before `:179` invokes `setupCodexHost`; marketplace add/plugin add at `:65-89` use default process environment. Dedicated `CODEX_HOME` and the explicit shared-home refusal appear only at `:150-165`. The unit suite T-03a tests the helper but does not make that main-sequence mutation safe. This violates the T-45-03 “writes only under dedicated home” and shared-home refusal criteria and ADR-017/023 dogfood isolation.

**Fix ticket:** title “Select and validate the Codex dogfood home before marketplace mutation”; scope “Determine source kind and dedicated/explicit target before any `codex plugin marketplace` read or write; pass that home to all plugin commands and bootstrap. Refuse an explicitly shared default home before mutation. Add a main-path test with stubbed Codex commands proving distinct checkouts never touch the shared home and that refusal has zero side effects.” Files: `scripts/install-shipyard-marketplace.cjs`, `tests/unit/marketplace-installer.test.cjs`.

### F4 — blocking `violation` — writer fence is late or missing on completed-role receipts (T-45-08)

**Evidence commands:** `nl -ba plugins/delivery-pipeline/scripts/claude-decompose-host.cjs | sed -n '21,25p;385,425p'` (exit 0) shows research maps to `research`, but `:404-415` fences only decomposition after `createClaudeWorkflowDispatch` returns at `:390`. `nl -ba plugins/delivery-pipeline/scripts/codex-decompose-host.cjs | sed -n '145,192p;810,845p;1220,1320p'` (exit 0) shows the checker returns `output` without `assertNoForeignEdit` (`:836`), research/planner fence only in later seal helpers, and Codex acquire at `:1236` precedes the `try/finally` at `:1281`. `nl -ba plugins/delivery-pipeline/scripts/dispatch-boundary.cjs | sed -n '2300,2325p;2360,2390p;2420,2440p'` (exit 0) shows the boundary calls `recorderFinalize` at `:2428` before returning the output to those host checks. The no-index assertions in `tests/unit/codex-decompose-host.test.cjs:831-850` and `tests/unit/claude-decompose-host.test.cjs:345-359` do not prove zero receipts. T-45-08 requires pre-seal fencing, no receipt over a foreign edit and release on every failure.

**Action:** covered by F1's fix ticket; it owns all affected host and test paths. Preserve the existing authenticated success and refusal contracts.

### F5 — blocking `human-question` — installed Stop hook checkpoint has not passed (T-45-01)

**Question:** After source fixes and a final `0.70.0` hook build, will the operator run `bash scripts/install-shipyard-claude-hook.sh` outside this sandbox, confirm `shasum -a 256 ~/.claude/hooks/shipyard-stop-gate/stop-gate.cjs plugins/delivery-pipeline/scripts/stop-gate.cjs` gives matching hashes, run `node scripts/shipyard-doctor.cjs`, and confirm the legacy bound before activation? I11 proves the current hashes differ; I10 reports installed 0.69.0. This is the explicit human checkpoint in `45-01-PLAN.md`, not a judgment substitution. Until the sequence is command-backed, its acceptance is unknown/failed.

### F6 — nonblocking `informational` — final-tree release gates and current remote collision status remain open (T-45-15)

I8/I9/I10/I15 check package, fixture gate, source versions and notes. I13/I14 failed on network lookup, so current remote tag/Release availability is **unknown**; I12 only checks the local tag. No command here ran `bash tests/live/live-round.sh --runtime claude`, `bash tests/live/live-round.sh --runtime codex`, or `node plugins/delivery-pipeline/scripts/live-receipt.cjs check --version 0.70.0 --tree-sha "$(git rev-parse 'HEAD^{tree}')"` for a final repaired tree. Next check after source fixes and generated package rebuild: rerun I8, full CI, both installed-host live rounds, exact-tree receipt check, `git ls-remote --tags origin refs/tags/v0.70.0`, and `gh release view v0.70.0 --repo serhii-nochevnyi/shipyard --json tagName` before tagging/publication. `docs/releases/v0.70.0.md:15` makes no completed-Release claim.

### F7 — nonblocking `informational` — final-tree repetition evidence not independently replayed (T-45-04/05)

T-04 and T-05a/b each passed once. Their plans require 50 consecutive runs (T-45-04 also with a CPU-burning sibling) and non-atomic guard-removal variants. This integration did not execute those loops or mutation variants, so stability beyond the single run is **unknown**. Next checks: `for i in $(seq 50); do env -u SHIPYARD_GRAPH_DIR node tests/unit/codex-decompose-host.test.cjs >/dev/null || exit 1; done`, and corresponding loops for `session-handoff.test.cjs` and `dispatch-boundary.test.cjs`, with the documented CPU sibling for Codex. The guard-removal claim requires an explicit failing variant run or reviewed ticket evidence.

### F8 — nonblocking `informational` — REQ-193 is only first-pass here (T-45-11/15)

I17 locates `.planning/ROADMAP.md:911,953-965`, which retains full REQ-193 for Phase 47. `rg -n 'recordChildModelEvidence|recordParentWait|wait_poll|actor.*parent|actor.*child' plugins/delivery-pipeline/scripts/codex-decompose-host.cjs plugins/delivery-pipeline/scripts/orchestration-overhead.cjs plugins/delivery-pipeline/commands/decompose.md` (exit 0) finds the child's production row at `codex-decompose-host.cjs:981-1014` and the callable parent helper at `orchestration-overhead.cjs:354-355`, but no production caller in `decompose.md`. T-11a/b prove the first-pass wait contract and explicit actor-row reporting; they cannot prove production parent wait attribution. Next check belongs to Phase 47: run a real detached decomposition through its production caller and verify both actor rows joined to the verified receipt.

### F9 — nonblocking `informational` — recovery receipt human comparisons are not in this integration evidence (T-45-09/10)

T-45-09 and T-45-10 each require a human comparison of a recovered receipt with a live counterpart before merge. I4 confirms their merge subjects at `a109ce22` and `aa93fee2`, and T-04/T-08a exercise their unit fixtures, but neither command is a human field-by-field comparison record. The coordinator supplied merged admission, so this is an **unknown observation**, not a claim that the pre-merge checkpoint failed. Next check: inspect the PR #369 and #383 approval/receipt comparison records with `gh pr view 369 --json reviews,comments` and `gh pr view 383 --json reviews,comments` when GitHub is available, then link the exact comparison artifact. I13/I14 show the network is unavailable from this worktree now.

## Resolution order and release boundary

F1/F3 are the two non-overlapping fix tickets; F2/F4 state distinct blocking violations covered by F1. Regenerate `plugins/shipyard/**` from the repaired canonical source with `make package-shipyard-codex` and rerun I8; I7 shows T-45-15 copied the current host source into the checked-in package. Re-run integration against the new exact head/tree. F5 is an explicit operator checkpoint for installed activation. F6 remains a publication gate, not evidence that this integration authorizes a default-branch merge or Release. I18 leaves full final-tree CI unknown.

`git status --short` (exit 0) listed only this new `INTEGRATION.md` and the supplied `.shipyard-integration45-diff.patch` scratch file; no runtime source file was edited during this judgment.
