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

# T-47-19 current final publication

Current inspection requires `ADR-026-source-update-1`, handback SHA-256
`d788b6e1be9b78914d9e58f1d9fb88f5069a0ece2517a22e9b80973c75ebccfe`. A missing or invalid current selection refuses;
HOLD applies only after candidate authentication. No original or superseded stage
is a fallback for current acceptance.

The reviewed source is `8192ba38942be328b27f8aa54984eae7cd47231c`, tree
`4ba34341bc4e94620de21a4c81d58a2f627afdca`, after actual T18 merge
`72f033c994053654d5025e128081ee37be0e04b7`. D22 changed only canonical
`plugins/delivery-pipeline/scripts/architecture-target.cjs`; its generated mirror
is mechanically copied from the supported successor candidate. Current 15-owner
PLAN SHA-256 is `d12c3b870fda04f0dc1f2f6afcebedbfad619f8961662ac253ad2abd45d781e8`;
task sizes are 3/5/3/4. The signed fresh checker authenticates this amendment;
the historical checker retains its original contract and receipt meaning.

Current generation is `4e63582ca45a0dc5edd2f63fd46ccc07afbff13cf3e71f8d6bbb305715598d50` with 161 package files,
version `0.71.0+codex.3274a569f21d3bce`, package SHA-256 `56e4bb0aa02dbcacb9c0ab4764adc575d5b565cb8ca01d18ce630be80ea6aa8d`.
The seven host mirrors and two manifests are the exact nine-output delta from the
reviewed checked-in package, copied with original publication modes. The original
T05 stage has 160 files, sixteen native owners (thirteen T14 plus three T15), and
twenty historical mechanical outputs. Those inventories and all original receipts
remain historical anchors. Earlier fifteen/nineteen statements below are retained
historical prose, not the operative inventory.

Source configuration is independently pinned to
`2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9` and checked against reviewed Git and
the source checkout. Operative coordinator configuration is separately pinned to
`6f3f3a35b9a0cbd31ec686b5b0f0bd67e0790d13d612cf42e3aa9f635ca969a0`. No equality waiver links the two.
Canonical bytes, modes and source ancestry remain strict on the checkout and the
signed epic branch. Only publication/test/docs descendants are admitted; even a
canonical change later reverted refuses. The supported builder is unchanged and
never invoked by either current consumer. Signature verification uses only an
owned temporary public keyring; no signing or installed native launch occurs.

The canonical context reader's `boundedBytes` rejects world-writable non-sticky
ancestors, but does not reject group-writable ancestors. Its leaf checks reject
symlinks and group/world-writable leaves, use `O_NOFOLLOW`, and compare descriptor
and pathname identity before/after reading; manifest/assets are checked against
pinned SHA-256 values. These checks do not establish directory-anchor protection
against every ancestor replacement race. Broader ancestor hardening is expressly
deferred. Changing that canonical reader requires separate source approval and a
new supported generation; no such fix or regenerated mirror is claimed here.

The entire original ledger is retained at `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr026-source-update-1/original-runtime-acceptance.json`,
SHA-256 `592439dcf4d663f9a072d280dfbb9b6866d43061ffda8094cdc5ddbd94c5d98d`, 48868 bytes,
and authenticated by the signed current handback. All twenty original obligation
rows, historical research/refusals/reasons/references and null accounting remain
unchanged. Current preparation is not installed identity or native acceptance.
`evidence_check: passed`, `status: HOLD`, `accepted: false`, `native_launches: 0`
is the expected valid missing-native smoke outcome, never a substitute for a pass
when source, selection or package authentication fails.

Run the six existing publication groups (`candidate`, `launch`, `caller`,
`integration`, `relay`, `complete`) sequentially using
`node tests/unit/phase47-package-publication.test.cjs --group <group>`.
Relay checks every non-manifest package file; complete checks all 161 files.
The sandbox smoke and `node scripts/refresh-runtime-digests.cjs --check .` follow
publication. The acceptance unit command and all three assigned final HOST tuples
belong exclusively to the trusted verifier with current scoped candidate-tree,
source and PLAN admission. At the sandbox executor handback, their results were pending. The trusted
coordinator subsequently reported all twelve exact PLAN19 commands passed and
signed predecessor commit `c21e04e1e7863bb1f07a562145a8c2faaf46241a`, tree
`af3fd000fac48cf083d5dbd245ec3b21a7324444`, with verification evidence digest
`1fd8c0dc7d7674dfc322daf21c36a7636cad44a8af7e882f8dbe2a608231dba3`
(the commit trailer retains this digest). The authenticated publication result
`/tmp/phase47-19-final-publication-result.json` identifies that commit/tree.
The coordinator also reports CI run `37626213827` passed for that predecessor.
These are predecessor results, not verification of these subsequent document edits.
The protected host evidence is unavailable to this review-fix sandbox; exact
per-command host output and CI status cannot be independently rechecked here.
Fresh post-edit trusted verification and publication remain pending. A denial remains unresolved and genuine assertion failure blocks.
No global install, push, GitHub message, finalizer or coverage action is performed
by this executor.

After genuine 19 handback and delivery merge, the coordinator obtains full phase
architecture and integrator judgments at the actual final integration head/base
and complete membership including 18/19. These are retained final obligations,
not a prerequisite to this executor's native handback. Ticket target skips do not
supply a conformity verdict. Phase 48 remains independent.

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

## Retained original T08 procedure (historical)

The text below is the original procedure at the retained ledger snapshot. Its
source/package and delivery-state statements describe that earlier handback.

# Phase47 isolated runtime acceptance

T-47-08 implements bounded evidence inspection. Its two Verification commands
can pass while phase acceptance remains **HOLD**. Exit zero means supplied
evidence was checked and every uncovered property stayed explicit; only
`accepted: true` with no open obligations means acceptance. A fixture result,
merged ticket, transport exit zero or matching cache bytes cannot supply native
proof. No public rollout, signing, merge or prior UAT completion is authorized.

The delivered PLAN SHA-256 is
`99710c9577d76ead5514b1ba00e5277571ef6ff9827f8d06cb692ef6284fe42c`.
The delivered context is the execution contract; unavailable planning documents
are not reconstructed. The immutable generation is
`bbf5ec33bf9b5bd1e5361254fb740c90c2e91d48f31b3f7bee700848fea76c34`.
It contains 160 package files. The landed publication checker allocates twenty
changed outputs (five plus nine plus six), including the Claude native guard;
the delivered prose's nineteen-output count does not permit dropping that file.

The pinned package digest is
`6be2bdeefdcb339c4a19fe863cb05462083dd4de194306b92688f063bd68991a`;
the plugin manifest digest is
`62820bdf169cb1d4d2ab35dfe9fb07a7dbb21f67a97935de014989cabf1b3e1d`;
the version is `0.71.0+codex.08a9403153faa8aa`. The original source is
`29e0b404fecd7cd711ee5cf29de9a3dfc8e44e82`, tree
`adace6f023b8b6913a313dcced9c0f01386e0ccb`, on baseline
`7eebae4812b3c67ccdbbb63c8c1603f7767b1466`.

Run the safe, unpaid checks from the assigned worktree:

```sh
node --test tests/unit/phase47-runtime-acceptance.test.cjs
node tests/smoke/phase47-runtime-acceptance.cjs --evidence docs/audits/phase47-runtime-acceptance.json
```

The smoke command reads the exclusive selection/binding and the original
coordinator handback pinned by the existing publication checker, recomputes
canonical input and complete package digests, checks source ancestry and bytes,
and checks both Verification argv/profile/timeout assignments through existing
T-47-10 admission. Later mechanical publication HEADs are admissible only with
identical canonical inputs; original source HEAD/tree remain unchanged.
The checkout's current head, tree and dirty-status digest are reported separately.
Unrelated tuning changes do not invalidate canonical source identity; current
policy and applicable exact-command admission must still match.

Original INV014 archives are checked with planning-result-sealer and the original
durable boundary HMAC envelope, without opening its creating recorder. The
runner never creates a receipt key, replays a completed role, installs a package
or deletes host resources during inspection. Signature checks, when original
approved-host proof is supplied, use a private temporary verification keyring
containing only the public key and remove only that owned directory. Diagnostics
contain identities/digest references, not findings, transcripts or private keys.

The unit command projects only scoped, already owned fixtures onto package
bytes in disposable test directories. It executes both public detached CLI
load orders, completed and artifact-producing blocked semantic callbacks, and
legitimate plus indirect notification callbacks with independent caps and exact
owned cleanup. It also refuses altered/missing/extra package files, lost modes,
foreign/tampered receipts, denied first-call heredocs followed by later hashes,
invented counters and unsafe switches. These deterministic observations do not
establish that an operator's runtime was installed or behaviorally accepted.

Before any isolated install, the trusted rollout owner must authenticate 12's
original complete parity result and unchanged exclusive 05 stage. Current-head
human review, signing and merge are separate gates: PR433 is recorded as draft,
pr-open on the inspected delivery snapshot. Bytes already present in this
dependency worktree do not close that gate. Preserve PR418's original
head/snapshot history. Do not run package generation, refresh-runtime writes,
marketplace generator tests or gsd-sync to repair a missing handoff.

The supported installer entry is an explicit Codex marketplace invocation:

```text
node scripts/install-shipyard-marketplace.cjs codex --source <approved-source-root>
```

The source must contain the exact published package. Record the full installer
argv, source revision/tree/dirty inventory, explicit runtime=codex, capability
file/digest, owned destination and environment before executing it. Use the
existing dedicated dogfood target selected by this installer, never the shared
default Codex home. Its installed cache's bootstrap entry is:

```text
bash <installed-package-root>/host/scripts/ensure-gsd-core.sh --launch-bootstrap
```

Record the actual resulting environment and successful outcome. Omit an
unsuitable inherited TMPDIR; do not rewrite global config or change policy.
Preserve the emergency notification mitigation until replacement proof exists.
These templates are procedural prerequisites, not authorized executor commands.
There is no install or current safe rollback identity supplied in this handoff.

Supply the existing host's original evidence in the ledger before native work.
Each obligation stores governing inputs, original argv arrays/environment,
outcome/exit, owner and original digest references. `HOLD`, `open` and `blocked`
require a reason and no accepted `proof`; unaccepted historical references remain
in `retained_references`. A `proven` row uses `kind: approved-host` with the
existing host-verification evidence path, byte SHA-256 and canonical evidence
digest. The trusted host supplies a detached operator-signed applicability
descriptor, `shipyard.phase47-acceptance-approval.v1`, not a model verdict.
It binds ticket/PLAN, exact installation identity and per-property commands,
environment, governing inputs, unchanged assertion tree, original artifact
references and a separately recorded implementation approval reference.
The pinned operator fingerprint is
`2F485C0A455BA33463F66332900FCE87BD1BFF0D`. Every signature/public-key reference
includes original path and byte digest. This descriptor associates existing
assertions; it does not grant a new host runner or replace assertion authority.

The installation identity includes runtime/root, actual native bundle root
(`<runtime-root>/shipyard`), complete package cache root/digests, original
source HEAD/tree/dirty state, current worktree HEAD/tree/dirty digest,
repository/common directory, controller/run, provenance sidecar, native CLI
executable bytes, runtime capability evidence, registered capability and
generated agent manifest/individual agent digests. Both the cache and every
actual bundle executable must match the immutable candidate. Ambiguous runtime,
unsuitable environment, foreign provenance or missing capability refuses.

Planner/checker obligations additionally require original authenticated native
receipts and child transcript/task digests. Their **first call** must have used
filesystem read-only inline `python -c` or `node -e`, with its computed task hash
in that same call's output. A denied original heredoc plus a later hash, a suffix,
an output file alone or a model claim does not satisfy this amended-input gate.
Keep a separately authenticated `validate-graph` exit-zero obligation. The runner
does not launch replacement planners/checkers or rerun accepted researchers.

Require independent final combined fifteen-file implementation approval with
separate 47-14 thirteen-file and 47-15 two-file ownership, distinct approved
pure-ticket/canonical/runtime source maps and human/trusted-host exact-byte
bootstrap approval. The experimental architecture target judgment cannot approve
its own implementation. Installed critical architecture evidence must bind
canonical graph, current PR/head/base/draft, complete architecture corpus and
decisions, installed capability/agent identity, original context/launch digest
echoes, receipt/transcript and sealed judgment. Use the existing shared
role-artifact boundary immediately before each actual writer, including a fresh
process after clearInflight. Mutable archive rebinding, corpus/path replacement,
symlinks and descriptor races refuse. Full generated instructions and complete
prompt/corpus/input byte accounting plus actual native model capacity proof
remain required; missing capacity is HOLD.

The actual caller obligation requires one genuine planning-context detached
trace per distinct supported Codex path, or command-backed proof that paths are
shared. Keep the original dispatch, measured parent waiter observations and
separate original child usage. Unknown counters remain null and efficiency
inconclusive. Bounded installed notification lifecycle and 04's original approved
exact-argv candidate-bound host/GPG assertions with disposable cleanup are
separate obligations. Reuse them only when governing inputs match; denial is
HOLD and an actual assertion failure blocks. Historical GPG cause remains unknown.

Only after applicable prerequisite proof and explicit signed execution authority
may the rollout owner invoke:

```text
node tests/smoke/phase47-runtime-acceptance.cjs --native --runtime codex --candidate <exact-selected-candidate> --runtime-root <owned-isolated-runtime> --evidence <current-ledger>
```

The collection descriptor, `shipyard.phase47-native-authorization.v1`, binds the
same ticket/PLAN/installation, authenticated writer release, separate
implementation approval, safe rollback package digest, original prerequisite
references, canonical graph/config, full environment, bounded timeout and an
existing installed builder-produced request reference. Native argv must be exactly
`node <runtime-root>/shipyard/scripts/codex-planning-context-host.cjs --args-file <request>`;
record it before launch. Existing canonical config must admit that exact argv
as a host command with the same timeout (at most 600 seconds). The current
Verification allow-list alone does not authorize a paid collection.

The request is parsed by the actual installed host. Only the supported
`gsd-phase-researcher` trace is collected here; planner/checker proof is supplied.
Provider/model remain selected by unchanged host policy. Use the approved PATH,
CODEX_HOME, capability file and canonical SHIPYARD_GRAPH_DIR; TMPDIR and
NODE_OPTIONS must be absent. The resolved native CLI bytes must agree with the
installation identity. The runner reports command/outcome digests and leaves
acceptance HOLD pending original evidence validation. Timeout/error/nonzero exit
is nonzero; inspect original dispatch recovery before any retry. A host invocation
does not establish a count of paid launches. Native receipts stay in their existing
trusted archives; the coordinator preserves the completed result outside checkout.

Stop on identity/containment drift, stale or disputed original context,
unreleased writer, invalid semantic result, suppressed legitimate notification,
recursion beyond the independent cap, host authority regression or missing
rollback proof. Retain original errors and accepted siblings. New product defects
go to their 01/02/03/04/06/07 owners; this ticket cannot change those products.

Rollback is HOLD until the owner names the exact prior reviewed safe package,
digest/version/source and approved supported-installer argv/environment for the
same owned runtime. Restore only that package under existing rollout authority,
preserving the known notify mitigation. Do not infer that an older launch-incompatible
package is safe. Retain candidate stage, sealed receipts/archives, dirty preparation,
backups and unrelated installations. Maintenance may delete only authenticated
exact owned disposables after checking prior disposal; no broad path/PID cleanup
is inferred. Follow the separate durable handoff before any refresh or failed-role
retry. No current installed release is claimed by this procedure.


Historical pre-R4 state: T16 source-repair publication was pending transport into the T27 base. The explicit consumer selects ADR-027-main421-T16-R3, handoff SHA256 3f4b67549647d227c375da8d1042e5dbb601e80303cf3d52fe47ef1ff54b9eba, signed source d1e3fcb20c4c8d3786dd7fa7294bd519fa57618d and version 0.71.0+codex.b7fbd7d015a08f33. Its declared inventory is 161 and its eight generated outputs remain T16-owned. T27 copies none of them. Original R2/F1 readers and materializations remain unchanged. Current source inequality is a refusal, not native HOLD success. All twenty original obligations remain HOLD; accepted=false, native_launches=0 and accounting inconclusive. Root owes source/base transport and the original four formal checks before any completed publication claim.


Historical R4 consumer selection was the literal-pinned ADR-027-main421-T16-R4 generation, handoff SHA256 d749a68e28c4355cd59c49b70ca42636d57d5cd318ff0a8d489e24383dd9a035. Its signed source is 6bd6943be0d617144803399b987a2877ed365c0c, tree 0588af073a11d35dab3abfd87aa5aa3349eca9aa, version 0.71.0+codex.daf277913a59a95f and inventory 161. Its predecessor is the immutable R3 identity recorded above, authenticated historically against original d1 source and published 63209e88de5213bb378b07b61cb7b64a4bc3d44f; R2 retains its separately signed f587 historical contract. The earlier pending-transport paragraph records the prior state, not the current selector.

R4 declares exactly three changed outputs: .codex-plugin/plugin.json, host/plugins/delivery-pipeline/scripts/deliver-dispatch.cjs and package-build.json. The signed binding records one supported build before final proof, native complete parity, both original final-tree HOST commands and sealing without rebuild. Source finalization binds proof c2fda6a34be316bf5af4ace1f1cd26d48f0d89abebb870a660817d662fc54323 and covered=true. Selection SHA256 7034eb1d3381a625312b7e55da5eea92190b1eacdc2de0d9cf9a5ca9a3e25eae and binding SHA256 d6d9aa45d3354bc86c7a637ab70ccad8cc00ed95b755b7896f65a23ad7a57783 remain exact; their files and candidate reside in the R4 namespace alongside generation.json and original detached signatures.

Current canonical bytes, modes and source Git ancestry remain mandatory. PR451/main-epic landing and fresh final main-target architecture/integration are outstanding coordinator checks; a later epic squash requires explicit provenance transport and cannot silently remove ancestry checks. The consumer update supplies no installed/native acceptance: all original twenty rows remain HOLD, accepted=false and native_launches=0; accounting stays null/inconclusive. The coordinator must run the original four formal commands at their approved 600-second assignments after handback.


Historical R5 consumer selected literal-pinned ADR-027-main421-T16-R5/generation.json, SHA256 bc0fd3d6dd33ee608056ef3e76aa5e835e48e538ca44699be5f44ae5a762a6b9. Signed source 74597623434d748357fcafedc87ed8d7397b7757 has tree 6c8bf92fe236af7058ae1bed7ecd3e99dfbe3090; version is 0.71.0+codex.b8ac969962427971 with 161 outputs. Selection SHA256 0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90 and binding SHA256 062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979 are independently signed in that same immutable namespace. Its immediate historical parent is literal R4, followed by original R3 and signed R2 historical admission; historical frozen source/Git/native/HOST/coverage/inventory checks remain mandatory without equality to today's source.

R5's measured three-output delta is .codex-plugin/plugin.json, host/plugins/delivery-pipeline/scripts/role-artifact.cjs and package-build.json. Its signed binding retains one supported build, native complete parity and original two final-tree HOST commands before sealing without rebuild; finalization /tmp/phase47-16-bounded-final-retry-trusted-fixer-finalization.json binds proof e6ba9e5707ac24ca70b0cf68a0905d67b344eeaa419ee1b1cb3d33c028c145e8. Source review /tmp/phase47-16-bounded-verdict-lookup-result.json and final publisher /tmp/phase47-16-bounded-clean-parity-result.json remain distinct genuine receipts. Failed intermediate candidates/preflights and the empty R4 consumer result receive no native credit.

Historical R5 admission required strict actual canonical bytes/modes, full 161-member stage and package inventory, source Git/tree/ancestry, separate Source39/coordinator48, original native/HOST/coverage and final recheck. All twenty original obligations retain HOLD, accepted=false, native_launches=0 and null/inconclusive accounting. PR451 landing and fresh complete main-target judgment are coordinator-owned outstanding checks; later epic squash requires actual Git/live-head provenance transport. The coordinator owes the original four formal 600-second checks after genuine consumer handback. No installed/native or main-merge judgment is inferred from publication.


Final R5 consumer evidence: `node -e "require('./tests/unit/phase47-package-publication.test.cjs').authenticateT16Successor('/Volumes/KINGSTON/claude-shipyard/.git')"` exited 0. The narrowed `validateLedger(JSON.parse(fs.readFileSync('docs/audits/phase47-runtime-acceptance.json')))` invocation exited 0; retained output /private/tmp/t27-r5-ledger.log reports status HOLD, evidence_check passed, accepted false and native_launches 0. Filtered portable command `node --test --test-name-pattern='R2 historical|T16 source-repair contract|R2 exact|exact GENF1' tests/unit/phase47-runtime-acceptance.test.cjs` exited 0 with tests 5, pass 5, fail 0. These historical R5 checks authenticated its selection/package/ledger and mutation refusals; the original four full formal commands and fresh main-target native judgment remain owed by the coordinator.

Historical R6 selects literal ADR-027-main421-T16-R6/generation.json, SHA256 b3a59beb7e369cb891e5934fe974e1bcad9d3ba7c96078fa6d6595b294a40de9. Its signed binding pins source fb444e75a115c57c70d27cb70f37c3a0e742a2df, tree 4188f087f978ccda7cb9c942232e1c742aa532f0, version 0.71.0+codex.c926509d9f20d683 and 161 outputs. Selection SHA256 e8954ec3ba0060ace0bc6b3256043e0564b4797a6c154d0abd698662eba1a87c and binding SHA256 1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33 reside with the original detached signatures in that immutable namespace. The immediate predecessor is literal R5; original R5/R4/R3/R2/F1 history and authority remain independently authenticated against their frozen Git bytes. The verified /tmp/phase47-27-final-R5-consumer-result.json remains R5 history only.

R6 declares exactly six changed outputs: both manifests and the gate-trailer, role-artifact, sentinel and state-sync host mirrors. Its original source result /tmp/phase47-16-shared-epic-repo-fix-result.json and publisher /tmp/phase47-16-shared-epic-parity-result.json are distinct. The binding retains one supported build before final proof, genuine publisher parity, and finalization /tmp/phase47-16-shared-epic-final-trusted-fixer-finalization.json with proof 3f22588fadf574bf8f3e73eec91d586ed8b7196cb762ac4905f5196489f98c16 before sealing without rebuild. Current canonical inputs/modes, full stage/package membership, native/HOST coverage, separate configurations, Git ancestry and final recheck remain mandatory.

All twenty original obligation objects and null/inconclusive accounting remain unchanged. Original four formal consumer commands at timeout_s:600 and fresh complete main-target judgment remain coordinator duties. PR451 CI/review/merge state is unknown to this consumer; the dispatch reports fresh CI/review pending and no merge. Future epic squash requires actual published PR source/Git/tree provenance independently; no historical parent is relabelled unchanged. No installed/native or current-main judgment is claimed.

R6 narrowed evidence: `node --test --test-name-pattern='R6 shared-epic|R2 historical|T16 source-repair contract|R2 exact|exact GENF1' tests/unit/phase47-runtime-acceptance.test.cjs` exited 0, tests6/pass6/fail0. `node tests/unit/phase47-package-publication.test.cjs` exited 0, fixture_only=true/passed186/private_build_calls0/selected_reuse_build_calls0. The real read-only `authenticateT16Successor('/Volumes/KINGSTON/claude-shipyard/.git')` command exited 0 and reported current version/161 outputs. The following narrowed real ledger command exited 0; /private/tmp/t27-r6-ledger.log reports HOLD/evidence_check passed/accepted false/native_launches0 and20 open obligations. Its candidate exactly matches the final ledger candidate. These are narrowed consumer checks; original four formal commands remain outstanding.

```sh
node - <<'JS' > /private/tmp/t27-r6-ledger.log 2>&1
const fs=require('node:fs');
const {validateLedger}=require('./tests/smoke/phase47-runtime-acceptance.cjs');
console.log(JSON.stringify(validateLedger(JSON.parse(fs.readFileSync('docs/audits/phase47-runtime-acceptance.json'))),null,2));
JS
```

Historical R7 selected literal ADR-027-main421-T16-R7/generation.json, SHA256 5d8f2d08de1421849719fdd3db3f3f01b9b8caca474b5b9a4efc485857cbec1a. Source cab5dc80ac223814713088fc5077860882508b8c, tree df908628cd1016a4f7d41c89661b23f1dbaa4f94, version 0.71.0+codex.bf58e0d9b9d7b99f, 161 outputs. Its exact five deltas are both manifests and role-artifact/sentinel/state-sync mirrors. R6 and its original signed source/native/HOST chain remain historical; /tmp/phase47-27-final-R6-consumer-result.json grants no R7 credit.

The prior R7 dispatch proposed PR451 squash admission; PR451 is closed without merge according to the current dispatch (live GitHub state not checked by this actor). Its obsolete merge evidence is neither created nor consumed as current authority. R7 now authenticates its original signed Git source/tree/native proofs/coverage and complete inventory as history, without current-branch ancestry; no installed/native or final main judgment is claimed. The twenty original obligations remain HOLD, accepted=false, native_launches=0, with null accounting.

R7 focused checks: `node --test --test-name-pattern='explicit HOLD|foreign, unsigned|publication fixture cannot|current candidate refusal|R7 literal|R7 signed squash|R6 shared-epic' tests/unit/phase47-runtime-acceptance.test.cjs` exited0 (tests7/pass7/fail0). Direct read-only `authenticateT16Successor` exited0 with current version/161 outputs. Narrowed `validateLedger` heredoc exited0; `/private/tmp/t27-r7-ledger.log` reports HOLD/evidence_check passed/accepted false/native_launches0 and20 open obligations. These are focused checks; the coordinator still owes the four formal commands and real post-merge squash-path verification.


Current R8 selects literal ADR-027-main421-T16-R8/generation.json, SHA256 5792799323c1533de10e65fe418aca8b640691db640f24f6623361381e7bccd0. Signed source 0b7791c208c2d3069c868d39af4f6bd9b2720e3c, tree 4a4afdf128ea7bc533004800a8a2a5d1f9856cc7, version 0.71.0+codex.b319402d6ef6389f, 161 outputs. Selection SHA256 e53f5bcff100db381aba215bc899f541250f9102ee24a14ab84014a02e5d821d; binding SHA256 c9de489f0d340ba0d49c28d6a18b0c95b9915db81d549e31bebe0b99e05b52d7. These identities are read from the immutable stage JSON by the focused consumer update. Its seven declared deltas are both manifests, role-artifact, deliver.md, arch-review.md, pr-sentinel.md and delivery-rules/SKILL.md. Historical R7 through original R2 remain independently authenticated with their original signed source, native/HOST proof, coverage, configuration and inventory guards.

Current admission requires strict canonical bytes/modes and direct source ancestry on this native-covered branch. Only literal R8 may alternatively consume original operator-signed /tmp/phase47-452-merged-publication.json (+.asc), bound to actual PR452 head, exact R8 stage digest/source tree, actual Git merge tree, base 265110621c8097a83867a9e9dd7958c0e7830cb2 ancestry and merge ancestry to current HEAD. Actual operator-signed `/tmp/phase47-452-merged-publication.json` (+.asc) records PR452 MERGED at16c2ff774185a77db55526361fc228dc8684a989, matching signed source0b7791c208c2d3069c868d39af4f6bd9b2720e3c and R8 stage5792799323c1533de10e65fe418aca8b640691db640f24f6623361381e7bccd0. Real sourceSquash verification passed on E according to the coordinator dispatch. No generic equal-tree admission is provided.

PR452 is actually MERGED at16c2ff774185a77db55526361fc228dc8684a989 according to the signed publication record read by `python3` from `/tmp/phase47-452-merged-publication.json`. The trusted record `/tmp/phase47-27-final-R8-consumer-trusted-finalization.json` reports all four original formal commands passed at signed17406a1e69e693a33e4f2c3277c7479c0084cf18, proof1e64a3e243ddcde5baccf4cb13a26fa18c674e4a0b8e34ed7a95895bd9722136. This is historical validation on pre-this-fix code. Latest follow-up formal proof remains coordinator-owned pending. Fresh complete native main-target architecture/integration remains outstanding. Original twenty obligations remain HOLD, accepted=false, native_launches=0 and null/inconclusive accounting; current CI and installed acceptance are not asserted.

R8 focused verification: `node --test --test-name-pattern='explicit HOLD|foreign, unsigned|publication fixture cannot|current candidate refusal|R7 literal|R8 literal|R8 signed squash|R6 shared-epic|R2 historical|T16 source-repair contract|R2 exact|exact GENF1' tests/unit/phase47-runtime-acceptance.test.cjs` exited 0, tests13/pass13/fail0 (output /private/tmp/t27-r8-final-focused.log). `node -e 'const p=require("./tests/unit/phase47-package-publication.test.cjs"); const a=p.authenticateT16Successor("/Volumes/KINGSTON/claude-shipyard/.git");console.log(JSON.stringify({current:a.current,version:a.selected.binding.version,outputs:a.selected.binding.outputs.length,publication:p.validatePublication(process.cwd(),a.selected,"candidate")}))'` exited 0: source_publication verified, current R8 version and161 outputs (output /private/tmp/t27-r8-final-auth.log). `node -e 'const fs=require("node:fs");console.log(JSON.stringify(require("./tests/smoke/phase47-runtime-acceptance.cjs").validateLedger(JSON.parse(fs.readFileSync("docs/audits/phase47-runtime-acceptance.json"))),null,2))'` exited 0: HOLD/evidence_check passed/accepted false/native_launches0/open20 (output /private/tmp/t27-r8-ledger.log). These are historical focused checks preceding the passed17406 formal proof. The coordinator owes the latest repaired-code formal rerun and fresh final main-target judgment.
