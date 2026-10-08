# Current T-47-27 R2 adoption — captured BEFORE current27 finalization

`node -e "const x=require('./tests/smoke/phase47-runtime-acceptance.cjs').inspectCandidate(); require('fs').writeFileSync('/tmp/phase47-R2-inspected27.json',JSON.stringify(x,null,2)); console.log(JSON.stringify(x.identity))"` exited 0. It authenticated actual generation 9365fc4817abc41cce69798cb84bf9a8938e4b9d1e0645ba5dce5a9781aebbd0 in ADR-027-main-review-repair-R2, original GENF1/GEN27/Volume signatures, original-byte materializations and independent Source39/coordinator48. Source PR449 HEAD 15a205063774993bc35404b5c8c8f1013f98b016, tree 5d57268a5835b3a817823c0c21e7b84eb1b0082f; worktree /Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-27, common directory /Volumes/KINGSTON/claude-shipyard/.git. Fixed signer remains 2F485C0A455BA33463F66332900FCE87BD1BFF0D.

Handoff /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair-R2/generation.json SHA256 b0b582fde0c832e89c4121cde4de34218a7ad3f3d1f73ce76767d7952375b5e5; approval /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair-R2/source-approval.json SHA256 147f5278ea9e5d1f3d0d71faa841d72565b8dabd6741cb73abb71fad3012016b, signature /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair-R2/source-approval.json.asc. Selection /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-R2/selection.json SHA256 1394f2b6cfb5447194b80a67b4e6456416cd3b1d1b40926da8b34073c995f3c1; binding /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-R2/9365fc4817abc41cce69798cb84bf9a8938e4b9d1e0645ba5dce5a9781aebbd0/binding.json SHA256 e3e08aefe542e17732976f670950fbced1c094eafae96d80fca4c53c3491d6a7; candidate /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-R2/9365fc4817abc41cce69798cb84bf9a8938e4b9d1e0645ba5dce5a9781aebbd0/candidate inventory SHA256 57c99e33411408b09a878da15ed885c3f04cc1e5e4ea5665d82eeca845fd264e. Fresh original-byte materializations V1 /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair-R2/historical-materialization.json SHA256 2e620175880f10daacf7067685b76ffdbea116e7fca2f4e87e63364d917b9f74 and V2 /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair-R2/historical-materialization-2.json SHA256 b1537ddbf637f8b07deff897dc02ad1adced6ada61af99adb4c0e2d1af927045 retain original three mappings. Signed R2 scope remains 4647587d0324060505c1516ffe61e76fb45892e10d0ad7e62705f0141891be6a; strict GENF1 historical contract remains 71a6acf6f858715a5e04f4270ec2f52252bbee298259f513a69a59d7963d16ce. Original F1/GEN27 pins remain unchanged.

`python3 /tmp/phase47-R2-adopt27.py` exited 0: copied only .codex-plugin/plugin.json, host/plugins/delivery-pipeline/scripts/role-artifact.cjs and package-build.json using recorded publication_mode; all 161 bytes/modes match, other five repair mirrors already match. Package version 0.71.0+codex.b6b9be62476070be, SHA256 2784921034c5a5484f35f7c3016fb64e0f35a0e1983319b4226675f20a5b0f7c. Twenty original obligations and retained accounting fields compare unchanged. `node --test --test-name-pattern='R2|GENF1|F1|fresh original|materialization' tests/unit/phase47-runtime-acceptance.test.cjs` exited 0, pass7/fail0/skipped1. These are portable observations, not formal current27 proof.

Original sealed final F2 integrator report `/tmp/phase47-F1-complete27-integration-20261008/integrator-read.json` retains needs-fix/blocking1 at head 734cafce24671c65ab69dfbb038266dff665bae8. Actual native sourcefix `/tmp/phase47-26-R2-readonly-authority-result.json` and authenticated source26 finalization /tmp/phase47-26-R2-trusted-fixer-finalization.json retain passed proof 827ba1fd10077491a5159f9817e06cc450a2f8fb40d27a8a4d41ac5499abd76a; its two commands `node --test --test-name-pattern="phase47 original containment recovery" tests/unit/codex-decompose-host.test.cjs` and `node --test tests/unit/role-artifact.test.cjs` each record status0, outcome passed. Readonly default receipt authority and directCLI initialization are source-fixed; F1 evidence-bound policy remains intact. Fresh final aggregate re-evaluation remains owed; the old sealed report is not relabelled passed.

These observations are captured BEFORE current27 R2 finalization. External Root signed finalization after the finalized tree and exact four approved commands is the authority: `node tests/unit/phase47-package-publication.test.cjs --group candidate`, `node tests/unit/phase47-package-publication.test.cjs --group complete`, `node tests/smoke/phase47-runtime-acceptance.cjs --evidence docs/audits/phase47-runtime-acceptance.json`, `node --test tests/unit/phase47-runtime-acceptance.test.cjs`. No future proof, commit or verdict is asserted. Original twenty installed/native HOLD rows, accepted=false, native_launches=0 and inconclusive accounting remain exact. No fixture or Root acceptance is claimed. Fresh main-target judgment requires live complete head/base/membership and all original ordered outputs; integrator report limit remains 98304 UTF-8 bytes. Claude large transport remains a static nonselected-runtime limitation.


Post-copy genuine `inspectCandidate()` plus existing `validatePublication(process.cwd(), x.authenticated.selected, "complete")` exited 0; `/tmp/phase47-R2-postcopy27.log` records status passed, complete_outputs161, unchanged_obligations20, source15a205063774993bc35404b5c8c8f1013f98b016 and generation9365fc4817abc41cce69798cb84bf9a8938e4b9d1e0645ba5dce5a9781aebbd0. This direct publication check is separate from Root’s formal grouped four-command finalization.

## Historical GENF1, GEN27 and earlier records

All following current/pending assertions describe their historical generation and observation time; none authorizes current R2 bytes or asserts the state of subsequent external finalization.

# Historical T-47-27 F1 adoption — observations before its finalization

The genuine current check `node - <<'JS'
const fs=require('fs');const s=require('./tests/smoke/phase47-runtime-acceptance.cjs');const r=s.inspectCandidate();fs.writeFileSync('/private/tmp/t4727-F1-current-inspection.json',JSON.stringify(r,null,2));console.log(JSON.stringify({identity:r.identity,changed:r.binding.changed_outputs,keys:Object.keys(r.binding)}));
JS` exited 0. It authenticated the original signatures and strict source/configuration/history guards for generation 12b4367bd4d9aaf0dbaea193a5c6693de09499c652a59b3d935d9cad5e022fa8, namespace ADR-027-main-review-repair-F1. Handoff /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair-F1/generation.json SHA256 27ca0d42db637e83f181d398f0d047959d4295a8486967cfe798dd24476e5509; source approval /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair-F1/source-approval.json SHA256 9b7291009e3f5192c2a9f303073556c4cc369638f600c672ec709673f1ba5a91, signature /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair-F1/source-approval.json.asc; fixed signer 2F485C0A455BA33463F66332900FCE87BD1BFF0D. Source HEAD 485058d9797efc40469a6db005dc4449e68015b1, tree e1182e67cd5b7ff0316f2f5fdd2285fc715a1cf1; worktree /Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-27; common directory /Volumes/KINGSTON/claude-shipyard/.git. Run identities remain the signed source/native records; this adoption is not a native receipt.

Selection /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-F1/selection.json SHA256 68623cda4d53280dca2ad625589a45680b54949ed69afad81f3598cddc5d00f5; binding /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-F1/12b4367bd4d9aaf0dbaea193a5c6693de09499c652a59b3d935d9cad5e022fa8/binding.json SHA256 3753108de3d078bc90ee50c8618f28f6170b03756c94f2419855ba80c1ed7523; candidate /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-F1/12b4367bd4d9aaf0dbaea193a5c6693de09499c652a59b3d935d9cad5e022fa8/candidate inventory SHA256 5d65e961849d844980bcc526163ba435dfaf701fdfc5dd1724de2470fcdccfb1. Package version 0.71.0+codex.1db8006491c9dd9e, package SHA256 e92fbef52606e1448f733d7a79c095f989db2e59943205ba3208d988caecc0cb, complete inventory 161. Only .codex-plugin/plugin.json, host/plugins/delivery-pipeline/scripts/role-artifact.cjs, package-build.json were copied using recorded publication_mode. The copy diagnostic compared all 161 tracked bytes/modes with the authenticated inventory and exited 0; the five other original repair mirrors already matched and were not rewritten. No builder, stage mutation, signing, commit or push occurred in this adoption.

Actual source26 PR447 corrects historical final-integrator needs-fix F1. Its original findings remain historical; fresh final native main-target judgment is still owed. Signed scope /tmp/phase47-F1-existing-contract-scope.json SHA256 853d28bce0ba31f135a12f197989a435516971242e03091dc9e73156c851b1a7 and pinned historical source contract /tmp/phase47-F1-pinned-historical-source-contract.json SHA256 07b20e75d00b8c40d7b4db4d8c6baf360e47860f998c9fc9c4035727990e9a14 retain their exact signed paths; only their two signature reads use guarded physical /private/tmp counterparts. Original GEN27 remains immutable. Fresh original-byte materializations V1 SHA256 2ef15f5583c34ec9da5b77bbec010b031fcf0d5b98e68ff54664a0b94affaba2 and V2 SHA256 d6a4c1a288f5f01445aa94511a4b3693c39b17e2853139bab5ce4046195273b4 preserve the original three mappings. Source39/coordinator48 remain independently authenticated.

These observations were captured BEFORE current27 F1 finalization. External trusted finalization is authoritative after Root runs exactly `node tests/unit/phase47-package-publication.test.cjs --group candidate`, `node tests/unit/phase47-package-publication.test.cjs --group complete`, `node tests/smoke/phase47-runtime-acceptance.cjs --evidence docs/audits/phase47-runtime-acceptance.json`, and `node --test tests/unit/phase47-runtime-acceptance.test.cjs` in their existing approved environments. No future signed commit, proof or verdict is asserted here. Source26 finalization /tmp/phase47-26-F1-trusted-fixer-finalization.json records passed proof e90b0231010d5ae3b87317802bead11426145a99028c51d0132834077747e1d9; its authenticated source results retain two passed commands: `node --test --test-name-pattern="phase47 original containment recovery" tests/unit/codex-decompose-host.test.cjs` and `node --test tests/unit/role-artifact.test.cjs`. It is a separate historical source proof, not current27 finalization. Post-copy genuine inspectCandidate plus direct complete publication validation exited 0, preserving all 161 outputs and exactly twenty original HOLD rows; targeted F1/history tests passed 5/fail0.

Exactly twenty original installed/native obligations remain HOLD, accepted=false, native_launches=0; unknown accounting remains inconclusive. No fixture or Root publication evidence advances native acceptance. Fresh final main-target judgment requires live head/base and authentic complete membership, all original ordered input outputs and a complete integrator report at most 98304 UTF-8 bytes. Claude large inline transport remains a static nonselected-runtime limitation. Original failed native executor, fixer/finalization provenance and prior adoption refusals remain history.

## Historical GEN27 and earlier publication records

All publication/finalization statements below refer to their historical generation and do not authorize current F1 bytes.


T-47-27 current publication: ADR-027-main-review-repair

Implementation verification and signing completed on commit `16d9aefb684fba1b032d3dc56ba778b333da3dce`, tree `a5c1de925f997c0b34c9e9b65e7affbf760c653d`, with signer `2F485C0A455BA33463F66332900FCE87BD1BFF0D`. The authenticated trusted-coordinator result `/tmp/phase47-27-trusted-finalization.json` records verification outcome `passed` and proof digest `af0835ea377fb69e147a8152780dab309f4196456776ad141fae7ee61b0572d6`; `/tmp/phase47-27-finalization-evidence.json` and sealed/validated publication `/tmp/phase47-27-publication-read.json` retain that same implementation identity. All four exact approved commands passed: `node tests/unit/phase47-package-publication.test.cjs --group candidate`, `node tests/unit/phase47-package-publication.test.cjs --group complete`, `node tests/smoke/phase47-runtime-acceptance.cjs --evidence docs/audits/phase47-runtime-acceptance.json`, and `node --test tests/unit/phase47-runtime-acceptance.test.cjs`. This is trusted-coordinator evidence (`native_receipt:false`), not installed/native acceptance. Verification and signing of any subsequent doc-only correction are owned by the conveyor after handback; this implementation proof does not cover those later bytes. Fresh final integration and main-target architecture judgment remain owed.

The existing Root-produced generation 3db73676e8576d95378669bc47977e0d396ef7db9afa7b168a5c7c0ff1ee4cdb is selected by /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair/generation.json (SHA256 3b678863a64f1d65606fc37ebcc75dd30c9e8650acd797b3eada909e67b0ef23); approval /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair/source-approval.json (SHA256 d362fdf1e835138d12ff119d039de9bc4b9a0f534a6f90c5ab54451a798ad23d) and their .asc signatures retain signer 2F485C0A455BA33463F66332900FCE87BD1BFF0D. Source actual merged26 HEAD 71f2895495ab2cb22f2542be13d4902437234cdc, tree f25b4305159e104d6a2d369311edb93cb9cb33e5, worktree /Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-27, common directory /Volumes/KINGSTON/claude-shipyard/.git. Run identities are the original signed native receipts; executor run identity remains unknown. Selection /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair/selection.json SHA256 35190ed9642cf33b582d03663a59430dd5ce2dd702fd54acb4c4b077b0b9f8ab; binding /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair/3db73676e8576d95378669bc47977e0d396ef7db9afa7b168a5c7c0ff1ee4cdb/binding.json SHA256 fb7fca84f3b0991558d68f2783a29e3f383fcd6dbd5512504fbeaa62b6c3d9d1; candidate /Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair/3db73676e8576d95378669bc47977e0d396ef7db9afa7b168a5c7c0ff1ee4cdb/candidate inventory SHA256 e9422b6254bb2f2f85ae8c81cc7a215c3567c29b4a1ff6f0d829a07273fa5f7d.

All six mirrors and both manifests were copied from this one 161-file stage, version 0.71.0+codex.9f0c3da5323cf055, package SHA256 710d97ebf62a307c4e3addbed269f2792d44870cc2082875a1bd389d1388c466. Exact delta: .codex-plugin/plugin.json, host/plugins/delivery-pipeline/scripts/claude-runtime-host.cjs, host/plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs, host/plugins/delivery-pipeline/scripts/codex-decompose-host.cjs, host/plugins/delivery-pipeline/scripts/orchestration-overhead.cjs, host/plugins/delivery-pipeline/scripts/planning-result-sealer.cjs, host/plugins/delivery-pipeline/scripts/role-artifact.cjs, package-build.json. The bounded publication work performed no build, install, signing or historical rewrite; subsequent trusted-host implementation verification and signing are recorded above. Read-only candidate/complete diagnostics remain distinct from that formal proof. Source39 2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9 and coordinator48 1195fed6807740e886592ba92ca99913368becde6b21d8de8126ecf134a0efe9 remain independently strict; GEN19 retains its frozen configuration and GEN21/GEN23 retain coordinator43 63a18625794b2772663567c95401ad91358daf13974f9c18117e0ce237256780.

Separately signed v2 original materialization /Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair/historical-materialization-2.json SHA256 db4c2aab32ae33189521720758c76446faac578b5e476e81a5431b45c5bdcf97 preserves v1 and supplies only the exact three measured original GEN21 research / GEN23 CONTEXT / GEN23 research entries. Consumers verify original predecessor/result/index/role/entry/retained bytes and current live document identities. Earlier prose below remains historical, including failed native attempts; no old generation acquires current-source authority.

The twenty original installed/native obligations remain HOLD, accepted=false, native_launches=0; unknown accounting remains inconclusive. Complete23 at HEAD 1a27045a1bfb87c3ecd58ce3be815bfb4c8f7f52 genuinely had integrator passed/blocking0 and CI37711154326 succeeded, while architecture refused original read protocol. Fresh complete final main-target semantic judgment remains owed at live head/base and authenticated membership, expected to include all 27 tickets. Every original ordered manifest/asset output is required; complete raw integrator report must be at most 98304 UTF-8 bytes with findings, decisions, commands and results retained through bounded references. Movement re-owes judgment. Claude large inline aggregate transport remains a static limitation of the nonselected runtime.

## Historical T-47-27 pre-finalization observation

Bounded repair sandbox verification completed: exact candidate and complete commands exited 0 with authentic signatures, 161-file complete parity, 189 private assertions and zero builds; staged contracts passed launch7/architecture156/detached2 with both public load orders. Exact ledger smoke exited 0 with evidence_check=passed and all twenty original HOLD obligations, accepted=false/native_launches=0. Targeted v1/v2 regressions and workingTree comment policy/diff--check passed. Trusted-host exact four-command verification/signing and fresh final main-target judgment remain pending; the reported candidate failure did not reproduce and its cause is unknown.

The pending state and failure observations above predate the authenticated implementation finalization; they are retained as history. All earlier publication sections below are historical.

# T-47-23 current ADR-027 volume successor

The operative branch is `ADR-027-current-ticket-volume`, generation `a096ae2afe9da4314994333128914a683074a42f1959573e5beab0ebb28ddf00`. Every section below the historical boundary retains its earlier T21/T19 meaning. Current publication and installed/native acceptance are separate: all twenty original obligations remain HOLD, accepted=false, native_launches=0, with unknown/inconclusive accounting unchanged.

The existing trusted coordinator built this immutable stage once after actual T22 merge `462683f52df5c3e2ab45a08d8a5e72f9281e5750`, tree `94d616d0ccaadb9c7bce551bc7fc12c1bffe6d3c`. Executor worktree is `/Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-23`; approved source worktree is `/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard`; common repository is `/Volumes/KINGSTON/claude-shipyard/.git`. Controller/run/writer lease remain unknown. Native source run identities are retained in the signed handoff's source_correction records and current researcher/planner/checker records; no executor run identity is inferred from them.

| Current identity | Path / SHA256 |
| --- | --- |
| Signed handoff | `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-volume/generation.json`; `32eb9144cc872ee6f6f4747ef83e475905c565effee16f93f64dc7a7e8d7062f` |
| Distinct signed approval | `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-volume/source-approval.json`; `547bc307249ac7aaa8ceaa0c690e473a8f34819333a8d2c0dad141307a3d304d` |
| Selection | `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-current-ticket-volume/selection.json`; `d98122718e031c63e4e7f2937824abb213e1e1b1ed403ef1795f594e8e381d51` |
| Binding | `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-current-ticket-volume/a096ae2afe9da4314994333128914a683074a42f1959573e5beab0ebb28ddf00/binding.json`; `8bd7eb3d844b0255ace7d57d106b4fe683c826f7c240b24d781e0f8699c304f7` |
| Candidate inventory | `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-current-ticket-volume/a096ae2afe9da4314994333128914a683074a42f1959573e5beab0ebb28ddf00/candidate`; `0326df20c175f80f7f3f99034e1d4ab2e247c698a85eb0fa38f81db72f5f16e5` |
| Frozen pre-T23 ledger | `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-volume/prior-final-runtime-acceptance.json`; `da5aa475e068eb28110d04f8f730363538bc606db6ba2cec7566096877d72284` |
| Frozen pre-T23 handoff | `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-volume/prior-final-runtime-handoff.md`; `675e86304f2d16360090fd2519919aeea3dbe335dfe97a08f4b08e488aff7fe4` |

Package SHA256 is `f25362a504e739afb3000a51cd3c223033b8cf19f64a9a5df29348cea8dd2a54`; content-derived version is `0.71.0+codex.c7c7e59fda712a64`. The complete inventory has 161 files. Exactly three generated outputs were measured and copied from this same stage, each mode 0644:

- `.codex-plugin/plugin.json`: 924 bytes, SHA256 `bbb47aa6773d971409cee345898260e798a7a69e0d87880e5a62c7b8a4b1d166`.
- `host/plugins/delivery-pipeline/scripts/role-artifact.cjs`: 191327 bytes, SHA256 `55d814c4812f83e36f4054436f4030c865ee7f3d8088ada20eda14bf6d75075d`.
- `package-build.json`: 300 bytes, SHA256 `097f81cbc660465b52b558bc107b3a95c0456b8135ce06cd4574f09a6b201105`.

Fixed signer remains `2F485C0A455BA33463F66332900FCE87BD1BFF0D`. Source39 `2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9` and coordinator43 `63a18625794b2772663567c95401ad91358daf13974f9c18117e0ce237256780` are authenticated independently. Neither is copied or waived. PLAN22 `5225fd21717e38d59a10c2921e1e1dfd8b54c0a2bc1c3e1115a623485095b7b7` and PLAN23 `c6a3f59e634d5683b2c7cda80520d0d4584dffb4bf9ad2d62bab67dddcedfc8c` are bound to the genuine current checker and planner index/child/first-call evidence.

Immediate T21 predecessor `a56da0e28c524cbc55821e10f5791404229f85442edc4424e808b3768b870f15` remains signed and immutable, with its five-output allocation and approval `a7e71a2f9f2a53d3a828adb46a19544e40e98da50f8e5169b3c9f5d113d308fc`. The T19 nine-output and original T05 twenty-output generations and original native chains remain authenticated history. PLAN21 remains `e0477ce6956720fd9697474731dea417626e7128cd84868c91b663d9a17a2f66`.

T22 initial executor remains verification_failed; fixture-kind ci-fix, distinct signed executor review completion and CI-cost ci-fix remain separate genuine records. The initial CI cancellation is preserved. The signed current approval binds the actual two-command final2 proof and actual complete22 merged parents; no failed or cancelled outcome was relabelled.

`node tests/unit/phase47-package-publication.test.cjs --group candidate` passed on the real stage with 169 private fixture checks and zero inspector builds. Complete parity and ledger smoke passed; measured results are recorded below. The exact `node --test tests/unit/phase47-runtime-acceptance.test.cjs` HOST/600000 ms assignment remains pending trusted verification and is not run in the sandbox. Formal host-assigned verification/signing remains the trusted host's responsibility.

Final complete23 main-target architecture/integration remains outstanding after actual T23 merge. The coordinator must use the live head/base and complete phase membership, consume every original required manifest chunk and asset, and retain a complete integrator report of at most 98304 UTF-8 bytes. Preserve the earlier complete-input consumption refusal and 983049-byte integrator sealing refusal; neither supplies a current passed gate or an invented product violation. Source/head/base movement re-owes judgment. There is no phase48 dependency, install, recovery, process restoration or global audit in this publication.

## Measured T23 executor checks

Candidate authentication exited 0 before copying. The one complete invocation exited 0 after copying: 161/161 files, all six existing groups, 169 private fixtures, and stageContracts launch 7/7, architecture 156/156, detached 2/2, plus two public load orders. Both publication checks reported zero inspector builds. Ledger smoke exited 0 with evidence_check=passed, twenty open obligations, accepted=false and native_launches=0. These are current executor sandbox observations; formal trusted scoped candidate-tree verification remains pending. The exact HOST acceptance command has not been run in the sandbox.

Working-tree comment policy used the existing analyze API with workingTree:true against actual baseline 462683f52df5c3e2ab45a08d8a5e72f9281e5750: ok=true, 301 added lines inspected and zero added comments. `git diff --check` exited 0. The generated mirror was recognized as a verified generated copy.

| Measured artifact | SHA256 / bytes |
| --- | --- |
| `/private/tmp/t4723-complete.stdout.json` | `b30036b6774c9b7530d54b90a3226cbca7c184d8c69e2e4aa1d9c9c96d152f89` / 4010 |
| `/private/tmp/t4723-complete.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` / 0 |
| `/private/tmp/t4723-ledger.stdout.json` | `4736105b2ddf80c9253e80dfcf3d37299637e6f4402094fa00bb6e7c1c8eb8c5` / 13062 |
| `/private/tmp/t4723-ledger.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` / 0 |
| `/private/tmp/t4723-comment-policy.json` | `777db4a8a1a02966a35c766b6cab858f50e1e128d980deee77178a167a07f2ca` / 1909 |
| `/private/tmp/t4723-publication-copy.json` | `0daeecfefa8f41d60cb437c26b9ff024d56e3d438c3a6cf6f52d7da0ec43d862` / 1024 |

## Historical T21 and earlier records (frozen meaning)

# T-47-21 current ADR-027 successor

The operative current branch is `ADR-027-current-ticket-evidence`. All T19 prose below is retained history, superseded for current inspection. Current inspection refuses missing, unsigned, stale, foreign or changed authority; source refusal is blocking and cannot become HOLD.

The coordinator built the immutable successor once after actual T20 merge `c9bd8ccae0c688e034cf9f94df4ad0cfc4c909b7`, tree `81ba5853ced3f8d07cd21b7d27d0fa00e7f77732`. Executor worktree is `/Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-21`; common repository is `/Volumes/KINGSTON/claude-shipyard/.git`. Executor controller/run/writer lease are not supplied and remain unknown. Current duty is an uncommitted eleven-owner handback to the dispatched coordinator; no new delivery loop is started.

| Current identity | Path / measurement |
| --- | --- |
| Signed handoff | `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-evidence/generation.json`; SHA256 `a56da0e28c524cbc55821e10f5791404229f85442edc4424e808b3768b870f15` |
| Signed source approval | `c9bd8ccae0c688e034cf9f94df4ad0cfc4c909b7`; `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-evidence/source-approval.json`; SHA256 `a7e71a2f9f2a53d3a828adb46a19544e40e98da50f8e5169b3c9f5d113d308fc` |
| Selection | `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-current-ticket-evidence/selection.json`; SHA256 `78d96a5b9a001170e4e3e02050025acb8cc569ea4605ee3ca7b98cb4d3fe9b59` |
| Binding | `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-current-ticket-evidence/b0c89350a4d253d539a4cb39abf299e422807f5ce11be575c688d5dec47842bf/binding.json`; SHA256 `fe4054ea3b5703be85a57acf3930535593d7cff0ffbe3e9bd7a31981efae4822` |
| Candidate | `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-current-ticket-evidence/b0c89350a4d253d539a4cb39abf299e422807f5ce11be575c688d5dec47842bf/candidate`; inventory SHA256 `01b5ada28446a2e03aee831767d08e2b6fb2209576bb61298dfa38d61d929e23` |
| Generation | `b0c89350a4d253d539a4cb39abf299e422807f5ce11be575c688d5dec47842bf` |
| Package / content version | `fe3f1b1bb516cc53df5e02bfce457dd7c926dc990685434e75b5dcf34b310f8b` / `0.71.0+codex.0010d0b2f631cd73`; 161 files |
| Policy | `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570` |
| Reviewed source39 configuration | `2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9` |
| Coordinator43 configuration | `63a18625794b2772663567c95401ad91358daf13974f9c18117e0ce237256780` |
| Frozen pre-T21 ledger | `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-evidence/prior-final-runtime-acceptance.json`; SHA256 `cdfc741be2c9e3dea66818ac2a1c86272c7f3ac19605024c9816fa19a518092c` |
| Frozen pre-T21 handoff | `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-evidence/prior-final-runtime-handoff.md`; SHA256 `8384d2a06b12b1a881a6abf94580e9edf7eec94434dc881e4c5d053fb29ef9a1` |

The five mechanical publication outputs are three mirrors (`role-artifact.cjs`, `codex-arch-review-context.cjs`, `claude-role-host.cjs`) and `.codex-plugin/plugin.json` / `package-build.json`. They are copied from the same immutable supported stage with recorded publication modes. No builder, signer, stage repair, global installation, digest-index edit or config edit belongs to this executor. Full package inventory retains `architecture-target.cjs`; original sixteen native owners/twenty outputs and T19 nine-output correction remain distinct historical inventories.

The signed handoff preserves original T05 and actual T19 selections, signatures and source bindings. Native original planner index `6fd5a44ad6ee4d47a33c84317dbb0b2774165814eae40fed9a007a3fcfbb3992` remains historical; explicit operator amendments do not relabel its original PLAN bytes. Current independent checker `dispatch-phase47-seven-owner-serialized-checker-b1ca8c93-a611-4183-a4df-d303112b7385` binds actual PLAN20 `d4f25b6a0668eb2848b73dc0738f6c166883a232aa607142b5b9d066537bc9c6` and PLAN21 `e0477ce6956720fd9697474731dea417626e7128cd84868c91b663d9a17a2f66`. Its retained native child transcript `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-evidence/current-checker-native-child.jsonl` has SHA256 `2f303a62351532a8e3984042a13cb0487c4223925163359f2817eda67eecbf27`. The original task relay file is absent; its signed binding and original first-call hash/output in the retained transcript are inspected without reconstructing it.

Original failed T20 executor `/tmp/phase47-20-archive-scope-result.json` / `5d8789eed50f9c794218405281038f570b4e4162f51993aba2dd48707ccec3d2` remains `verification_failed`. Source ci-fix `/tmp/phase47-20-aggregate-caller-repair-result.json` / `aeeab38cb08374a313f19432a299ec3ef5af0a82a0c6a347f28173e6234f93be` and actual PR439 fixture ci-fix `/tmp/phase47-439-ci-fixture-fix-result.json` / `27a05a26d0aabc8b684fc9cdf5929e7e2fd33e6295ffe79705d6b0e70f9ce5f8` are separate genuine results. Final supported T20 four-command envelope `/Users/serhii/.local/state/shipyard/codex/finalization/a6723cb3f1aa3e9687e201328c112897c038bba1d262791977fe6ad587f2fde4/verification/6f144e5f4b18bd666b29bc78ae6a03c69bb60afb0ae7f6de1c52202fb6f9b124.json` binds digest `6f144e5f4b18bd666b29bc78ae6a03c69bb60afb0ae7f6de1c52202fb6f9b124` and passed outcomes to the actual source tree; it does not change earlier failures.

Original twenty native obligations remain HOLD, `accepted=false`, `native_launches=0`; accounting remains unknown/inconclusive. Package equality and trusted-coordinator approval (`native_receipt:false`) do not prove installation or native completion. All earlier checker/CI/HOST denials, architecture preflight refusals and unsealed native results remain history.

Sandbox checks are candidate, complete, ledger smoke and runtime-digest `--check`, sequentially. Complete covers all six existing publication groups and stage contracts on the same tree. The three exact HOST/600000 ms assignments stay pending trusted coordinator verification; they are never launched in this sandbox. The acceptance suite's protected-authority EPERM cause remains unknown. Actual environment refusals must be retained separately from assertions and passed checks.

After actual T21 merge the coordinator owes complete current-phase architecture/integration at the final PR into main, live head/base and membership including T20/T21. Ticket-to-epic architecture is skipped-by-target. The previous nineteen-ticket integrator's passed raw report was 983049 bytes and sealing refused; it is not a sealed final gate. Preserve the raw report and refusal in coordinator evidence. A fresh complete integrator report must be at most 98304 UTF-8 bytes with all findings/commands/results/limitations and concise path/digest references; no limit change or truncation is authorized. A moved head/base re-owes review. Next criterion: trusted verification/signing/finalization of this actual uncommitted candidate, then actual merge and final aggregate native judgments.

Retained unaccepted final history (measured during T21; these references do not establish a sealed current gate):

| Evidence | Bytes | SHA256 |
| --- | --- | --- |
| `/Volumes/KINGSTON/worktrees/phase47-final-integration-current/claude-shipyard/.planning/phases/47-complete-deferred-decomposition-wait-attribution/INTEGRATION.md` | 983049 | `a82f09ca1397b5f1578d2f3527fc610e331bd76d81d287184a346a51ad1f85ce` |
| `/private/tmp/phase47-final-integration-20261007/integrator-result.json` | 11317 | `9d3eb371e013eac27d9cdcdfc6eee6709e6744a6a61674757abc7fc0d336b4bd` |
| `/private/tmp/phase47-final-integration-20261007/integrator-native-result.json` | 7304 | `fd7abf3623ad94eebb795048f12598602e65e346995b44376a60e15416a6d48f` |
| `/private/tmp/phase47-final-integration-20261007/architecture-stderr.log` | 75 | `9e380681efd18ec9938321829625587362addc8f80b8a1e7a8030c9efad12a22` |
| `/private/tmp/phase47-final-integration-20261007/architecture-canonical-stderr.log` | 152 | `a577729893df284c4d86e3be968074cc7d5ae937a433ed7da74bca4ab99ce43a` |
| `/private/tmp/phase47-final-integration-20261007/architecture-approved-source-stderr.log` | 243 | `28581e04037685557cdca31a0cf6997df5bf9464bd6d75017df65554fde57d73` |

The original integrator sealing-refusal transcript path/digest was not supplied; it remains an explicit coordinator retention obligation. The 983049-byte raw report and its native passed result remain distinct from a sealed final verdict.

T21 local sandbox handback: candidate and complete exit 0 with 139 fixture cases / zero private builds; complete verifies all 161 outputs and six groups, stage contracts 7 launch / 156 architecture / 2 detached plus two load orders. Ledger smoke exits 0 with `evidence_check=passed`, `status=HOLD`, `accepted=false`, `native_launches=0`, twenty open obligations. Runtime digest check exits 0. Original logs and SHA256 are recorded in the current ledger under `current_verification.sandbox_results`; these local records are not trusted HOST/native receipts. The three HOST assignments remain pending and were not attempted in this sandbox.

---

# T-47-19 current durable handoff

Historical executor duty: return the uncommitted fifteen-owner implementation
to the existing trusted coordinator. Current duty: return these three document
repairs, uncommitted, for trusted verification and publication. Worktree: `/Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-19`. Executor source HEAD: `8192ba38942be328b27f8aa54984eae7cd47231c`;
source tree: `4ba34341bc4e94620de21a4c81d58a2f627afdca`. Common directory:
`/Volumes/KINGSTON/claude-shipyard/.git`. Current executor controller/run/writer lease are
not supplied and remain null; this handback does not infer them from a historical
research receipt. No host cleanup paths/PIDs, safe rollback identity, installed
release or new paid native collection is claimed.

Current signed handback: `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr026-source-update-1/generation.json`,
SHA-256 `d788b6e1be9b78914d9e58f1d9fb88f5069a0ece2517a22e9b80973c75ebccfe`.
Signed source approval: `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr026-source-update-1/source-approval.json`,
SHA-256 `c91002a34bf75f85d4860a052310b1b84fff1aadfe7e57be9ea433a4ac4ca659`.
Selection: `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-026-source-update-1/selection.json`, SHA-256 `012a1889290a5aa9cd76e50eb291b3b09d156acc4c17506a26514e285f1905a6`.
Binding: `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-026-source-update-1/4e63582ca45a0dc5edd2f63fd46ccc07afbff13cf3e71f8d6bbb305715598d50/binding.json`, SHA-256 `21c9c96cbebedf1a3029a93bd5ae650fdbecdb1c0e28352a0c6285c4a184a996`.
Readonly candidate: `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-026-source-update-1/4e63582ca45a0dc5edd2f63fd46ccc07afbff13cf3e71f8d6bbb305715598d50/candidate`, inventory SHA-256
`e92f06723873ad56a3337f011cc144b4ce7a287a972c28f6f6a86b751dd536c8`. Package: `56e4bb0aa02dbcacb9c0ab4764adc575d5b565cb8ca01d18ce630be80ea6aa8d`;
version: `0.71.0+codex.3274a569f21d3bce`; complete inventory: 161 files.
The four corrected mirrors/plugin manifest, three shared mirrors and build
manifest all come from this single coordinator-supported stage with sealed bytes
and original publication modes; no builder/signing authority was used here.

Original T05 and superseded first-final selections, signatures and approval links
remain immutable. Superseded first-final handback SHA-256 is
`83441e6d3f4a65b8b6018e9a753c1c7ea95a64181cf49a4b8877d679f55ae799`;
it retains source 72f033c9 and eight-output correction history. Current D22 source
8192ba38 uses seven mirrors plus two manifests, nine outputs. This history is
separate from original sixteen native owners and twenty mechanical outputs.
The full 48868-byte original ledger is retained under
`/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr026-source-update-1/original-runtime-acceptance.json`, SHA-256 `592439dcf4d663f9a072d280dfbb9b6866d43061ffda8094cdc5ddbd94c5d98d`.
Original refused research and missing capacity, notification, GPG, cleanup,
installed/native acceptance and unknown accounting retain their prior meaning.

Verification outcomes are measured in `.shipyard-evidence.md` and the current
ledger's `verification` field. HOST acceptance units and three final HOST tuples were pending at the sandbox
executor handback. Subsequently, the trusted coordinator reported all twelve
exact PLAN19 commands passed and signed predecessor commit
`c21e04e1e7863bb1f07a562145a8c2faaf46241a`, tree
`af3fd000fac48cf083d5dbd245ec3b21a7324444`, with verification evidence digest
`1fd8c0dc7d7674dfc322daf21c36a7636cad44a8af7e882f8dbe2a608231dba3`.
The commit trailer and `/tmp/phase47-19-final-publication-result.json` identify
that predecessor; the coordinator reports CI run `37626213827` passed. The
protected host proof is unavailable to this sandbox and the CI API could not be
reached for independent rechecking. This record summarizes the coordinator
report, without inventing per-command outputs or a native acceptance receipt.
Fresh verification of these document edits remains pending with the coordinator. No fixture result replaces host proof. An actual failure blocks;
protected-authority denial remains unresolved without a permission change/retry.

Next criterion: fresh trusted verification of this document repair, supported
signing and coverage, then coordinator publication/merge. After genuine 19 delivery merge,
obtain fresh full architecture and integrator judgments at exact live final
head/base and complete phase membership. Do not relabel earlier ticket-target
skips or fabricate a verdict. These later judgments do not block native executor
handback. Preserve the existing writer/recovery order and phase48 independence.

Historical executor sandbox results: all six publication groups exited 0; complete parity covers 161 files.
Current smoke exited 0 with evidence_check:passed, HOLD, accepted:false, native_launches:0
and twenty open obligations. Runtime digest check exited 0. At that handback the acceptance unit
and three HOST tuples were pending; full output hashes/durations are recorded
in `.shipyard-evidence.md` and the ledger.

Post-edit sandbox diagnostics: `node --test tests/unit/phase47-runtime-acceptance.test.cjs`
exited 1 (17 passed, one packaged public-load-order test failed with
`native spawn must be reached`). The exact smoke command
`node tests/smoke/phase47-runtime-acceptance.cjs --evidence docs/audits/phase47-runtime-acceptance.json`
exited 1 (`ERR_ASSERTION`). Direct `validateLedger` diagnosis identified
coordinator `delivery-state.json` digest drift: observed
`c1e4d846c924100c3412b61e59cef52fe98cce58d0dfa962d3f90d4ca6a6ae24`, expected
`be5bc64f990bd6f15cb679939f32ac81fbff165796dfaf8f3c62f0cdd8605d0d`.
These are unresolved post-edit checks for the trusted coordinator; no authority,
source, graph, generation or expected digest was changed to bypass refusal.

## Retained original T08 handoff (historical)

The text below describes the earlier T08 worktree and duty. Its receipts and
resource exclusions are retained; they do not identify the current executor run.

# T-47-08 durable handoff

Current duty is **finish the executor handback to the trusted coordinator**.
The five declared files remain uncommitted. The trusted host stages, signs,
verifies and retains the completed result beside its original authenticated
receipt outside this checkout. No tracked phase SUMMARY is created; existing
historical SUMMARY, UAT and VERIFICATION artifacts retain their prior meaning.

Assigned worktree:
`/Volumes/KINGSTON/worktrees/phase47-investigation/.wt-claude-shipyard/T-47-08`.
Git repository/common directory: `/Volumes/KINGSTON/claude-shipyard/.git`.
Dependency head: `6d47be603714b8c493838424242fc0435ecec322`, tree
`8debd6b2db46fc38cb9982ed7277d362f542975b`. This is PR433's recorded draft
publication head, distinct from original generation source
`29e0b404fecd7cd711ee5cf29de9a3dfc8e44e82`. Canonical input identity is
`bbf5ec33bf9b5bd1e5361254fb740c90c2e91d48f31b3f7bee700848fea76c34`.
The ledger retains the exact original tree, binding, selection and package hashes.

The read-only existing authority inspection was:

```text
node plugins/delivery-pipeline/scripts/session-handoff.cjs inspect --cwd . --runtime codex
```

It exited zero and returned `shipyard.session-handoff.v1`, the exact common
directory, `next_epoch: 1`, and `scopes: []`. It establishes no active owner or
finished resumable scope. Executor controller/run/lease/callback identity was
not supplied; these fields are null/HOLD, not a newly created owner. The inherited
canonical graph directory is
`/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard/.planning/graph`.
Do not attach this executor to the original INV014 run or another controller.

Completed actions: created the bounded runner/procedure and regressions; inspected
the sole candidate without generation; verified original INV014 archive/receipt
identity read-only; recorded each remaining acceptance obligation and owned
resource exclusions. The scoped unit tests execute package-bound fixture
boundaries; their results do not replace actual installed/native proof.
The ledger's `verification` field and the external completed result retain the
exact commands, outcomes and executable digests. Do not replay unchanged owner
suites to replace missing original receipts.

Historical completed research duty belongs to run
`deliver-build-research-INV-014-runtime-delivery-correctness-063888d6-af70-44c6-8295-f69792282744`.
All four original INV014 dispatches and archives are retained in the ledger and
authenticated during the smoke check. They prove original historical research,
not final installed release. The original capacity refusal and successful
same-model retry remain separate evidence. The historical capacity record reports
`server_overloaded`, zero accepted artifacts and released lease; it cannot establish
the state of any current planner/checker writer.

Acceptance duty remains HOLD. 12's current publication bytes match the single
stage, but its original complete parity receipt/current-head human approval and
landing are not supplied by a merged summary. The installed isolated runtime,
capability, installer environment, original native parent/child trace, fresh
planner/checker first-call receipts, installed architecture consumption/capacity,
notification lifecycle, applicable host assertions/cleanup and exact rollback
identity remain separate prerequisites. PR418's original history and historical
GPG unknown risk remain retained. The sentinel API discrepancy/network cause is
unknown pending bounded host-owned collection with a fixed installed identity;
no privilege expansion follows from that unknown.

The next criterion is authenticated coordinator inspection of the actual
writer/controller/run/lease and original completed-result receipt. Retain exact
failed role, primary error, accepted siblings and unaccepted artifacts. None of
those current-run identities may be guessed from the executor branch or a stale
research receipt. **Never refresh context or manifests while a callback owns the
writer.** Establish authenticated completion/release first. Then, under existing
authority, refresh only if safe and source-bind any retry to the failed role;
accepted siblings remain sealed. Unknown outcome requires recovery inspection
before relaunch. This recovery ordering adds no ticket code dependency.

Resume finished handback/publication duty through existing session-handoff
inspection and coordinator authority. Do not begin a new owner, resurrect
completed research or use automatic transfer. Current-head human APPROVED
review, trusted-host signing/verification and merge remain the host's gates;
autonomous implementation closes none of them.

Resource inventory and disposal disposition:

| Resource | Exact identity / owner | Disposition |
| --- | --- | --- |
| Selected generation stage | `/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-publication/INV-014-runtime-delivery-correctness/bbf5ec33bf9b5bd1e5361254fb740c90c2e91d48f31b3f7bee700848fea76c34`; original 05 trusted generation owner | RETAIN; acceptance/rollback/recovery prerequisite; no disposal authority supplied |
| Exclusive selection | Same publication root's `selection.json`, SHA-256 `845a90729264029e5bdd78c92c2c60c288faa381541710d1c0007f293349956a` | RETAIN unchanged; never replace/regenerate |
| Binding | Stage `binding.json`, SHA-256 `1a622db6af3fe989dbdc603fa22f7493b6b6120f8ff0fb18ded889ff33e7c4c8` | RETAIN read-only |
| Original generation handback/signature | `phase47-current-generation-20261006` under the existing 6cba328f… host root; full original path/digest in ledger | RETAIN; coordinator-owned original preparation |
| Four sealed INV014 archives/receipts | Existing `/Users/serhii/.local/state/shipyard/codex/0fd9a841a5da4528f18a5ddd346452ddd67b8bbf03ddc67639480665e11af98f` | RETAIN; original evidence; never a disposable test store |
| Original research request/result/capacity refusal | `/Users/serhii/.local/state/shipyard/investigations/INV-014-20261003` | RETAIN; unknown historical causes remain unknown |
| Assigned executor worktree and five dirty output files | Exact worktree above, coordinator-owned | RETAIN until trusted handback; no git reset or worktree deletion |
| Unit-created temporary package copies/repositories and notify delegates | Exact mkdtemp returns owned by each fixture; no live acceptance install | Disposed by scoped fixture finalizers; do not rediscover by prefix or stage for host cleanup |
| Actual installed cache, prior safe package, disposable native notify/GPG resources | Current exact path/PID/run ownership not supplied | HOLD; no install/deletion occurred and no wildcard cleanup is staged |
| Backups, dirty preparation, unrelated runtimes, original receipts and sealed archives | Existing owners | Excluded from deletion |

There are **no host cleanup candidates or PIDs staged**. Exact previous disposal
evidence is required before maintenance stages any later path/PID. A prefix,
empty session inspection, merged ticket or matching bytes is not ownership.
Rollback package identity and approved restore argv remain null/HOLD. Keep the
stage until durable acceptance, safe rollback and recovery references exist and
the original owner explicitly authorizes exact disposal. Rollback must preserve
known notification mitigation and signing/isolation authority.
