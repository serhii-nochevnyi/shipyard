# Phase 46 integration judgment

Date: 2026-10-02. Verdict: **needs-fix**. Blocking finding index: **F1, F2, F3** (3 findings; F2 retains all eight native-pair receipt gaps). F1 is a delivery-loop fix ticket; F2 and F3 require operator decisions and remain blocking after code repair. This judgment does not authorize activation or a default-branch merge.

Commands cited as C01–C17 are printed exactly below, with outputs/exit statuses. C11 and C12 include their complete inline programs. Archived observations are identified as historical; unknowns include the next required check. This is fresh role-owned integration evidence for the authenticated dispatch.

## Bound revision and complete ticket set

- Authenticated subject: `phase=46-refresh-native-runtime-model-ladder;repository=/Volumes/KINGSTON/claude-shipyard/.git;tickets=83f64686a7e023e938d3c1b4bcd883bd474cd07d77500c081639aac688af06ab`.
- Worktree: `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-integration-20261002`.
- C01/C11, exit 0: combined head `1ead39a290966aacc3cb37a0feb2acb851b58300`, tree `a79df5d10e131b2a0d4987034e4cf858ea1aa802`; `origin/main` commit `845fd6d7f22aac05f96288e80604ac48c394ae49`, tree `3c4c8adf3954da2f5bf50c5b4687b3ccc7f30653`.
- C02, exit 0 and empty output, before tests and again after tests: worktree clean before writing this artifact.
- C03, exit 0: combined non-planning diff contains 66 files, 1,754 insertions, 892 deletions. Review covers this combined revision, including source, mirrors, tests, guidance and the clearly labeled advisory audit additions; `.planning/` is read for contracts/ADRs/rollout evidence rather than treated as generated code.
- C12, exit 0: SHA-256 of `JSON.stringify(ticket_set)` is `83f64686a7e023e938d3c1b4bcd883bd474cd07d77500c081639aac688af06ab`. The structured result below preserves host order and the exact five fields per entry.

| Ticket / PR | Integration commit | Merged tree equals authenticated PR head tree | Evidence |
|---|---|---|---|
| T-46-01 / [405](https://github.com/serhii-nochevnyi/shipyard/pull/405) | `a3821498ecd6f72740650f1cc6b988c9b54c8cd9` | `f551ecd7ed765f8b464fe92a4d35c8ae07116baf` | C11, ancestor exit 0 and tree equality |
| T-46-04 / [406](https://github.com/serhii-nochevnyi/shipyard/pull/406) | `316778bf7afdc3bc2d31a515508c474fc1b00b8d` | `0b1b709dbc923b0a5f32ab8fa828641415641236` | C11, ancestor exit 0 and tree equality |
| T-46-05 / [408](https://github.com/serhii-nochevnyi/shipyard/pull/408) | `6bf4a496d84f7716da0655aaaf976c6502c88adc` | `7d5f0f59457c11dabc9ba3fbcfbc82da7ae7fc80` | C11, ancestor exit 0 and tree equality |
| T-46-06 / [409](https://github.com/serhii-nochevnyi/shipyard/pull/409) | `1ead39a290966aacc3cb37a0feb2acb851b58300` | `a79df5d10e131b2a0d4987034e4cf858ea1aa802` | C11, ancestor exit 0 and tree equality |

These are local Git integration checks of the authenticated ticket set. C14 could not freshly query remote delivery/CI/review state; no current remote gate success is inferred from merge ancestry.

## Cross-ticket coherence and architecture

1. **Policy → runtime adapters → configuration → guidance:** C04/C06/C08/C13 passed. Exact v7 policy identity is `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570`. Policy/adapter paths are `plugins/delivery-pipeline/scripts/model-policy-internal.cjs:26`, `:78`, `:112` and `runtime-adapters.cjs:11`, `:15`, `:25`; configuration checks include `pipeline-config.cjs:1597`, `:1651`. Current code tests prove canonical ordinary/escalated pairs, conflicting native Sol assertions, pinned Sonnet observations, retained Luna/medium sentinel and Fable routing. C06 checks the complete supported table at `docs/gsd_multilevel_delivery_pipeline.md:774` against `tests/unit/source-contract.test.cjs:1000`. No contradictory current grid was found in those checked surfaces.
2. **Tuner → routed planning:** C05 passed the tuner cases, while its pipeline-config component had the environmental failures retained in F4. C08 then passed all configuration assertions. `gsd-tune.cjs:700` detects both old planner/reviewer `opus`/`fable` keys and `:1086` blocks apply before mutation; tests check preservation and policy-driven planning (`tests/unit/gsd-tune.test.cjs:169`, `:189`). This supplies a compatible handoff from T-46-01 to the dependent operator documentation.
3. **Repair chain → capability fallback:** C04/C05 passed boundary and capability cases at `model-capability.cjs:101` and `tests/unit/dispatch-boundary.test.cjs:662`. Unsupported deep repair refuses `UNSUPPORTED_REPAIR_FALLBACK`, because the immediate repeat receipt cannot prove the base predecessor required for a fallback repeat rung. This is the contract's safe-refusal alternative, not proof of a successful authenticated fallback. The runbook at `ADR-024-ROLLOUT.md:194` and protocol at `docs/gsd_multilevel_delivery_pipeline.md:883` describe that refusal.
4. **Reviewed source → generated package:** C11 proves byte equality for 137 plugin files, four capability files and seven host scripts. C12 recomputes package identity with the builder's read-only hashing algorithm (`scripts/package-shipyard-codex.cjs:51`). Content digest `852f99a1cb762216807792e41fe2af4c063b005c9ca4484f92e011a4fc050bd1`; version `0.70.0+codex.852f99a1cb762216`; build digest `baceaab44caacb408876d267009c97d1f8b300cd2a44c708afd0c0fc9127a492`. The mirrors are generated projection, not independent duplicate policy implementations.
5. **Package → isolated installation:** this seam fails P46-D. C15 shows the new rollout command at `ADR-024-ROLLOUT.md:89` enters `scripts/install-shipyard-codex.sh:133` (GSD dependency setup) and `:668` (global apply) with shared defaults at `:658`. `scripts/ensure-gsd-core.sh:72` invokes global dependency setup. C11 verifies the retained real install log's set/removal of shared defaults at lines 39/91. Successful package hashes and fixture installation do not make this isolation contract true. F1 is the actionable integration fix.
6. **History, ownership and scope:** C04 passes stale-v6 attribution and native negatives; C11 finds no modified/deleted preexisting files in the checked fixture/capture/investigation history paths. C11 also proves T-45-09 commit `a109ce224bf28c7b185f0b336731d6269802ab7f` and T-45-10 commit `aa93fee225d9b86a0048566784ddd53e0fb94c26` precede T-46-01's effective base, and reuse commit `1ca29f3658717efc8c212f6a5e81d33cfb2557f5` precedes the PR head. It has a stored `gpgsig` header; cryptographic validity and its historical native receipt remain unknown. Next check: owning host `git verify-commit 1ca29f3658717efc8c212f6a5e81d33cfb2557f5` and original receipt validation. ADR-023 D6 stays outside this phase per `ADR-024-model-ladder-refresh.md:75` (C15); no activation is inferred.

## Acceptance sweep

Numbering below follows the four authenticated contracts' acceptance arrays. C11 prints the local PLAN and ADR digests, matching the packet hashes. This table preserves partial and unknown observations rather than treating ticket merge as acceptance proof.

| Contract criterion | Observation / status | Command and relevant location |
|---|---|---|
| T-46-01 #1 — exact native pairs/current fixtures, historical meaning | Verified for the policy/adapter/history checks and native-host subset run here; live account application remains HOLD. | C04 exit 0; C09 exit 0; C10 exit 0; policy `:78`, `:112`; `tests/unit/usage-attribution.test.cjs:1540`; F2 |
| T-46-01 #2 — shipped defaults/protocol, conflicting Sol refusal, tuner blocker | Verified by configuration/source/tuner checks; the original ambient-marker failure is retained. | C05 exit 1 overall but tuner/boundary passed; C08 exit 0 (244 assertions); C06 exit 0; `pipeline-config.cjs:1597`, `gsd-tune.cjs:700`, `source-contract.test.cjs:2152` |
| T-46-01 #3 — signed reuse/ownership/full role artifacts | Git ancestry and stored signature header verified. Cryptographic signature, historical receipt and executor PR-body/evidence seal acceptance unknown; scratch files are absent here. | C11 exit 0; initial `rg -n 'prelaunch|reuse|1ca29f|ownership|369|T-45-09|T-45-10|merge-base|scope|CI|review' .shipyard-evidence.md .shipyard-pr-body.md .planning/phases/46-refresh-native-runtime-model-ladder/46-05-SUMMARY.md` exited 2: both scratch files absent. Next: trusted finalizer's retained PR405 executor artifact and receipt validation; do not infer loss from absent scratch files. |
| T-46-01 #4 — all eight commands + green CI + review before merge | Partial verification only. Focused commands below passed except ambient config; isolated rerun passed. Complete eight-group execution/full CI not newly verified. PR405 conform artifact file digests verified; remote CI unavailable. | C04–C10, C11, C14; archived PR405 review head `2cac957e...`; next: network-enabled host query C14 and retained exact-head CI/finalization receipts |
| T-46-04 #1 — supported exact table/signals/regression | Verified by the complete-table source assertion and scoped docs smoke. | C06/C07 exit 0; `docs/gsd_multilevel_delivery_pipeline.md:774`; `tests/unit/source-contract.test.cjs:1000` |
| T-46-04 #2 — executable isolated provenance/HOLD/rollback procedure, D6 boundary | Documentation records the required fields and boundaries, but its executable isolation path conflicts with actual installation behavior. Needs F1; missing rollback proof remains F3. | C15 exit 0; `ADR-024-ROLLOUT.md:51`, `:89`, `:104`, `:158`, `:226`; C11 archived shared-defaults mutation |
| T-46-04 #3 — no new savings/full-suite claim | No new economy or full-suite outcome is asserted in this judgment; scoped documentation checks passed. Source rollout evidence distinguishes synthetic/unknown outcomes. | C07 exit 0; C15 `46-ROLLOUT-EVIDENCE.md:22`, `:95`, `:103`; vendor economics in added audits remain historical/advisory, not verified savings |
| T-46-05 #1 — regenerated package/mirror/content identity | Read-only byte and digest reproduction verified. Actual executor invocation of the builder is not re-enacted or independently proven by this dispatch. | C11/C12 exit 0; `plugins/shipyard/package-build.json:2`; next historical-action check: retained T-46-05 executor command log |
| T-46-05 #2 — branch-independent stale negative/isolated install negatives | Source inspection verifies the unconditional comparison and stale negative; archived test/smoke logs retain historical success. No fresh installer run authorized; real isolation still fails F1. | C17 exit 0; `tests/unit/marketplace-install.test.cjs:89`, `:94`; C11 verifies archived focused log 9 pass/0 fail and smoke 37 rungs; F1 |
| T-46-05 #3 — fixed v6 stays stale, no prior history rewrite | Verified for the fixed historical fixture and checked prior history paths. | C04 exit 0; `usage-attribution.test.cjs:1540`; C11 history output `(none)` |
| T-46-05 #4 — prior reviewed rollback/package provenance/in-flight ownership | Prior source/archive identity retained, but prior installed manifest/provenance and restore target are unavailable; rollback readiness HOLD. | C11 verifies archive bytes and rollback metadata keys; C15 `46-ROLLOUT-EVIDENCE.md:99`; F3 |
| T-46-05 #5 — prelaunch merged-parent ancestry/log | Both real integration commits are ancestors of the package base, and parent outputs exist there. Timing/order of coordinator prelaunch sync/worktree preparation unknown. | C11 exit 0; `46-05-PLAN.md:60`; next: retained timestamped state-sync/prelaunch record with effective base `316778bf...`; current ancestry alone does not prove the barrier ran before launch |
| T-46-06 #1 — focused grid/static/native negatives/history/installer checks | Fresh policy/adapter/history/native-host subset checks passed; matching archived focused/smoke results verified by hashes. Installer commands intentionally not rerun. | C04/C09/C11/C12 exit 0; C11 archived focused 9 pass/0 fail, smoke 37 rungs; C15 `46-ROLLOUT-EVIDENCE.md:19` |
| T-46-06 #2 — independent source/package disposition, sealed research chain | PR405/408 conform artifact references and referenced file hashes verified. No local arch-review artifact found for PR406/409 in the searched ticket stores; remote disposition unknown. INV-011 sealed chain remains explicitly unverified and is not used as rollout proof. | C11 exit 0; C14 exit 1; C15 `46-ROLLOUT-EVIDENCE.md:7`, `:13`; next: owning host validates exact-revision review receipt chains and any INV-011 sealed evidence it intends to cite |
| T-46-06 #3 — each new pair exact native receipt or explicit HOLD | All eight HOLD reasons are recorded; archived failed auth and empty native result verified. This satisfies honest HOLD reporting, not exact application or isolation completion. | C11 exit 0; C15 `46-ROLLOUT-EVIDENCE.md:40`, `:80`, `:86`; F1/F2 |
| T-46-06 #4 — operator provenance/rollback/in-flight review before activation | Operator checkpoint remains pending, installation and rollback readiness HOLD; D6 ownership remains separate in the report. No activation approval can be concluded. | C15 `46-ROLLOUT-EVIDENCE.md:99`, `:101`, `:103`; F2/F3; next: operator records concrete activation-or-HOLD decision after prerequisites, without new launches inside the checkpoint |

## Retained native HOLD matrix

C15 reads the existing eight rows at `46-ROLLOUT-EVIDENCE.md:86`–`:93`; C11 verifies historical discoveries (both authenticated=false/exit 1) and a zero-byte native executor result. Every applied/observed pair, isolated verified session/receipt reference and entitlement remains **unknown**. No new discovery, login, vendor query or native model launch was performed in this dispatch.

| Required pair | Outcome and retained reason |
|---|---|
| gpt-6.1-sol / low | HOLD — authorized ordinary executor attempt exited 1; no verified receipt |
| gpt-6.1-sol / high | HOLD — isolated authentication and an authorized research/review receipt absent |
| gpt-6.1-sol / xhigh | HOLD — isolated authentication and verified judgment receipt absent; prospective checkpoint signal is not application proof |
| claude-sonnet-5-5 / low | HOLD — no authorized bounded actionable sentinel duty; isolated auth absent |
| claude-sonnet-5-5 / medium | HOLD — isolated auth and executor/drift receipt absent |
| claude-sonnet-5-5 / high | HOLD — authentic fixer duty/predecessor and isolated auth absent |
| claude-sonnet-5-5 / xhigh | HOLD — authorized research/critical-executor receipt and isolated auth absent |
| claude-opus-5-5 / high | HOLD — genuine escalation duty/chain and isolated auth absent |

Retained additional HOLDs: violated installation isolation boundary (`46-ROLLOUT-EVIDENCE.md:32`), absent exact shared-defaults before image/restoration proof (`:32`), absent prior installed rollback identity/target (`:99`), pending operator checkpoint (`:103`). C11's archive verification establishes retained bytes, not successful model application or restoration.

## Complete finding index and structured result

F1 is a deterministic installer/runbook seam, so the verdict is needs-fix. F2/F3 are independent human questions and remain blocking if F1 is repaired. Informational F4/F5 preserve environment and verification limits. All remediation, scope, files, dependencies and exact questions are retained below.

```json
{
  "outcome": "needs-fix",
  "phase": "46-refresh-native-runtime-model-ladder",
  "head": "1ead39a290966aacc3cb37a0feb2acb851b58300",
  "head_tree": "a79df5d10e131b2a0d4987034e4cf858ea1aa802",
  "base": "origin/main",
  "base_tree": "3c4c8adf3954da2f5bf50c5b4687b3ccc7f30653",
  "ticket_set": [
    {
      "id": "T-46-01",
      "pr": 405,
      "head": "2cac957e4c52c29ab9a1e15c850832a32e3f4a0c",
      "base": "epic/46-refresh-native-runtime-model-ladder",
      "branch": "ticket/T-46-01-migrate-native-ladder-runtime-trailer"
    },
    {
      "id": "T-46-04",
      "pr": 406,
      "head": "2416f23a95b1d91d94fa7fa9fda926e88d74c753",
      "base": "epic/46-refresh-native-runtime-model-ladder",
      "branch": "ticket/T-46-04-publish-supported-grid-and-isolated-roll"
    },
    {
      "id": "T-46-05",
      "pr": 408,
      "head": "992fd1fca755ce812ef04d3714f12e108378c090",
      "base": "epic/46-refresh-native-runtime-model-ladder",
      "branch": "ticket/T-46-05-regenerate-the-reviewed-package-and-veri"
    },
    {
      "id": "T-46-06",
      "pr": 409,
      "head": "7c2d81df34185a02d1854dcfe3ba3edfbf010d3b",
      "base": "epic/46-refresh-native-runtime-model-ladder",
      "branch": "ticket/T-46-06-independently-review-native-application"
    }
  ],
  "ticket_set_digest": "83f64686a7e023e938d3c1b4bcd883bd474cd07d77500c081639aac688af06ab",
  "blocking_count": 3,
  "summary": "Source policy and package agree, but the isolated-install runbook reaches shared GSD-default mutations (F1). Eight native pairs and the operator checkpoint remain HOLD (F2); restoration and rollback readiness require human resolution (F3). Complete evidence and command limitations are in INTEGRATION.md.",
  "findings": [
    {
      "id": "F1",
      "type": "fix-ticket",
      "blocking": true,
      "ticket": null,
      "summary": "The isolated rollout procedure reaches dependency setup and global tuning that mutate shared GSD defaults; the archived installation log confirms the mutation.",
      "evidence": "scripts/install-shipyard-codex.sh:133; scripts/install-shipyard-codex.sh:658; scripts/install-shipyard-codex.sh:668; scripts/ensure-gsd-core.sh:72; .planning/architecture/ADR-024-ROLLOUT.md:89; .planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:32. Commands C11 and C15 in INTEGRATION.md, exit 0; archived install log lines 39 and 91.",
      "fix_ticket": {
        "title": "Make isolated rollout installation preserve shared GSD defaults",
        "scope": "Provide an isolated installation path that confines GSD dependency setup and Shipyard tuning to candidate-owned state, or refuses before mutation when dependency isolation cannot be guaranteed. Cover direct Codex, marketplace bootstrap, and the documented Claude dependency path. Add regressions that detect writes outside the candidate home, update the executable rollout procedure, regenerate the package mirror, and preserve all existing authentication, application, restoration, rollback, and operator HOLD evidence. Do not infer or restore unknown previous global-default bytes.",
        "files": [
          "scripts/ensure-gsd-core.sh",
          "scripts/install-shipyard-codex.sh",
          "scripts/install-shipyard-marketplace.cjs",
          "scripts/bootstrap-shipyard-plugin.cjs",
          "tests/unit/gen-codex-shipyard.test.cjs",
          "tests/unit/marketplace-install.test.cjs",
          "tests/smoke/model-ladder-runtime-smoke.sh",
          ".planning/architecture/ADR-024-ROLLOUT.md",
          "plugins/shipyard/"
        ],
        "depends_on": [
          "T-46-04",
          "T-46-05",
          "T-46-06"
        ]
      }
    },
    {
      "id": "F2",
      "type": "human-question",
      "blocking": true,
      "ticket": "T-46-06",
      "summary": "All eight required native model/effort pairs remain HOLD; archived isolated authentication failed and the attempted Codex executor produced no verified receipt.",
      "question": "Who will arrange separate isolated authentication and authorize genuine role duties for the eight required pairs, then record the operator activation-or-HOLD decision after exact same-session receipts and independent review?",
      "evidence": ".planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:40; .planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:80; .planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:86; .planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:103. C11, exit 0, verifies archived authenticated=false/exit 1 for both runtimes and empty native-result bytes; C15 reads all eight HOLD rows."
    },
    {
      "id": "F3",
      "type": "human-question",
      "blocking": true,
      "ticket": "T-46-06",
      "summary": "The shared-defaults before image/restoration proof and the prior package's installed identity/isolated restore target remain unavailable; rollback readiness is HOLD.",
      "question": "What audited remediation is authorized for the shared-defaults mutation without an exact before image, and which verified prior installed identity and quiescent or fresh isolated restore target will be retained before rollout?",
      "evidence": ".planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:32; .planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:99; .planning/architecture/ADR-024-ROLLOUT.md:226. C11, exit 0, confirms rollback metadata contains archive/source/package fields only; C15 reads the restoration and rollback HOLDs. Recovery authorization and the missing identities are unknown."
    },
    {
      "id": "F4",
      "type": "informational",
      "blocking": false,
      "ticket": "T-46-01",
      "summary": "The scoped configuration group failed 19 compatibility assertions with inherited Codex session markers; rerunning pipeline-config with those markers removed passed all 244 assertions.",
      "evidence": "tests/unit/pipeline-config.test.cjs:31; tests/unit/pipeline-config.test.cjs:1852; plugins/delivery-pipeline/scripts/runtime-context.cjs:90. C05 exited 1 (225 passed/19 failed in pipeline-config); C08 exited 0 (244 passed/0 failed). No source or global-default repair was applied."
    },
    {
      "id": "F5",
      "type": "informational",
      "blocking": false,
      "ticket": null,
      "summary": "Installer checks were not rerun under this dispatch prohibition. Current remote CI/reviews and some historical prelaunch/finalization records remain unverified; source/package and archived proof checks do not replace those gates.",
      "evidence": ".planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:13; .planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md:19; .planning/phases/46-refresh-native-runtime-model-ladder/46-05-PLAN.md:60. C14 queries for PR405/406/408/409 each exited 1 connecting to api.github.com. C11 verified preserved PR405/408 review file digests and found no local arch-review artifact for PR406/409 in the searched stores."
    }
  ]
}
```

## Exact command register

C01 — revision identity, exit 0; output head/tree/base commit/base tree in that order:
```sh
git rev-parse HEAD 'HEAD^{tree}' origin/main 'origin/main^{tree}'
```

C02 — clean-worktree checks, exit 0, empty output before review and after tests:
```sh
git status --porcelain=v1
```

C03 — phase combined code scope, exit 0; 66 files, 1,754 insertions, 892 deletions:
```sh
git diff --stat origin/main HEAD -- . ':!.planning'
```

C04 — policy/selection/application-negative/history spot verification, exit 0; Node reports 69 top-level tests, 69 pass, 0 fail (custom-harness files also report their internal assertions):
```sh
node --test tests/unit/model-policy.test.cjs tests/unit/model-capability.test.cjs tests/unit/codex-agent.test.cjs tests/unit/codex-dispatch-adapter.test.cjs tests/unit/claude-dispatch-adapter.test.cjs tests/unit/usage-attribution.test.cjs
```

C05 — exact eighth core scoped command, exit 1; Node 8 top-level tests, 7 pass/1 fail. Pipeline-config reports 225 pass/19 fail under ambient Codex session runtime markers; tuner/capability/boundary components passed. Preserve this failure; C08 is a changed-environment diagnostic rerun, not a retroactive pass for this exact invocation:
```sh
node --test tests/unit/gsd-tune.test.cjs tests/unit/model-capability.test.cjs tests/unit/dispatch-boundary.test.cjs tests/unit/pipeline-config.test.cjs
```

C06 — exact fourth core scoped command, exit 0; Node 4 top-level tests, 4 pass/0 fail. Internal harness totals: auto-route 21/0, instructions 3/0, source-contract 43/0, workflow arguments 73/0:
```sh
node --test tests/unit/source-contract.test.cjs tests/unit/workflows-args.test.cjs tests/unit/claude-instructions.test.cjs tests/unit/auto-route.test.cjs
```

C07 — documentation smoke, exit 0; `docs smoke passed`:
```sh
bash tests/smoke/docs-smoke.sh
```

C08 — configuration rerun removing session-runtime environment markers, exit 0; 244 internal assertions passed/0 failed; Node 1 top-level test passed. No persistent settings changed:
```sh
env -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED -u CLAUDE_PLUGIN_ROOT -u CLAUDE_CODE_ENTRYPOINT -u SHIPYARD_RUNTIME -u GSD_RUNTIME node --test tests/unit/pipeline-config.test.cjs
```

C09 — native-host/research fixture subset, exit 0; Node 31 top-level tests passed/0 failed; custom harness Claude runtime 28/0, Codex runtime 17/0, investigation research 11/0. These are fixture tests, not account probes:
```sh
env -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED -u CLAUDE_PLUGIN_ROOT -u CLAUDE_CODE_ENTRYPOINT -u SHIPYARD_RUNTIME -u GSD_RUNTIME node --test tests/unit/codex-runtime-host.test.cjs tests/unit/claude-runtime-host.test.cjs tests/unit/claude-decompose-host.test.cjs tests/unit/investigation-research.test.cjs
```

C10 — run scope/controller/contracts, exit 0; Node 19 tests passed/0 failed:
```sh
node --test tests/unit/run-contract.test.cjs tests/unit/run-controller.test.cjs tests/unit/run-scope.test.cjs
```

C11 — consolidated read-only revision, lineage, parent-base, mirror, archive, review-file and history audit. Exit 0. Full exact command:
```sh
python3 - <<'PY'
import hashlib,json,pathlib,re,stat,subprocess,tarfile
root=pathlib.Path('.')
def sha(data): return hashlib.sha256(data).hexdigest()
def git(*args): return subprocess.check_output(['git',*args],text=True).strip()
def ancestor(older,newer):
    argv=['git','merge-base','--is-ancestor',older,newer]
    result=subprocess.run(argv)
    print(' '.join(argv),'exit',result.returncode)
    assert result.returncode==0
combined='1ead39a290966aacc3cb37a0feb2acb851b58300'
assert git('rev-parse','HEAD')==combined
assert git('rev-parse','HEAD^{tree}')=='a79df5d10e131b2a0d4987034e4cf858ea1aa802'
assert git('rev-parse','origin/main')=='845fd6d7f22aac05f96288e80604ac48c394ae49'
assert git('rev-parse','origin/main^{tree}')=='3c4c8adf3954da2f5bf50c5b4687b3ccc7f30653'
pairs=[
('405','a3821498ecd6f72740650f1cc6b988c9b54c8cd9','2cac957e4c52c29ab9a1e15c850832a32e3f4a0c'),
('406','316778bf7afdc3bc2d31a515508c474fc1b00b8d','2416f23a95b1d91d94fa7fa9fda926e88d74c753'),
('408','6bf4a496d84f7716da0655aaaf976c6502c88adc','992fd1fca755ce812ef04d3714f12e108378c090'),
('409',combined,'7c2d81df34185a02d1854dcfe3ba3edfbf010d3b')]
for pr,merge,head in pairs:
    ancestor(merge,combined)
    assert git('rev-parse',merge+'^{tree}')==git('rev-parse',head+'^{tree}')
    print('PASS PR',pr,'merged tree equals authenticated PR head tree',git('rev-parse',merge+'^{tree}'))
for _,merge,_ in pairs[:2]: ancestor(merge,'6bf4a496d84f7716da0655aaaf976c6502c88adc^')
for commit in ['a109ce224bf28c7b185f0b336731d6269802ab7f','aa93fee225d9b86a0048566784ddd53e0fb94c26']:
    ancestor(commit,'7ae0616f0e4a465fc97bd702ff96cae939f4e031')
ancestor('1ca29f3658717efc8c212f6a5e81d33cfb2557f5',pairs[0][2])
print('reuse commit contains stored gpgsig header:', '\ngpgsig ' in git('cat-file','commit','1ca29f3658717efc8c212f6a5e81d33cfb2557f5'))
for p in ['plugins/delivery-pipeline/scripts/model-policy-internal.cjs','plugins/delivery-pipeline/scripts/runtime-adapters.cjs','plugins/delivery-pipeline/commands/deliver.md','tests/smoke/model-ladder-runtime-smoke.sh','docs/gsd_multilevel_delivery_pipeline.md','.planning/architecture/ADR-024-ROLLOUT.md']:
    subprocess.check_output(['git','cat-file','-e','316778bf7afdc3bc2d31a515508c474fc1b00b8d:'+p])
print('PASS parent source/guidance/smoke/runbook exist at package base')
def snapshot(p):
    return {f.relative_to(p).as_posix():sha(f.read_bytes()) for f in p.rglob('*') if f.is_file() and not re.search(r'\.(bak|orig|rej|swp)$|(?:^|/)\.DS_Store$|~$',f.as_posix())}
for a,b in [('plugins/delivery-pipeline','plugins/shipyard/host/plugins/delivery-pipeline'),('capabilities/delivery-pipeline','plugins/shipyard/host/capabilities/delivery-pipeline')]:
    a,b=root/a,root/b
    assert snapshot(a)==snapshot(b)
    print('PASS mirror',str(a),str(b),len(snapshot(a)),'files')
for name in ['bootstrap-shipyard-plugin.cjs','ensure-gsd-plugin.cjs','ensure-gsd-core.sh','install-shipyard-codex.sh','gen-codex-shipyard.cjs','merge-codex-config.cjs','configure-codex-notify.cjs']:
    assert (root/'scripts'/name).read_bytes()==(root/'plugins/shipyard/host/scripts'/name).read_bytes()
print('PASS 7 host script mirrors')
for file in ['46-01-PLAN.md','46-04-PLAN.md','46-05-PLAN.md','46-06-PLAN.md']:
    p=root/'.planning/phases/46-refresh-native-runtime-model-ladder'/file
    print('contract_sha256',p,sha(p.read_bytes()))
for file in ['ADR-023-residual-pipeline-efficiency.md','ADR-024-model-ladder-refresh.md','ADR-024-ROLLOUT.md']:
    p=root/'.planning/architecture'/file
    print('ADR_sha256',p,sha(p.read_bytes()))
report=root/'.planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md'
proofroot=pathlib.Path('/Users/serhii/.local/state/shipyard/evidence/phase46')
archive=proofroot/'0e79d8cf8d187c1c897d24622133586415039d9e33ac39d844ef6e281c1c2508.tar'
manifest=proofroot/'dccd9979e0c4e440edf0adae75746bbdc666318ad1580e11a54e8e6c8eab7ad1.manifest.json'
assert stat.S_IMODE(proofroot.stat().st_mode)==0o700
for p,n in [(archive,20080640),(manifest,8690)]:
    assert not p.is_symlink() and p.stat().st_size==n
    assert stat.S_IMODE(p.stat().st_mode)==0o400
    assert sha(p.read_bytes())==p.name.split('.')[0]
entries=json.loads(manifest.read_bytes())['entries']
quote=chr(96)
pattern=r'^\| '+quote+r'([^'+quote+r']+)'+quote+r' \| (\d+) \| '+quote+r'([0-9a-f]{64})'+quote+r' \|$'
rows=re.findall(pattern,report.read_text(),re.M)
expected=[(p,int(n),h) for p,n,h in rows]
expected.append(('/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/global-defaults-after-install.json',1005,'2edab0e2e95e8d265da9c66fcf4de6d5193b3511b629d4d07920dda4ac4ee4b0'))
assert len(rows)==30 and len(entries)==31
assert [(e['source'],e['bytes'],e['sha256']) for e in entries]==expected
with tarfile.open(archive,'r:') as tar:
    assert sorted(tar.getnames())==sorted([e['member'] for e in entries]+['manifest.json'])
    assert tar.extractfile('manifest.json').read()==manifest.read_bytes()
    for e in entries:
        m=tar.getmember(e['member']);data=tar.extractfile(m).read()
        assert m.isfile() and m.size==e['bytes'] and len(data)==e['bytes'] and sha(data)==e['sha256']
        source=e['source']
        if source.endswith('-discovery.json'):
            v=json.loads(data);print('archived discovery',v['runtime'],'authenticated',v['authenticated'],'exit',v.get('exit_code',v.get('auth_status_exit')))
        if source.endswith('isolated-codex-install.log'):
            for n,line in enumerate(data.decode().splitlines(),1):
                if 'defaults' in line or 'legacy global' in line: print('archived install line',n,line)
        if source.endswith('isolated-executor-result.json'): print('archived native result bytes',len(data))
        if source.endswith('prior-reviewed.json'): print('archived rollback keys',sorted(json.loads(data)))
        if source.endswith('focused-tests.log') or source.endswith('smoke.log'):
            print('archived test log',source,data.decode().splitlines()[-9:])
print('PASS 31 preserved proof members and manifest/archive digests; read only, no extraction')
reviewroot=pathlib.Path('/Volumes/KINGSTON/.wt-claude-shipyard/.wt-inv-011-model-ladder-refresh')
for ticket in ['T-46-01','T-46-04','T-46-05','T-46-06']:
    reviews=[]
    for file in (reviewroot/ticket/'.shipyard-role-artifacts').glob('*/.shipyard-role-artifact.json'):
        v=json.loads(file.read_bytes())
        if v.get('role')!='arch-review': continue
        envelope=v['envelope']
        for key in ['evidence_index','findings_index']:
            ref=envelope[key];f=reviewroot/ticket/ref['path']
            assert f.stat().st_size==ref['bytes'] and sha(f.read_bytes())==ref['sha256']
        reviews.append((str(file),sha(file.read_bytes()),v['head'],envelope['outcome'],envelope['blocking_count']))
    print('review artifacts',ticket,reviews)
modified=git('diff','--name-only','--diff-filter=MD','origin/main','HEAD','--','tests/fixtures','tests/captures','.planning/investigations')
print('modified/deleted prior history paths:',modified or '(none)')
assert modified==''
print('PASS combined read-only audit')
PY
```

Relevant C11 output:
```text
git merge-base --is-ancestor a3821498ecd6f72740650f1cc6b988c9b54c8cd9 1ead39a290966aacc3cb37a0feb2acb851b58300 exit 0
PASS PR 405 merged tree equals authenticated PR head tree f551ecd7ed765f8b464fe92a4d35c8ae07116baf
git merge-base --is-ancestor 316778bf7afdc3bc2d31a515508c474fc1b00b8d 1ead39a290966aacc3cb37a0feb2acb851b58300 exit 0
PASS PR 406 merged tree equals authenticated PR head tree 0b1b709dbc923b0a5f32ab8fa828641415641236
git merge-base --is-ancestor 6bf4a496d84f7716da0655aaaf976c6502c88adc 1ead39a290966aacc3cb37a0feb2acb851b58300 exit 0
PASS PR 408 merged tree equals authenticated PR head tree 7d5f0f59457c11dabc9ba3fbcfbc82da7ae7fc80
git merge-base --is-ancestor 1ead39a290966aacc3cb37a0feb2acb851b58300 1ead39a290966aacc3cb37a0feb2acb851b58300 exit 0
PASS PR 409 merged tree equals authenticated PR head tree a79df5d10e131b2a0d4987034e4cf858ea1aa802
git merge-base --is-ancestor a3821498ecd6f72740650f1cc6b988c9b54c8cd9 6bf4a496d84f7716da0655aaaf976c6502c88adc^ exit 0
git merge-base --is-ancestor 316778bf7afdc3bc2d31a515508c474fc1b00b8d 6bf4a496d84f7716da0655aaaf976c6502c88adc^ exit 0
git merge-base --is-ancestor a109ce224bf28c7b185f0b336731d6269802ab7f 7ae0616f0e4a465fc97bd702ff96cae939f4e031 exit 0
git merge-base --is-ancestor aa93fee225d9b86a0048566784ddd53e0fb94c26 7ae0616f0e4a465fc97bd702ff96cae939f4e031 exit 0
git merge-base --is-ancestor 1ca29f3658717efc8c212f6a5e81d33cfb2557f5 2cac957e4c52c29ab9a1e15c850832a32e3f4a0c exit 0
reuse commit contains stored gpgsig header: True
PASS parent source/guidance/smoke/runbook exist at package base
PASS mirror plugins/delivery-pipeline plugins/shipyard/host/plugins/delivery-pipeline 137 files
PASS mirror capabilities/delivery-pipeline plugins/shipyard/host/capabilities/delivery-pipeline 4 files
PASS 7 host script mirrors
contract_sha256 .planning/phases/46-refresh-native-runtime-model-ladder/46-01-PLAN.md dd6224527b1e12e04ffb49595de6dc5a71000ade1da342895dfef7997aae2ef5
contract_sha256 .planning/phases/46-refresh-native-runtime-model-ladder/46-04-PLAN.md b5675193f6bdfca99f9fda8b8e7058116a50bd5a28b870cce22cf0a50139b597
contract_sha256 .planning/phases/46-refresh-native-runtime-model-ladder/46-05-PLAN.md 31eeb1d7d35c7005625cb75876a0ef311a1b1fbf53d828a61a2130efe252a9c7
contract_sha256 .planning/phases/46-refresh-native-runtime-model-ladder/46-06-PLAN.md 85b33ebfefc3cda34487ff52017ec6bf6a14a374d156b3de82bd9b4620ef1bb4
ADR_sha256 .planning/architecture/ADR-023-residual-pipeline-efficiency.md 762e5c2b4f4507bf458314acc81cb600b45136e05ad8b4c23a97a4a409ddf41d
ADR_sha256 .planning/architecture/ADR-024-model-ladder-refresh.md f96c03235c600886b119a38964f221bcfbeecfe7e09d23f235653e0693ca2f47
ADR_sha256 .planning/architecture/ADR-024-ROLLOUT.md 51e2b5c886787fe41e81e91410185766a260e02f4a756537b9739b6002e0de65
archived rollback keys ['archive', 'archive_sha256', 'bytes', 'package_build_digest', 'source_sha', 'version']
archived native result bytes 0
archived discovery codex authenticated False exit 1
archived discovery claude authenticated False exit 1
archived install line 21   [32m✓[0m Installed gsd-core/bin/shared/config-defaults.manifest.json
archived install line 39   [32m✓[0m Set runtime: "codex" in ~/.gsd/defaults.json
archived install line 83 → GSD global defaults (~/.gsd/defaults.json)
archived install line 84   gsd-tune: runtime "codex" (--runtime) — /Users/serhii/.gsd/defaults.json  [global defaults]
archived install line 86     ⚠ legacy global runtime "codex" is present.
archived install line 87       ~/.gsd/defaults.json is shared by both installs, so this key makes the
archived install line 91   ✓ removed legacy global runtime in /Users/serhii/.gsd/defaults.json
archived test log /tmp/phase46-06-focused-tests.log ['✔ tests/unit/model-policy.test.cjs (113.542458ms)', 'ℹ tests 9', 'ℹ suites 0', 'ℹ pass 9', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 1619.546791']
archived test log /tmp/phase46-06-smoke.log ['model-ladder runtime smoke: OK (37 installed runtime rungs; fingerprints, installer validation, native Claude bytes, refusal cases)']
PASS 31 preserved proof members and manifest/archive digests; read only, no extraction
review artifacts T-46-01 [('/Volumes/KINGSTON/.wt-claude-shipyard/.wt-inv-011-model-ladder-refresh/T-46-01/.shipyard-role-artifacts/927d3d5ac76595fc59beaef14ee5d0044a550c9fddd9b14604e8f3a7bf7bf04b/.shipyard-role-artifact.json', 'ab2234d65265b3ce104ba1955d72a6b58b2e8f0f1a3c2aaf4098fba7a6b1a6b4', '2cac957e4c52c29ab9a1e15c850832a32e3f4a0c', 'conform', 0)]
review artifacts T-46-04 []
review artifacts T-46-05 [('/Volumes/KINGSTON/.wt-claude-shipyard/.wt-inv-011-model-ladder-refresh/T-46-05/.shipyard-role-artifacts/0d6c8c04367d9f12f364f06c423c0bf870e9eaf6463ee07a72b8a5e516bdeb79/.shipyard-role-artifact.json', '1758d9665077150300623b2ffefec9930ba9cddaac8e08391adcfc24bfe172f0', '992fd1fca755ce812ef04d3714f12e108378c090', 'conform', 0)]
review artifacts T-46-06 []
modified/deleted prior history paths: (none)
PASS combined read-only audit
```

C12 — read-only package digest/manifest/policy and complete-ticket-set digest reproduction. Exit 0. Full exact command:
```sh
node - <<'JS'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const dest='plugins/shipyard',hash=crypto.createHash('sha256');
function walk(dir,prefix=''){
  for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const rel=prefix+e.name;
    if(rel==='package-build.json'||rel==='.codex-plugin/plugin.json')continue;
    if(e.isDirectory())walk(path.join(dir,e.name),rel+'/');
    else{hash.update(rel+'\0');hash.update(fs.readFileSync(path.join(dir,e.name)));}
  }
}
walk(dest);
const content=hash.digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(dest,'.codex-plugin/plugin.json')));
const source=JSON.parse(fs.readFileSync('plugins/delivery-pipeline/.claude-plugin/plugin.json'));
const build=JSON.parse(fs.readFileSync(path.join(dest,'package-build.json')));
assert.equal(manifest.version,source.version+'+codex.'+content.slice(0,16));
const digest=crypto.createHash('sha256').update(content).update('\0').update(fs.readFileSync(path.join(dest,'.codex-plugin/plugin.json'))).digest('hex');
assert.equal(build.version,manifest.version);assert.equal(build.digest,digest);
const policy=require('./plugins/delivery-pipeline/scripts/model-policy.cjs');
const mirror=require('./plugins/shipyard/host/plugins/delivery-pipeline/scripts/model-policy.cjs');
assert.equal(policy.POLICY_HASH,mirror.POLICY_HASH);assert.equal(policy.POLICY_VERSION,mirror.POLICY_VERSION);
const tickets=[
{id:'T-46-01',pr:405,head:'2cac957e4c52c29ab9a1e15c850832a32e3f4a0c',base:'epic/46-refresh-native-runtime-model-ladder',branch:'ticket/T-46-01-migrate-native-ladder-runtime-trailer'},
{id:'T-46-04',pr:406,head:'2416f23a95b1d91d94fa7fa9fda926e88d74c753',base:'epic/46-refresh-native-runtime-model-ladder',branch:'ticket/T-46-04-publish-supported-grid-and-isolated-roll'},
{id:'T-46-05',pr:408,head:'992fd1fca755ce812ef04d3714f12e108378c090',base:'epic/46-refresh-native-runtime-model-ladder',branch:'ticket/T-46-05-regenerate-the-reviewed-package-and-veri'},
{id:'T-46-06',pr:409,head:'7c2d81df34185a02d1854dcfe3ba3edfbf010d3b',base:'epic/46-refresh-native-runtime-model-ladder',branch:'ticket/T-46-06-independently-review-native-application'}
];
const ticketDigest=crypto.createHash('sha256').update(JSON.stringify(tickets)).digest('hex');
assert.equal(ticketDigest,'83f64686a7e023e938d3c1b4bcd883bd474cd07d77500c081639aac688af06ab');
console.log(JSON.stringify({content_sha256:content,version:manifest.version,build_digest:digest,policy_version:policy.POLICY_VERSION,policy_hash:policy.POLICY_HASH,ticket_set_digest:ticketDigest}));
JS
```
```text
{"content_sha256":"852f99a1cb762216807792e41fe2af4c063b005c9ca4484f92e011a4fc050bd1","version":"0.70.0+codex.852f99a1cb762216","build_digest":"baceaab44caacb408876d267009c97d1f8b300cd2a44c708afd0c0fc9127a492","policy_version":"adr-014.v7","policy_hash":"3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570","ticket_set_digest":"83f64686a7e023e938d3c1b4bcd883bd474cd07d77500c081639aac688af06ab"}
```

C13 — current canonical fingerprint, exit 0:
```sh
node plugins/delivery-pipeline/scripts/model-policy.cjs fingerprint
```
Output: `{"policy_version":"adr-014.v7","policy_hash":"3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570"}`.

C14 — read-only remote PR checks. Each exact command below exited 1 with `error connecting to api.github.com`; current CI/review details are unknown. Next check is the same query from the trusted network-enabled host:
```sh
gh pr view 405 --json state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,reviewDecision,statusCheckRollup --jq '{state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,reviewDecision,checks:[.statusCheckRollup[]|{name,status,conclusion,detailsUrl}]}'
gh pr view 406 --json state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,reviewDecision,statusCheckRollup --jq '{state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,reviewDecision,checks:[.statusCheckRollup[]|{name,status,conclusion,detailsUrl}]}'
gh pr view 408 --json state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,reviewDecision,statusCheckRollup --jq '{state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,reviewDecision,checks:[.statusCheckRollup[]|{name,status,conclusion,detailsUrl}]}'
gh pr view 409 --json state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,reviewDecision,statusCheckRollup --jq '{state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,reviewDecision,checks:[.statusCheckRollup[]|{name,status,conclusion,detailsUrl}]}'
```

C15 — source and architecture/evidence inspection supporting F1–F3, each command exit 0:
```sh
nl -ba scripts/install-shipyard-codex.sh | sed -n '72,140p;651,673p'
nl -ba scripts/ensure-gsd-core.sh | sed -n '1,260p'
nl -ba .planning/architecture/ADR-024-ROLLOUT.md | sed -n '45,132p;248,279p'
nl -ba .planning/architecture/ADR-024-model-ladder-refresh.md | sed -n '19,31p;68,91p'
nl -ba .planning/phases/46-refresh-native-runtime-model-ladder/46-ROLLOUT-EVIDENCE.md
nl -ba plugins/delivery-pipeline/scripts/model-capability.cjs
nl -ba plugins/delivery-pipeline/scripts/runtime-adapters.cjs
nl -ba plugins/delivery-pipeline/scripts/gsd-tune.cjs | sed -n '690,735p;1055,1115p'
nl -ba plugins/delivery-pipeline/scripts/pipeline-config.cjs | sed -n '1460,1650p'
nl -ba plugins/delivery-pipeline/scripts/pipeline-config.cjs | sed -n '1650,1765p'
```

C16 — installer-containing test inspection, exit 0; generator tests invoke `install-shipyard-codex.sh` at line 782, smoke invokes it at line 86, marketplace tests invoke dependency-install setup at line 33. Those entire commands were intentionally not executed under the dispatch's installer prohibition:
```sh
rg -n 'install|spawn|execFile|execSync' tests/unit/model-policy.test.cjs tests/unit/model-capability.test.cjs tests/unit/codex-agent.test.cjs tests/unit/codex-dispatch-adapter.test.cjs tests/unit/gen-codex-shipyard.test.cjs tests/unit/claude-dispatch-adapter.test.cjs tests/unit/marketplace-install.test.cjs tests/smoke/model-ladder-runtime-smoke.sh tests/smoke/docs-smoke.sh
```

C17 — marketplace/history assertion inspection, exit 0:
```sh
nl -ba tests/unit/marketplace-install.test.cjs | sed -n '54,99p'; nl -ba tests/unit/usage-attribution.test.cjs | sed -n '1539,1560p'
```

## Verification boundaries and next checks

- The exact first core verification group contains `gen-codex-shipyard.test.cjs`, and the smoke/marketplace groups execute installers. They were not rerun. C04 is explicitly a safe subset plus history coverage; C11 checks retained archived smoke/focused results without executing their historical commands.
- The complete core host and legacy-harness groups were not all rerun. C09/C10 are named spot-verification subsets. No local full-suite or full-CI pass is claimed.
- Archived test exit-0 statements are retained in `46-ROLLOUT-EVIDENCE.md:19`/`:20`; C11 independently verifies their log bytes and result text. The logs are synthetic/fixture proof and cannot clear the real eight-pair HOLD.
- PR405/408 review artifact hashes and referenced evidence/findings hashes are independently checked by C11. Dispatch-receipt chain revalidation was not attempted against live/stale ticket checkouts; next check is the trusted consuming host's original receipt-bound validation. PR406/409 remote review state and all fresh remote CI checks are unknown after C14.
- Exact signature validation, executor role-artifact acceptance, prelaunch timing and INV-011 sealed research validation remain historical checks for the owning host. None is inferred from a summary, a PR body, or the generated halted SUMMARY files.
- F1 requires implementation through the normal delivery loop. F2/F3 require precise operator decisions on authentication/duties, recovery/rollback evidence and the checkpoint. No synthetic launch, capability success, restoration, guessed before image or activation may substitute for those checks.

Only this INTEGRATION.md is authorized for a persistent worktree write. Its host seal/validate is a subsequent consuming-boundary action, not performed or claimed by this judgment.
